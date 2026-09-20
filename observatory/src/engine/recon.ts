import type { Graph } from "./graph";
import type { Belief, Incident } from "./types";
import { believedWater } from "./water";

// Deciding what you do NOT know, and what it would be worth going to look at.
//
// Two very different holes in the picture:
//  - an incident someone called about, but nobody has seen: ±400 m, "no sabe cuántos hay";
//  - a piece of the city that is simply silent. Silence is not good news. A neighbourhood that was
//    calling and stopped, or one that never called while the streets around it did, is either empty
//    or out of reach: no line, no battery, nobody left conscious. Only a look tells you which.

/** Side of a zone: about two or three blocks, the area one aerial look covers. */
const ZONE_M = 700;
/** A cell with fewer street nodes than this is not a neighbourhood: sea, fields, a motorway junction. */
const MIN_ZONE_NODES = 12;
/** How far back "recent activity" goes. */
const WINDOW_TICKS = 40;
/** Under this, another look at the same place is not worth a unit. */
const RESCOUT_TICKS = 50;
/** How far around a zone counts as "next door". */
const NEIGHBOUR_M = 1400;
/** A look this recent by a crew on the ground beats anything a drone could add. */
const FRESH_GROUND_TICKS = 25;

export interface Zone {
  id: string;
  /** Node at the centre of the cell: where an observer would be sent. */
  node: number;
  nodes: number[];
  name: string | null;
}

/** Where the coordinator is deciding blind, and what it would learn by looking. */
export interface InfoGap {
  /** The incident (C7) or the zone (Z12) to look at: what an order names. */
  id: string;
  node: number;
  kind: "incident" | "silence";
  /** Higher = more worth spending a unit on. */
  score: number;
  /** The reasoning, in words, for the briefing and for a human audit. */
  why: string;
}

const CACHE = new WeakMap<Graph, { zones: Zone[]; byNode: Int32Array }>();

/** The city cut into zones, once per map. */
export function zonesOf(graph: Graph): Zone[] {
  return index(graph).zones;
}

export function zoneById(graph: Graph, id: string): Zone | undefined {
  return index(graph).zones.find((z) => z.id === id);
}

/** The zone a node falls in, or undefined if that corner of the map is not a neighbourhood. */
export function zoneAt(graph: Graph, node: number): Zone | undefined {
  const i = index(graph).byNode[node];
  return i < 0 ? undefined : index(graph).zones[i];
}

function index(graph: Graph): { zones: Zone[]; byNode: Int32Array } {
  const cached = CACHE.get(graph);
  if (cached) return cached;

  const [south, west, north, east] = graph.data.bbox;
  const rad = Math.PI / 180;
  const midLat = (south + north) / 2;
  const lonStep = ZONE_M / (6371000 * rad * Math.cos(midLat * rad));
  const latStep = ZONE_M / (6371000 * rad);
  const cols = Math.max(1, Math.ceil((east - west) / lonStep));
  const rows = Math.max(1, Math.ceil((north - south) / latStep));

  const cells = new Map<number, number[]>();
  graph.data.nodes.forEach(([lon, lat], node) => {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((lon - west) / lonStep)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((lat - south) / latStep)));
    const cell = row * cols + col;
    (cells.get(cell) ?? cells.set(cell, []).get(cell)!).push(node);
  });

  const zones: Zone[] = [];
  const byNode = new Int32Array(graph.nodeCount).fill(-1);
  for (const [cell, nodes] of [...cells].sort((a, b) => a[0] - b[0])) {
    if (nodes.length < MIN_ZONE_NODES) continue;
    // Whichever node is closest to the middle of the cell stands for it.
    const lon = nodes.reduce((sum, n) => sum + graph.data.nodes[n][0], 0) / nodes.length;
    const lat = nodes.reduce((sum, n) => sum + graph.data.nodes[n][1], 0) / nodes.length;
    const centre = nodes.reduce((best, n) =>
      Math.hypot(graph.data.nodes[n][0] - lon, graph.data.nodes[n][1] - lat) <
      Math.hypot(graph.data.nodes[best][0] - lon, graph.data.nodes[best][1] - lat)
        ? n
        : best,
    );
    const zone: Zone = { id: `Z${cell}`, node: centre, nodes, name: graph.streetAt(centre) };
    const i = zones.push(zone) - 1;
    for (const n of nodes) byNode[n] = i;
  }

  const built = { zones, byNode };
  CACHE.set(graph, built);
  return built;
}

/** Ticks since this place was last looked at from the air, or null if never (a bad look ages faster). */
function lastLook(belief: Belief, graph: Graph, node: number): number | null {
  let best: number | null = null;
  for (const s of belief.scouts) {
    if (graph.distanceM(s.node, node) > s.radiusM) continue;
    // Half a look is worth half the time: a report at quality 0.5 goes stale twice as fast.
    const age = (belief.tick - s.tick) / Math.max(0.35, s.quality);
    if (best === null || age < best) best = age;
  }
  return best;
}

/** What a crew on the ground has already confirmed nearby: no drone adds to that. */
function groundTruthNear(belief: Belief, graph: Graph, node: number, radiusM: number): boolean {
  return belief.incidents.some(
    (i) => i.located && belief.tick - i.updatedTick <= FRESH_GROUND_TICKS && graph.distanceM(i.node, node) <= radiusM,
  );
}

function incidentGap(incident: Incident, belief: Belief, tick: number): InfoGap | null {
  if (incident.status !== "open" || incident.located) return null;
  if (belief.units.some((u) => u.mission === "to_observe" && u.incidentId === incident.id)) return null;

  const reasons: string[] = [];
  let score = (3 - incident.priority) * 8;
  if (incident.locationErrorM >= 150) {
    reasons.push(`solo sabes dónde es con ±${incident.locationErrorM} m`);
    score += Math.min(20, incident.locationErrorM / 20);
  }
  if (!incident.victimsReported && !incident.foci.some((f) => f.peopleSeen)) {
    reasons.push("nadie ha dicho cuántos heridos hay");
    score += 8;
  }
  if (incident.unreachable) {
    reasons.push("sin ruta por carretera: hay que saber si de verdad hace falta un rescate");
    score += 12;
  }
  if (!incident.conscious && !incident.breathing) {
    reasons.push("no sabes si responde ni si respira");
    score += 6;
  }
  if (reasons.length === 0) return null;

  // Somebody is already on the way: it will be confirmed on its own in a moment.
  const heading = belief.units.filter((u) => u.incidentId === incident.id && u.mission === "to_scene" && u.brokenUntil === null);
  if (heading.length > 0) score -= 25;
  if (incident.seenTick !== null) score -= Math.max(0, 25 - (tick - incident.seenTick));
  if (score <= 0) return null;

  return {
    id: incident.id,
    node: incident.node,
    kind: "incident",
    score: score + Math.min(10, (tick - incident.openedTick) / 4),
    why: `P${incident.priority} a ciegas: ${reasons.join("; ")}`,
  };
}

/**
 * Silence, read as information. A zone that has gone quiet while its neighbours keep calling, or one
 * the water is reaching without a single call from it, is the most likely place for people nobody
 * has counted yet. It may also be that there is genuinely nobody there — which is exactly why you look.
 */
function silenceGaps(belief: Belief, graph: Graph, tick: number): InfoGap[] {
  const water = believedWater(belief);
  const gaps: InfoGap[] = [];

  const callsByZone = new Map<string, number[]>();
  for (const call of belief.calls) {
    const zone = zoneAt(graph, call.node);
    if (!zone) continue;
    (callsByZone.get(zone.id) ?? callsByZone.set(zone.id, []).get(zone.id)!).push(call.tick);
  }

  for (const zone of zonesOf(graph)) {
    const ticks = callsByZone.get(zone.id) ?? [];
    const recent = ticks.filter((t) => tick - t <= WINDOW_TICKS).length;
    if (recent > 0) continue; // it is talking to you: no need to go and look

    const look = lastLook(belief, graph, zone.node);
    if (look !== null && look < RESCOUT_TICKS) continue;
    if (groundTruthNear(belief, graph, zone.node, 400)) continue;

    const neighbours = [...callsByZone].reduce((sum, [id, list]) => {
      const other = zonesOf(graph).find((z) => z.id === id)!;
      if (other.id === zone.id || graph.distanceM(other.node, zone.node) > NEIGHBOUR_M) return sum;
      return sum + list.filter((t) => tick - t <= WINDOW_TICKS).length;
    }, 0);

    const nearWater = water.zones.some((z) => graph.distanceM(z.node, zone.node) <= z.radiusM + 900);
    const quietFor = ticks.length ? tick - Math.max(...ticks) : null;

    const reasons: string[] = [];
    let score = Math.min(12, zone.nodes.length / 8);
    if (quietFor !== null) {
      reasons.push(`llamaron ${ticks.length} vez(ces) y llevan ${quietFor} ticks en silencio`);
      score += 14;
    } else {
      reasons.push("ni una sola llamada en toda la noche");
      score += 6;
    }
    if (neighbours >= 2) {
      reasons.push(`alrededor sí llaman (${neighbours} llamadas a menos de 1,4 km)`);
      score += Math.min(18, neighbours * 3);
    }
    if (nearWater) {
      reasons.push("y el agua ya está encima");
      score += 16;
    }
    if (look !== null) score -= 10;
    // Without neighbours calling and without water, silence is probably just a quiet street.
    if (neighbours < 2 && !nearWater && quietFor === null) continue;

    gaps.push({
      id: zone.id,
      node: zone.node,
      kind: "silence",
      score,
      why:
        `${zone.name ? `zona de ${zone.name}` : "zona sin calle nombrada"}: ${reasons.join(", ")}. ` +
        "O no hay nadie, o no hay quien pueda llamar (sin cobertura, sin batería, nadie consciente).",
    });
  }
  return gaps;
}

/** Everything worth going to look at right now, best first. Somewhere a unit is already flying to is not a gap. */
export function infoGaps(belief: Belief, graph: Graph, tick: number, limit = 6): InfoGap[] {
  const gaps: InfoGap[] = [];
  for (const incident of belief.incidents) {
    const gap = incidentGap(incident, belief, tick);
    if (gap) gaps.push(gap);
  }
  gaps.push(...silenceGaps(belief, graph, tick));

  const onTheWay = belief.units.filter((u) => u.mission === "to_observe" && u.destNode !== null).map((u) => u.destNode!);
  return gaps
    .filter((gap) => !onTheWay.some((node) => graph.distanceM(node, gap.node) <= ZONE_M / 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Node an order's target names, whether it is an incident or a zone. */
export function scoutTargetNode(belief: Belief, graph: Graph, target: string): number | null {
  const incident = belief.incidents.find((i) => i.id === target && !i.mergedInto);
  if (incident) return incident.node;
  return zoneById(graph, target)?.node ?? null;
}
