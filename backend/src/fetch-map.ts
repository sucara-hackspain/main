// Descarga el callejero de OSM (Overpass) y lo guarda como grafo compacto en data/valencia.json
import { mkdirSync, writeFileSync } from "node:fs";
import { MAP_FILE } from "./config.js";
import { haversine, type Graph, type NodeId } from "./map/graph.js";

const BBOX = "39.40,-0.45,39.49,-0.34"; // S,W,N,E — València ciudad + l'Horta Sud (zona DANA). ponytail: knob
const HIGHWAYS = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
const QUERY = `[out:json][timeout:120];way["highway"~"^(${HIGHWAYS})$"](${BBOX});out body;>;out skel qt;`;

type El = { type: "node"; id: number; lat: number; lon: number } | { type: "way"; id: number; nodes: number[]; tags?: Record<string, string> };

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "User-Agent": "dana-sim/0.1 (hackathon)", Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
  body: "data=" + encodeURIComponent(QUERY),
});
if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
const els: El[] = (await res.json()).elements;

const pos = new Map<NodeId, [number, number]>();
for (const e of els) if (e.type === "node") pos.set(e.id, [+e.lat.toFixed(6), +e.lon.toFixed(6)]);
const edges: Graph["edges"] = [];
for (const w of els) {
  if (w.type !== "way") continue;
  for (let i = 1; i < w.nodes.length; i++) {
    const [u, v] = [w.nodes[i - 1], w.nodes[i]];
    if (pos.has(u) && pos.has(v)) edges.push([u, v, Math.round(haversine(pos.get(u)!, pos.get(v)!)), w.tags?.name ?? ""]);
  }
}

// Nos quedamos con la componente conexa más grande: sin islas inalcanzables
const adj = new Map<NodeId, NodeId[]>();
for (const [u, v] of edges) (adj.get(u) ?? adj.set(u, []).get(u)!).push(v), (adj.get(v) ?? adj.set(v, []).get(v)!).push(u);
const comp = new Map<NodeId, number>();
let best = 0, bestSize = 0;
for (const start of adj.keys()) {
  if (comp.has(start)) continue;
  const id = comp.size, stack = [start];
  comp.set(start, id);
  let size = 0;
  for (let n; (n = stack.pop()) !== undefined; ) for (const x of (size++, adj.get(n)!)) if (!comp.has(x)) comp.set(x, id), stack.push(x);
  if (size > bestSize) (bestSize = size), (best = id);
}
const keep = edges.filter(([u]) => comp.get(u) === best);
const nodes: Graph["nodes"] = {};
for (const [u, v] of keep) (nodes[u] = pos.get(u)!), (nodes[v] = pos.get(v)!);

mkdirSync("data", { recursive: true });
writeFileSync(MAP_FILE, JSON.stringify({ nodes, edges: keep }));
console.log(`${MAP_FILE}: ${Object.keys(nodes).length} nodos, ${keep.length} tramos (descartados ${edges.length - keep.length} de islas)`);
