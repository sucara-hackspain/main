import type { Graph } from "./graph";
import type { Rng } from "./rng";
import type { MasterAction, World } from "./types";

/** The game master: looks at the world each tick and decides what goes wrong next. */
export interface Master {
  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] | Promise<MasterAction[]>;
}

export interface RandomMasterConfig {
  /** Per tick. */
  pPatient: number;
  /** Per tick: several patients around one spot. */
  pIncident: number;
  incidentSize: [number, number];
  /** Patient time to live, in ticks. */
  ttl: [number, number];
  /** Per tick. */
  pRoadClosure: number;
  /** Share of closures aimed at a road an ambulance is about to use. */
  targetedClosureBias: number;
  /** Per closed road per tick. */
  pReopen: number;
  /** Per moving ambulance per tick. */
  pPuncture: number;
  punctureTicks: [number, number];
}

export const DEFAULT_MASTER: RandomMasterConfig = {
  pPatient: 0.12,
  pIncident: 0.012,
  incidentSize: [3, 6],
  ttl: [12, 70],
  pRoadClosure: 0.03,
  targetedClosureBias: 0.5,
  pReopen: 0.01,
  pPuncture: 0.002,
  punctureTicks: [10, 30],
};

export class RandomMaster implements Master {
  private readonly cfg: RandomMasterConfig;

  constructor(config: Partial<RandomMasterConfig> = {}) {
    this.cfg = { ...DEFAULT_MASTER, ...config };
  }

  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] {
    const { cfg } = this;
    const actions: MasterAction[] = [];

    if (rng.chance(cfg.pPatient)) {
      actions.push({ type: "spawn_patient", node: rng.int(0, graph.nodeCount - 1), ttl: rng.int(...cfg.ttl) });
    }

    if (rng.chance(cfg.pIncident)) {
      // Victims spread over the streets touching one random edge's neighbourhood.
      const centre = graph.data.edges[rng.int(0, graph.edgeCount - 1)];
      const size = rng.int(...cfg.incidentSize);
      for (let i = 0; i < size; i++) {
        actions.push({ type: "spawn_patient", node: rng.pick([centre.a, centre.b]), ttl: rng.int(...cfg.ttl) });
      }
    }

    if (rng.chance(cfg.pRoadClosure)) {
      const ahead = world.ambulances.flatMap((a) => a.route.slice(a.progressS > 0 ? 1 : 0));
      const edge =
        ahead.length > 0 && rng.chance(cfg.targetedClosureBias)
          ? rng.pick(ahead).edge
          : rng.int(0, graph.edgeCount - 1);
      actions.push({ type: "close_road", edge });
    }

    for (const edge of world.closedEdges) {
      if (rng.chance(cfg.pReopen)) actions.push({ type: "open_road", edge });
    }

    for (const amb of world.ambulances) {
      if (amb.route.length > 0 && amb.brokenUntil === null && rng.chance(cfg.pPuncture)) {
        actions.push({ type: "puncture", ambulanceId: amb.id, ticks: rng.int(...cfg.punctureTicks) });
      }
    }

    return actions;
  }
}
