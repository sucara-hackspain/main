import { PUNCTURE_REPAIR_TURNS, SPEED_M_PER_TURN } from "../config.js";
import type { NodeId } from "../map/graph.js";
import type { RoadMap } from "../map/road-map.js";
import type { Base } from "./base.js";
import type { InjuredId } from "./injured.js";

export type AmbulanceId = string;

export type Ambulance = {
  id: AmbulanceId;
  position: NodeId;
  target: InjuredId | null; // destino: herido asignado
  repairTurns: number; // > 0 = pinchada, turnos que le quedan parada
};

export type AmbulanceStatus = "libre" | "en ruta" | "pinchada";

export const createAmbulances = (count: number, base: Base): Ambulance[] =>
  Array.from({ length: count }, (_, i) => ({ id: `A${i + 1}`, position: base.position, target: null, repairTurns: 0 }));

export const isPunctured = (a: Ambulance) => a.repairTurns > 0;
export const isBusy = (a: Ambulance) => a.target !== null || isPunctured(a); // "ocupada"
export const statusOf = (a: Ambulance): AmbulanceStatus => (isPunctured(a) ? "pinchada" : a.target ? "en ruta" : "libre");

export function puncture(a: Ambulance) {
  a.repairTurns = PUNCTURE_REPAIR_TURNS;
  a.target = null; // se libera el herido para que el coordinador lo reasigne
}

export function repairTick(a: Ambulance) {
  if (a.repairTurns > 0) a.repairTurns--;
}

/** Avanza por `path` (que empieza en su posición) hasta SPEED_M_PER_TURN metros. */
export function advance(a: Ambulance, path: NodeId[], map: RoadMap) {
  // ponytail: avanza nodo a nodo sin progreso intra-arista; siempre al menos un nodo para no bloquearse en aristas largas
  let budget = SPEED_M_PER_TURN, i = 0;
  for (; i < path.length - 1; i++) {
    const meters = map.edgeLength(path[i], path[i + 1]);
    if (i > 0 && meters > budget) break;
    budget -= meters;
  }
  a.position = path[i];
}
