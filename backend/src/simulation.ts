// Bucle de turno: Coordinador → mover ambulancias → Master → fin de turno.
import { greedyCoordinator, type Coordinator } from "./coordinator.js";
import { advance, isPunctured, repairTick, type Ambulance } from "./entities/ambulance.js";
import { isDead, tick, type Injured } from "./entities/injured.js";
import { blockedEdges } from "./entities/street-cut.js";
import type { RoadMap } from "./map/road-map.js";
import { findInjured, logEvent, type World } from "./world.js";

/** El Master perturba el mundo (cortes, heridos, pinchazos). Puede ser una IA o nadie. */
export type Master = (w: World, map: RoadMap) => Promise<void>;

export function moveAmbulances(w: World, map: RoadMap) {
  const blocked = blockedEdges(w.cuts);
  for (const a of w.ambulances) {
    if (isPunctured(a) || !a.target) continue;
    const target = findInjured(w, a.target);
    if (!target) { a.target = null; continue; }
    const path = map.shortestPath(a.position, target.position, blocked);
    if (!path) {
      logEvent(w, `${a.id}: sin ruta a ${target.id}, objetivo liberado`);
      a.target = null;
      continue;
    }
    advance(a, path, map);
    if (a.position === target.position) rescue(w, map, a, target);
  }
}

function rescue(w: World, map: RoadMap, a: Ambulance, h: Injured) {
  w.injured = w.injured.filter((x) => x !== h);
  w.stats.rescued++;
  a.target = null; // rescate instantáneo: la ambulancia queda libre en el sitio
  logEvent(w, `✅ ${a.id} rescata a ${h.id} en ${map.streetOf(h.position)}`);
}

export function endTurn(w: World) {
  w.injured.forEach(tick);
  for (const h of w.injured.filter(isDead)) {
    w.stats.dead++;
    logEvent(w, `✝ ${h.id} ha muerto`);
    for (const a of w.ambulances) if (a.target === h.id) a.target = null;
  }
  w.injured = w.injured.filter((h) => !isDead(h));
  w.ambulances.forEach(repairTick);
  w.turn++;
}

export async function step(w: World, map: RoadMap, { coordinator = greedyCoordinator, master }: { coordinator?: Coordinator; master?: Master } = {}) {
  coordinator(w, map);
  moveAmbulances(w, map);
  await master?.(w, map);
  endTurn(w);
}
