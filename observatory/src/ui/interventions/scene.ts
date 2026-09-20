import { remainingRoute } from "../map/routes";
import type {
  GraphData,
  LonLat,
  RunMeta,
  TickRecord,
} from "../engineTrace";
import type { AuditItem } from "../audit/model";
import {
  isolatedWaiting,
  unattended,
  type Intervention,
  type Prescription,
} from "./model";
import { metresBetween, type Router } from "./routing";

// What the decision room shows around one request: the map framed on it and the thread behind it.

export type SceneLine = {
  id: string;
  /** option: the trip an option orders. leg: its onward trip to hospital. before: the route the
   * blocked unit had. mission: a unit's current trip, when the whole fleet is the context. */
  kind: "option" | "leg" | "before" | "mission";
  optionId?: string;
  prescribed?: boolean;
  /** Option trips: the unit sent, where to if it is a hospital, and ticks until it gets there. */
  unitId?: string;
  hospitalId?: string;
  eta?: number;
  coords: LonLat[];
};

export type IncidentScene = {
  /** Incidents in focus: the request's one, or every unattended one in a surge. */
  incidents: string[];
  /** Units in play: the blocked or loaded one, the ones already on the incident, the ones an option would send. */
  units: string[];
  blocked: string | null;
  /** Hospitals an option would take someone to. */
  hospitals: string[];
  /** Streets that stopped the blocked unit: what its crew radioed, or known closures new on its route. */
  cause: number[];
  lines: SceneLine[];
  /** west, south, east, north */
  bounds: [number, number, number, number] | null;
};

export function incidentScene(
  item: Intervention,
  prescription: Prescription,
  record: TickRecord,
  records: TickRecord[],
  meta: RunMeta,
  graph: GraphData,
  router: Router,
): IncidentScene {
  const { frame } = record;
  const unitOf = (id: string) => frame.units.find((u) => u.id === id);
  const nodeOf = (hospitalId: string) =>
    meta.hospitals.find((h) => h.id === hospitalId)?.node;
  const incident = frame.incidents.find((i) => i.id === item.incidentId);
  const lines: SceneLine[] = [];
  const units = new Set<string>([
    ...item.units,
    ...frame.units
      .filter((u) => item.incidentId && u.incidentId === item.incidentId)
      .map((u) => u.id),
  ]);
  const hospitals = new Set<string>();

  prescription.options.forEach((option, i) => {
    const action = option.action;
    const unit = action && unitOf(action.unitId);
    // A phone call to a site moves no unit: nothing to draw.
    if (!action || !unit || action.type === "warn" || action.type === "call_zone") return;
    const target =
      action.type === "transport" ? nodeOf(action.hospitalId) : action.node;
    if (target === undefined) return;
    const coords = router.path(unit, target);
    if (!coords) return;
    const base = { optionId: option.id, prescribed: i === 0 };
    units.add(unit.id);
    lines.push({
      id: option.id,
      kind: "option",
      coords,
      unitId: unit.id,
      hospitalId: action.type === "transport" ? action.hospitalId : undefined,
      eta: router.eta(unit, target),
      ...base,
    });
    const onward = action.type === "dispatch" || action.type === "transport" ? action.hospitalId : undefined;
    if (onward) hospitals.add(onward);
    const leg =
      action.type === "dispatch" && action.hospitalId
        ? router.pathFrom(unit.kind, target, nodeOf(action.hospitalId)!)
        : null;
    if (leg) lines.push({ id: `${option.id}:leg`, kind: "leg", coords: leg, ...base });
  });

  // The route the blocked unit had just before, and what stopped it.
  const blocked = item.kind === "stranded" ? item.units[0] : null;
  const opening = records.find((r) => r.tick === item.openedTick);
  const previous = records.find((r) => r.tick === item.openedTick - 1);
  const before = blocked
    ? previous?.frame.units.find((u) => u.id === blocked)
    : undefined;
  let cause: number[] = [];
  if (blocked && opening) {
    const radioed = opening.events.flatMap((e) =>
      e.type === "road_blocked_found" && e.unitId === blocked ? e.edges : [],
    );
    const route = new Set(before?.route.map(([edge]) => edge) ?? []);
    const known = new Set(previous?.frame.knownClosedEdges ?? []);
    const newOnRoute = opening.frame.knownClosedEdges.filter(
      (e) => route.has(e) && !known.has(e),
    );
    cause = [...new Set([...radioed.filter((e) => route.has(e)), ...newOnRoute])];
    if (!cause.length) cause = [...new Set(radioed)];
  }
  if (before?.route.length)
    lines.push({ id: "before", kind: "before", coords: remainingRoute(before, graph) });

  // Saturation is about the whole fleet, isolated places about the units that can wade or fly.
  const focus =
    item.kind === "surge"
      ? unattended(frame).map((i) => i.id)
      : item.kind === "water"
        ? isolatedWaiting(frame).map((i) => i.id)
        : incident
          ? [incident.id]
          : [];
  const fleet =
    item.kind === "surge"
      ? frame.units
      : item.kind === "water"
        ? frame.units.filter((u) => u.kind === "rescue" || u.kind === "helicopter")
        : [];
  for (const unit of fleet) {
    units.add(unit.id);
    if (unit.route.length)
      lines.push({
        id: `mission:${unit.id}`,
        kind: "mission",
        coords: remainingRoute(unit, graph),
      });
  }

  // Frame the incident with its location uncertainty, and everything in play around it.
  const points: LonLat[] = [
    ...focus.flatMap((id) => {
      const i = frame.incidents.find((x) => x.id === id);
      if (!i) return [];
      const [lon, lat] = graph.nodes[i.node];
      const r = i.located ? 0 : i.locationErrorM;
      const dLat = r / 111320,
        dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
      return [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat + dLat],
      ] as LonLat[];
    }),
    ...[...units].flatMap((id) => {
      const unit = unitOf(id);
      return unit ? [unit.pos] : [];
    }),
    ...[...hospitals].flatMap((id) => {
      const node = nodeOf(id);
      return node === undefined ? [] : [graph.nodes[node]];
    }),
    ...lines.flatMap((l) => l.coords),
    ...cause.flatMap((e) => graph.edges[e]?.geom ?? []),
  ];
  return {
    incidents: focus,
    units: [...units],
    blocked,
    hospitals: [...hospitals],
    cause,
    lines,
    bounds: boundsOf(points),
  };
}

function boundsOf(points: LonLat[]): IncidentScene["bounds"] {
  if (!points.length) return null;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  // A single spot still needs a few streets around it.
  const pad = 0.004;
  return [
    Math.min(w, e - pad),
    Math.min(s, n - pad),
    Math.max(e, w + pad),
    Math.max(n, s + pad),
  ];
}

export type ThreadItem = AuditItem & {
  /** cause: what stopped the unit. opened: the record where the request opened. */
  mark?: "cause" | "opened";
};

/** The chain of thoughts behind a request: the calls about the incident, what crews radioed from it,
 * its units since it opened, and what the coordinator decided when the request came up. */
export function incidentThread(
  item: Intervention,
  items: AuditItem[],
  record: TickRecord,
): ThreadItem[] {
  const incident = record.frame.incidents.find((i) => i.id === item.incidentId);
  const about = new Set(
    [
      item.incidentId,
      item.victimId,
      incident?.sceneId,
      ...(incident?.callIds ?? []),
      ...(incident?.victims.map((v) => v.id) ?? []),
    ].filter((x): x is string => Boolean(x)),
  );
  const since = incident?.openedTick ?? item.openedTick;
  const units = new Set(item.units);
  return items.flatMap((x): ThreadItem[] => {
    const own = x.refs.some((r) => about.has(r));
    const crew = x.tick >= since && x.refs.some((r) => units.has(r));
    const decided = x.lane === "coordinator" && x.tick === item.openedTick;
    if (!own && !crew && !decided) return [];
    const opened =
      x.tick === item.openedTick &&
      (x.event?.type === "unit_stranded" || x.event?.type === "scene_not_found") &&
      units.has(x.event.unitId);
    const cause =
      x.tick === item.openedTick &&
      x.event?.type === "road_blocked_found" &&
      units.has(x.event.unitId);
    return [{ ...x, mark: cause ? "cause" : opened ? "opened" : undefined }];
  });
}

/** Distance from a node to the nearest known water, for the facts panel. */
export function metresToKnownWater(record: TickRecord, graph: GraphData, node: number) {
  const zones = record.frame.knownWater.zones;
  if (!zones.length) return null;
  return Math.max(
    0,
    Math.min(
      ...zones.map(
        (z) => metresBetween(graph.nodes[node], graph.nodes[z.node]) - z.radiusM,
      ),
    ),
  );
}
