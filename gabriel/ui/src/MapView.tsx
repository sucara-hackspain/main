import type { Feature, FeatureCollection } from "geojson";
import { Map as MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { UnitFrame, GraphData, LonLat, RunMeta, TickRecord } from "../../src/engine";

export type ViewMode = "belief" | "truth";

export interface MapHandle {
  /** Draw the world at a fractional tick index; positions are interpolated between frames. */
  draw(ticks: TickRecord[], playhead: number, mode: ViewMode, selectedIncident: string | null): void;
}

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const FONT = ["Noto Sans Regular"];
export const KIND_COLORS = { ambulance: "#f8fafc", fire: "#ef4444", rescue: "#3b82f6", helicopter: "#e879f9" } as const;
export const KIND_LABELS = { ambulance: "Ambulancia", fire: "Bomberos", rescue: "Rescate acuático", helicopter: "Helicóptero" } as const;
export const AMBULANCE_COLORS = ["#38bdf8", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#fb923c", "#22d3ee", "#e879f9"];
const DEAD_VISIBLE_TICKS = 20;
export const PRIORITY_COLORS = ["#ef4444", "#f97316", "#facc15", "#4ade80"];
const TRIAGE_COLORS = { red: "#ef4444", yellow: "#facc15", green: "#4ade80", black: "#475569" };

const collection = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
const point = (coordinates: LonLat, properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates },
  properties,
});
const line = (coordinates: LonLat[], properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties,
});
/** Circle of `meters` around a point, as a polygon the map can fill. */
const disc = (center: LonLat, meters: number, properties: Record<string, unknown>): Feature => {
  const ring: LonLat[] = [];
  const dLat = meters / 111320;
  const dLon = dLat / Math.cos((center[1] * Math.PI) / 180);
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    ring.push([center[0] + dLon * Math.cos(a), center[1] + dLat * Math.sin(a)]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties };
};

export function ambulanceState(a: UnitFrame): { label: string; color: string } {
  if (a.broken) return { label: "averiada", color: "#ef4444" };
  if (a.mission === "to_scene") return { label: `va al incidente ${a.incidentId}`, color: "#38bdf8" };
  if (a.mission === "to_hospital") return { label: `lleva ${a.victimId} → ${a.hospitalId}`, color: "#22c55e" };
  if (a.mission === "reposition") return { label: "reubicándose", color: "#94a3b8" };
  if (a.victimId) return { label: `con ${a.victimId}, sin destino`, color: "#f59e0b" };
  return { label: "libre", color: "#94a3b8" };
}

export const MapView = forwardRef<MapHandle, { graph: GraphData; meta: RunMeta }>(({ graph, meta }, ref) => {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<[TickRecord[], number, ViewMode, string | null] | null>(null);

  const draw = (ticks: TickRecord[], playhead: number, mode: ViewMode, selectedIncident: string | null) => {
    const m = map.current;
    if (!m || !ready.current) {
      pending.current = [ticks, playhead, mode, selectedIncident];
      return;
    }
    if (ticks.length === 0) return;
    const i = Math.min(Math.floor(playhead), ticks.length - 1);
    const t = playhead - i;
    const { frame, tick } = ticks[i];
    const next = ticks[i + 1]?.frame;

    const ambulances: Feature[] = [];
    const routes: Feature[] = [];
    frame.units.forEach((a, index) => {
      const to = next?.units[index]?.pos ?? a.pos;
      const pos: LonLat = [a.pos[0] + (to[0] - a.pos[0]) * t, a.pos[1] + (to[1] - a.pos[1]) * t];
      const color = KIND_COLORS[a.kind];
      ambulances.push(point(pos, { id: a.id, color, state: ambulanceState(a).color, loaded: a.victimId ? 1 : 0 }));
      if (a.route.length > 0) {
        const coords: LonLat[] = [pos];
        a.route.forEach(([edge, forward], step) => {
          const geom = graph.edges[edge].geom;
          const ordered = forward ? geom : [...geom].reverse();
          coords.push(...(step === 0 ? ordered.slice(-1) : ordered));
        });
        routes.push(line(coords, { color }));
      }
    });

    // Truth: the impassable core and the shallow fringe around it. Belief: old official maps pushed forward, plus sightings.
    const floods =
      mode === "truth"
        ? frame.floods.flatMap((f) => [disc(graph.nodes[f.node], f.fringeM, { kind: "fringe" }), disc(graph.nodes[f.node], f.radiusM, { kind: "core" })])
        : [];
    const knownWater = frame.knownWater.zones.map((z) => disc(graph.nodes[z.node], z.radiusM, {}));
    const sightings = frame.knownWater.sightings.map((w) => point(graph.nodes[w.node], { kind: w.kind, fresh: w.ageTicks <= 30 ? 1 : 0 }));

    // What the coordinator believes: incidents, each with how unsure it is about where.
    const incidents: Feature[] = [];
    const zones: Feature[] = [];
    for (const inc of frame.incidents) {
      if (inc.status !== "open") continue;
      const color = PRIORITY_COLORS[inc.priority];
      const selected = inc.id === selectedIncident ? 1 : 0;
      if (inc.locationErrorM > 0) zones.push(disc(graph.nodes[inc.node], inc.locationErrorM, { color, selected }));
      const warn = inc.cutOffIn === null ? "" : inc.cutOffIn === 0 ? " · AISLADO" : ` · agua <${inc.cutOffIn}`;
      incidents.push(point(graph.nodes[inc.node], { label: `${inc.id} · P${inc.priority}${warn}`, color, selected, located: inc.located ? 1 : 0 }));
    }

    // What is really there. Only the human supervisor gets to see this layer.
    const victims: Feature[] = [];
    if (mode === "truth") {
      for (const scene of frame.scenes) {
        const shown = scene.victims.filter(
          (v) => v.status === "waiting" || (v.status === "dead" && v.endTick !== null && tick - v.endTick <= DEAD_VISIBLE_TICKS),
        );
        shown.forEach((v, i) => {
          const [lon, lat] = graph.nodes[scene.node];
          // Fan victims of one scene out a little so they do not sit on top of each other.
          const offset = (i - (shown.length - 1) / 2) * 0.00025;
          const label = v.status === "dead" ? `${v.id} ✕` : `${v.id}${v.ttl === null ? "" : ` · ${v.ttl}`}`;
          victims.push(point([lon + offset, lat], { label, color: TRIAGE_COLORS[v.triage] }));
        });
      }
    }

    const hospitals = meta.hospitals.map((h) => {
      const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
      return point(graph.nodes[h.node], { label: `${h.id} ${h.capacity - occupied}/${h.capacity}`, full: occupied >= h.capacity ? 1 : 0 });
    });

    const known = new Set(frame.knownClosedEdges);
    const closed = (mode === "truth" ? frame.closedEdges : frame.knownClosedEdges).map((edge) => line(graph.edges[edge].geom, { known: known.has(edge) ? 1 : 0 }));

    (m.getSource("routes") as GeoJSONSource).setData(collection(routes));
    (m.getSource("closed") as GeoJSONSource).setData(collection(closed));
    (m.getSource("hospitals") as GeoJSONSource).setData(collection(hospitals));
    (m.getSource("floods") as GeoJSONSource).setData(collection(floods));
    (m.getSource("knownWater") as GeoJSONSource).setData(collection(knownWater));
    (m.getSource("sightings") as GeoJSONSource).setData(collection(sightings));
    (m.getSource("zones") as GeoJSONSource).setData(collection(zones));
    (m.getSource("incidents") as GeoJSONSource).setData(collection(incidents));
    (m.getSource("victims") as GeoJSONSource).setData(collection(victims));
    (m.getSource("ambulances") as GeoJSONSource).setData(collection(ambulances));
  };

  useImperativeHandle(ref, () => ({ draw }));

  useEffect(() => {
    const [south, west, north, east] = graph.bbox;
    const m = new MapLibreMap({
      container: container.current!,
      style: STYLE,
      bounds: [west, south, east, north],
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true },
    });
    map.current = m;
    m.on("error", (e) => console.error("[map]", e.error?.message ?? e));
    m.addControl(new NavigationControl({ showCompass: false }), "top-left");

    m.on("load", () => {
      for (const id of ["floods", "knownWater", "sightings", "zones", "routes", "closed", "hospitals", "incidents", "victims", "ambulances"]) {
        m.addSource(id, { type: "geojson", data: collection([]) });
      }
      m.addLayer({
        id: "floods",
        type: "fill",
        source: "floods",
        paint: { "fill-color": "#2563eb", "fill-opacity": ["match", ["get", "kind"], "core", 0.4, 0.12] },
      });
      m.addLayer({ id: "known-water", type: "fill", source: "knownWater", paint: { "fill-color": "#22d3ee", "fill-opacity": 0.12 } });
      m.addLayer({
        id: "known-water-edge",
        type: "line",
        source: "knownWater",
        paint: { "line-color": "#22d3ee", "line-width": 2, "line-dasharray": [3, 2] },
      });
      m.addLayer({
        id: "zones",
        type: "fill",
        source: "zones",
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["==", ["get", "selected"], 1], 0.35, 0.16] },
      });
      m.addLayer({
        id: "zone-outlines",
        type: "line",
        source: "zones",
        paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [2, 2] },
      });
      m.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.75 },
      });
      m.addLayer({
        id: "closed",
        type: "line",
        source: "closed",
        layout: { "line-cap": "round" },
        paint: { "line-color": ["case", ["==", ["get", "known"], 1], "#fb923c", "#ef4444"], "line-width": 3, "line-opacity": 0.8 },
      });
      m.addLayer({
        id: "sightings",
        type: "circle",
        source: "sightings",
        paint: {
          "circle-radius": ["match", ["get", "kind"], "blocked", 5, 3],
          "circle-color": ["match", ["get", "kind"], "blocked", "#22d3ee", "#0b1120"],
          "circle-stroke-color": "#22d3ee",
          "circle-stroke-width": 1.5,
          "circle-opacity": ["case", ["==", ["get", "fresh"], 1], 1, 0.35],
          "circle-stroke-opacity": ["case", ["==", ["get", "fresh"], 1], 1, 0.35],
        },
      });
      m.addLayer({
        id: "hospitals",
        type: "circle",
        source: "hospitals",
        paint: {
          "circle-radius": 9,
          "circle-color": ["case", ["==", ["get", "full"], 1], "#7f1d1d", "#f8fafc"],
          "circle-stroke-color": "#ef4444",
          "circle-stroke-width": 3,
        },
      });
      m.addLayer({
        id: "hospital-labels",
        type: "symbol",
        source: "hospitals",
        layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 12, "text-offset": [0, 1.5], "text-allow-overlap": true },
        paint: { "text-color": "#f8fafc", "text-halo-color": "#0b1120", "text-halo-width": 2 },
      });
      m.addLayer({
        id: "incidents",
        type: "circle",
        source: "incidents",
        paint: {
          "circle-radius": ["case", ["==", ["get", "selected"], 1], 9, 6],
          "circle-color": ["case", ["==", ["get", "located"], 1], ["get", "color"], "#0b1120"],
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 3,
        },
      });
      m.addLayer({
        id: "incident-labels",
        type: "symbol",
        source: "incidents",
        layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1.5], "text-allow-overlap": true },
        paint: { "text-color": ["get", "color"], "text-halo-color": "#0b1120", "text-halo-width": 2 },
      });
      m.addLayer({
        id: "victims",
        type: "circle",
        source: "victims",
        paint: { "circle-radius": 5, "circle-color": ["get", "color"], "circle-stroke-color": "#f8fafc", "circle-stroke-width": 1.5 },
      });
      m.addLayer({
        id: "victim-labels",
        type: "symbol",
        source: "victims",
        layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 10, "text-offset": [0, 1.4], "text-allow-overlap": true },
        paint: { "text-color": "#f8fafc", "text-halo-color": "#0b1120", "text-halo-width": 2 },
      });
      m.addLayer({
        id: "ambulances",
        type: "circle",
        source: "ambulances",
        paint: {
          "circle-radius": 10,
          "circle-color": ["get", "state"],
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 4,
        },
      });
      m.addLayer({
        id: "ambulance-labels",
        type: "symbol",
        source: "ambulances",
        layout: { "text-field": ["get", "id"], "text-font": FONT, "text-size": 9, "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#0b1120" },
      });
      ready.current = true;
      if (pending.current) draw(...pending.current);
    });

    return () => {
      ready.current = false;
      m.remove();
    };
  }, [graph]);

  return <div ref={container} className="map" />;
});
