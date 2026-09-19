import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BASE_COORDS, LOG_KEEP, STATE_FILE } from "./config.js";
import { createAmbulances, type Ambulance, type AmbulanceId } from "./entities/ambulance.js";
import { createBase, type Base } from "./entities/base.js";
import type { Injured, InjuredId } from "./entities/injured.js";
import type { StreetCut } from "./entities/street-cut.js";
import type { NodeId } from "./map/graph.js";
import type { Followup } from "./followup.js";
import type { RoadMap } from "./map/road-map.js";
import { emptyRecorderState, type RecorderState } from "./recorder.js";
import type { Call, Incident } from "./triage.js";

/** Todo el estado mutable de la simulación. Se persiste tal cual en JSON. */
export type World = {
  turn: number;
  base: Base;
  ambulances: Ambulance[];
  injured: Injured[];
  cuts: StreetCut[];
  incidents: Incident[]; // tablón del agente de triaje: prioridad por herido
  followups: Followup[]; // seguimientos telefónicos de heridos ya atendidos
  stats: { rescued: number; dead: number };
  log: string[]; // eventos recientes, prefijados con el turno
  events: SimEvent[]; // lo ocurrido desde el último registro (recorder.ts los vacía cada turno)
  nextInjuredId: number;
  nextIncidentId: number; // el agente de triaje reutiliza ids cuando el tablón se vacía; los nuevos incidentes reciben el nuestro
  runId?: string; // partida grabada en runs/<runId>/ para el Control Center (la crea `init`)
  startedAt?: string;
  ui: RecorderState;
};

/** Hechos estructurados del turno, para el registro que lee la UI. `logEvent` los apunta junto al mensaje. */
export type SimEvent = SimEventBody & { tick: number };
export type SimEventBody =
  | { type: "call"; injuredId: InjuredId; call: Call }
  | { type: "triaged"; injuredId: InjuredId; incidentId: string; priority: string; reasoning: string; isNew: boolean }
  | { type: "dispatch"; unitId: AmbulanceId; injuredId: InjuredId; eta: number }
  | { type: "rescued"; unitId: AmbulanceId; injuredId: InjuredId }
  | { type: "died"; injuredId: InjuredId }
  | { type: "cut"; street: string; edges: [NodeId, NodeId][] }
  | { type: "punctured"; unitId: AmbulanceId; turns: number }
  | { type: "repaired"; unitId: AmbulanceId }
  | { type: "followup"; injuredId: InjuredId; text: string };

export function createWorld(map: RoadMap, ambulances: number): World {
  const base = createBase(map, BASE_COORDS);
  return { turn: 0, base, ambulances: createAmbulances(ambulances, base), injured: [], cuts: [], incidents: [], followups: [], stats: { rescued: 0, dead: 0 }, log: [], events: [], nextInjuredId: 1, nextIncidentId: 1, ui: emptyRecorderState() };
}

export function logEvent(w: World, message: string, event?: SimEventBody) {
  w.log.push(`t${w.turn} ${message}`);
  if (event) w.events.push({ ...event, tick: w.turn });
  if (w.log.length > LOG_KEEP) w.log.splice(0, w.log.length - LOG_KEEP);
}

export const findInjured = (w: World, id: InjuredId) => w.injured.find((h) => h.id === id);
export const ambulanceAssignedTo = (w: World, id: InjuredId) => w.ambulances.find((a) => a.target === id);

export function loadWorld(file = STATE_FILE): World {
  if (!existsSync(file)) throw new Error(`no hay ${file}: ejecuta 'init' primero`);
  const w: World = JSON.parse(readFileSync(file, "utf8"));
  w.incidents ??= []; // partidas guardadas antes de los agentes 112
  w.followups ??= [];
  w.events ??= [];
  w.nextIncidentId ??= 1;
  w.ui ??= emptyRecorderState();
  return w;
}

export const saveWorld = (w: World, file = STATE_FILE) => writeFileSync(file, JSON.stringify(w));
