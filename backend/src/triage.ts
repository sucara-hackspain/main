// Agente de triaje 112 (HappyRobot): cada llamada es una ejecución que devuelve el tablón de incidentes con prioridades.
import { z } from "zod";
import { callFromInjured, spawnInjured } from "./actions.js";
import { TRIAGE_NODE, TRIAGE_WORKFLOW, TTL_BY_PRIORITY } from "./config.js";
import type { Injured, InjuredId } from "./entities/injured.js";
import { runWorkflow } from "./happyrobot.js";
import type { RoadMap } from "./map/road-map.js";
import { findInjured, logEvent, type World } from "./world.js";

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Llamada al 112 tal como la registra el operador (teléfono real, simulador o derivada de un herido del Master). Tolerante: la escribe una IA. */
export const CallSchema = z.object({
  id: z.string().catch("?"),
  tick: z.coerce.number().catch(0),
  caller: z.string().catch("bystander"),
  mechanism: z.string().nullable().catch(null),
  node: z.coerce.number().catch(0),
  locationErrorM: z.coerce.number().catch(300),
  street: z.string().nullable().catch(null),
  conscious: z.string().catch("unknown"),
  breathing: z.string().catch("unknown"),
  bleeding: z.string().catch("unknown"),
  trapped: z.string().catch("unknown"),
  ageGroup: z.string().catch("unknown"),
  victims: z.coerce.number().nullable().catch(null),
  text: z.string().catch(""),
  phone: z
    .string()
    .nullable()
    .catch(null)
    .transform((p) => (p && /^\d{9}$/.test(p) ? `+34${p}` : p)), // solo llamadas reales: el identificador llega en formato nacional y la llamada saliente exige E.164
});
export type Call = z.infer<typeof CallSchema>;

/** Incidente del tablón. `callIds` son ids de heridos (una llamada = un herido). El resto de campos vuelven al agente tal cual. */
export type Incident = { id: string; callIds: InjuredId[]; priority: Priority } & Record<string, unknown>;

type Triage = { matchedIncidentId: string; matchedNewIncident: boolean; reasoning: string; incidents: Incident[] };

/** Prioridad del herido según el tablón; "medium" mientras no esté triado. */
export const priorityOf = (w: World, id: InjuredId): Priority => w.incidents.find((i) => i.callIds.includes(id))?.priority ?? "medium";
export const priorityRank = (w: World, id: InjuredId) => PRIORITIES.indexOf(priorityOf(w, id));

/** Una llamada entrante entra al mundo como herido: en la calle que dice, o en un nodo al azar si no está en el mapa. */
export function admitCall(w: World, map: RoadMap, call: Call): Injured {
  const position = map.findStreet(call.street) ?? (call.node in map.graph.nodes ? call.node : map.randomNode());
  return spawnInjured(w, map, position, TTL_BY_PRIORITY.medium, call); // ttl provisional: lo fija el triaje
}

/** Una llamada → una ejecución del agente → nuevo tablón. */
export async function triageCall(w: World, call: Call): Promise<Triage> {
  const [result] = await runWorkflow<Triage>(TRIAGE_WORKFLOW, { call, incidents: w.incidents }, TRIAGE_NODE);
  if (!Array.isArray(result?.incidents)) throw new Error("el agente no devolvió incidentes");
  // Id propio y creciente para cada incidente nuevo: el agente empieza en I1 cada vez que el tablón está vacío y la UI los confundiría.
  const created = result.matchedNewIncident ? result.incidents.find((i) => i.id === result.matchedIncidentId) : undefined;
  if (created) created.id = result.matchedIncidentId = `I${w.nextIncidentId++}`;
  w.incidents = result.incidents;
  const priority = priorityOf(w, call.id);
  logEvent(w, `🩺 triaje ${call.id} → ${result.matchedIncidentId}${result.matchedNewIncident ? " (nuevo)" : ""} [${priority}]: ${result.reasoning}`, {
    type: "triaged", injuredId: call.id, incidentId: result.matchedIncidentId, priority, reasoning: result.reasoning, isNew: result.matchedNewIncident,
  });
  return result;
}

/** Triaja los heridos que aún no están en el tablón (una ejecución por llamada) y olvida los incidentes sin heridos vivos. */
export async function triagePending(w: World, map: RoadMap) {
  w.incidents = w.incidents.filter((i) => i.callIds.some((id) => findInjured(w, id)));
  // ponytail: un herido que el agente no meta en ningún incidente se reintenta cada turno
  for (const h of w.injured.filter((h) => !w.incidents.some((i) => i.callIds.includes(h.id)))) {
    try {
      await triageCall(w, h.call ?? callFromInjured(w, map, h));
      if (h.call) h.ttl = TTL_BY_PRIORITY[priorityOf(w, h.id)]; // llamada de fuera: la gravedad la decide el triaje
    } catch (e) {
      logEvent(w, `⚠️ triaje de ${h.id} falló: ${(e as Error).message}`);
    }
  }
}
