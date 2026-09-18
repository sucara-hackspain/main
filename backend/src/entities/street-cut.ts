import { edgeKey, haversine, type Blocked, type NodeId } from "../map/graph.js";
import type { RoadMap } from "../map/road-map.js";

/** Tramo de calle cortado (inundado, derrumbado…). */
export type StreetCut = { u: NodeId; v: NodeId; street: string };

export const blockedEdges = (cuts: StreetCut[]): Blocked => new Set(cuts.map((c) => edgeKey(c.u, c.v)));

/** Tramos de `street` aún no cortados; con `near`, solo los que están a menos de `radius` m de ese nodo. */
export function planStreetCut(map: RoadMap, existing: StreetCut[], street: string, near?: NodeId, radius = Infinity): StreetCut[] {
  const blocked = blockedEdges(existing);
  return map
    .edgesOfStreet(street)
    .filter(([u, v]) => !blocked.has(edgeKey(u, v)) && (near === undefined || haversine(map.coords(u), map.coords(near)) < radius))
    .map(([u, v]) => ({ u, v, street }));
}
