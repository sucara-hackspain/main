import {
  elapsed, injuryLabel, sceneLabel, unitKind,
  type Action, type Call, type IncidentFrame, type ObservedEvent, type TickRecord, type UnitFrame,
} from "../engineTrace";
import { eventText } from "../thoughts/model";

export const ticketStates = { triage: "Triage", progress: "Progreso", resolved: "Resuelto" } as const;
export type TicketState = keyof typeof ticketStates;
export type TicketStep = {
  id: string; tick: number; title: string; detail?: string; reason?: string;
  source: string; kind: "call" | "action" | "assessment" | "update" | "alert" | "resolved";
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
  return `${name} reubicada`;
}

export function closureText(i: IncidentFrame) {
  if (i.closedReason === "merged") return `Agrupado con ${i.mergedInto ?? "otra incidencia"}`;
  if (i.closedReason === "not_found") return "La dotación no encontró a nadie en el lugar";
  return "Atención en el lugar finalizada";
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
