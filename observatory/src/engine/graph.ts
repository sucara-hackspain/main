import type { GraphData, LonLat, Step } from "./types";

interface Arc {
  edge: number;
  to: number;
  forward: boolean;
  seconds: number;
}

export interface Route {
  steps: Step[];
  seconds: number;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop(): [number, number] {
    const { keys, vals } = this;
    const top: [number, number] = [keys[0], vals[0]];
    const key = keys.pop()!;
    const val = vals.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        vals[i] = vals[child];
        i = child;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}

const NO_CLOSURES: ReadonlySet<number> = new Set();
const WRONG_WAY_FACTOR = 3;
export const WADING_FACTOR = 4;

/** Routable street network. Edge weights are free-flow travel seconds. */
/** The map is in Valencian; callers often say the street in Spanish. */
const STREET_IN_VALENCIAN: Record<string, string> = { reino: "regne", san: "sant", puerto: "port", nuevo: "nou", nueva: "nova", iglesia: "esglesia", pintor: "pintor", doctor: "doctor", cardenal: "cardenal", arzobispo: "arquebisbe", obispo: "bisbe", maestro: "mestre", cruz: "creu", fuente: "font", huerta: "horta", antiguo: "antic", viejo: "vell", camino: "cami" };

/** Words that are part of how a street is said, not of which street it is. */
const STREET_NOISE = new Set(["calle", "carrer", "avenida", "avinguda", "av", "avda", "plaza", "placa", "camino", "cami", "paseo", "passeig", "de", "del", "la", "el", "les", "los", "las", "en", "numero"]);

export class Graph {
  readonly data: GraphData;
  private readonly out: Arc[][];

  constructor(data: GraphData) {
    this.data = data;
    this.out = data.nodes.map(() => []);
    data.edges.forEach((e, edge) => {
      const seconds = e.len / (e.kph / 3.6);
      this.out[e.a].push({ edge, to: e.b, forward: true, seconds });
      // Everything routed here is an emergency vehicle: it may go against a one-way street, slowly.
      // Without this, a flooded exit turns a one-way carriageway into a trap with no way back.
      this.out[e.b].push({ edge, to: e.a, forward: false, seconds: e.oneway ? seconds * WRONG_WAY_FACTOR : seconds });
    });
  }

  get nodeCount(): number {
    return this.data.nodes.length;
  }

  get edgeCount(): number {
    return this.data.edges.length;
  }

  stepStart(step: Step): number {
    const e = this.data.edges[step.edge];
    return step.forward ? e.a : e.b;
  }

  stepEnd(step: Step): number {
    const e = this.data.edges[step.edge];
    return step.forward ? e.b : e.a;
  }

  stepSeconds(step: Step): number {
    const e = this.data.edges[step.edge];
    const seconds = e.len / (e.kph / 3.6);
    return e.oneway && !step.forward ? seconds * WRONG_WAY_FACTOR : seconds;
  }

  edgeName(edge: number): string | null {
    return this.data.edges[edge].name ?? null;
  }

  /** Fastest route avoiding closed edges, or null if unreachable. */
  route(from: number, to: number, closed: ReadonlySet<number> = NO_CLOSURES, slow: ReadonlySet<number> = NO_CLOSURES): Route | null {
    if (from === to) return { steps: [], seconds: 0 };
    const { dist, prev } = this.dijkstra(from, closed, to, slow);
    if (dist[to] === Infinity) return null;
    const steps: Step[] = [];
    for (let node = to; node !== from; ) {
      const arc = prev[node]!;
      steps.push({ edge: arc.edge, forward: arc.forward });
      node = this.stepStart(arc);
    }
    steps.reverse();
    return { steps, seconds: dist[to] };
  }

  /** Travel seconds from one node to every node (Infinity if unreachable). */
  timesFrom(from: number, closed: ReadonlySet<number> = NO_CLOSURES, slow: ReadonlySet<number> = NO_CLOSURES): Float64Array {
    return this.dijkstra(from, closed, -1, slow).dist;
  }

  /** `slow` edges (flooded streets a rescue unit wades through) cost WADING_FACTOR times more. */
  private dijkstra(from: number, closed: ReadonlySet<number>, target: number, slow: ReadonlySet<number>) {
    const dist = new Float64Array(this.nodeCount).fill(Infinity);
    const prev: (Arc | undefined)[] = new Array(this.nodeCount);
    const heap = new MinHeap();
    dist[from] = 0;
    heap.push(0, from);
    while (heap.size > 0) {
      const [d, node] = heap.pop();
      if (d > dist[node]) continue;
      if (node === target) break;
      for (const arc of this.out[node]) {
        if (closed.has(arc.edge)) continue;
        const nd = d + (slow.has(arc.edge) ? arc.seconds * WADING_FACTOR : arc.seconds);
        if (nd < dist[arc.to]) {
          dist[arc.to] = nd;
          prev[arc.to] = arc;
          heap.push(nd, arc.to);
        }
      }
    }
    return { dist, prev };
  }

  /**
   * Where a street someone named is: a node about halfway along it, or null if the map has no such street.
   * Forgiving the way an operator is: accents, "calle/carrer/avinguda", articles and word order do not matter.
   */
  findStreet(spoken: string): number | null {
    const words = (text: string) =>
      text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, " ").split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STREET_NOISE.has(w))
        .map((w) => STREET_IN_VALENCIAN[w] ?? w);
    const wanted = words(spoken);
    if (wanted.length === 0) return null;
    let best: { name: string; score: number } | null = null;
    const byName = new Map<string, number[]>();
    this.data.edges.forEach((edge, id) => {
      if (!edge.name) return;
      const list = byName.get(edge.name);
      if (list) list.push(id);
      else byName.set(edge.name, [id]);
    });
    for (const name of byName.keys()) {
      const have = words(name);
      // "Vicente" is "Vicent", "Peris y Valero" is "Peris i Valero": the same word with a Spanish or a Valencian ending.
      const same = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
      const hits = wanted.filter((w) => have.some((h) => same(w, h))).length;
      if (hits === 0) continue;
      // Either everything the caller said is in the name ("Sueca" for "Carrer de Sueca"), or the whole name is in
      // what they said ("Jaume Roig 2, puerta A, junto al garaje"). The more words in common, the better the match.
      const named = have.every((h) => wanted.some((w) => same(w, h)));
      if (hits < wanted.length && !named) continue;
      const score = hits - (have.length - hits) * 0.05;
      if (!best || score > best.score) best = { name, score };
    }
    if (!best) return null;
    const edges = byName.get(best.name)!;
    return this.data.edges[edges[Math.floor(edges.length / 2)]].a;
  }

  /** Name of a street touching this node, if any is named. */
  streetAt(node: number): string | null {
    for (const arc of this.out[node]) {
      const name = this.data.edges[arc.edge].name;
      if (name) return name;
    }
    return null;
  }

  /** Straight-line metres between two nodes. */
  distanceM(a: number, b: number): number {
    const [lon1, lat1] = this.data.nodes[a];
    const [lon2, lat2] = this.data.nodes[b];
    const rad = Math.PI / 180;
    const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
    const y = (lat2 - lat1) * rad;
    return Math.hypot(x, y) * 6371000;
  }

  /** Nodes within `meters` of a node, itself included. */
  nodesWithin(node: number, meters: number): number[] {
    const found: number[] = [];
    for (let i = 0; i < this.nodeCount; i++) if (this.distanceM(node, i) <= meters) found.push(i);
    return found;
  }

  nearestNode(lon: number, lat: number): number {
    const cos = Math.cos((lat * Math.PI) / 180);
    let best = 0;
    let bestD = Infinity;
    this.data.nodes.forEach((p, i) => {
      const dx = (p[0] - lon) * cos;
      const dy = p[1] - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Point at `fraction` (0..1) of a step, following the street geometry. */
  pointAlong(step: Step, fraction: number): LonLat {
    const geom = this.data.edges[step.edge].geom;
    const line = step.forward ? geom : [...geom].reverse();
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < line.length; i++) {
      const l = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      lengths.push(l);
      total += l;
    }
    let remaining = Math.min(Math.max(fraction, 0), 1) * total;
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i] && lengths[i] > 0) {
        const t = remaining / lengths[i];
        return [
          line[i][0] + (line[i + 1][0] - line[i][0]) * t,
          line[i][1] + (line[i + 1][1] - line[i][1]) * t,
        ];
      }
      remaining -= lengths[i];
    }
    return line[line.length - 1];
  }
}
