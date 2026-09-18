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

/** Edges that can be driven but at a crawl (a fire engine in a flooded street). */
export interface SlowEdges {
  edges: ReadonlySet<number>;
  factor: number;
}

export function distM(a: LonLat, b: LonLat): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Routable street network. Edge weights are free-flow travel seconds. */
export class Graph {
  readonly data: GraphData;
  private readonly out: Arc[][];
  private readonly midpoints: LonLat[];

  constructor(data: GraphData) {
    this.data = data;
    this.midpoints = data.edges.map((e) => e.geom[Math.floor(e.geom.length / 2)]);
    this.out = data.nodes.map(() => []);
    data.edges.forEach((e, edge) => {
      const seconds = e.len / (e.kph / 3.6);
      this.out[e.a].push({ edge, to: e.b, forward: true, seconds });
      if (!e.oneway) this.out[e.b].push({ edge, to: e.a, forward: false, seconds });
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
    return e.len / (e.kph / 3.6);
  }

  edgeName(edge: number): string | null {
    return this.data.edges[edge].name ?? null;
  }

  edgeMidpoint(edge: number): LonLat {
    return this.midpoints[edge];
  }

  /** Ids of the edges that touch a node. */
  edgesAt(node: number): number[] {
    return this.out[node].map((arc) => arc.edge);
  }

  /** Edges whose midpoint lies within radiusM of a point. */
  edgesWithin(center: LonLat, radiusM: number): number[] {
    const found: number[] = [];
    this.midpoints.forEach((p, edge) => {
      if (distM(center, p) <= radiusM) found.push(edge);
    });
    return found;
  }

  /** Fastest route avoiding closed edges, or null if unreachable. */
  route(from: number, to: number, closed: ReadonlySet<number> = NO_CLOSURES, slow?: SlowEdges): Route | null {
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
  timesFrom(from: number, closed: ReadonlySet<number> = NO_CLOSURES, slow?: SlowEdges): Float64Array {
    return this.dijkstra(from, closed, -1, slow).dist;
  }

  private dijkstra(from: number, closed: ReadonlySet<number>, target: number, slow?: SlowEdges) {
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
        const nd = d + (slow?.edges.has(arc.edge) ? arc.seconds * slow.factor : arc.seconds);
        if (nd < dist[arc.to]) {
          dist[arc.to] = nd;
          prev[arc.to] = arc;
          heap.push(nd, arc.to);
        }
      }
    }
    return { dist, prev };
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
