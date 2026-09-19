import type { Graph } from "./graph";
import type { Belief, ObservedEvent, SceneKind, WaterZone } from "./types";

// What the coordinator thinks the water is doing. Nobody tells it in real time. It has:
//  - sightings: flood calls ("wet") and crews that had to turn back ("blocked"), exact but local;
//  - official maps: the whole picture, but minutes old when they arrive.
// From those it extrapolates. The believed flood always lags the real one.

/** Calls about these only happen where there is water. */
const WATER_MECHANISMS = new Set<SceneKind>(["vehicle_trapped", "flooded_home", "swept_away"]);
const DEFAULT_GROWTH_M = 5;
/** Around a spot where a crew turned back, assume this much is impassable too. */
const BLOCKED_SPOT_M = 150;
const FORECAST_HORIZONS = [0, 10, 20, 40];

export const impliesWater = (mechanism: SceneKind | null | undefined): boolean => !!mechanism && WATER_MECHANISMS.has(mechanism);

export function addSighting(belief: Belief, tick: number, node: number, from: string, kind: "wet" | "blocked"): void {
  belief.waterSightings.push({ tick, node, from, kind });
}

/** Where the front probably is now, given how old the last map is. */
export function projectedRadius(zone: WaterZone, tick: number): number {
  return Math.round(zone.radiusM + zone.growthM * Math.max(0, tick - zone.asOfTick));
}

type Bulletin = Extract<ObservedEvent, { type: "flood_bulletin" }>;

/** Official map: where each flood was `asOfTick`. Everything inside is closed to traffic from now on. */
export function applyBulletin(belief: Belief, bulletin: Bulletin, graph: Graph): void {
  for (const f of bulletin.floods) {
    let zone = belief.floods.find((z) => z.id === f.id);
    if (!zone) {
      zone = { id: f.id, name: f.name, node: f.node, radiusM: f.radiusM, asOfTick: bulletin.asOfTick, growthM: DEFAULT_GROWTH_M, bulletins: 0 };
      belief.floods.push(zone);
    } else if (bulletin.asOfTick > zone.asOfTick) {
      zone.growthM = Math.max(0, (f.radiusM - zone.radiusM) / (bulletin.asOfTick - zone.asOfTick));
    }
    zone.radiusM = f.radiusM;
    zone.asOfTick = bulletin.asOfTick;
    zone.bulletins++;

    const known = new Set(belief.closedEdges);
    graph.data.edges.forEach((e, edge) => {
      if (graph.distanceM(f.node, e.a) > f.radiusM || graph.distanceM(f.node, e.b) > f.radiusM) return;
      if (!known.has(edge)) belief.closedEdges.push(edge);
      if (!belief.floodedEdges.includes(edge)) belief.floodedEdges.push(edge);
    });
  }
}

export interface WaterPicture {
  /** Discs of impassable water and how fast each grows. */
  zones: { node: number; radiusM: number; growthM: number }[];
  closedEdges: number[];
}

/** The coordinator's picture: official floods pushed forward to now, plus a patch around every spot a crew turned back. */
export function believedWater(belief: Belief): WaterPicture {
  return {
    zones: [
      ...belief.floods.map((z) => ({ node: z.node, radiusM: projectedRadius(z, belief.tick), growthM: z.growthM })),
      ...belief.waterSightings.filter((s) => s.kind === "blocked").map((s) => ({ node: s.node, radiusM: BLOCKED_SPOT_M, growthM: DEFAULT_GROWTH_M })),
    ],
    closedEdges: belief.closedEdges,
  };
}

/**
 * When will the water leave a place with no way out by road? Distance to the water is not enough:
 * a neighbourhood is lost the moment its last bridge goes under, however far the water still is.
 * So push the water forward and check what can still be reached from a dry hospital.
 * Returns ticks until cut off (0 = already), or null if safe for the whole forecast.
 */
export function cutOffForecast(water: WaterPicture, hospitals: { node: number }[], graph: Graph): (node: number) => number | null {
  const { zones } = water;
  if (zones.length === 0) return () => null;
  // The hospital furthest from any water is our "outside world".
  const dryness = (node: number) => Math.min(...zones.map((z) => graph.distanceM(z.node, node) - z.radiusM));
  const base = [...hospitals].sort((a, b) => dryness(b.node) - dryness(a.node))[0].node;
  const fromCentre = zones.map((z) => graph.data.nodes.map((_, n) => graph.distanceM(z.node, n)));

  const reach = FORECAST_HORIZONS.map((ticks) => {
    const closed = new Set(water.closedEdges);
    graph.data.edges.forEach((e, edge) => {
      if (zones.some((z, i) => fromCentre[i][e.a] <= z.radiusM + z.growthM * ticks && fromCentre[i][e.b] <= z.radiusM + z.growthM * ticks)) closed.add(edge);
    });
    return graph.timesFrom(base, closed);
  });
  return (node) => {
    for (let i = 0; i < reach.length; i++) if (reach[i][node] === Infinity) return FORECAST_HORIZONS[i];
    return null;
  };
}
