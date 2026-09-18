import { distM, type Graph } from "./graph";
import type { Rng } from "./rng";
import type { LonLat, MasterAction, Need, Severity, World } from "./types";

/** The game master: looks at the world each tick and decides what goes wrong next. */
export interface Master {
  readonly name: string;
  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] | Promise<MasterAction[]>;
}

export function randomSeverity(rng: Rng): Severity {
  const r = rng.next();
  return r < 0.25 ? "critico" : r < 0.7 ? "grave" : "leve";
}

function randomNeed(rng: Rng): Need {
  const r = rng.next();
  return r < 0.6 ? "general" : r < 0.95 ? "trauma" : "quemados";
}

function victims(rng: Rng, count: number, trapped: number, need: Need) {
  return Array.from({ length: count }, (_, i) => ({ severity: randomSeverity(rng), need, trapped: i < trapped }));
}

export interface NoiseConfig {
  /** Per tick: one isolated patient somewhere dry. */
  pPatient: number;
  /** Per tick: a call with nobody behind it. */
  pFalseAlarm: number;
  /** Per tick: something blocks a street (fallen tree, broken-down lorry). */
  pObstacle: number;
  /** Share of obstacles that land on a road some unit is about to use. */
  targetedObstacleBias: number;
  /** Per moving road unit per tick. */
  pBreakdown: number;
  breakdownTicks: [number, number];
  /** Per tick: a crash with several victims, some trapped, blocking its road. */
  pAccident: number;
}

export const DEFAULT_NOISE: NoiseConfig = {
  pPatient: 0.1,
  pFalseAlarm: 0.01,
  pObstacle: 0.03,
  targetedObstacleBias: 0.5,
  pBreakdown: 0.002,
  breakdownTicks: [10, 30],
  pAccident: 0.01,
};

/** Everyday bad luck, shared by every master. */
function noise(cfg: NoiseConfig, world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] {
  const actions: MasterAction[] = [];
  const flooded = new Set(world.floodEdges);
  const dryEdge = (): number => {
    for (let i = 0; i < 20; i++) {
      const edge = rng.int(0, graph.edgeCount - 1);
      if (!flooded.has(edge)) return edge;
    }
    return rng.int(0, graph.edgeCount - 1);
  };

  if (rng.chance(cfg.pPatient)) {
    actions.push({ type: "spawn_patient", node: graph.data.edges[dryEdge()].a, severity: randomSeverity(rng), need: randomNeed(rng) });
  }
  if (rng.chance(cfg.pFalseAlarm)) actions.push({ type: "false_alarm", node: graph.data.edges[dryEdge()].a });

  if (rng.chance(cfg.pAccident)) {
    const edge = dryEdge();
    const count = rng.int(2, 5);
    actions.push({
      type: "start_incident",
      kind: "accident",
      label: `Accidente múltiple en ${graph.edgeName(edge) ?? "vía sin nombre"}`,
      node: graph.data.edges[edge].a,
      edge,
      victims: victims(rng, count, rng.int(0, 2), "trauma"),
      roadWork: 8,
    });
  }

  if (rng.chance(cfg.pObstacle)) {
    const ahead = world.units.flatMap((u) => u.route.slice(u.progressS > 0 ? 1 : 0));
    const edge = ahead.length > 0 && rng.chance(cfg.targetedObstacleBias) ? rng.pick(ahead).edge : dryEdge();
    if (!world.closedEdges.includes(edge)) {
      actions.push({ type: "close_road", edge, label: rng.pick(["Árbol caído", "Camión averiado", "Socavón", "Cables caídos"]) });
    }
  }

  for (const unit of world.units) {
    if (unit.kind !== "heli" && unit.route.length > 0 && unit.brokenUntil === null && rng.chance(cfg.pBreakdown)) {
      actions.push({ type: "breakdown", unitId: unit.id, ticks: rng.int(...cfg.breakdownTicks) });
    }
  }
  return actions;
}

/** No story, just dice. Good for benchmarks over many seeds. */
export class RandomMaster implements Master {
  readonly name = "random";
  private readonly cfg: NoiseConfig;

  constructor(config: Partial<NoiseConfig> = {}) {
    this.cfg = { ...DEFAULT_NOISE, ...config };
  }

  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] {
    return noise(this.cfg, world, graph, rng);
  }
}

interface Beat {
  tick: number;
  run: (world: Readonly<World>, graph: Graph, rng: Rng) => MasterAction[];
}

/**
 * A flash flood (DANA) told in acts, on top of the everyday noise. Places are fractions of the
 * map's bounding box so the same story plays on any city; beat times shift a little with the seed.
 */
export class DanaMaster implements Master {
  readonly name = "dana";
  private beats: Beat[] | null = null;
  private readonly cfg: NoiseConfig = { ...DEFAULT_NOISE, pPatient: 0.07, pAccident: 0.004 };

  act(world: Readonly<World>, graph: Graph, rng: Rng): MasterAction[] {
    this.beats ??= this.script(graph, rng);
    const actions = noise(this.cfg, world, graph, rng);

    for (const beat of this.beats) if (beat.tick === world.tick) actions.push(...beat.run(world, graph, rng));

    const floods = world.zones.filter((z) => z.kind === "flood" && z.active);
    // People on rooftops and in ground floors: only firefighters or the helicopter can get them out.
    if (floods.length > 0 && world.floodEdges.length > 0 && rng.chance(0.06)) {
      const edge = rng.pick(world.floodEdges);
      const count = rng.int(1, 3);
      const mild = (): Severity => (rng.chance(0.6) ? "leve" : rng.chance(0.85) ? "grave" : "critico");
      actions.push({
        type: "start_incident",
        kind: "flood_rescue",
        label: `Personas atrapadas por el agua en ${graph.edgeName(edge) ?? "calle sin nombre"}`,
        node: graph.data.edges[edge].a,
        victims: Array.from({ length: count }, () => ({ severity: mild(), need: "general" as Need, trapped: true })),
        ttlFactor: 1.6,
      });
    }
    // The water reaches a hospital: it stops admitting.
    for (const zone of floods) {
      for (const h of world.hospitals) {
        if (h.offlineUntil === null && distM(zone.center, graph.data.nodes[h.node]) <= zone.radiusM) {
          actions.push({ type: "hospital_down", hospitalId: h.id, ticks: 9999 });
        }
      }
    }
    return actions;
  }

  private script(graph: Graph, rng: Rng): Beat[] {
    const [south, west, north, east] = graph.data.bbox;
    const at = (x: number, y: number): LonLat => [west + (east - west) * x, south + (north - south) * y];
    const nodeAt = (x: number, y: number) => graph.nearestNode(...at(x, y));
    const jitter = (tick: number) => tick + rng.int(-4, 4);
    const river = at(0.18, 0.17);

    // A fast road near the flood for the pile-up.
    const fastRoad = (): number => {
      const target = at(0.3, 0.32);
      let best = 0;
      let bestD = Infinity;
      graph.data.edges.forEach((e, i) => {
        if (e.kph < 70) return;
        const d = distM(target, e.geom[0]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };

    return [
      {
        tick: jitter(10),
        run: () => [{ type: "start_zone", kind: "flood", label: "Desbordamiento del barranco", center: river, radiusM: 250, growthM: 18, maxRadiusM: 1700 }],
      },
      {
        tick: jitter(28),
        run: (_w, g, r) => {
          const edge = fastRoad();
          return [{
            type: "start_incident",
            kind: "accident",
            label: `Colisión en cadena en ${g.edgeName(edge) ?? "la autovía"}`,
            node: g.data.edges[edge].a,
            edge,
            victims: victims(r, 6, 2, "trauma"),
            roadWork: 10,
          }];
        },
      },
      {
        tick: jitter(45),
        run: () => [{ type: "start_zone", kind: "no_coverage", label: "Caída de la red móvil", center: river, radiusM: 2400, durationTicks: 45 }],
      },
      {
        tick: jitter(65),
        run: (_w, g, r) => [{
          type: "start_incident",
          kind: "fire",
          label: "Incendio en edificio de viviendas",
          node: nodeAt(0.47, 0.57),
          victims: victims(r, 3, 1, "quemados"),
          fireWork: 36,
          extraVictims: 6,
        }],
      },
      {
        tick: jitter(100),
        run: (w) => w.units.filter((u) => u.kind === "heli").map((u) => ({ type: "breakdown" as const, unitId: u.id, ticks: 25 })),
      },
      {
        tick: jitter(125),
        run: (_w, _g, r) => [{
          type: "start_incident",
          kind: "collapse",
          label: "Derrumbe de un edificio",
          node: nodeAt(0.56, 0.43),
          victims: victims(r, 7, 5, "trauma"),
        }],
      },
      {
        tick: jitter(155),
        run: () => [{ type: "start_zone", kind: "flood", label: "Desbordamiento al norte", center: at(0.62, 0.93), radiusM: 200, growthM: 15, maxRadiusM: 900 }],
      },
    ];
  }
}
