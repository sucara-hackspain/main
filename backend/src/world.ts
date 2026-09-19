import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BASE_COORDS, LOG_KEEP, STATE_FILE } from "./config.js";
import { createAmbulances, type Ambulance } from "./entities/ambulance.js";
import { createBase, type Base } from "./entities/base.js";
import type { Injured, InjuredId } from "./entities/injured.js";
import type { StreetCut } from "./entities/street-cut.js";
import type { RoadMap } from "./map/road-map.js";

/** Todo el estado mutable de la simulación. Se persiste tal cual en JSON. */
export type World = {
  turn: number;
  base: Base;
  ambulances: Ambulance[];
  injured: Injured[];
  cuts: StreetCut[];
  stats: { rescued: number; dead: number };
  log: string[]; // eventos recientes, prefijados con el turno
  nextInjuredId: number;
};

export function createWorld(map: RoadMap, ambulances: number): World {
  const base = createBase(map, BASE_COORDS);
  return { turn: 0, base, ambulances: createAmbulances(ambulances, base), injured: [], cuts: [], stats: { rescued: 0, dead: 0 }, log: [], nextInjuredId: 1 };
}

export function logEvent(w: World, message: string) {
  w.log.push(`t${w.turn} ${message}`);
  if (w.log.length > LOG_KEEP) w.log.splice(0, w.log.length - LOG_KEEP);
}

export const findInjured = (w: World, id: InjuredId) => w.injured.find((h) => h.id === id);
export const ambulanceAssignedTo = (w: World, id: InjuredId) => w.ambulances.find((a) => a.target === id);

export function loadWorld(file = STATE_FILE): World {
  if (!existsSync(file)) throw new Error(`no hay ${file}: ejecuta 'init' primero`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export const saveWorld = (w: World, file = STATE_FILE) => writeFileSync(file, JSON.stringify(w));
