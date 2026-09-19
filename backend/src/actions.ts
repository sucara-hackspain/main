// Acciones sobre el mundo: las que ejecuta el Master (IA o humano por CLI).
import { CUT_RADIUS_M } from "./config.js";
import { puncture, type AmbulanceId } from "./entities/ambulance.js";
import { createInjured, type Injured } from "./entities/injured.js";
import { planStreetCut } from "./entities/street-cut.js";
import type { NodeId } from "./map/graph.js";
import type { RoadMap } from "./map/road-map.js";
import type { Call } from "./triage.js";
import { logEvent, type World } from "./world.js";

export function spawnInjured(w: World, map: RoadMap, position: NodeId, ttl: number, call?: Call): Injured {
  const h = createInjured(`H${w.nextInjuredId++}`, position, ttl);
  // La llamada lleva el id del herido: el tablón de triaje apunta a heridos. Sin llamada real, una sintética para el registro y el triaje.
  const c: Call = call ? { ...call, id: h.id, tick: w.turn, node: position } : callFromInjured(w, map, h);
  if (call) h.call = c;
  w.injured.push(h);
  logEvent(w, `🆘 herido ${h.id} en ${map.streetOf(position)} (ttl ${ttl})${call ? `: ${call.text}` : ""}`, { type: "call", injuredId: h.id, call: c });
  return h;
}

/** Llamada sintética para un herido que puso el Master o la CLI. ponytail: el ttl del Master se traduce en "respira mal" o no. */
export const callFromInjured = (w: World, map: RoadMap, h: Injured): Call => ({
  id: h.id, tick: w.turn, caller: "bystander", mechanism: null, node: h.position, locationErrorM: 100, street: map.streetOf(h.position),
  conscious: "yes", breathing: h.ttl <= 8 ? "difficult" : "normal", bleeding: "unknown", trapped: "unknown", ageGroup: "unknown", victims: 1,
  text: `Herido en ${map.streetOf(h.position)}, ${h.ttl <= 8 ? "muy grave" : "estable"} según quien llama.`,
  phone: null,
});

/** Corta `street`: entera, o solo los tramos a menos de `radius` m de `near`. Devuelve tramos cortados. */
export function cutStreet(w: World, map: RoadMap, street: string, near?: NodeId, radius = CUT_RADIUS_M): number {
  const cuts = planStreetCut(map, w.cuts, street, near, near === undefined ? Infinity : radius);
  w.cuts.push(...cuts);
  if (cuts.length) logEvent(w, `🚧 calle cortada: ${street} (${cuts.length} tramos)`, { type: "cut", street, edges: cuts.map((c) => [c.u, c.v]) });
  return cuts.length;
}

export function punctureAmbulance(w: World, id: AmbulanceId): boolean {
  const a = w.ambulances.find((x) => x.id === id);
  if (!a) return false;
  puncture(a);
  logEvent(w, `💥 ${a.id} pinchada, parada ${a.repairTurns} turnos`, { type: "punctured", unitId: a.id, turns: a.repairTurns });
  return true;
}
