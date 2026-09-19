import type { GraphData } from "../../gabriel/src/engine/types";
import type {
  AmbulanceFrame as EngineAmbulanceFrame,
  RunMeta,
  TickRecord as EngineTickRecord,
} from "../../gabriel/src/engine/trace";
export type { GraphData, RunMeta };

// Operational fields supplied by the data service. Optional so older recordings
// remain readable; their absence must never be treated as proof of availability.
export type AmbulanceFrame = EngineAmbulanceFrame & {
  busyUntil?: number;
  brokenUntil?: number | null;
  /** Travel only; loading, unloading and repair are separate. */
  etaTicks?: number | null;
};
export type TickRecord = Omit<EngineTickRecord, "frame"> & {
  frame: Omit<EngineTickRecord["frame"], "ambulances" | "patients"> & {
    ambulances: AmbulanceFrame[];
    patients: (EngineTickRecord["frame"]["patients"][number] & {
      spawnTick?: number;
      pickupTick?: number | null;
    })[];
  };
};
export const elapsed = (tick: number, seconds: number) => {
  const n = Math.floor(tick * seconds);
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};
export const patientStatus = {
  waiting: "Esperando atención",
  in_ambulance: "En traslado",
  delivered: "En hospital",
  dead: "Fallecido",
};
export function unitStatus(a: AmbulanceFrame) {
  if (a.broken) return "Averiada";
  if (a.stranded) return "Sin ruta abierta";
  if (a.mission === "to_patient") return "Hacia paciente";
  if (a.mission === "to_hospital") return "Hacia hospital";
  if (a.patientId) return "Paciente a bordo";
  if (a.mission === "reposition") return "Reubicándose";
  return "Sin misión"; // An idle mission alone is not proof of availability.
}
export function assertRunRecords(records: TickRecord[]) {
  for (const r of records) {
    if (
      !Number.isInteger(r.tick) ||
      !r.frame ||
      !Array.isArray(r.frame.ambulances) ||
      !Array.isArray(r.frame.patients) ||
      !Array.isArray(r.events) ||
      !Array.isArray(r.actions)
    )
      throw new Error(
        "Formato de registros de actividad no válido.",
      );
  }
}
