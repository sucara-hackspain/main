// El callejero en el formato del Control Center (crisis-observatory): nodos por índice, aristas con geometría, y el hospital base.
import { edgeKey, type NodeId } from "./graph.js";
import type { RoadMap } from "./road-map.js";

export const UI_MAP_NAME = "valencia-ui";
export const HOSPITAL_ID = "LaFe";

type LonLat = [number, number];
export type UiGraph = {
  data: { name: string; bbox: [number, number, number, number]; nodes: LonLat[]; edges: { a: number; b: number; len: number; kph: number; oneway: boolean; name?: string; geom: LonLat[] }[]; hospitals: { name: string; lon: number; lat: number; node: number; emergency: boolean }[] };
  nodeIndex: Map<NodeId, number>; // id OSM → índice en `nodes`
  edgeIndex: Map<string, number>; // edgeKey(u, v) → índice en `edges`
};

const cache = new WeakMap<RoadMap, UiGraph>();

export function uiGraph(map: RoadMap, base: NodeId): UiGraph {
  const cached = cache.get(map);
  if (cached) return cached;
  const ids = Object.keys(map.graph.nodes).map(Number);
  const nodeIndex = new Map(ids.map((id, i) => [id, i]));
  const nodes: LonLat[] = ids.map((id) => [map.graph.nodes[id][1], map.graph.nodes[id][0]]);
  const edgeIndex = new Map<string, number>();
  const edges = map.graph.edges.map(([u, v, len, street], i) => {
    edgeIndex.set(edgeKey(u, v), i);
    const a = nodeIndex.get(u)!, b = nodeIndex.get(v)!;
    return { a, b, len, kph: 36, oneway: false, name: street || undefined, geom: [nodes[a], nodes[b]] };
  });
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]; // sur, oeste, norte, este
  for (const [lon, lat] of nodes) bbox[0] = Math.min(bbox[0], lat), bbox[1] = Math.min(bbox[1], lon), bbox[2] = Math.max(bbox[2], lat), bbox[3] = Math.max(bbox[3], lon);
  const [lat, lon] = map.graph.nodes[base];
  const g: UiGraph = { data: { name: UI_MAP_NAME, bbox, nodes, edges, hospitals: [{ name: "Hospital La Fe", lon, lat, node: nodeIndex.get(base)!, emergency: true }] }, nodeIndex, edgeIndex };
  cache.set(map, g);
  return g;
}
