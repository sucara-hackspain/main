import {
  elapsed,
  isFree,
  type EscalationKind,
  type EscalationRequest,
  sceneLabel,
  unitKind,
  UNIT_KINDS,
  type Action,
  type IncidentFrame,
  type RunMeta,
  type TickRecord,
  type UnitFrame,
  type UnitKind,
} from "../engineTrace";
import { actionText } from "../audit/model";
import type { Router } from "./routing";

// Exceptions the system leaves open and a person should decide on. The engine's escalation desk
// decides which ones those are, from the catalogue in policies/escalation.json, and writes
// them into each record; detectInterventions() below reads runs recorded before that existed.
// interventionsAt() hides what later records say about how each one ended.

/** The exceptions the escalation catalogue covers: the engine's vocabulary, one word each. */
export type InterventionKind = EscalationKind;

/** A request as the operator works with it. From the engine it carries the policy that raised it. */
export type Intervention = Omit<EscalationRequest, "policyId"> & { policyId?: string };

/**
 * What the engine's escalation desk raised, as of the records received: each request in the state its
 * last record left it. Null for runs recorded before the desk existed, which are read the old way.
 */
export function escalationsFrom(records: TickRecord[]): Intervention[] | null {
  const byId = new Map<string, Intervention>();
  let desk = false;
  for (const record of records) {
    if (!record.escalations) continue;
    desk = true;
    for (const request of record.escalations) byId.set(request.id, { ...request });
  }
  return desk ? [...byId.values()] : null;
}

export type Option = {
  id: string;
  label: string;
  detail?: string;
  /** Same order type Simulation.order() takes. Absent when the decision happens outside the engine. */
  action?: Action;
};

export type Prescription = {
  summary: string;
  rationale: string;
  /** options[0] is the prescribed one. */
  options: Option[];
  /** Tick after which the decision no longer helps. */
  deadlineTick: number | null;
  /** Where the deadline comes from: the water forecast, or the victims' real state in the simulation. */
  deadlineSource?: "water" | "simulation";
};

export type OperatorDecision = {
  interventionId: string;
  optionId: string;
  label: string;
  /** True when the operator took the prescribed option. */
  approved: boolean;
  action?: Action;
  tick: number;
  at: string;
};

export type InterventionView = Intervention & {
  status: "pending" | "decided" | "expired";
  decision?: OperatorDecision;
};

/** Minutes of margin, in ticks, below which a water cut-off needs a decision. */
const CUTOFF_TICKS = 20;
const SURGE_AFTER = 3;
const SURGE_CALM = 3;
const NOTICE_TICKS = 10;
const LOADED_AFTER = 2;
/** An incident's situation must last this long without the system acting before it asks a person. */
const PERSIST_TICKS = 3;

type Frame = TickRecord["frame"];
const working = (frame: Frame, incidentId: string) =>
  frame.units.filter((u) => u.incidentId === incidentId && !u.broken);
const waterOrAir = (u: UnitFrame) =>
  UNIT_KINDS[u.kind].wades || UNIT_KINDS[u.kind].flies;
/** Open P0/P1 incidents nobody is working on. */
export const unattended = (frame: Frame) =>
  frame.incidents.filter(
    (i) => i.status === "open" && i.priority <= 1 && working(frame, i.id).length === 0,
  );
/** Already cut off: no known street gets there, or the forecast says the water closed it. */
const isolated = (i: IncidentFrame) => i.unreachable || i.cutOffIn === 0;
/** Open P2/P3 incidents the water has cut off, with no water or air unit on them. */
export const isolatedWaiting = (frame: Frame) =>
  frame.incidents.filter(
    (i) =>
      i.status === "open" &&
      i.priority >= 2 &&
      isolated(i) &&
      !working(frame, i.id).some(waterOrAir),
  );

export function detectInterventions(records: TickRecord[]): Intervention[] {
  const found: Intervention[] = [];
  const open = new Map<string, Intervention>();
  const loadedSince = new Map<string, number>();
  const standing = new Map<string, number>();
  let hot = 0,
    calm = 0,
    surgeDeaths = 0,
    wet = 0,
    dry = 0;
  const start = (
    key: string,
    item: Omit<Intervention, "id" | "closedTick" | "outcome">,
  ) => {
    if (open.has(key)) return;
    // One request per incident at a time: the most specific one, opened first, stands.
    // A victim on board is its own matter, whatever incident it came from.
    if (
      item.incidentId &&
      !item.victimId &&
      [...open.values()].some((x) => x.incidentId === item.incidentId && !x.victimId)
    )
      return;
    const next = {
      ...item,
      id: `${key}:${item.openedTick}`,
      closedTick: null,
      outcome: null,
    };
    open.set(key, next);
    found.push(next);
  };
  for (const record of records) {
    const { frame, tick } = record;
    const queue = unattended(frame);
    const saturated = queue.length >= 2 && !frame.units.some(isFree);

    for (const [key, item] of open) {
      let outcome: string | null = null;
      if (item.kind === "surge") {
        surgeDeaths += record.events.filter((e) => e.type === "victim_died").length;
        calm = saturated ? 0 : calm + 1;
        if (queue.length === 0 || calm >= SURGE_CALM)
          outcome = surgeDeaths
            ? `La saturación terminó con ${surgeDeaths} ${surgeDeaths === 1 ? "fallecido" : "fallecidos"}`
            : "La demanda urgente volvió a quedar cubierta sin fallecidos";
      } else if (item.kind === "water") {
        dry = isolatedWaiting(frame).length ? 0 : dry + 1;
        if (dry >= SURGE_CALM)
          outcome = "Las zonas aisladas ya tienen una unidad acuática o se resolvieron";
      } else if (item.kind === "fallback") {
        if (record.decision?.source === "llm") outcome = "La IA volvió a decidir";
      } else if (item.kind === "rejected") {
        if (tick >= item.openedTick + NOTICE_TICKS)
          outcome = "El coordinador recibió el rechazo y siguió operando";
      } else outcome = settled(item, frame);
      if (outcome) {
        item.closedTick = tick;
        item.outcome = outcome;
        open.delete(key);
      }
    }

    for (const u of frame.units) {
      const incident = frame.incidents.find((i) => i.id === u.incidentId);
      if (u.stranded && (u.victimId || incident?.status === "open"))
        start(`stranded:${u.id}:${u.victimId ?? u.incidentId}`, {
          kind: "stranded",
          severity: "critical",
          openedTick: tick,
          title: u.victimId
            ? `${u.id} bloqueada con ${u.victimId} a bordo`
            : `${u.id} sin ruta conocida hacia ${u.incidentId}`,
          incidentId: u.incidentId,
          units: [u.id],
          victimId: u.victimId,
        });
      const key = `${u.id}:${u.victimId}`;
      if (u.victimId && u.mission === "idle" && !u.broken && !u.stranded) {
        const since = loadedSince.get(key) ?? tick;
        loadedSince.set(key, since);
        if (tick - since + 1 >= LOADED_AFTER)
          start(`loaded:${key}`, {
            kind: "loaded",
            severity: "critical",
            openedTick: tick,
            title: `${u.id} con ${u.victimId} a bordo y sin hospital`,
            incidentId: u.incidentId,
            units: [u.id],
            victimId: u.victimId,
          });
      } else loadedSince.delete(key);
    }

    const free = frame.units.some(isFree);
    const seen = new Set<string>();
    for (const incident of frame.incidents) {
      if (incident.status !== "open") continue;
      const crews = working(frame, incident.id);
      // Less urgent isolated places go to one shared request (below); urgent ones get their own.
      const cutOff = isolated(incident);
      const kind: InterventionKind | null =
        cutOff && !crews.some(waterOrAir)
          ? incident.priority <= 1
            ? "unreachable"
            : null
          : !cutOff &&
              incident.cutOffIn !== null &&
              incident.cutOffIn <= CUTOFF_TICKS &&
              crews.length === 0
            ? "cutoff"
            : incident.priority <= 1 && crews.length === 0 && free
              ? "unassigned"
              : null;
      if (!kind) continue;
      // The coordinator usually acts within a tick or two: only what it leaves standing reaches a person.
      const key = `${kind}:${incident.id}`;
      seen.add(key);
      const since = standing.get(key) ?? tick;
      standing.set(key, since);
      if (tick - since + 1 < PERSIST_TICKS) continue;
      start(key, {
        kind,
        severity: incident.priority <= 1 ? "critical" : "warning",
        openedTick: tick,
        incidentId: incident.id,
        units: [],
        victimId: null,
        title:
          kind === "unreachable"
            ? incident.unreachable
              ? `${incident.id} sin acceso por carretera`
              : `El agua ha aislado ${incident.id}`
            : kind === "cutoff"
              ? `El agua va a aislar ${incident.id}`
              : `${incident.id} (P${incident.priority}) sin unidad asignada`,
      });
    }
    for (const key of standing.keys()) if (!seen.has(key)) standing.delete(key);

    for (const e of record.events) {
      if (e.type !== "scene_not_found" || !e.incidentId) continue;
      const incident = frame.incidents.find((i) => i.id === e.incidentId);
      if (incident?.status !== "open") continue;
      start(`not_found:${e.incidentId}`, {
        kind: "not_found",
        severity: incident.priority <= 1 ? "critical" : "warning",
        openedTick: tick,
        title: `${e.unitId} no encuentra a nadie en ${e.incidentId}`,
        incidentId: e.incidentId,
        units: [e.unitId],
        victimId: null,
      });
    }

    if (!open.has("water")) {
      wet = isolatedWaiting(frame).length ? wet + 1 : 0;
      if (wet >= PERSIST_TICKS) {
        start("water", {
          kind: "water",
          severity: "warning",
          openedTick: tick,
          title: "Zonas aisladas por el agua sin unidad acuática",
          incidentId: null,
          units: [],
          victimId: null,
        });
        wet = dry = 0;
      }
    }
    if (!open.has("surge")) {
      hot = saturated ? hot + 1 : 0;
      if (hot >= SURGE_AFTER) {
        start("surge", {
          kind: "surge",
          severity: "critical",
          openedTick: tick,
          title: "Saturación: incidentes urgentes sin unidad",
          incidentId: null,
          units: [],
          victimId: null,
        });
        hot = calm = surgeDeaths = 0;
      }
    }
    if (record.decision?.source === "fallback")
      start("fallback", {
        kind: "fallback",
        severity: "warning",
        openedTick: tick,
        title: "IA no disponible: deciden las reglas",
        incidentId: null,
        units: [],
        victimId: null,
        note: record.decision.error,
      });
    const rejected = record.events.flatMap((e) =>
      e.type === "action_rejected" ? [e] : [],
    );
    if (rejected.length)
      start(`rejected:${tick}`, {
        kind: "rejected",
        severity: "warning",
        openedTick: tick,
        title:
          rejected.length === 1
            ? "El motor rechazó una orden"
            : `El motor rechazó ${rejected.length} órdenes`,
        incidentId: null,
        units: [...new Set(rejected.map((e) => e.action.unitId))],
        victimId: null,
        note: rejected.map((e) => `${actionText(e.action)} · ${e.reason}`).join("; "),
      });
  }
  return found;
}

/** How the records settled a request on their own, or null while it still stands. */
function settled(item: Intervention, frame: Frame): string | null {
  const unit = frame.units.find((u) => u.id === item.units[0]);
  const incident = frame.incidents.find((i) => i.id === item.incidentId);
  const ended = () => {
    if (!incident) return `${item.incidentId} dejó de figurar entre los incidentes`;
    if (incident.status === "open") return null;
    return incident.closedReason === "not_found"
      ? `${incident.id} se cerró sin encontrar a nadie`
      : incident.closedReason === "merged"
        ? `${incident.id} se unió a ${incident.mergedInto}`
        : `${incident.id} quedó resuelto`;
  };
  if (item.kind === "stranded" || item.kind === "loaded") {
    if (item.victimId) {
      if (!unit || unit.victimId !== item.victimId)
        return `${item.victimId} ya no va a bordo de ${item.units[0]}`;
      if (item.kind === "loaded" && unit.mission === "to_hospital")
        return `El coordinador envió ${unit.id} a ${unit.hospitalId}`;
      if (item.kind === "stranded" && !unit.stranded)
        return `${unit.id} recuperó una ruta conocida`;
      return null;
    }
    if (!unit || unit.incidentId !== item.incidentId)
      return `El coordinador retiró ${item.units[0]} de ${item.incidentId}`;
    if (!unit.stranded) return `${unit.id} recuperó una ruta conocida`;
    return ended();
  }
  const closed = ended();
  if (closed) return closed;
  const crews = working(frame, incident!.id);
  if (item.kind === "unreachable") {
    const crew = crews.find(waterOrAir);
    if (crew) return `El coordinador envió ${crew.id} (${unitKind[crew.kind].label.toLowerCase()})`;
    if (!incident!.unreachable && incident!.cutOffIn !== 0)
      return crews.length ? `El coordinador envió ${crews[0].id}` : "Vuelve a haber acceso por carretera";
    return null;
  }
  if (item.kind === "not_found") {
    if (incident!.located) return `Una dotación localizó ${incident!.id}`;
    return crews.length ? `El coordinador envió ${crews[0].id} a buscar de nuevo` : null;
  }
  if (item.kind === "cutoff") {
    if (crews.length) return `El coordinador envió ${crews[0].id}`;
    if (incident!.unreachable) return `El agua aisló ${incident!.id}`;
    if (incident!.cutOffIn === null) return "La previsión del agua ya no lo aísla";
    return null;
  }
  return crews.length ? `El coordinador envió ${crews[0].id}` : null;
}

/** What the panel shows at `tick`: later records and later decisions stay hidden, including how the situation ended. */
export function interventionsAt(
  all: Intervention[],
  tick: number,
  decisions: Record<string, OperatorDecision>,
): InterventionView[] {
  return all
    .filter((item) => item.openedTick <= tick)
    .map((item) => {
      const closed = item.closedTick !== null && item.closedTick <= tick;
      const made = decisions[item.id];
      const decision = made && made.tick <= tick ? made : undefined;
      return {
        ...item,
        closedTick: closed ? item.closedTick : null,
        outcome: closed ? item.outcome : null,
        status: decision ? "decided" : closed ? "expired" : "pending",
        decision,
      };
    });
}

const WAIT: Option = { id: "wait", label: "Mantener a la espera" };
const ESCALATE: Option = { id: "escalate", label: "Escalar a mando" };

/** What an incident needs, as the coordinator knows it: someone to free trapped people, someone to carry. */
function needs(incident: IncidentFrame) {
  const trapped =
    incident.trapped?.value === "yes" ||
    incident.victims.some((v) => v.trapped && v.status === "waiting");
  const carry: UnitKind[] = incident.unreachable
    ? ["rescue", "helicopter"]
    : ["ambulance", "rescue", "helicopter"];
  const free: UnitKind[] = incident.unreachable ? ["rescue"] : ["fire", "rescue"];
  return { trapped, kinds: trapped ? [...new Set([...free, ...carry])] : carry };
}

export function prescribe(
  item: Intervention,
  record: TickRecord,
  meta: RunMeta,
  router: Router,
): Prescription | null {
  const { frame, tick } = record;
  const seconds = meta.config.tickSeconds;
  const time = (ticks: number) => elapsed(Math.max(0, ticks), seconds);
  const incident = frame.incidents.find((i) => i.id === item.incidentId);
  const unit = frame.units.find((u) => u.id === item.units[0]);

  // Beds already spoken for by units heading to each hospital, as the dispatcher counts them.
  const beds = (hospitalId: string) => {
    const site = meta.hospitals.find((h) => h.id === hospitalId)!;
    const occupied = frame.hospitals.find((h) => h.id === hospitalId)?.occupied ?? 0;
    const inbound = frame.units.filter((u) => u.hospitalId === hospitalId).length;
    return site.capacity - occupied - inbound;
  };
  const hospitalsFor = (kind: UnitKind, eta: (node: number) => number, skip?: string | null) =>
    meta.hospitals
      .filter((h) => h.id !== skip && beds(h.id) > 0 && (!UNIT_KINDS[kind].flies || h.helipad))
      .map((h) => ({ id: h.id, eta: eta(h.node) }))
      .filter((h) => h.eta < Infinity)
      .sort((a, b) => a.eta - b.eta);
  const candidates = (target: IncidentFrame, kinds: UnitKind[]) =>
    frame.units
      .filter((u) => isFree(u) && kinds.includes(u.kind))
      .map((u) => ({ unit: u, eta: router.eta(u, target.node) }))
      .filter((x) => x.eta < Infinity)
      .sort((a, b) => a.eta - b.eta);
  const dispatch = (target: IncidentFrame, x: { unit: UnitFrame; eta: number }, label: string): Option => {
    const hospitalId = UNIT_KINDS[x.unit.kind].carries
      ? hospitalsFor(x.unit.kind, (node) => router.etaFrom(x.unit.kind, target.node, node))[0]?.id
      : undefined;
    return {
      id: `dispatch:${x.unit.id}`,
      label,
      detail: `${unitKind[x.unit.kind].label} · llega en ${time(x.eta)}${hospitalId ? ` · luego ${hospitalId}` : ""}`,
      action: {
        type: "dispatch",
        unitId: x.unit.id,
        incidentId: target.id,
        node: target.node,
        hospitalId,
      },
    };
  };
  const transport = (u: UnitFrame, h: { id: string; eta: number }): Option => ({
    id: `transport:${h.id}`,
    label: `Llevar a ${h.id}`,
    detail: `Llega en ${time(h.eta)}`,
    action: { type: "transport", unitId: u.id, hospitalId: h.id },
  });
  // Deadlines: the water forecast when there is one; otherwise how long the victims really have,
  // which the simulation knows and the coordinator does not.
  const victimTtl = (victimId: string | null) =>
    frame.scenes.flatMap((s) => s.victims).find((v) => v.id === victimId)?.ttl ?? null;
  const incidentTtl = (i: IncidentFrame | undefined) => {
    const scene = frame.scenes.find((s) => s.id === i?.sceneId);
    const ttls = (scene?.victims ?? [])
      .filter((v) => v.status === "waiting" && v.ttl !== null)
      .map((v) => v.ttl!);
    return ttls.length ? Math.min(...ttls) : null;
  };
  const deadline = (i: IncidentFrame | undefined) => {
    if (i?.cutOffIn) return { deadlineTick: tick + i.cutOffIn, deadlineSource: "water" as const };
    const ttl = incidentTtl(i);
    return ttl === null
      ? { deadlineTick: null }
      : { deadlineTick: tick + ttl, deadlineSource: "simulation" as const };
  };
  const describe = (i: IncidentFrame) =>
    [
      `P${i.priority}`,
      i.mechanism ? sceneLabel(i.mechanism.value) : "sin mecanismo claro",
      i.located ? "ubicación confirmada" : `ubicación a ±${i.locationErrorM} m`,
      i.trapped?.value === "yes" ? "hay personas atrapadas" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const pick = (i: IncidentFrame, byWater = false) => {
    const { kinds, trapped } = needs(i);
    const units = candidates(i, byWater ? (["rescue", "helicopter"] as UnitKind[]) : kinds);
    // Trapped people need someone who can free them first.
    const freeing = trapped ? units.filter((x) => UNIT_KINDS[x.unit.kind].extricates) : [];
    return { units, first: freeing[0] ?? units[0], trapped };
  };

  if ((item.kind === "stranded" || item.kind === "loaded") && item.victimId && unit) {
    const sites = hospitalsFor(unit.kind, (node) => router.eta(unit, node), unit.hospitalId);
    const ttl = victimTtl(item.victimId);
    const best = sites.find((h) => ttl === null || h.eta <= ttl) ?? sites[0];
    const facts =
      item.kind === "loaded"
        ? `${unit.id} lleva a ${item.victimId} a bordo sin hospital asignado.`
        : `${unit.id} no tiene ruta conocida${unit.hospitalId ? ` hacia ${unit.hospitalId}` : ""} con ${item.victimId} a bordo.`;
    return {
      summary: `${facts}${ttl !== null ? ` Según la simulación, ${item.victimId} aguanta unos ${time(ttl)}.` : ""}`,
      rationale: best
        ? `${best.id} tiene cama${UNIT_KINDS[unit.kind].flies ? " y helipuerto" : ""} y ${unit.id} llega en ${time(best.eta)}.`
        : "Ningún hospital con cama es alcanzable ahora mismo desde su posición.",
      options: best
        ? [
            transport(unit, best),
            ...sites.filter((h) => h !== best).slice(0, 1).map((h) => transport(unit, h)),
            WAIT,
            ESCALATE,
          ]
        : [ESCALATE, WAIT],
      deadlineTick: ttl === null ? null : tick + ttl,
      deadlineSource: ttl === null ? undefined : "simulation",
    };
  }

  if (item.kind === "surge") {
    const queue = unattended(frame).sort((a, b) => a.priority - b.priority);
    return {
      summary: `${queue.length} ${queue.length === 1 ? "incidente urgente espera" : "incidentes urgentes esperan"} sin unidad y no queda ninguna libre.`,
      rationale: queue.length
        ? `El más urgente es ${queue[0].id} (${describe(queue[0])}). La flota actual no cubre la demanda.`
        : "La flota actual no cubre la demanda.",
      options: [
        { id: "reinforce", label: "Solicitar refuerzos externos" },
        { id: "hold", label: "Seguir con la flota actual" },
      ],
      deadlineTick: null,
    };
  }

  if (item.kind === "water") {
    const places = isolatedWaiting(frame);
    const freeUnits = frame.units.filter((u) => isFree(u) && waterOrAir(u));
    return {
      summary: `${places.length} ${places.length === 1 ? "incidente P2–P3 aislado por el agua espera" : "incidentes P2–P3 aislados por el agua esperan"} una unidad acuática o el helicóptero.`,
      rationale: freeUnits.length
        ? `${freeUnits.map((u) => u.id).join(", ")} ${freeUnits.length === 1 ? "está libre" : "están libres"}, pero no alcanzan para todos.`
        : "No queda ninguna unidad acuática ni el helicóptero libres: solo más medios acortan la espera.",
      options: [
        { id: "reinforce", label: "Pedir embarcaciones externas" },
        { id: "hold", label: "Mantener las prioridades actuales" },
      ],
      deadlineTick: null,
    };
  }

  if (item.kind === "fallback")
    return {
      summary: `La IA no respondió en +${time(item.openedTick)} y el despachador por reglas tomó el relevo.${item.note ? ` Error: ${item.note}` : ""}`,
      rationale: "Las reglas mantienen la cobertura mientras la IA no vuelva a responder.",
      options: [
        { id: "continue", label: "Continuar con reglas" },
        { ...ESCALATE, label: "Escalar incidencia técnica" },
      ],
      deadlineTick: null,
    };

  if (item.kind === "rejected")
    return {
      summary: `El motor no aplicó todas las órdenes del coordinador: ${item.note}.`,
      rationale: "El coordinador recibe el rechazo como parte y puede corregirlo en su siguiente decisión.",
      options: [{ id: "ack", label: "Dejar que el coordinador lo corrija" }, ESCALATE],
      deadlineTick: null,
    };

  if (!incident) return null;
  const others = working(frame, incident.id).filter((u) => u.id !== unit?.id);
  const about = `${incident.id} (${describe(incident)})`;

  if (item.kind === "stranded" && unit) {
    const { units, first } = pick(incident);
    const since = tick - item.openedTick;
    const facts = `${unit.id} ${since ? `lleva ${time(since)}` : "se ha quedado"} sin ruta conocida hacia ${about}.${others.length ? ` También va ${others.map((u) => u.id).join(", ")}.` : " Ninguna otra unidad va en camino."}`;
    if (first)
      return {
        summary: facts,
        rationale: `${first.unit.id} (${unitKind[first.unit.kind].label.toLowerCase()}) está libre y tiene camino conocido: llega en ${time(first.eta)}.`,
        options: [
          dispatch(incident, first, `Reasignar ${incident.id} a ${first.unit.id}`),
          ...units.filter((x) => x !== first).slice(0, 1).map((x) => dispatch(incident, x, `Enviar ${x.unit.id}`)),
          { ...WAIT, label: `Mantener ${unit.id} a la espera` },
          ESCALATE,
        ],
        ...deadline(incident),
      };
    return {
      summary: facts,
      rationale: "Ninguna unidad libre tiene un camino conocido hasta allí.",
      options: [{ ...ESCALATE, label: "Pedir medio alternativo" }, { ...WAIT, label: `Mantener ${unit.id} a la espera` }],
      ...deadline(incident),
    };
  }

  if (item.kind === "unreachable") {
    const { units, first } = pick(incident, true);
    const summary = `${about}: ${incident.unreachable ? "ninguna calle conocida llega hasta allí" : "según la previsión, el agua ya ha cortado el acceso"}. Solo el rescate acuático o el helicóptero pueden alcanzarlo.`;
    return first
      ? {
          summary,
          rationale: `${first.unit.id} (${unitKind[first.unit.kind].label.toLowerCase()}) está libre y llega en ${time(first.eta)}.`,
          options: [
            dispatch(incident, first, `Enviar ${first.unit.id} a ${incident.id}`),
            ...units.filter((x) => x !== first).slice(0, 1).map((x) => dispatch(incident, x, `Enviar ${x.unit.id}`)),
            { ...ESCALATE, label: "Pedir embarcaciones externas" },
            WAIT,
          ],
          ...deadline(incident),
        }
      : {
          summary,
          rationale: "No hay ninguna unidad acuática ni el helicóptero libres.",
          options: [{ ...ESCALATE, label: "Pedir embarcaciones externas" }, WAIT],
          ...deadline(incident),
        };
  }

  if (item.kind === "cutoff") {
    const left = incident.cutOffIn ?? 0;
    const { units } = pick(incident);
    const inTime = units.filter((x) => x.eta < left || UNIT_KINDS[x.unit.kind].wades || UNIT_KINDS[x.unit.kind].flies);
    const first = inTime[0];
    const summary = `Según la previsión del agua, ${about} quedará aislado en ${time(left)} y nadie va en camino.`;
    return first
      ? {
          summary,
          rationale: `${first.unit.id} llega en ${time(first.eta)}${first.eta < left ? `, antes de que el agua cierre el paso (margen ${time(left - first.eta)})` : `; ${unitKind[first.unit.kind].label.toLowerCase()} puede llegar aunque el agua cierre el paso`}.`,
          options: [
            dispatch(incident, first, `Enviar ${first.unit.id} ahora`),
            ...inTime.filter((x) => x !== first).slice(0, 1).map((x) => dispatch(incident, x, `Enviar ${x.unit.id}`)),
            { ...ESCALATE, label: "Ordenar evacuación preventiva" },
            WAIT,
          ],
          ...deadline(incident),
        }
      : {
          summary,
          rationale: units.length
            ? `La unidad libre más rápida (${units[0].unit.id}) llegaría en ${time(units[0].eta)}, cuando el paso ya estará cerrado.`
            : "Ninguna unidad libre tiene camino conocido hasta allí.",
          options: [
            { ...ESCALATE, label: "Ordenar evacuación preventiva" },
            ...units.slice(0, 1).map((x) => dispatch(incident, x, `Enviar ${x.unit.id} igualmente`)),
            WAIT,
          ],
          ...deadline(incident),
        };
  }

  if (item.kind === "unassigned") {
    const { units, first, trapped } = pick(incident);
    const summary = `${about} espera sin ninguna unidad asignada y hay unidades libres.`;
    return first
      ? {
          summary,
          rationale: `${first.unit.id} (${unitKind[first.unit.kind].label.toLowerCase()}) llega en ${time(first.eta)}${trapped && UNIT_KINDS[first.unit.kind].extricates ? " y puede liberar a los atrapados" : ""}.`,
          options: [
            dispatch(incident, first, `Enviar ${first.unit.id} a ${incident.id}`),
            ...units.filter((x) => x !== first).slice(0, 1).map((x) => dispatch(incident, x, `Enviar ${x.unit.id}`)),
            { id: "hold", label: "No enviar unidad por ahora" },
            ESCALATE,
          ],
          ...deadline(incident),
        }
      : {
          summary,
          rationale: "Las unidades libres no tienen un camino conocido hasta allí.",
          options: [{ ...ESCALATE, label: "Pedir medio alternativo" }, { id: "hold", label: "No enviar unidad por ahora" }],
          ...deadline(incident),
        };
  }

  if (item.kind === "not_found") {
    const { units, first } = pick(incident);
    const calls = incident.callIds.length;
    const search = first && dispatch(incident, first, `Enviar ${first.unit.id} a buscar en la zona`);
    const wait = { id: "wait-calls", label: "Esperar más llamadas" };
    const close = { id: "close", label: `Cerrar ${incident.id} sin intervención` };
    return {
      summary: `${item.units[0]} llegó al punto indicado de ${about} y no encontró a nadie. ${calls} ${calls === 1 ? "llamada respalda" : "llamadas respaldan"} el aviso.`,
      rationale:
        incident.priority <= 1
          ? `Es P${incident.priority}: si la ubicación era errónea, cada minuto cuenta.${first ? ` ${first.unit.id} llega en ${time(first.eta)}.` : ""}`
          : "Otra llamada suele precisar la ubicación antes de volver a enviar a nadie.",
      options:
        incident.priority <= 1 && search
          ? [search, wait, close, ...units.slice(1, 2).map((x) => dispatch(incident, x, `Enviar ${x.unit.id}`))]
          : [wait, ...(search ? [search] : []), close],
      ...deadline(incident),
    };
  }

  return null;
}

export type Pending = { item: InterventionView; prescription: Prescription };
/** Most urgent first: critical, then the closest deadline, then the oldest. */
export function byUrgency(a: Pending, b: Pending) {
  return (
    Number(b.item.severity === "critical") - Number(a.item.severity === "critical") ||
    (a.prescription.deadlineTick ?? Infinity) - (b.prescription.deadlineTick ?? Infinity) ||
    a.item.openedTick - b.item.openedTick
  );
}
