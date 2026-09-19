// Acciones sobre el mundo: las que ejecuta el Master (IA o humano por CLI).
import { CUT_RADIUS_M } from "./config.js";
import { puncture, type AmbulanceId } from "./entities/ambulance.js";
import { createInjured, type Injured } from "./entities/injured.js";
import { planStreetCut } from "./entities/street-cut.js";
import type { NodeId } from "./map/graph.js";
import type { RoadMap } from "./map/road-map.js";
import { logEvent, type World } from "./world.js";

export function spawnInjured(w: World, map: RoadMap, position: NodeId, ttl: number): Injured {
  const h = createInjured(`H${w.nextInjuredId++}`, position, ttl);
  w.injured.push(h);
  logEvent(w, `🆘 herido ${h.id} en ${map.streetOf(position)} (ttl ${ttl})`);
  return h;
}

/** Corta `street`: entera, o solo los tramos a menos de `radius` m de `near`. Devuelve tramos cortados. */
export function cutStreet(w: World, map: RoadMap, street: string, near?: NodeId, radius = CUT_RADIUS_M): number {
  const cuts = planStreetCut(map, w.cuts, street, near, near === undefined ? Infinity : radius);
  w.cuts.push(...cuts);
  if (cuts.length) logEvent(w, `🚧 calle cortada: ${street} (${cuts.length} tramos)`);
  return cuts.length;
}

export function punctureAmbulance(w: World, id: AmbulanceId): boolean {
  const a = w.ambulances.find((x) => x.id === id);
  if (!a) return false;
  puncture(a);
  logEvent(w, `💥 ${a.id} pinchada, parada ${a.repairTurns} turnos`);
  return true;
}
