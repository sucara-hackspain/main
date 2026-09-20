// Downloads the drivable street network + hospitals of a bbox from OpenStreetMap
// (Overpass API) and writes a compact routable graph to data/<name>.json.
//
//   pnpm fetch-graph                                   -> valencia (default bbox)
//   pnpm fetch-graph madrid 40.38,-3.75,40.48,-3.63    -> bbox is south,west,north,east
import { writeFileSync } from "node:fs";
import type { EdgeData, GraphData, HospitalData, LonLat } from "../src/engine/types";

const OVERPASS = "https://overpass-api.de/api/interpreter";

const DEFAULT_KPH: Record<string, number> = {
  motorway: 100,
  trunk: 80,
  primary: 50,
  secondary: 50,
  tertiary: 40,
  unclassified: 30,
  residential: 30,
  living_street: 15,
  motorway_link: 50,
  trunk_link: 40,
  primary_link: 40,
  secondary_link: 40,
  tertiary_link: 30,
};

interface OsmNode { type: "node"; id: number; lon: number; lat: number }
interface OsmWay { type: "way"; id: number; nodes: number[]; tags?: Record<string, string> }
interface OsmPoi {
  type: string;
  id: number;
  lon?: number;
  lat?: number;
  center?: { lon: number; lat: number };
  tags?: Record<string, string>;
}

async function overpass<T>(query: string): Promise<T[]> {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "crisis-sim/0.1" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { elements: T[] }).elements;
}

function haversine(a: LonLat, b: LonLat): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Largest strongly connected component (iterative Kosaraju), so every node can reach every other.
function largestScc(nodeIds: number[], arcs: [number, number][]): Set<number> {
  const fwd = new Map<number, number[]>();
  const rev = new Map<number, number[]>();
  for (const id of nodeIds) {
    fwd.set(id, []);
    rev.set(id, []);
  }
  for (const [u, v] of arcs) {
    fwd.get(u)!.push(v);
    rev.get(v)!.push(u);
  }
  const visited = new Set<number>();
  const order: number[] = [];
  for (const root of nodeIds) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack: [number, number][] = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = fwd.get(top[0])!;
      if (top[1] < next.length) {
        const v = next[top[1]++];
        if (!visited.has(v)) {
          visited.add(v);
          stack.push([v, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const assigned = new Set<number>();
  let best: number[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i];
    if (assigned.has(root)) continue;
    assigned.add(root);
    const comp = [root];
    for (let j = 0; j < comp.length; j++) {
      for (const v of rev.get(comp[j])!) {
        if (!assigned.has(v)) {
          assigned.add(v);
          comp.push(v);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return new Set(best);
}

const round6 = (p: LonLat): LonLat => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];

async function main() {
  const name = process.argv[2] ?? "valencia";
  const bboxArg = process.argv[3] ?? "39.435,-0.425,39.505,-0.315";
  const [s, w, n, e] = bboxArg.split(",").map(Number);
  const bbox = `${s},${w},${n},${e}`;

  console.log(`Fetching streets for ${name} (${bbox})...`);
  const highwayRe = `^(${Object.keys(DEFAULT_KPH).join("|")})$`;
  const elements = await overpass<OsmNode | OsmWay>(
    `[out:json][timeout:180];way["highway"~"${highwayRe}"]["access"!~"^(private|no)$"]["area"!="yes"](${bbox});out body;>;out skel qt;`,
  );
  console.log("Fetching hospitals...");
  const pois = await overpass<OsmPoi>(
    `[out:json][timeout:60];nwr["amenity"="hospital"](${bbox});out center tags;`,
  );

  const coords = new Map<number, LonLat>();
  const ways: OsmWay[] = [];
  for (const el of elements) {
    if (el.type === "node") coords.set(el.id, [el.lon, el.lat]);
    else if (el.type === "way") ways.push(el);
  }

  // A graph node is any OSM node that ends a way or is shared between ways (an intersection).
  const uses = new Map<number, number>();
  for (const way of ways) {
    way.nodes.forEach((id, i) => {
      const isEnd = i === 0 || i === way.nodes.length - 1;
      uses.set(id, (uses.get(id) ?? 0) + (isEnd ? 2 : 1));
    });
  }

  interface RawEdge { a: number; b: number; oneway: boolean; kph: number; name?: string; path: number[] }
  const raw: RawEdge[] = [];
  for (const way of ways) {
    const tags = way.tags ?? {};
    const hw = tags.highway;
    let nodes = way.nodes.filter((id) => coords.has(id));
    let oneway =
      ["yes", "true", "1", "-1"].includes(tags.oneway ?? "") ||
      tags.junction === "roundabout" ||
      tags.junction === "circular" ||
      hw === "motorway" ||
      hw === "motorway_link";
    if (tags.oneway === "no") oneway = false;
    if (tags.oneway === "-1") nodes = [...nodes].reverse();
    const parsed = parseInt(tags.maxspeed ?? "", 10);
    const kph = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KPH[hw];

    let start = 0;
    for (let i = 1; i < nodes.length; i++) {
      if ((uses.get(nodes[i]) ?? 0) > 1) {
        const path = nodes.slice(start, i + 1);
        if (path[0] !== path[path.length - 1]) {
          raw.push({ a: path[0], b: path[path.length - 1], oneway, kph, name: tags.name, path });
        }
        start = i;
      }
    }
  }

  const arcs: [number, number][] = [];
  const endpointIds = new Set<number>();
  for (const r of raw) {
    arcs.push([r.a, r.b]);
    if (!r.oneway) arcs.push([r.b, r.a]);
    endpointIds.add(r.a);
    endpointIds.add(r.b);
  }
  const keep = largestScc([...endpointIds], arcs);

  const index = new Map<number, number>();
  const nodes: LonLat[] = [];
  const nodeIndex = (osmId: number): number => {
    let i = index.get(osmId);
    if (i === undefined) {
      i = nodes.length;
      index.set(osmId, i);
      nodes.push(round6(coords.get(osmId)!));
    }
    return i;
  };

  const edges: EdgeData[] = [];
  for (const r of raw) {
    if (!keep.has(r.a) || !keep.has(r.b)) continue;
    const geom = r.path.map((id) => round6(coords.get(id)!));
    let len = 0;
    for (let i = 1; i < geom.length; i++) len += haversine(geom[i - 1], geom[i]);
    if (len < 1) len = 1;
    const edge: EdgeData = {
      a: nodeIndex(r.a),
      b: nodeIndex(r.b),
      len: Math.round(len * 10) / 10,
      kph: r.kph,
      oneway: r.oneway,
      geom,
    };
    if (r.name) edge.name = r.name;
    edges.push(edge);
  }

  const nearest = (p: LonLat): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const dx = (nodes[i][0] - p[0]) * Math.cos((p[1] * Math.PI) / 180);
      const dy = nodes[i][1] - p[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const hospitals: HospitalData[] = [];
  const seen = new Set<string>();
  for (const poi of pois) {
    const hName = poi.tags?.name;
    const lon = poi.lon ?? poi.center?.lon;
    const lat = poi.lat ?? poi.center?.lat;
    if (!hName || lon === undefined || lat === undefined || seen.has(hName)) continue;
    seen.add(hName);
    hospitals.push({
      name: hName,
      lon,
      lat,
      node: nearest([lon, lat]),
      emergency: poi.tags?.emergency === "yes",
    });
  }

  const graph: GraphData = { name, bbox: [s, w, n, e], nodes, edges, hospitals };
  const out = `data/${name}.json`;
  writeFileSync(out, JSON.stringify(graph));
  console.log(`${out}: ${nodes.length} nodes, ${edges.length} edges, ${hospitals.length} hospitals`);
  for (const h of hospitals) console.log(`  ${h.emergency ? "[ER]" : "    "} ${h.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
