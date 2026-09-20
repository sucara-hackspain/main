import { UNIT_KINDS } from "./engine";
import type { Priority } from "./types";
import type { Frame, IncidentFrame, UnitFrame } from "./trace";

// When the coordinator has to stop and ask a person. The conditions are not in the code: they are a
// catalogue an operator writes (policies/escalation.json), and this desk is what applies it, tick by
// tick, on the same picture the coordinator had. Every request says which policy raised it, so an
// alert can be traced back to the rule that asked for it, and switching a policy off switches its
// alerts off for good.

export const ESCALATION_KINDS = [
  "stranded", "unassigned", "loaded", "surge", "unreachable", "cutoff", "water", "not_found", "fallback", "rejected",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export interface EscalationPolicy {
  /** Stable name the alerts cite: ESC-01. */
  id: string;
  kind: EscalationKind;
  severity: "critical" | "warning";
  title: string;
  /** The condition in words, for whoever decides. The numbers below are what the desk applies. */
  body: string;
  /** Off means this exception never reaches a person. */
  enabled?: boolean;
  /** Ticks the situation must hold before it is worth asking: the coordinator usually fixes it first. */
  afterTicks?: number;
  /** `cutoff`: ask while the water is still this far from closing the way in. */
  withinTicks?: number;
  /** `surge`: urgent incidents with nobody on them for it to count as saturation. */
  minIncidents?: number;
  /** Housekeeping from the editor; the desk ignores them. */
  deleted?: boolean;
  updatedAt?: string;
}

/** One exception standing open, as of the tick it is written on. */
export interface EscalationRequest {
  id: string;
  /** The policy that asked for it. */
  policyId: string;
  kind: EscalationKind;
  severity: "critical" | "warning";
  openedTick: number;
  /** Set on the tick the situation ended by itself, without anybody deciding. */
  closedTick: number | null;
  outcome: string | null;
  title: string;
  incidentId: string | null;
  /** The blocked, loaded or searching unit. */
  units: string[];
  victimId: string | null;
  /** What the record showed when it opened. */
  note?: string;
}

const DEFAULTS: Record<EscalationKind, Pick<EscalationPolicy, "afterTicks" | "withinTicks" | "minIncidents">> = {
  stranded: {}, unassigned: { afterTicks: 3 }, loaded: { afterTicks: 2 }, surge: { afterTicks: 3, minIncidents: 2 },
  unreachable: { afterTicks: 3 }, cutoff: { afterTicks: 3, withinTicks: 20 }, water: { afterTicks: 3 },
  not_found: {}, fallback: {}, rejected: {},
};
/** Ticks of calm before a saturation or a stretch of isolated places counts as over. */
const CALM_TICKS = 3;
/** A rejected order is news for this long; after that the coordinator has had time to take it in. */
const NOTICE_TICKS = 10;

/** The catalogue the engine ships with: every exception it knows how to raise, switched on. */
export const DEFAULT_ESCALATION: EscalationPolicy[] = [
  { id: "ESC-01", kind: "stranded", severity: "critical", title: "Unidad bloqueada durante una intervención",
    body: "Solicitar una decisión humana cuando una unidad quede sin ruta conocida y tenga una víctima a bordo o se dirija a una incidencia abierta." },
  { id: "ESC-02", kind: "unassigned", severity: "critical", afterTicks: 3, title: "Incidencia urgente sin unidad asignada",
    body: "Escalar si una incidencia P0 o P1 permanece sin una dotación trabajando en ella durante tres registros consecutivos, pese a existir unidades libres." },
  { id: "ESC-03", kind: "loaded", severity: "critical", afterTicks: 2, title: "Víctima a bordo sin hospital de destino",
    body: "Escalar cuando una unidad con una víctima a bordo esté sin misión de traslado durante dos registros consecutivos, sin estar averiada ni bloqueada." },
  { id: "ESC-04", kind: "surge", severity: "critical", afterTicks: 3, minIncidents: 2, title: "Demanda urgente superior a los recursos disponibles",
    body: "Pedir una decisión humana cuando dos o más incidencias P0 o P1 estén sin atender y no haya unidades libres durante tres registros consecutivos." },
  { id: "ESC-05", kind: "fallback", severity: "warning", title: "El agente deja de estar disponible",
    body: "Escalar cuando el coordinador recurra al sistema de reglas de respaldo por un fallo de la IA. Mostrar el error registrado para que el operador revise la continuidad de la respuesta." },
  { id: "ESC-06", kind: "rejected", severity: "warning", title: "Una orden no puede ejecutarse",
    body: "Solicitar revisión humana cuando el motor rechace una orden. Presentar la acción propuesta, la unidad afectada y el motivo del rechazo." },
  { id: "ESC-07", kind: "unreachable", severity: "critical", afterTicks: 3, title: "Incidencia urgente que solo alcanzan el agua o el aire",
    body: "Escalar cuando una incidencia P0 o P1 sin ruta por carretera, o ya aislada por el agua, siga tres registros sin rescate acuático ni helicóptero trabajando en ella." },
  { id: "ESC-08", kind: "cutoff", severity: "critical", afterTicks: 3, withinTicks: 20, title: "El agua va a aislar una incidencia sin unidad",
    body: "Pedir una decisión cuando la previsión del agua deje menos de veinte registros de acceso a una incidencia abierta y nadie vaya de camino durante tres registros." },
  { id: "ESC-09", kind: "water", severity: "warning", afterTicks: 3, title: "Zonas menos urgentes aisladas sin unidad acuática",
    body: "Escalar una sola vez, como decisión de reparto, cuando queden incidencias P2 o P3 aisladas por el agua sin rescate acuático ni helicóptero durante tres registros." },
  { id: "ESC-10", kind: "not_found", severity: "warning", title: "La dotación no encuentra a nadie",
    body: "Solicitar revisión humana cuando una dotación llegue al lugar indicado por los avisos y no haya nadie, con la incidencia todavía abierta." },
];

/** Reads a catalogue written by hand: anything that is not a usable policy is dropped, with its reason. */
export function parseEscalationPolicies(data: unknown): { policies: EscalationPolicy[]; skipped: string[] } {
  const skipped: string[] = [];
  if (!Array.isArray(data)) return { policies: [], skipped: ["el catálogo no es una lista"] };
  const policies: EscalationPolicy[] = [];
  const positive = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
  for (const raw of data as EscalationPolicy[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const why = !id ? "sin identificador"
      : !ESCALATION_KINDS.includes(raw.kind) ? `situación desconocida (${raw.kind})`
      : raw.severity !== "critical" && raw.severity !== "warning" ? `prioridad desconocida (${raw.severity})`
      : typeof raw.title !== "string" || !raw.title.trim() ? "sin título"
      : typeof raw.body !== "string" || !raw.body.trim() ? "sin condición escrita"
      : !positive(raw.afterTicks) || !positive(raw.withinTicks) || !positive(raw.minIncidents) ? "umbrales no numéricos"
      : policies.some((p) => p.id === id) ? "identificador repetido" : "";
    if (why) skipped.push(`${id || "(sin id)"}: ${why}`);
    else policies.push(raw);
  }
  return { policies, skipped };
}

const free = (u: UnitFrame) =>
  !u.victimId && !u.broken && !u.stranded && u.mission !== "to_scene" && u.mission !== "to_observe";
const working = (frame: Frame, incidentId: string | null) =>
  frame.units.filter((u) => u.incidentId === incidentId && !u.broken);
const waterOrAir = (u: UnitFrame) => UNIT_KINDS[u.kind].wades || UNIT_KINDS[u.kind].flies;
/** Already cut off: no known street gets there, or the forecast says the water closed it. */
const isolated = (i: IncidentFrame) => i.unreachable || i.cutOffIn === 0;
/** Open P0/P1 incidents nobody is working on. */
export const unattended = (frame: Frame) =>
  frame.incidents.filter((i) => i.status === "open" && i.priority <= 1 && working(frame, i.id).length === 0);
/** Open P2/P3 incidents the water has cut off, with no water or air unit on them. */
export const isolatedWaiting = (frame: Frame) =>
  frame.incidents.filter((i) => i.status === "open" && i.priority >= 2 && isolated(i) && !working(frame, i.id).some(waterOrAir));

export interface DeskInput {
  tick: number;
  frame: Frame;
  /** Crews finding nobody, orders the engine refused, victims lost: the tick as it was reported. */
  events: { type: string; [key: string]: unknown }[];
  /** Whether the agent decided this tick, or the rules had to step in for it. */
  decisionSource?: "llm" | "fallback" | "rules";
  /** Why the agent did not answer, for the operator to read. */
  decisionError?: string;
}

/**
 * Applies the catalogue to each tick and hands back the requests that opened or closed on it.
 * It keeps what has to persist between ticks (how long a situation has been standing), so one desk
 * belongs to one run. A situation that resolves itself is closed here with what happened: the
 * operator is never asked about something the coordinator already sorted out.
 */
export class EscalationDesk {
  private readonly byKind = new Map<EscalationKind, EscalationPolicy>();
  private readonly open = new Map<string, EscalationRequest>();
  private readonly loadedSince = new Map<string, number>();
  private readonly standing = new Map<string, number>();
  private hot = 0;
  private calm = 0;
  private surgeDeaths = 0;
  private wet = 0;
  private dry = 0;

  constructor(readonly policies: EscalationPolicy[] = DEFAULT_ESCALATION) {
    // The first live policy for each kind decides; the rest of the catalogue is there to be read.
    for (const policy of policies) {
      if (policy.deleted || policy.enabled === false || this.byKind.has(policy.kind)) continue;
      this.byKind.set(policy.kind, policy);
    }
  }

  private after(kind: EscalationKind): number {
    const policy = this.byKind.get(kind);
    return policy?.afterTicks ?? DEFAULTS[kind].afterTicks ?? 1;
  }

  review(input: DeskInput): EscalationRequest[] {
    const { tick, frame, events } = input;
    const changed: EscalationRequest[] = [];
    const queue = unattended(frame);
    const surge = this.byKind.get("surge");
    const saturated = queue.length >= (surge?.minIncidents ?? DEFAULTS.surge.minIncidents!) && !frame.units.some(free);

    const start = (key: string, kind: EscalationKind, item: Omit<EscalationRequest, "id" | "policyId" | "kind" | "severity" | "closedTick" | "outcome">) => {
      const policy = this.byKind.get(kind);
      if (!policy || this.open.has(key)) return;
      // One request per incident at a time: the most specific one, opened first, stands.
      // A victim on board is its own matter, whatever incident it came from.
      if (item.incidentId && !item.victimId && [...this.open.values()].some((x) => x.incidentId === item.incidentId && !x.victimId)) return;
      const request: EscalationRequest = { ...item, id: `${key}:${item.openedTick}`, policyId: policy.id, kind, severity: policy.severity, closedTick: null, outcome: null };
      this.open.set(key, request);
      changed.push(request);
    };

    for (const [key, item] of this.open) {
      let outcome: string | null = null;
      if (item.kind === "surge") {
        this.surgeDeaths += events.filter((e) => e.type === "victim_died").length;
        this.calm = saturated ? 0 : this.calm + 1;
        if (queue.length === 0 || this.calm >= CALM_TICKS)
          outcome = this.surgeDeaths
            ? `La saturación terminó con ${this.surgeDeaths} ${this.surgeDeaths === 1 ? "fallecido" : "fallecidos"}`
            : "La demanda urgente volvió a quedar cubierta sin fallecidos";
      } else if (item.kind === "water") {
        this.dry = isolatedWaiting(frame).length ? 0 : this.dry + 1;
        if (this.dry >= CALM_TICKS) outcome = "Las zonas aisladas ya tienen una unidad acuática o se resolvieron";
      } else if (item.kind === "fallback") {
        if (input.decisionSource === "llm") outcome = "La IA volvió a decidir";
      } else if (item.kind === "rejected") {
        if (tick >= item.openedTick + NOTICE_TICKS) outcome = "El coordinador recibió el rechazo y siguió operando";
      } else outcome = settled(item, frame);
      if (outcome) {
        item.closedTick = tick;
        item.outcome = outcome;
        this.open.delete(key);
        changed.push(item);
      }
    }

    for (const u of frame.units) {
      const incident = frame.incidents.find((i) => i.id === u.incidentId);
      if (u.stranded && (u.victimId || incident?.status === "open"))
        start(`stranded:${u.id}:${u.victimId ?? u.incidentId}`, "stranded", {
          openedTick: tick, incidentId: u.incidentId, units: [u.id], victimId: u.victimId,
          title: u.victimId ? `${u.id} bloqueada con ${u.victimId} a bordo` : `${u.id} sin ruta conocida hacia ${u.incidentId}`,
        });
      const key = `${u.id}:${u.victimId}`;
      if (u.victimId && u.mission === "idle" && !u.broken && !u.stranded) {
        const since = this.loadedSince.get(key) ?? tick;
        this.loadedSince.set(key, since);
        if (tick - since + 1 >= this.after("loaded"))
          start(`loaded:${key}`, "loaded", {
            openedTick: tick, incidentId: u.incidentId, units: [u.id], victimId: u.victimId,
            title: `${u.id} con ${u.victimId} a bordo y sin hospital`,
          });
      } else this.loadedSince.delete(key);
    }

    const anyFree = frame.units.some(free);
    const cutoffWithin = this.byKind.get("cutoff")?.withinTicks ?? DEFAULTS.cutoff.withinTicks!;
    const seen = new Set<string>();
    for (const incident of frame.incidents) {
      if (incident.status !== "open") continue;
      const crews = working(frame, incident.id);
      // Less urgent isolated places go to one shared request (below); urgent ones get their own.
      const cutOff = isolated(incident);
      const kind: EscalationKind | null =
        cutOff && !crews.some(waterOrAir)
          ? incident.priority <= 1 ? "unreachable" : null
          : !cutOff && incident.cutOffIn !== null && incident.cutOffIn <= cutoffWithin && crews.length === 0
            ? "cutoff"
            : incident.priority <= 1 && crews.length === 0 && anyFree
              ? "unassigned"
              : null;
      if (!kind) continue;
      // The coordinator usually acts within a tick or two: only what it leaves standing reaches a person.
      const key = `${kind}:${incident.id}`;
      seen.add(key);
      const since = this.standing.get(key) ?? tick;
      this.standing.set(key, since);
      if (tick - since + 1 < this.after(kind)) continue;
      start(key, kind, {
        openedTick: tick, incidentId: incident.id, units: [], victimId: null,
        title:
          kind === "unreachable"
            ? incident.unreachable ? `${incident.id} sin acceso por carretera` : `El agua ha aislado ${incident.id}`
            : kind === "cutoff"
              ? `El agua va a aislar ${incident.id}`
              : `${incident.id} (P${incident.priority as Priority}) sin unidad asignada`,
      });
    }
    for (const key of this.standing.keys()) if (!seen.has(key)) this.standing.delete(key);

    for (const e of events) {
      if (e.type !== "scene_not_found" || typeof e.incidentId !== "string") continue;
      const incident = frame.incidents.find((i) => i.id === e.incidentId);
      if (incident?.status !== "open") continue;
      start(`not_found:${e.incidentId}`, "not_found", {
        openedTick: tick, incidentId: e.incidentId as string, units: [String(e.unitId)], victimId: null,
        title: `${e.unitId} no encuentra a nadie en ${e.incidentId}`,
      });
    }

    if (!this.open.has("water")) {
      this.wet = isolatedWaiting(frame).length ? this.wet + 1 : 0;
      if (this.wet >= this.after("water")) {
        start("water", "water", { openedTick: tick, incidentId: null, units: [], victimId: null, title: "Zonas aisladas por el agua sin unidad acuática" });
        this.wet = this.dry = 0;
      }
    }
    if (!this.open.has("surge")) {
      this.hot = saturated ? this.hot + 1 : 0;
      if (this.hot >= this.after("surge")) {
        start("surge", "surge", { openedTick: tick, incidentId: null, units: [], victimId: null, title: "Saturación: incidentes urgentes sin unidad" });
        this.hot = this.calm = this.surgeDeaths = 0;
      }
    }
    if (input.decisionSource === "fallback")
      start("fallback", "fallback", { openedTick: tick, incidentId: null, units: [], victimId: null, title: "IA no disponible: deciden las reglas", note: input.decisionError });
    const rejected = events.filter((e) => e.type === "action_rejected");
    if (rejected.length)
      start(`rejected:${tick}`, "rejected", {
        openedTick: tick, incidentId: null, victimId: null,
        units: [...new Set(rejected.map((e) => String((e.action as { unitId?: string })?.unitId ?? "")).filter(Boolean))],
        title: rejected.length === 1 ? "El motor rechazó una orden" : `El motor rechazó ${rejected.length} órdenes`,
        note: rejected.map((e) => String(e.reason ?? "sin motivo")).join("; "),
      });
    return changed;
  }
}

/** How the tick settled a request on its own, or null while it still stands. Mirrors what the
 * Control Center used to work out for itself, so nothing an operator saw before changes meaning. */
function settled(item: EscalationRequest, frame: Frame): string | null {
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
      if (!unit || unit.victimId !== item.victimId) return `${item.victimId} ya no va a bordo de ${item.units[0]}`;
      if (item.kind === "loaded" && unit.mission === "to_hospital") return `El coordinador envió ${unit.id} a ${unit.hospitalId}`;
      if (item.kind === "stranded" && !unit.stranded) return `${unit.id} recuperó una ruta conocida`;
      return null;
    }
    if (!unit || unit.incidentId !== item.incidentId) return `El coordinador retiró ${item.units[0]} de ${item.incidentId}`;
    if (!unit.stranded) return `${unit.id} recuperó una ruta conocida`;
    return ended();
  }
  const closed = ended();
  if (closed) return closed;
  const crews = working(frame, incident!.id);
  if (item.kind === "unreachable") {
    const crew = crews.find(waterOrAir);
    if (crew) return `El coordinador envió ${crew.id} (${UNIT_KINDS[crew.kind].label})`;
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
