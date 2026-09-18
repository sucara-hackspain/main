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

/** Routable street network. Edge weights are free-flow travel seconds. */
export class Graph {
  readonly data: GraphData;
  private readonly out: Arc[][];

  constructor(data: GraphData) {
    this.data = data;
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

  /** Fastest route avoiding closed edges, or null if unreachable. */
  route(from: number, to: number, closed: ReadonlySet<number> = NO_CLOSURES): Route | null {
    if (from === to) return { steps: [], seconds: 0 };
    const { dist, prev } = this.dijkstra(from, closed, to);
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
  timesFrom(from: number, closed: ReadonlySet<number> = NO_CLOSURES): Float64Array {
    return this.dijkstra(from, closed, -1).dist;
  }

  private dijkstra(from: number, closed: ReadonlySet<number>, target: number) {
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
        const nd = d + arc.seconds;
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
