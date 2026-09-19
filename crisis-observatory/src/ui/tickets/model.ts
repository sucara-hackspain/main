import {
  elapsed, injuryLabel, sceneLabel, unitKind,
  type Action, type Call, type CaseEntry, type IncidentFrame, type ObservedEvent, type TickRecord, type UnitFrame,
} from "../engineTrace";
import { eventText } from "../thoughts/model";

export const ticketStates = { triage: "Triage", progress: "Progreso", resolved: "Resuelto" } as const;
export type TicketState = keyof typeof ticketStates;
export type TicketStep = {
  id: string; tick: number; title: string; detail?: string; reason?: string;
  source: string; kind: "call" | "action" | "assessment" | "update" | "alert" | "resolved";
  /** What the engine filed it as, to filter the timeline by. Absent on runs older than the engine's case file. */
  group?: "call" | "decision" | "radio" | "update";
  /** What a call added to what was known. */
  facts?: string[];
  /** Doctrine rules the coordinator cited for the order. */
  applies?: string[];
  focusId?: string;
};
export type Ticket = {
  id: string; incident: IncidentFrame; state: TicketState; title: string; location: string;
  steps: TicketStep[]; crews: UnitFrame[]; calls: Call[]; lastSeenTick: number; updatedTick: number;
};

function actionTitle(action: Action, units: UnitFrame[], accepted: boolean) {
  const u = units.find((u) => u.id === action.unitId);
  const name = `${u ? unitKind[u.kind].label : "Unidad"} ${action.unitId}`;
  if (!accepted) return `Orden rechazada · ${name}`;
  if (action.type === "dispatch") return `${name} enviada a la zona`;
  if (action.type === "transport") return `${name} · traslado a ${action.hospitalId}`;
  if (action.type === "scout") return `${name} · reconocimiento de la zona`;
  return `${name} reubicada`;
}

export function closureText(i: IncidentFrame) {
  if (i.closedReason === "merged") return `Agrupado con ${i.mergedInto ?? "otra incidencia"}`;
  if (i.closedReason === "not_found") return "La dotación no encontró a nadie en el lugar";
  return "Atención en el lugar finalizada";
}

const decidedBy = { llm: "Agente coordinador", fallback: "Coordinador · respaldo por reglas", rules: "Coordinador · reglas", operator: "Operador · orden directa" } as const;

function entrySource(e: CaseEntry) {
  if (e.kind === "call") return "112 · llamada";
  if (e.kind === "order" || e.kind === "operator") return decidedBy[e.decidedBy ?? "rules"];
  if (e.from.startsWith("radio ")) return `Dotación ${e.from.slice(6)} · radio`;
  if (e.from.startsWith("hospital ")) return `Hospital ${e.from.slice(9)}`;
  if (e.from === "reglas") return "Protocolo de triaje";
  if (e.from === "sistema") return "Centro de coordinación";
  return `Según el aviso ${e.from}`;
}

/** The engine's own case file, as steps: nothing here is inferred by the UI. */
export function caseSteps(incident: IncidentFrame, seconds: number): TicketStep[] {
  const steps: TicketStep[] = [];
  incident.timeline.forEach((e, n) => {
    const last = steps.at(-1);
    // What a call changed is part of that call, not a line of its own.
    if (e.kind === "update" && last?.kind === "call" && last.tick === e.tick && e.from === last.id.split(":call:")[1] && !e.flag) {
      (last.facts ??= []).push(e.text);
      return;
    }
    const step: TicketStep = { id: `${incident.id}:t:${n}`, tick: e.tick, title: e.text, source: entrySource(e), kind: "update", group: "update", focusId: e.focusId };
    if (e.kind === "call") Object.assign(step, { id: `${incident.id}:t:${n}:call:${e.callId}`, title: `Aviso al 112 · ${e.callId}`, detail: e.text, kind: "call", group: "call" });
    else if (e.kind === "order" || e.kind === "operator") Object.assign(step, {
      kind: e.accepted ? "action" : "alert", group: "decision", applies: e.applies,
      detail: e.accepted && e.etaTicks !== undefined ? `Orden aceptada · llegada estimada en ${elapsed(e.etaTicks, seconds)}` : undefined,
      reason: e.reason ?? (e.kind === "operator" ? "Orden directa del operador, por encima del coordinador." : "Sin justificación registrada para esta orden."),
    });
    else if (e.kind === "radio") Object.assign(step, { kind: e.flag ?? "update", group: "radio" });
    else if (e.kind === "closed") Object.assign(step, { kind: "resolved", title: "Ticket resuelto", detail: closureText(incident) });
    else if (e.flag === "alert") Object.assign(step, e.text.startsWith("prioridad:")
      ? { kind: "alert", title: "La incidencia es más grave de lo previsto", detail: `${e.text.slice(11)} · según la información registrada en este instante.` }
      : { kind: "alert" });
    steps.push(step);
  });
  return steps;
}

/** Rebuild from the visible past, keeping closed tickets after the engine drops their snapshots. */
export function buildTickets(records: TickRecord[], seconds: number): Ticket[] {
  const tickets = new Map<string, Ticket>();
  const calls = new Map<string, Call>();
  const victims = new Map<string, string>();
  const assignments = new Map<string, string>();
  const started = new Set<string>();
  for (const record of records) {
    const previous = new Map([...tickets].map(([id, t]) => [id, t.incident]));
    for (const call of record.calls) calls.set(call.id, call);
    for (const event of record.events) if (event.type === "call_received") calls.set(event.call.id, event.call);
    for (const incident of record.frame.incidents) {
      let ticket = tickets.get(incident.id);
      if (!ticket) {
        ticket = {
          id: incident.id, incident, state: "triage", title: "Incidencia pendiente de valorar",
          location: "Ubicación aproximada", steps: [], crews: [], calls: [],
          lastSeenTick: record.tick, updatedTick: incident.updatedTick,
        };
        tickets.set(incident.id, ticket);
        ticket.steps.push({ id: `${incident.id}:opened`, tick: incident.openedTick,
          title: "Incidencia abierta · triage inicial", source: "Centro de coordinación", kind: "update" });
      }
      ticket.incident = incident;
      ticket.lastSeenTick = record.tick;
      ticket.calls = incident.callIds.flatMap((id) => calls.has(id) ? [calls.get(id)!] : []);
      ticket.title = incident.mechanism ? sceneLabel(incident.mechanism.value) : "Incidencia pendiente de valorar";
      ticket.location = ticket.calls.find((c) => c.street)?.street ?? "Ubicación sin calle confirmada";
      for (const v of incident.victims) victims.set(v.id, incident.id);
    }
    // Events belong to the unit's mission at that instant, not a future reassignment.
    const eventIncident = (e: ObservedEvent): string | undefined => {
      if (e.type === "call_received") return record.frame.incidents.find((i) => i.callIds.includes(e.call.id))?.id;
      if ("action" in e && e.action.type === "dispatch") return e.action.incidentId;
      if ("incidentId" in e && e.incidentId) return e.incidentId;
      if ("victimId" in e && victims.has(e.victimId)) return victims.get(e.victimId);
      const unitId = "action" in e ? e.action.unitId : "unitId" in e ? e.unitId : undefined;
      return unitId ? assignments.get(unitId) ?? record.frame.units.find((u) => u.id === unitId)?.incidentId ?? undefined : undefined;
    };
    const outcomes = new Set<number>();
    for (const [n, event] of record.events.entries()) {
      const id = eventIncident(event), ticket = id ? tickets.get(id) : undefined;
      if (!ticket) continue;
      const step: TicketStep = {
        id: `${record.tick}:e:${n}`, tick: event.tick, title: eventText(event, seconds),
        source: "Dotación · parte operativo", kind: "update",
      };
      if (event.type === "call_received") {
        step.title = `Aviso al 112 · ${event.call.id}`;
        step.detail = event.call.text;
        step.source = "112 · llamada";
        step.kind = "call";
      } else if (event.type === "action_applied" || event.type === "action_rejected") {
        const index = record.actions.findIndex((a, i) => !outcomes.has(i) && JSON.stringify(a) === JSON.stringify(event.action));
        if (index >= 0) outcomes.add(index);
        const accepted = event.type === "action_applied";
        step.title = actionTitle(event.action, record.frame.units, accepted);
        step.detail = accepted
          ? `Orden aceptada${event.action.type === "dispatch" ? ` · llegada estimada en ${elapsed(event.etaTicks, seconds)}` : ""}${"hospitalId" in event.action && event.action.hospitalId ? ` · destino ${event.action.hospitalId}` : ""}`
          : event.reason;
        step.reason = (index >= 0 ? record.decision?.reasons?.[index] : undefined) || "Sin justificación registrada para esta orden.";
        step.source = record.decision?.source === "llm" ? "Agente coordinador" : record.decision?.source === "fallback" ? "Coordinador · respaldo por reglas" : "Coordinador · reglas";
        step.kind = accepted ? "action" : "alert";
        if (accepted && event.action.type === "dispatch") {
          started.add(ticket.id);
          assignments.set(event.action.unitId, ticket.id);
        }
        if (accepted && event.action.type === "reposition") assignments.delete(event.action.unitId);
      } else if (event.type === "scene_assessed") {
        started.add(ticket.id);
        step.title = `${event.unitId} · valoración en el lugar`;
        step.detail = event.victims.map((v) => `${v.id}: ${injuryLabel(v.injury)} · ${v.triage === "red" ? "rojo" : v.triage === "yellow" ? "amarillo" : v.triage === "green" ? "verde" : "negro"}${v.trapped ? " · atrapada" : ""}`).join("; ") || "Sin víctimas en la valoración.";
        step.kind = "assessment";
        for (const v of event.victims) victims.set(v.id, ticket.id);
      } else if (["unit_broken", "unit_stranded", "road_blocked_found", "hospital_full", "victim_died"].includes(event.type)) {
        step.kind = "alert";
      }
      ticket.steps.push(step);
    }
    // A recorded order without an outcome is a proposal, never a confirmed dispatch.
    record.actions.forEach((action, n) => {
      if (outcomes.has(n)) return;
      const id = action.type === "dispatch" ? action.incidentId : assignments.get(action.unitId);
      const ticket = id ? tickets.get(id) : undefined;
      if (ticket) ticket.steps.push({ id: `${record.tick}:a:${n}`, tick: record.tick,
        title: `Orden propuesta · ${action.unitId}`, detail: "Pendiente de confirmación de ejecución.",
        reason: record.decision?.reasons?.[n] || "Sin justificación registrada para esta orden.",
        source: "Coordinador", kind: "action" });
    });
    for (const incident of record.frame.incidents) {
      const ticket = tickets.get(incident.id)!, before = previous.get(incident.id);
      if (before && before.priority !== incident.priority) ticket.steps.push({
        id: `${record.tick}:${incident.id}:priority`, tick: record.tick,
        title: incident.priority < before.priority ? "La incidencia es más grave de lo previsto" : "Prioridad actualizada",
        detail: `P${before.priority} → P${incident.priority} · según la información registrada en este instante.`,
        source: "Actualización del incidente", kind: incident.priority < before.priority ? "alert" : "update",
      });
      if (incident.status === "closed" && before?.status !== "closed") ticket.steps.push({
        id: `${record.tick}:${incident.id}:closed`, tick: incident.updatedTick,
        title: "Ticket resuelto", detail: closureText(incident), source: "Centro de coordinación", kind: "resolved",
      });
    }
    // A no-order summary is relevant only when it explicitly names this incident.
    if (record.decision?.situation && !record.actions.length) for (const ticket of tickets.values()) {
      if (!record.decision.situation.split(/[^\p{L}\p{N}_-]+/u).includes(ticket.id)) continue;
      ticket.steps.push({ id: `${record.tick}:decision:${ticket.id}`, tick: record.tick,
        title: "Coordinador · sin nuevas órdenes", detail: record.decision.situation,
        source: "Resumen registrado del coordinador", kind: "update" });
    }
    assignments.clear();
    for (const u of record.frame.units) if (u.incidentId) assignments.set(u.id, u.incidentId);
  }
  const current = records.at(-1);
  for (const ticket of tickets.values()) {
    ticket.crews = current?.frame.units.filter((u) => u.incidentId === ticket.id) ?? [];
    ticket.state = ticket.incident.status === "closed" ? "resolved"
      : started.has(ticket.id) || ticket.incident.located || ticket.crews.length ? "progress" : "triage";
    // Runs that carry the engine's case file are shown from it; the reconstruction above is for older runs.
    if (ticket.incident.timeline?.length) {
      ticket.steps = caseSteps(ticket.incident, seconds);
      if (ticket.incident.status !== "closed" && ticket.state === "triage" && ticket.incident.timeline.some((e) => e.action?.type === "dispatch" && e.accepted)) ticket.state = "progress";
    }
    ticket.steps.sort((a, b) => a.tick - b.tick);
    ticket.updatedTick = Math.max(ticket.incident.updatedTick, ticket.steps.at(-1)?.tick ?? 0);
  }
  return [...tickets.values()].sort((a, b) =>
    Number(a.state === "resolved") - Number(b.state === "resolved") || a.incident.priority - b.incident.priority ||
    b.updatedTick - a.updatedTick || a.id.localeCompare(b.id, "es", { numeric: true }));
}

/** Operational next step inferred from reported facts; not an invented agent explanation. */
export function ticketNextStep(ticket: Ticket): { title: string; detail: string } {
  const i = ticket.incident;
  if (ticket.state === "resolved") return { title: "Ticket resuelto", detail: closureText(i) };
  if (ticket.crews.some((u) => u.broken || u.stranded)) return {
    title: "Intervención bloqueada", detail: "Hay una unidad averiada o sin ruta conocida. Pendiente de recuperar el acceso o asignar apoyo.",
  };
  if (i.unreachable || i.cutOffIn === 0) return {
    title: "Acceso por carretera comprometido", detail: "Pendiente de confirmar acceso y respuesta de los equipos de rescate.",
  };
  if (!ticket.crews.length) return {
    title: "Pendiente de asignación", detail: "No hay una unidad asignada en este instante. El registro no indica el motivo de la espera.",
  };
  if (!i.located) return {
    title: "Esperando valoración en la zona", detail: "Falta confirmar la ubicación exacta, la gravedad y el número de personas afectadas con el parte de la dotación.",
  };
  return { title: "Atención en curso", detail: "Pendiente del siguiente parte de las unidades para actualizar la atención y los traslados." };
}
