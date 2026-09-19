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
  makeSceneVictims,
  Rng,
  type DanaMasterConfig,
  type Graph,
  type Master,
  type MasterAction,
  type SimConfig,
  type SiteKind,
  type VictimSpec,
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
  volume?: number;
  /** Chance that a detail the caller gives never reaches its field (see CallObserver). */
  buried?: number;
  /**
   * A moment instead of a whole night: the rule-based dispatcher plays up to `tick`, the agent takes the next
   * `decisions` decisions, and the dispatcher plays the rest. Whatever changes in the count is down to those decisions.
   */
  handover?: { tick: number; decisions: number; why: string; night: string };
  stats: { scenes: number; silent: number; victims: number; floods: string[] };
}

export const SCENARIO_DIR = "lab/scenarios";

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Scenario);
}

export interface MomentRef {
  id: string;
  night: string;
  tick: number;
  decisions: number;
  why: string;
}

/** What the lab plays: whole nights, or (LAB_MOMENTS=<file>) the hard moments picked out of them. */
export function loadPlayables(): Scenario[] {
  const nights = loadScenarios();
  const file = process.env.LAB_MOMENTS;
  if (!file) return nights;
  const moments = JSON.parse(readFileSync(file, "utf8")) as MomentRef[];
  return moments.map((m) => {
    const night = nights.find((n) => n.id === m.night)!;
    return { ...night, id: m.id, title: `${night.title} · tick ${m.tick} · ${m.why}`, handover: { tick: m.tick, decisions: m.decisions, why: m.why, night: night.id } };
  });
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
  /** How many emergencies can break out in the same tick: 1 is a bad night, 6 is the 29th of October 2024. */
  intensity?: number;
  /** Tick each flood comes out at (default 0: the night starts with the water already out). Upstream gauges warn of the late ones. */
  floodTicks?: number[];
  /** Care homes, schools and car parks in the water's path, full of people who are fine until it arrives. */
  sites?: number;
  /** The power goes out over the flooded districts at this tick: hardly anyone inside can phone 112. */
  blackoutTick?: number;
  /** How loud the citizen channel is: 1 is a bad night, 5 is everyone posting at once. */
  volume?: number;
  buried?: number;
  /** A longer night than the training ones: ticks of new emergencies, and total ticks. */
  eventTicks?: number;
  ticks?: number;
  /** Ticks at which a bridge goes: every street within 140 m of a crossing between the water and the city closes at once. */
  bridges?: number[];
}

const SITE_NAMES: Record<SiteKind, string[]> = {
  residence: ["Residencia Sant Josep", "Residencia La Saleta", "Centro de día Verge del Carme", "Residencia El Pilar"],
  school: ["CEIP Rei en Jaume", "Escoleta Els Xiquets", "CEIP Blasco Ibáñez", "IES La Marxadella"],
  garage: ["Garaje Plaza Major", "Aparcamiento Mercat", "Garaje residencial Av. del Sud", "Aparcamiento Estació"],
};
const SITE_PEOPLE: Record<SiteKind, [number, number]> = { residence: [18, 34], school: [24, 40], garage: [8, 18] };
const SITE_AGE: Record<SiteKind, [number, number]> = { residence: [72, 96], school: [6, 12], garage: [22, 70] };

/** Whoever the water catches in a ground floor or a basement: what a flooded home does to people, at the ages of that site. */
function peopleInside(kind: SiteKind, rng: Rng): VictimSpec[] {
  const people: VictimSpec[] = [];
  const wanted = rng.int(...SITE_PEOPLE[kind]);
  while (people.length < wanted) people.push(...makeSceneVictims("flooded_home", rng));
  return people.slice(0, wanted).map((p) => ({ ...p, age: rng.int(...SITE_AGE[kind]) }));
}

const EVENT_TICKS = 40;
const TICKS = 90;
/** Per road unit per tick, whatever it is doing: a breakdown does not wait for the unit to be on a job. */
const P_BREAKDOWN = 0.003;

/** A short night that starts in the middle of the crisis: the water is already out and calls come in from tick 0. */
const DENSE: Partial<DanaMasterConfig> = { pSceneStart: 0.5, pScenePeak: 0.6, peakTick: 20 };

/**
 * Writes the night by letting the scripted master loose on a city where nobody moves. With no unit on the road it
 * has no route to aim a closure at, so nothing in the script depends on a coordinator.
 */
export function generateScenario(spec: ScenarioSpec, graph: Graph): Scenario {
  const config = { ...DEFAULT_CONFIG, ...spec.config };
  const world = createWorld(graph, config);
  const floods = spec.floods.map((index, n) => ({ tick: spec.floodTicks?.[n] ?? 0, ...FLOOD_SOURCES[index], radiusM: 450, growthM: 10, maxRadiusM: 1300 }));
  const master = new DanaMaster({ ...DEFAULT_DANA, ...DENSE, ...spec.dana, floods });
  const root = new Rng(spec.seed);
  const masterRng = root.fork();
  const breakdownRng = root.fork();
  const roadUnits = world.units.filter((u) => u.kind === "ambulance" || u.kind === "fire");

  const EVENTS = spec.eventTicks ?? EVENT_TICKS;
  const LENGTH = spec.ticks ?? TICKS;
  const script: Scenario["script"] = [];
  const siteRng = root.fork();
  for (let n = 0; n < (spec.sites ?? 0); n++) {
    const flood = floods[n % floods.length];
    const source = graph.nearestNode(flood.lon, flood.lat);
    // Far enough that there is time to act, near enough that the water gets there before the night is over.
    const ring = graph.nodesWithin(source, 950).filter((node) => graph.distanceM(source, node) > 520);
    if (ring.length === 0) continue;
    const kind = siteRng.pick<SiteKind>(["residence", "residence", "school", "garage"]);
    const action: MasterAction = { type: "place_site", kind, name: SITE_NAMES[kind][n % 4], node: siteRng.pick(ring), people: peopleInside(kind, siteRng) };
    applyMasterAction(world, graph, action);
    script.push({ tick: 0, action });
  }
  const gaugeRng = root.fork();
  const gauges = floods.filter((f) => f.tick > 0);

  const bridgeRng = new Rng(spec.seed + 7919);
  for (let tick = 0; tick < LENGTH; tick++) {
    const actions = master.act(world, graph, masterRng);
    if (spec.bridges?.includes(tick)) {
      const flood = floods[spec.bridges.indexOf(tick) % floods.length];
      const source = graph.nearestNode(flood.lon, flood.lat);
      const crossing = bridgeRng.pick(graph.nodesWithin(source, 1500).filter((node) => graph.distanceM(source, node) > 900));
      const around = new Set(graph.nodesWithin(crossing, 140));
      graph.data.edges.forEach((e, edge) => {
        if (around.has(e.a) && around.has(e.b)) actions.push({ type: "close_road", edge });
      });
      actions.push({ type: "narrate", text: `Cae un puente junto a ${graph.streetAt(crossing) ?? "el cauce"}: el barrio queda partido en dos.` });
    }
    if (tick === spec.blackoutTick) for (const f of floods) actions.push({ type: "blackout", node: graph.nearestNode(f.lon, f.lat), radiusM: 1500, ticks: TICKS });
    // A catastrophe is many emergencies at once, not one after another: more rolls of the same dice per tick.
    for (let extra = 1; extra < (spec.intensity ?? 1); extra++) actions.push(...master.act(world, graph, masterRng).filter((a) => a.type === "spawn_scene"));
    for (let i = actions.length - 1; i >= 0; i--) if (tick >= EVENTS && actions[i].type === "spawn_scene") actions.splice(i, 1);
    // The channel fills for a while before it spills, and the forecast of when sharpens as it gets closer.
    for (const f of gauges) {
      if (tick % 3 !== 0 || tick > f.tick + 6) continue;
      const left = Math.max(0, f.tick - tick);
      actions.push({ type: "gauge_reading", name: f.name, node: graph.nearestNode(f.lon, f.lat), level: Number(Math.min(1.3, 1 - left * 0.025).toFixed(2)), overflowTick: f.tick + Math.round(gaugeRng.range(-1, 1) * (left / 5)), radiusM: f.radiusM, growthM: f.growthM });
    }
    for (const unit of roadUnits) {
      if (tick < EVENTS && breakdownRng.chance(P_BREAKDOWN)) actions.push({ type: "puncture", unitId: unit.id, ticks: breakdownRng.int(10, 25) });
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
    eventTicks: EVENTS,
    ticks: LENGTH,
    config: spec.config ?? {},
    script,
    volume: spec.volume,
    buried: spec.buried,
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
/** A provincial deployment for a night with hundreds of victims: three times the fleet, and still nowhere near enough. */
const DEPLOYED: Partial<SimConfig> = { ambulances: 15, fireUnits: 8, rescueUnits: 6, helicopters: 2, drones: 5, hospitals: 8, hospitalCapacity: 45 };

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

  { id: "F1", family: "F · DANA a escala real", split: "train", title: "La Torre y Malilla, cientos de víctimas", seed: 601, floods: [LA_TORRE, MALILLA], config: DEPLOYED, intensity: 6 },
  { id: "F2", family: "F · DANA a escala real", split: "train", title: "La Punta y Sant Isidre, cientos de víctimas", seed: 602, floods: [LA_PUNTA, SANT_ISIDRE], config: DEPLOYED, intensity: 6 },
  { id: "F3", family: "F · DANA a escala real", split: "validation", title: "La Torre y Natzaret, cientos de víctimas", seed: 603, floods: [LA_TORRE, NATZARET], config: DEPLOYED, intensity: 6 },
  { id: "F4", family: "F · DANA a escala real", split: "test", title: "Malilla y La Punta, cientos de víctimas", seed: 604, floods: [MALILLA, LA_PUNTA], config: DEPLOYED, intensity: 6 },

  { id: "G1", family: "G · Anticipación", split: "train", title: "La Torre avisa con 12 ticks; residencias y colegios en el camino", seed: 701, floods: [LA_TORRE, MALILLA], floodTicks: [12, 26], sites: 6 },
  { id: "G2", family: "G · Anticipación", split: "train", title: "La Punta avisa con 10 ticks; sitios en el camino", seed: 702, floods: [LA_PUNTA, SANT_ISIDRE], floodTicks: [10, 24], sites: 6 },
  { id: "G3", family: "G · Anticipación", split: "validation", title: "Natzaret avisa con 14 ticks; sitios en el camino", seed: 703, floods: [NATZARET, LA_TORRE], floodTicks: [14, 28], sites: 6 },
  { id: "G4", family: "G · Anticipación", split: "test", title: "Malilla avisa con 11 ticks; sitios en el camino", seed: 704, floods: [MALILLA, LA_PUNTA], floodTicks: [11, 25], sites: 6 },

  { id: "H1", family: "H · Apagón y redes", split: "train", title: "La Torre a oscuras: casi nadie puede llamar", seed: 801, buried: 0.6, floods: [LA_TORRE], blackoutTick: 3, volume: 3, dana: SILENT },
  { id: "H2", family: "H · Apagón y redes", split: "train", title: "La Punta a oscuras", seed: 802, buried: 0.6, floods: [LA_PUNTA], blackoutTick: 5, volume: 3, dana: SILENT },
  { id: "H3", family: "H · Apagón y redes", split: "validation", title: "Malilla a oscuras", seed: 803, buried: 0.6, floods: [MALILLA], blackoutTick: 4, volume: 3, dana: SILENT },
  { id: "H4", family: "H · Apagón y redes", split: "test", title: "Natzaret a oscuras", seed: 804, buried: 0.6, floods: [NATZARET], blackoutTick: 2, volume: 3, dana: SILENT },

  // The showcase: never trained on. Modelled on the evening of 29 October 2024 south of Valencia: the channel fills for
  // a quarter of an hour before it spills, three fronts open one after another, the power and the phones go, two
  // crossings fall, care homes, schools and car parks stand in the water's path, and the whole city is posting.
  {
    id: "X1", family: "X · 29 de octubre", split: "test", title: "Tres frentes, apagón, puentes caídos, 14 centros en el camino del agua", seed: 2910,
    floods: [LA_TORRE, SANT_ISIDRE, LA_PUNTA], floodTicks: [14, 24, 38], sites: 14, blackoutTick: 18, bridges: [22, 46], buried: 0.6, volume: 5, intensity: 8,
    eventTicks: 90, ticks: 150, dana: { pSilent: 0.3, pSilentFlood: 0.45, pSilentInWater: 0.8 },
    config: { ambulances: 22, fireUnits: 10, rescueUnits: 8, helicopters: 3, drones: 6, hospitals: 8, hospitalCapacity: 40, outboundLines: 8 },
  },

  { id: "E1", family: "E · Dos focos y hospitales saturados", split: "test", title: "La Torre y Natzaret a la vez", seed: 501, floods: [LA_TORRE, NATZARET], config: SATURATED },
  { id: "E2", family: "E · Dos focos y hospitales saturados", split: "test", title: "Sant Isidre y La Punta a la vez", seed: 502, floods: [SANT_ISIDRE, LA_PUNTA], config: SATURATED },
];
