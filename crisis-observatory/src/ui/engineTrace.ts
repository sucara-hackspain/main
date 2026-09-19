import type {
  Action,
  Call,
  CaseEntry,
  Focus,
  GraphData,
  LonLat,
  ObservedEvent,
  Priority,
  Triage,
  UnitKind,
} from "../../../gabriel/src/engine/types";
import type {
  Frame,
  IncidentFrame,
  RunMeta,
  SceneFrame,
  TickRecord,
  UnitFrame,
} from "../../../gabriel/src/engine/trace";
import { UNIT_KINDS } from "../../../gabriel/src/engine/engine";
import { INJURIES, SCENES } from "../../../gabriel/src/engine/victims";

// The run format the engine in ../gabriel writes (units, scenes, incidents, water), as the UI reads it.

export type {
  Action,
  Call,
  CaseEntry,
  Focus,
  Frame,
  GraphData,
  IncidentFrame,
  LonLat,
  ObservedEvent,
  Priority,
  RunMeta,
  SceneFrame,
  TickRecord,
  Triage,
  UnitFrame,
  UnitKind,
};
/** Ticks as a clock since the start of the run: 00:05:30. */
export const elapsed = (tick: number, seconds: number) => {
  const n = Math.floor(tick * seconds);
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};
/** What each kind of unit can do: carries, extricates, wades, flies. */
export { UNIT_KINDS };

export const unitKind: Record<UnitKind, { label: string; plural: string }> = {
  ambulance: { label: "Ambulancia", plural: "Ambulancias" },
  fire: { label: "Bomberos", plural: "Bomberos" },
  rescue: { label: "Rescate acuático", plural: "Rescate acuático" },
  helicopter: { label: "Helicóptero", plural: "Helicópteros" },
  drone: { label: "Dron", plural: "Drones" },
};
export const sceneLabel = (kind: keyof typeof SCENES) => SCENES[kind].label;
export const injuryLabel = (kind: keyof typeof INJURIES) => INJURIES[kind].label;

/** 0 = life at risk right now ... 3 = can wait. Deduced by the coordinator from what callers said. */
export const priority: Record<Priority, { label: string; tone: "danger" | "warning" | "info" | "neutral" }> = {
  0: { label: "Riesgo vital", tone: "danger" },
  1: { label: "Urgente", tone: "warning" },
  2: { label: "Demorable", tone: "info" },
  3: { label: "Leve", tone: "neutral" },
};
export const triageLabel: Record<Triage, string> = {
  red: "Rojo",
  yellow: "Amarillo",
  green: "Verde",
  black: "Negro",
};
export const victimStatus = {
  waiting: "Esperando",
  in_ambulance: "En traslado",
  delivered: "En hospital",
  treated: "Atendida en el lugar",
  dead: "Fallecida",
};

export function unitStatus(u: UnitFrame): string {
  if (u.broken) return "Averiada";
  if (u.stranded) return `Sin ruta conocida${u.incidentId ? ` hacia ${u.incidentId}` : ""}`;
  if (u.mission === "to_scene") return `Hacia ${u.incidentId ?? "su destino"}`;
  if (u.mission === "to_hospital") return `Traslado a ${u.hospitalId}`;
  if (u.victimId) return "Víctima a bordo, sin destino";
  if (u.mission === "reposition") return "Reubicándose";
  if (u.mission === "to_observe") return `Reconociendo${u.incidentId ? ` ${u.incidentId}` : ""}`;
  // The frame has no busyUntil: idle alone is not proof of availability.
  return "Sin misión";
}

/** Units the coordinator could send now: nothing on board, not broken, not stuck, not on a call. */
export const isFree = (u: UnitFrame) =>
  !u.victimId && !u.broken && !u.stranded && u.mission !== "to_scene" && u.mission !== "to_observe";

export type EntityKind = "incident" | "unit" | "hospital" | "scene";
export type Selection = { kind: EntityKind; id: string };
export const sameSelection = (a: Selection | null, b: Selection | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

/** A selection whose entity is not in this record (a closed incident dropped from the frame) no longer holds. */
export function selectionExists(
  selection: Selection,
  record: TickRecord | undefined,
  meta: RunMeta | null,
) {
  if (!record || !meta) return false;
  const { frame } = record;
  if (selection.kind === "unit") return frame.units.some((u) => u.id === selection.id);
  if (selection.kind === "incident")
    return frame.incidents.some((i) => i.id === selection.id);
  if (selection.kind === "scene") return frame.scenes.some((s) => s.id === selection.id);
  return meta.hospitals.some((h) => h.id === selection.id);
}

export function selectionPosition(
  selection: Selection,
  record: TickRecord,
  meta: RunMeta,
  graph: GraphData,
): LonLat | undefined {
  const { frame } = record;
  if (selection.kind === "unit")
    return frame.units.find((u) => u.id === selection.id)?.pos;
  const node =
    selection.kind === "incident"
      ? frame.incidents.find((i) => i.id === selection.id)?.node
      : selection.kind === "scene"
        ? frame.scenes.find((s) => s.id === selection.id)?.node
        : meta.hospitals.find((h) => h.id === selection.id)?.node;
  return node === undefined ? undefined : graph.nodes[node];
}

export function assertEngineRecords(
  records: unknown,
): asserts records is TickRecord[] {
  if (!Array.isArray(records))
    throw new Error("Formato de registros de actividad no válido.");
  for (const r of records) {
    if (r?.frame && Array.isArray(r.frame.ambulances))
      throw new Error(
        "Esta ejecución usa el formato anterior de ambulancias y pacientes. Control Center lee ahora el modelo de unidades e incidentes: genera una nueva con npm run data:local.",
      );
    if (
      !r ||
      !Number.isInteger(r.tick) ||
      !r.frame ||
      !Array.isArray(r.frame.units) ||
      !Array.isArray(r.frame.scenes) ||
      !Array.isArray(r.frame.incidents) ||
      !Array.isArray(r.frame.closedEdges) ||
      !Array.isArray(r.events) ||
      !Array.isArray(r.actions)
    )
      throw new Error("Formato de registros de actividad no válido.");
  }
}
