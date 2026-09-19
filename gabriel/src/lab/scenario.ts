// A scenario is one night written down in full: everything that goes wrong, and when. Whoever coordinates, the
// same things happen, so two games of the same scenario differ only in what was decided.
import { readdirSync, readFileSync } from "node:fs";
import {
  advance,
  applyMasterAction,
  createWorld,
  DanaMaster,
  DEFAULT_CONFIG,
  DEFAULT_DANA,
  Rng,
  type DanaMasterConfig,
  type Graph,
  type Master,
  type MasterAction,
  type SimConfig,
  type World,
} from "../engine";
import { FLOOD_SOURCES } from "../masters/protocol";

export type Split = "train" | "validation" | "test";

export interface Scenario {
  id: string;
  family: string;
  split: Split;
  title: string;
  seed: number;
  /** New emergencies stop here; the rest of the night is for what is already open to play out. */
  eventTicks: number;
  ticks: number;
  config: Partial<SimConfig>;
  script: { tick: number; action: MasterAction }[];
  stats: { scenes: number; silent: number; victims: number; floods: string[] };
}

export const SCENARIO_DIR = "lab/scenarios";

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Scenario);
}

/** Plays a scenario back. It never looks at the world, so it cannot react to the coordinator. */
export class ScriptedMaster implements Master {
  constructor(private readonly scenario: Scenario) {}

  act(world: Readonly<World>): MasterAction[] {
    return this.scenario.script.filter((step) => step.tick === world.tick).map((step) => step.action);
  }
}

export interface ScenarioSpec {
  id: string;
  family: string;
  split: Split;
  title: string;
  seed: number;
  /** Indexes into FLOOD_SOURCES, all out from the first tick. */
  floods: number[];
  dana?: Partial<DanaMasterConfig>;
  config?: Partial<SimConfig>;
}

const EVENT_TICKS = 80;
const TICKS = 120;
/** Per road unit per tick, whatever it is doing: a breakdown does not wait for the unit to be on a job. */
const P_BREAKDOWN = 0.0015;

/** A short night that starts in the middle of the crisis: the water is already out and calls come in from tick 0. */
const DENSE: Partial<DanaMasterConfig> = { pSceneStart: 0.3, pScenePeak: 0.5, peakTick: 40 };

/**
 * Writes the night by letting the scripted master loose on a city where nobody moves. With no unit on the road it
 * has no route to aim a closure at, so nothing in the script depends on a coordinator.
 */
export function generateScenario(spec: ScenarioSpec, graph: Graph): Scenario {
  const config = { ...DEFAULT_CONFIG, ...spec.config };
  const world = createWorld(graph, config);
  const floods = spec.floods.map((index) => ({ tick: 0, ...FLOOD_SOURCES[index], radiusM: 300, growthM: 8, maxRadiusM: 1300 }));
  const master = new DanaMaster({ ...DEFAULT_DANA, ...DENSE, ...spec.dana, floods });
  const root = new Rng(spec.seed);
  const masterRng = root.fork();
  const breakdownRng = root.fork();
  const roadUnits = world.units.filter((u) => u.kind === "ambulance" || u.kind === "fire");

  const script: Scenario["script"] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    const actions = master.act(world, graph, masterRng).filter((a) => tick < EVENT_TICKS || a.type !== "spawn_scene");
    for (const unit of roadUnits) {
      if (tick < EVENT_TICKS && breakdownRng.chance(P_BREAKDOWN)) actions.push({ type: "puncture", unitId: unit.id, ticks: breakdownRng.int(10, 25) });
    }
    for (const action of actions) {
      applyMasterAction(world, graph, action);
      script.push({ tick, action });
    }
    advance(world, graph);
    world.tick++;
  }

  const scenes = script.flatMap((s) => (s.action.type === "spawn_scene" ? [s.action] : []));
  return {
    id: spec.id,
    family: spec.family,
    split: spec.split,
    title: spec.title,
    seed: spec.seed,
    eventTicks: EVENT_TICKS,
    ticks: TICKS,
    config: spec.config ?? {},
    script,
    stats: {
      scenes: scenes.length,
      silent: scenes.filter((s) => s.silent).length,
      victims: scenes.reduce((sum, s) => sum + s.victims.length, 0),
      floods: spec.floods.map((index) => FLOOD_SOURCES[index].name),
    },
  };
}

// ---------- the collection ----------

const [LA_TORRE, LA_PUNTA, MALILLA, SANT_ISIDRE, NATZARET] = [0, 1, 2, 3, 4];
const SCARCE: Partial<SimConfig> = { ambulances: 3, fireUnits: 2, hospitalCapacity: 6 };
const SILENT: Partial<DanaMasterConfig> = { pSilent: 0.35, pSilentFlood: 0.5, pSilentInWater: 0.8 };
const SATURATED: Partial<SimConfig> = { hospitals: 4, hospitalCapacity: 5 };

/**
 * Four kinds of night to learn from, each with games the researcher studies (train) and games it is only scored on
 * (validation). A fifth kind appears only in the final test: the doctrine has never met it.
 */
export const COLLECTION: ScenarioSpec[] = [
  { id: "A1", family: "A · Agua desde el sur", split: "train", title: "La Torre", seed: 101, floods: [LA_TORRE] },
  { id: "A2", family: "A · Agua desde el sur", split: "train", title: "La Torre, otra noche", seed: 102, floods: [LA_TORRE] },
  { id: "A3", family: "A · Agua desde el sur", split: "validation", title: "La Torre", seed: 103, floods: [LA_TORRE] },
  { id: "A4", family: "A · Agua desde el sur", split: "test", title: "La Torre", seed: 104, floods: [LA_TORRE] },

  { id: "B1", family: "B · Agua desde otro foco", split: "train", title: "La Punta", seed: 201, floods: [LA_PUNTA] },
  { id: "B2", family: "B · Agua desde otro foco", split: "train", title: "Malilla", seed: 202, floods: [MALILLA] },
  { id: "B3", family: "B · Agua desde otro foco", split: "validation", title: "Natzaret", seed: 203, floods: [NATZARET] },
  { id: "B4", family: "B · Agua desde otro foco", split: "test", title: "Sant Isidre", seed: 204, floods: [SANT_ISIDRE] },

  { id: "C1", family: "C · Pocos recursos", split: "train", title: "La Torre con media flota", seed: 301, floods: [LA_TORRE], config: SCARCE },
  { id: "C2", family: "C · Pocos recursos", split: "train", title: "Malilla con media flota", seed: 302, floods: [MALILLA], config: SCARCE },
  { id: "C3", family: "C · Pocos recursos", split: "validation", title: "La Punta con media flota", seed: 303, floods: [LA_PUNTA], config: SCARCE },

  { id: "D1", family: "D · Noche silenciosa", split: "train", title: "La Torre, casi nadie llama", seed: 401, floods: [LA_TORRE], dana: SILENT },
  { id: "D2", family: "D · Noche silenciosa", split: "train", title: "La Punta, casi nadie llama", seed: 402, floods: [LA_PUNTA], dana: SILENT },
  { id: "D3", family: "D · Noche silenciosa", split: "validation", title: "Malilla, casi nadie llama", seed: 403, floods: [MALILLA], dana: SILENT },

  { id: "E1", family: "E · Dos focos y hospitales saturados", split: "test", title: "La Torre y Natzaret a la vez", seed: 501, floods: [LA_TORRE, NATZARET], config: SATURATED },
  { id: "E2", family: "E · Dos focos y hospitales saturados", split: "test", title: "Sant Isidre y La Punta a la vez", seed: 502, floods: [SANT_ISIDRE, LA_PUNTA], config: SATURATED },
];
