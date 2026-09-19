import { Graph } from "../../../../gabriel/src/engine/graph";
import { closuresFor } from "../../../../gabriel/src/engine/engine";
import { remainingRoute } from "../map/routes";
import {
  UNIT_KINDS,
  type GraphData,
  type LonLat,
  type RunMeta,
  type TickRecord,
  type UnitFrame,
  type UnitKind,
} from "../engineTrace";

/** Helicopters fly straight at 180 km/h, as in the engine. */
const HELICOPTER_MPS = 50;

/**
 * Travel as the coordinator can plan it at one instant: road crews avoid the closures it knows of,
 * water rescue wades through the ones that are water, the helicopter flies straight.
 */
export type Router = {
  /** Ticks for this unit to reach a node. Infinity = no known way. */
  eta(unit: UnitFrame, node: number): number;
  etaFrom(kind: UnitKind, from: number, node: number): number;
  path(unit: UnitFrame, node: number): LonLat[] | null;
  pathFrom(kind: UnitKind, from: number, node: number): LonLat[] | null;
};

export function metresBetween(a: LonLat, b: LonLat) {
  const rad = Math.PI / 180;
  return (
    Math.hypot(
      (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad),
      (b[1] - a[1]) * rad,
    ) * 6371000
  );
}

/**
 * Known closures that are water: what crews radioed back as flooded, plus known closures inside
 * the water the official maps show. The frame does not carry the coordinator's list itself.
 */
export function knownFlooded(
  records: TickRecord[],
  record: TickRecord,
  graph: GraphData,
): number[] {
  const flooded = new Set<number>();
  for (const r of records) {
    if (r.tick > record.tick) break;
    for (const e of r.events)
      if (e.type === "road_blocked_found" && e.flooded)
        e.edges.forEach((edge) => flooded.add(edge));
  }
  const zones = record.frame.knownWater.zones;
  for (const edge of record.frame.knownClosedEdges) {
    const geom = graph.edges[edge]?.geom;
    if (!geom) continue;
    const middle = geom[Math.floor(geom.length / 2)];
    if (zones.some((z) => metresBetween(middle, graph.nodes[z.node]) <= z.radiusM))
      flooded.add(edge);
  }
  return [...flooded];
}

export function createRouter(data: GraphData, config: RunMeta["config"]) {
  const graph = new Graph(data);
  const nodeAt = new Map(data.nodes.map((p, i) => [p.join(","), i]));
  const toTicks = (seconds: number) =>
    Math.ceil(seconds / config.ambulanceSpeedFactor / config.tickSeconds);
  const flightTicks = (metres: number) =>
    Math.ceil(metres / HELICOPTER_MPS / config.tickSeconds);

  // A unit between nodes has to finish the edge it is on, as in the engine.
  function origin(unit: UnitFrame) {
    const node = nodeAt.get(unit.pos.join(","));
    if (node !== undefined) return { node, seconds: 0, edge: null };
    const [edge, forward] = unit.route[0] ?? [];
    if (edge !== undefined && data.edges[edge]) {
      const step = { edge, forward: forward === 1 };
      return {
        node: graph.stepEnd(step),
        seconds:
          graph.stepSeconds(step) *
          (1 - fractionAlong(unit.pos, data.edges[edge].geom, step.forward)),
        edge: unit.route[0],
      };
    }
    return {
      node: graph.nearestNode(unit.pos[0], unit.pos[1]),
      seconds: 0,
      edge: null,
    };
  }

  /** Router for the closures known at one instant. Road times are cached per origin and kind. */
  return function at(closed: number[], flooded: number[]): Router {
    const byKind = new Map<UnitKind, ReturnType<typeof closuresFor>>();
    const rules = (kind: UnitKind) => {
      let r = byKind.get(kind);
      if (!r) byKind.set(kind, (r = closuresFor(kind, closed, flooded)));
      return r;
    };
    const cache = new Map<string, Float64Array>();
    const timesFrom = (kind: UnitKind, node: number) => {
      const wades = UNIT_KINDS[kind].wades;
      const key = `${wades ? "w" : "r"}:${node}`;
      let times = cache.get(key);
      if (!times) {
        const { closed: shut, slow } = rules(kind);
        times = graph.timesFrom(node, shut, slow);
        cache.set(key, times);
      }
      return times;
    };
    const flies = (kind: UnitKind) => UNIT_KINDS[kind].flies;
    return {
      eta(unit, node) {
        if (flies(unit.kind))
          return flightTicks(metresBetween(unit.pos, data.nodes[node]));
        const { node: from, seconds } = origin(unit);
        return toTicks(timesFrom(unit.kind, from)[node] + seconds);
      },
      etaFrom(kind, from, node) {
        if (flies(kind))
          return flightTicks(metresBetween(data.nodes[from], data.nodes[node]));
        return toTicks(timesFrom(kind, from)[node]);
      },
      path(unit, node) {
        if (flies(unit.kind)) return [unit.pos, data.nodes[node]];
        const { node: from, edge } = origin(unit);
        const { closed: shut, slow } = rules(unit.kind);
        const found = graph.route(from, node, shut, slow);
        if (!found) return null;
        // Starts at the reported position, finishing the edge in progress first.
        return remainingRoute(
          {
            pos: unit.pos,
            route: [
              ...(edge ? [edge] : []),
              ...found.steps.map((s): [number, 0 | 1] => [s.edge, s.forward ? 1 : 0]),
            ],
          },
          data,
        );
      },
      pathFrom(kind, from, node) {
        if (flies(kind)) return [data.nodes[from], data.nodes[node]];
        const { closed: shut, slow } = rules(kind);
        const found = graph.route(from, node, shut, slow);
        if (!found) return null;
        return [
          data.nodes[from],
          ...found.steps.flatMap((s) => {
            const geom = data.edges[s.edge].geom;
            return (s.forward ? geom : [...geom].reverse()).slice(1);
          }),
        ];
      },
    };
  };
}

function fractionAlong(pos: LonLat, geom: LonLat[], forward: boolean) {
  const line = forward ? geom : [...geom].reverse();
  let total = 0,
    travelled = 0,
    best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [x, y] = line[i],
      dx = line[i + 1][0] - x,
      dy = line[i + 1][1] - y,
      length = Math.hypot(dx, dy),
      k = Math.max(
        0,
        Math.min(
          1,
          ((pos[0] - x) * dx + (pos[1] - y) * dy) / (length * length || 1),
        ),
      ),
      d = Math.hypot(pos[0] - x - k * dx, pos[1] - y - k * dy);
    if (d < best) {
      best = d;
      travelled = total + k * length;
    }
    total += length;
  }
  return total ? travelled / total : 1;
}
