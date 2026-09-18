// Lo que ve el Master cada turno: estado resumido + candidatos sobre los que puede actuar.
import { etaTurns } from "../coordinator.js";
import { statusOf } from "../entities/ambulance.js";
import { blockedEdges } from "../entities/street-cut.js";
import { haversine, type NodeId } from "../map/graph.js";
import { UNNAMED, type RoadMap } from "../map/road-map.js";
import { ambulanceAssignedTo, findInjured, type World } from "../world.js";

const ON_ROUTE_STREETS = 12;
const RANDOM_STREETS = 5;
const PLACES = 8;

export type StreetCandidate = { near: NodeId; onRoute: boolean }; // near: nodo alrededor del cual cortar

export type Briefing = {
  summary: object; // lo que se envía al modelo
  streets: Map<string, StreetCandidate>;
  places: NodeId[];
};

export function buildBriefing(w: World, map: RoadMap): Briefing {
  const blocked = blockedEdges(w.cuts);

  // calles en la ruta de alguna ambulancia (cortarlas fuerza desvíos), más unas aleatorias
  const streets = new Map<string, StreetCandidate>();
  for (const a of w.ambulances) {
    const target = a.target && findInjured(w, a.target);
    const path = target && map.shortestPath(a.position, target.position, blocked);
    for (let i = 1; path && i < path.length && streets.size < ON_ROUTE_STREETS; i++) {
      const street = map.edgeStreet(path[i - 1], path[i]);
      if (street !== UNNAMED && !streets.has(street)) streets.set(street, { near: path[i - 1], onRoute: true });
    }
  }
  const allStreets = map.streetNames();
  for (let goal = streets.size + RANDOM_STREETS; streets.size < goal; ) {
    const street = allStreets[Math.floor(Math.random() * allStreets.length)];
    if (!streets.has(street)) streets.set(street, { near: map.edgesOfStreet(street)[0][0], onRoute: false });
  }

  const places = Array.from({ length: PLACES }, () => map.randomNode());
  const km = (a: NodeId, b: NodeId) => +(haversine(map.coords(a), map.coords(b)) / 1000).toFixed(1);

  const summary = {
    turn: w.turn,
    stats: w.stats,
    ambulances: w.ambulances.map((a) => ({ id: a.id, en: map.streetOf(a.position), estado: statusOf(a), objetivo: a.target, eta: etaTurns(w, map, a) })),
    injured: w.injured.map((h) => ({ id: h.id, en: map.streetOf(h.position), ttl: h.ttl, ambulancia: ambulanceAssignedTo(w, h.id)?.id })),
    log: w.log.slice(-12),
    streets: [...streets].map(([name, { onRoute }]) => ({ name, enRutaDeAmbulancia: onRoute })),
    places: places.map((n, i) => ({
      i,
      calle: map.streetOf(n),
      km_a_base: km(n, w.base.position),
      km_a_ambulancia_mas_cercana: Math.min(...w.ambulances.map((a) => km(n, a.position))),
    })),
  };
  return { summary, streets, places };
}
