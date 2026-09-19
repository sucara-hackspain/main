// Coordinador 112 (HappyRobot): cada N turnos genera una tanda de llamadas simuladas que entran al mundo como heridos.
import { COORDINATOR_EVERY_TURNS, COORDINATOR_NODE, COORDINATOR_WORKFLOW, SCENARIO } from "./config.js";
import { runWorkflow } from "./happyrobot.js";
import type { RoadMap } from "./map/road-map.js";
import { admitCall, CallSchema } from "./triage.js";
import { logEvent, type World } from "./world.js";

export const coordinatorDue = (w: World) => w.turn % COORDINATOR_EVERY_TURNS === 0;

/** Una ejecución = una llamada por iteración de su bucle. Se envía `ticks`, pero hoy el bucle del workflow va fijo a 5. */
export async function runCoordinator112(w: World, map: RoadMap) {
  const calls = await runWorkflow<unknown>(COORDINATOR_WORKFLOW, { ticks: COORDINATOR_EVERY_TURNS, scenario: SCENARIO }, COORDINATOR_NODE);
  logEvent(w, `☎️ coordinador 112: ${calls.length} llamadas nuevas`);
  for (const raw of calls) admitCall(w, map, CallSchema.parse(raw));
}
