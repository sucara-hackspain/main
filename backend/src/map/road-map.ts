import { MinHeap } from "./heap.js";
import { edgeKey, haversine, type Blocked, type Coords, type Edge, type Graph, type NodeId } from "./graph.js";

type Adjacent = { to: NodeId; meters: number; street: string };

export const UNNAMED = "(sin nombre)";

/** Mapa de carreteras inmutable: consultas de calles y rutas. Los cortes se pasan en cada consulta (`Blocked`). */
export class RoadMap {
  private readonly adjacency = new Map<NodeId, Adjacent[]>();
  private readonly namedNodes: NodeId[]; // nodos sobre una calle con nombre (legibles para humanos)

  constructor(readonly graph: Graph) {
    const add = (from: NodeId, adj: Adjacent) => {
      const list = this.adjacency.get(from);
      list ? list.push(adj) : this.adjacency.set(from, [adj]);
    };
    for (const [u, v, meters, street] of graph.edges) {
      add(u, { to: v, meters, street });
      add(v, { to: u, meters, street });
    }
    this.namedNodes = [...this.adjacency].filter(([, adj]) => adj.some((e) => e.street)).map(([n]) => n);
  }

  private adjacentTo = (n: NodeId): Adjacent[] => this.adjacency.get(n) ?? [];

  // ---- consultas ----

  coords = (n: NodeId): Coords => this.graph.nodes[n];
  streetOf = (n: NodeId): string => this.adjacentTo(n).find((e) => e.street)?.street ?? UNNAMED;
  edgeStreet = (u: NodeId, v: NodeId): string => this.adjacentTo(u).find((e) => e.to === v)?.street || UNNAMED;
  edgeLength = (u: NodeId, v: NodeId): number => this.adjacentTo(u).find((e) => e.to === v)?.meters ?? 0;
  edgesOfStreet = (street: string): Edge[] => this.graph.edges.filter((e) => e[3] === street);
  streetNames = (): string[] => [...new Set(this.graph.edges.map((e) => e[3]).filter(Boolean))];

  pathLength(path: NodeId[]): number {
    let meters = 0;
    for (let i = 1; i < path.length; i++) meters += this.edgeLength(path[i - 1], path[i]);
    return meters;
  }

  nearest(target: Coords): NodeId {
    let best = this.namedNodes[0], bestDistance = Infinity;
    for (const n of this.namedNodes) {
      const d = haversine(this.coords(n), target);
      if (d < bestDistance) (bestDistance = d), (best = n);
    }
    return best;
  }

  randomNode(): NodeId {
    return this.namedNodes[Math.floor(Math.random() * this.namedNodes.length)];
  }

  /** Un nodo de la calle que alguien nombra ("calle Colón, 12" o "Sueca" valen para "Carrer de Colón" / "Carrer de Sueca"), o null si no está en el mapa. */
  findStreet(spoken: string | null): NodeId | null {
    if (!spoken) return null;
    const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    // ponytail: se quitan tipo de vía, artículos y números y se buscan las palabras que quedan; sin traducir (Calabazas ≠ Carabasses)
    const NOISE = /\b(calle|carrer|avenida|avinguda|plaza|placa|camino|cami|paseo|passeig|de|del|la|las|les|el|els|los|numero|n)\b|\b[dl]'|[\d,.;:º°]+/g;
    const wanted = fold(spoken).replace(NOISE, " ").split(/\s+/).filter(Boolean);
    if (!wanted.length) return null;
    const names = this.streetNames();
    const street = names.find((s) => fold(s) === fold(spoken)) ?? names.filter((s) => wanted.every((w) => fold(s).includes(w))).sort((a, b) => a.length - b.length)[0];
    return street ? this.edgesOfStreet(street)[0][0] : null;
  }

  // ---- rutas ----

  /** Dijkstra desde `source` evitando `blocked`. Termina en cuanto todos los `targets` están resueltos. */
  dijkstra(source: NodeId, targets: Iterable<NodeId>, blocked: Blocked) {
    const distance = new Map<NodeId, number>([[source, 0]]);
    const previous = new Map<NodeId, NodeId>();
    const settled = new Set<NodeId>();
    const pending = new Set(targets);
    const heap = new MinHeap<NodeId>();
    heap.push(0, source);

    for (let top; (top = heap.pop()); ) {
      const [d, u] = top;
      if (settled.has(u)) continue;
      settled.add(u);
      if (pending.delete(u) && !pending.size) break;
      for (const { to, meters } of this.adjacentTo(u)) {
        if (blocked.has(edgeKey(u, to))) continue;
        const candidate = d + meters;
        if (candidate < (distance.get(to) ?? Infinity)) {
          distance.set(to, candidate);
          previous.set(to, u);
          heap.push(candidate, to);
        }
      }
    }
    return { distance, previous };
  }

  /** Camino más corto de `from` a `to` evitando `blocked`, o null si no hay. */
  shortestPath(from: NodeId, to: NodeId, blocked: Blocked): NodeId[] | null {
    if (from === to) return [from];
    const { distance, previous } = this.dijkstra(from, [to], blocked);
    if (!distance.has(to)) return null;
    const path = [to];
    for (let n = to; n !== from; ) path.push((n = previous.get(n)!));
    return path.reverse();
  }
}
