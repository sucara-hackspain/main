import type { Graph } from "./graph";
import type { Rng } from "./rng";
import type { MasterAction, World } from "./types";
import { FLOOD_FRINGE_M } from "./engine";
import { cutOffForecast } from "./water";
import { makeSceneVictims, pickSceneKind } from "./victims";

/** The game master: looks at the world each tick and decides what goes wrong next. */
export interface Master {
  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] | Promise<MasterAction[]>;
}

export interface RandomMasterConfig {
  /** Per tick: something happens somewhere (a collapse, a crash, a fire...). */
  pScene: number;
  /** Per tick. */
  pRoadClosure: number;
  /** Share of closures aimed at a road an ambulance is about to use. */
  targetedClosureBias: number;
  /** Per closed road per tick. */
  pReopen: number;
  /** Per moving ambulance per tick. */
  pPuncture: number;
  punctureTicks: [number, number];
  /** Share of scenes nobody calls 112 about: only a unit sent to look ever finds them. */
  pSilent: number;
}

export const DEFAULT_MASTER: RandomMasterConfig = {
  pScene: 0.1,
  pRoadClosure: 0.03,
  targetedClosureBias: 0.5,
  pReopen: 0.01,
  pPuncture: 0.002,
  punctureTicks: [10, 30],
  pSilent: 0.12,
};

export class RandomMaster implements Master {
  private readonly cfg: RandomMasterConfig;

  constructor(config: Partial<RandomMasterConfig> = {}) {
    this.cfg = { ...DEFAULT_MASTER, ...config };
  }

  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] {
    const { cfg } = this;
    const actions: MasterAction[] = [];

    if (rng.chance(cfg.pScene)) {
      const kind = pickSceneKind(rng, "city");
      actions.push({ type: "spawn_scene", kind, node: rng.int(0, graph.nodeCount - 1), victims: makeSceneVictims(kind, rng), silent: rng.chance(cfg.pSilent) });
    }

    if (rng.chance(cfg.pRoadClosure)) {
      const ahead = world.units.flatMap((a) => a.route.slice(a.progressS > 0 ? 1 : 0));
      const edge =
        ahead.length > 0 && rng.chance(cfg.targetedClosureBias)
          ? rng.pick(ahead).edge
          : rng.int(0, graph.edgeCount - 1);
      actions.push({ type: "close_road", edge });
    }

    for (const edge of world.closedEdges) {
      if (rng.chance(cfg.pReopen)) actions.push({ type: "open_road", edge });
    }

    for (const amb of world.units) {
      if (amb.route.length > 0 && amb.brokenUntil === null && rng.chance(cfg.pPuncture)) {
        actions.push({ type: "puncture", unitId: amb.id, ticks: rng.int(...cfg.punctureTicks) });
      }
    }

    return actions;
  }
}

interface FloodPlan {
  tick: number;
  name: string;
  lon: number;
  lat: number;
  radiusM: number;
  growthM: number;
  maxRadiusM: number;
}

/** Where the shallow fringe catches people: beyond the impassable core, so an ambulance can still get in. */
const WATER_EDGE_M: [number, number] = [80, FLOOD_FRINGE_M];


export interface DanaMasterConfig {
  /** Chance per tick of a new scene at the start, and once the night is at its worst. */
  pSceneStart: number;
  pScenePeak: number;
  peakTick: number;
  /** Once the water is out: share of scenes at its advancing edge, and share inside it (nobody can drive there). */
  floodShare: number;
  inWaterShare: number;
  /** Share of scenes nobody calls about: ordinary ones, at the water's edge, and inside the water. */
  pSilent: number;
  pSilentFlood: number;
  pSilentInWater: number;
  floods: FloodPlan[];
}

export const DEFAULT_DANA: DanaMasterConfig = {
  pSceneStart: 0.05,
  pScenePeak: 0.2,
  peakTick: 120,
  floodShare: 0.5,
  inWaterShare: 0.25,
  // Inside the water nobody calls: the line is down, the phone is gone, or nobody is left conscious.
  pSilent: 0.1,
  pSilentFlood: 0.25,
  pSilentInWater: 0.6,
  // Rough stand-ins for 29 Oct 2024: water coming up from the south of the city.
  floods: [
    { tick: 15, name: "Barranco sur · La Torre", lon: -0.398, lat: 39.438, radiusM: 250, growthM: 6, maxRadiusM: 1300 },
    { tick: 80, name: "Nuevo cauce · La Punta", lon: -0.345, lat: 39.441, radiusM: 200, growthM: 5, maxRadiusM: 1000 },
  ],
};

/**
 * A DANA night: ordinary emergencies all over the city, then the water comes out and most
 * of what happens is at its advancing edge, where whoever is not reached in time gets cut off.
 */
export class DanaMaster implements Master {
  private readonly cfg: DanaMasterConfig;
  /** Random road closures and breakdowns still happen; the water does the rest. */
  private readonly background = new RandomMaster({ pScene: 0, pRoadClosure: 0.01, targetedClosureBias: 0.3 });

  constructor(config: Partial<DanaMasterConfig> = {}) {
    this.cfg = { ...DEFAULT_DANA, ...config };
  }

  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] {
    const { cfg } = this;
    const actions = this.background.act(world, graph, rng);

    for (const plan of cfg.floods) {
      if (plan.tick !== world.tick) continue;
      const { name, radiusM, growthM, maxRadiusM } = plan;
      actions.push({ type: "start_flood", name, node: graph.nearestNode(plan.lon, plan.lat), radiusM, growthM, maxRadiusM });
    }

    const ramp = Math.min(1, world.tick / cfg.peakTick);
    if (rng.chance(cfg.pSceneStart + (cfg.pScenePeak - cfg.pSceneStart) * ramp)) {
      let node = rng.int(0, graph.nodeCount - 1);
      let where: "flood" | "city" = "city";
      let pSilent = cfg.pSilent;
      const roll = rng.next();
      if (world.floods.length > 0 && roll < cfg.floodShare + cfg.inWaterShare) {
        const flood = rng.pick(world.floods);
        let candidates: number[];
        if (roll < cfg.inWaterShare) {
          // Caught by the water where they were. They call, but no ambulance will reach them.
          candidates = graph.nodesWithin(flood.node, flood.radiusM).filter((n) => graph.distanceM(flood.node, n) > flood.radiusM * 0.3);
        } else {
          // Ahead of the front, in places an ambulance can still get in and out of.
          const cutOffIn = cutOffForecast({ zones: world.floods, closedEdges: world.closedEdges }, world.hospitals, graph);
          candidates = graph
            .nodesWithin(flood.node, flood.radiusM + WATER_EDGE_M[1])
            .filter((n) => graph.distanceM(flood.node, n) > flood.radiusM + WATER_EDGE_M[0] && cutOffIn(n) === null);
        }
        if (candidates.length > 0) {
          node = rng.pick(candidates);
          where = "flood";
          pSilent = roll < cfg.inWaterShare ? cfg.pSilentInWater : cfg.pSilentFlood;
        }
      }
      const kind = pickSceneKind(rng, where);
      actions.push({ type: "spawn_scene", kind, node, victims: makeSceneVictims(kind, rng), silent: rng.chance(pSilent) });
    }
    return actions;
  }
}
