// Bucle de turno: bandeja de webhooks → [agentes 112: coordinador cada N turnos, triaje de llamadas nuevas] → Coordinador → mover ambulancias → [seguimientos] → Master → fin de turno.
import { greedyCoordinator, type Coordinator } from "./coordinator.js";
import { coordinatorDue, runCoordinator112 } from "./coordinator-112.js";
import { advance, isPunctured, repairTick, type Ambulance } from "./entities/ambulance.js";
import { isDead, tick, type Injured } from "./entities/injured.js";
import { blockedEdges } from "./entities/street-cut.js";
import { placeFollowupCalls, scheduleFollowup } from "./followup.js";
import { drainInbox } from "./inbox.js";
import type { RoadMap } from "./map/road-map.js";
import { triagePending } from "./triage.js";
import { record } from "./recorder.js";
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
  scheduleFollowup(w, map, h); // antes de sacarlo del mundo: aún está en el tablón
  w.injured = w.injured.filter((x) => x !== h);
  w.stats.rescued++;
  a.target = null; // rescate instantáneo: la ambulancia queda libre en el sitio
  logEvent(w, `✅ ${a.id} rescata a ${h.id} en ${map.streetOf(h.position)}`, { type: "rescued", unitId: a.id, injuredId: h.id });
}

/** Cierra el turno: pasa el tiempo a heridos y averías. El contador de turno lo sube `step` tras grabar el registro. */
export function endTurn(w: World) {
  w.injured.forEach(tick);
  for (const h of w.injured.filter(isDead)) {
    w.stats.dead++;
    logEvent(w, `✝ ${h.id} ha muerto`, { type: "died", injuredId: h.id });
    for (const a of w.ambulances) if (a.target === h.id) a.target = null;
  }
  w.injured = w.injured.filter((h) => !isDead(h));
  for (const a of w.ambulances) {
    if (a.repairTurns === 1) logEvent(w, `🔧 ${a.id} reparada`, { type: "repaired", unitId: a.id });
    repairTick(a);
  }
}

export type StepOptions = { coordinator?: Coordinator; master?: Master; agents112?: boolean };

export async function step(w: World, map: RoadMap, { coordinator = greedyCoordinator, master, agents112 = false }: StepOptions = {}) {
  await drainInbox(w, map); // llamadas reales y partes de seguimiento que llegaron por los webhooks
  if (agents112) {
    if (coordinatorDue(w)) await runCoordinator112(w, map).catch((e: Error) => logEvent(w, `⚠️ coordinador 112 falló: ${e.message}`));
    await triagePending(w, map); // toda llamada nueva pasa por el agente antes de asignar ambulancias
  }
  coordinator(w, map);
  moveAmbulances(w, map);
  if (agents112) await placeFollowupCalls(w, map); // a los rescatados que ya toca se les llama; el parte vuelve por POST /followup
  await master?.(w, map);
  endTurn(w);
  record(w, map); // el turno, en el formato del Control Center
  w.turn++;
}
