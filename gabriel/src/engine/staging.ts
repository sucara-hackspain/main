import type { Graph } from "./graph";
import { believedWater, cutOffForecast, projectedRadius } from "./water";
import type { Belief, Incident, Unit } from "./types";

// Where a free unit can be told to wait, and the standing orders that keep it there. The engine always let a unit
// be moved anywhere; what was missing is a vocabulary a coordinator can plan with: named places ahead of the water,
// and a way to say "this one stays free for that" that outlives the decision it was said in.

export interface StagingPoint {
  /** `E1N`: north of flood 1's front, ten ticks from now. */
  id: string;
  node: number;
  label: string;
}

const AHEAD_TICKS = 10;
const CLEAR_OF_THE_FRONT_M = 350;
const BEARINGS: [string, string, number, number][] = [
  ["N", "norte", 0, 1],
  ["E", "este", 1, 0],
  ["S", "sur", 0, -1],
  ["O", "oeste", -1, 0],
];

/** Dry places just outside where each flood will be in ten ticks, that the water is not about to cut off. */
export function stagingPoints(belief: Belief, graph: Graph, tick: number): StagingPoint[] {
  const cutOffIn = cutOffForecast(believedWater(belief), belief.hospitals, graph);
  const points: StagingPoint[] = [];
  belief.floods.forEach((flood, index) => {
    const [lon, lat] = graph.data.nodes[flood.node];
    const reach = projectedRadius(flood, tick + AHEAD_TICKS) + CLEAR_OF_THE_FRONT_M;
    for (const [code, name, dx, dy] of BEARINGS) {
      const node = graph.nearestNode(lon + (dx * reach) / (111_320 * Math.cos((lat * Math.PI) / 180)), lat + (dy * reach) / 111_320);
      // The map ends somewhere: a point the bearing could not really reach is not a place to wait.
      if (Math.abs(graph.distanceM(flood.node, node) - reach) > 250 || cutOffIn(node) !== null) continue;
      points.push({ id: `E${index + 1}${code}`, node, label: `al ${name} del frente de ${flood.name}, en seco${graph.streetAt(node) ? ` (${graph.streetAt(node)})` : ""}` });
    }
  });
  return points;
}

export type HoldFor = "agua" | "P0" | "nada";

export interface Hold {
  unitId: string;
  /** The only kind of incident this unit may be spent on while the hold lasts. */
  onlyFor: HoldFor;
  untilTick: number;
  reason: string;
}

const IN_WATER = new Set(["swept_away", "flooded_home", "vehicle_trapped"]);

export function holdAllows(hold: Hold, incident: Incident): boolean {
  if (hold.onlyFor === "agua") return incident.unreachable || IN_WATER.has(incident.mechanism?.value ?? "");
  if (hold.onlyFor === "P0") return incident.priority === 0;
  return false;
}

/** The hold on this unit, if one is still running. */
export function holdOn(holds: Hold[], unit: Unit, tick: number): Hold | undefined {
  return holds.find((h) => h.unitId === unit.id && h.untilTick > tick);
}
