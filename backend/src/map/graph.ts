import { readFileSync } from "node:fs";

export type NodeId = number; // id de nodo OSM
export type Coords = [lat: number, lon: number];
export type Edge = [u: NodeId, v: NodeId, meters: number, street: string];

/** Callejero como grafo no dirigido (las ambulancias ignoran los sentidos únicos). */
export type Graph = { nodes: Record<NodeId, Coords>; edges: Edge[] };

/** Aristas bloqueadas, identificadas por `edgeKey`. */
export type Blocked = ReadonlySet<string>;
export const NOTHING_BLOCKED: Blocked = new Set();

export const edgeKey = (u: NodeId, v: NodeId) => (u < v ? `${u}-${v}` : `${v}-${u}`);

export const loadGraph = (file: string): Graph => JSON.parse(readFileSync(file, "utf8"));

/** Distancia en metros entre dos coordenadas. */
export function haversine([lat1, lon1]: Coords, [lat2, lon2]: Coords): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
