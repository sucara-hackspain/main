// Coordinador: decide qué ambulancia va a qué herido.
import { SPEED_M_PER_TURN } from "./config.js";
import { isBusy, type Ambulance, type AmbulanceId } from "./entities/ambulance.js";
import type { Injured, InjuredId } from "./entities/injured.js";
import { blockedEdges } from "./entities/street-cut.js";
import type { RoadMap } from "./map/road-map.js";
import { priorityOf, priorityRank } from "./triage.js";
import { findInjured, logEvent, type World } from "./world.js";

export type Coordinator = (w: World, map: RoadMap) => void;

/** Turnos que tarda `a` en llegar a su objetivo actual (null = sin objetivo o sin ruta). */
export function etaTurns(w: World, map: RoadMap, a: Ambulance): number | null {
  const target = a.target && findInjured(w, a.target);
  const path = target && map.shortestPath(a.position, target.position, blockedEdges(w.cuts));
  return path ? Math.ceil(map.pathLength(path) / SPEED_M_PER_TURN) : null;
}

/**
 * Heurística: heridos por prioridad del triaje (critical > high > medium > low) y, a igualdad, ttl ascendente; a cada uno, la ambulancia libre más cercana.
 * Pasada 1 (triaje): solo si llega a tiempo. Pasada 2: las ambulancias que sigan libres, al más cercano aunque no llegue.
 * ponytail: greedy; Hungarian si alguna vez importa la asignación óptima global.
 */
export const greedyCoordinator: Coordinator = (w, map) => {
  const alreadyTargeted = new Set(w.ambulances.map((a) => a.target));
  let free = w.ambulances.filter((a) => !isBusy(a));
  let pending = w.injured.filter((h) => !alreadyTargeted.has(h.id)).sort((x, y) => priorityRank(w, x.id) - priorityRank(w, y.id) || x.ttl - y.ttl);
  if (!free.length || !pending.length) return;

  const blocked = blockedEdges(w.cuts);
  const eta = new Map<AmbulanceId, Map<InjuredId, number>>();
  for (const a of free) {
    const { distance } = map.dijkstra(a.position, pending.map((h) => h.position), blocked);
    eta.set(a.id, new Map(pending.map((h) => [h.id, Math.ceil((distance.get(h.position) ?? Infinity) / SPEED_M_PER_TURN)])));
  }
  const turns = (a: Ambulance, h: Injured) => eta.get(a.id)!.get(h.id)!;

  for (const onlyIfInTime of [true, false]) {
    for (const h of [...pending]) {
      const candidates = free.filter((a) => turns(a, h) < Infinity && (!onlyIfInTime || turns(a, h) <= h.ttl));
      if (!candidates.length) continue;
      const a = candidates.reduce((best, c) => (turns(c, h) < turns(best, h) ? c : best));
      a.target = h.id;
      free = free.filter((x) => x !== a);
      pending = pending.filter((x) => x !== h);
      logEvent(w, `${a.id} → ${h.id} [${priorityOf(w, h.id)}] (eta ${turns(a, h)} turnos, ttl ${h.ttl}${onlyIfInTime ? "" : ", NO llega a tiempo"})`, { type: "dispatch", unitId: a.id, injuredId: h.id, eta: turns(a, h) });
    }
  }
};
