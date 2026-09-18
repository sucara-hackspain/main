import type { Feature, FeatureCollection } from "geojson";
import { Map as MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { AmbulanceFrame, GraphData, LonLat, RunMeta, TickRecord } from "../../src/engine";

export interface MapHandle {
  /** Draw the world at a fractional tick index; positions are interpolated between frames. */
  draw(ticks: TickRecord[], playhead: number): void;
}

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const FONT = ["Noto Sans Regular"];
export const AMBULANCE_COLORS = ["#38bdf8", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#fb923c", "#22d3ee", "#e879f9"];
const DEAD_VISIBLE_TICKS = 20;

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

export function ambulanceState(a: AmbulanceFrame): { label: string; color: string } {
  if (a.broken) return { label: "averiada", color: "#ef4444" };
  if (a.stranded) return { label: "bloqueada", color: "#f97316" };
  if (a.mission === "to_patient") return { label: `va a por ${a.targetPatientId}`, color: "#38bdf8" };
  if (a.mission === "to_hospital") return { label: `lleva ${a.patientId} → ${a.hospitalId}`, color: "#22c55e" };
  if (a.patientId) return { label: `con ${a.patientId}, sin destino`, color: "#f59e0b" };
  return { label: "libre", color: "#94a3b8" };
}

export const MapView = forwardRef<MapHandle, { graph: GraphData; meta: RunMeta }>(({ graph, meta }, ref) => {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<[TickRecord[], number] | null>(null);

  const draw = (ticks: TickRecord[], playhead: number) => {
    const m = map.current;
    if (!m || !ready.current) {
      pending.current = [ticks, playhead];
      return;
    }
    if (ticks.length === 0) return;
    const i = Math.min(Math.floor(playhead), ticks.length - 1);
    const t = playhead - i;
    const { frame, tick } = ticks[i];
    const next = ticks[i + 1]?.frame;

    const ambulances: Feature[] = [];
    const routes: Feature[] = [];
    frame.ambulances.forEach((a, index) => {
      const to = next?.ambulances[index]?.pos ?? a.pos;
      const pos: LonLat = [a.pos[0] + (to[0] - a.pos[0]) * t, a.pos[1] + (to[1] - a.pos[1]) * t];
      const color = AMBULANCE_COLORS[index % AMBULANCE_COLORS.length];
      ambulances.push(point(pos, { id: a.id, color, state: ambulanceState(a).color, loaded: a.patientId ? 1 : 0 }));
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

    const patients: Feature[] = [];
    for (const p of frame.patients) {
      if (p.status === "waiting") {
        const urgency = p.ttl <= 10 ? "critical" : p.ttl <= 25 ? "urgent" : "stable";
        patients.push(point(graph.nodes[p.node], { label: `${p.id} · ${p.ttl}`, urgency }));
      } else if (p.status === "dead" && p.endTick !== null && tick - p.endTick <= DEAD_VISIBLE_TICKS) {
        patients.push(point(graph.nodes[p.node], { label: `${p.id} ✕`, urgency: "dead" }));
      }
    }

    const hospitals = meta.hospitals.map((h) => {
      const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
      return point(graph.nodes[h.node], { label: `${h.id} ${h.capacity - occupied}/${h.capacity}`, full: occupied >= h.capacity ? 1 : 0 });
    });

    const closed = frame.closedEdges.map((edge) => line(graph.edges[edge].geom, {}));

    (m.getSource("routes") as GeoJSONSource).setData(collection(routes));
    (m.getSource("closed") as GeoJSONSource).setData(collection(closed));
    (m.getSource("hospitals") as GeoJSONSource).setData(collection(hospitals));
    (m.getSource("patients") as GeoJSONSource).setData(collection(patients));
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
      for (const id of ["routes", "closed", "hospitals", "patients", "ambulances"]) {
        m.addSource(id, { type: "geojson", data: collection([]) });
      }
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
        paint: { "line-color": "#ef4444", "line-width": 6, "line-opacity": 0.9 },
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
        id: "patients",
        type: "circle",
        source: "patients",
        paint: {
          "circle-radius": ["match", ["get", "urgency"], "critical", 9, "urgent", 7, "dead", 5, 6],
          "circle-color": ["match", ["get", "urgency"], "critical", "#ef4444", "urgent", "#f97316", "dead", "#475569", "#facc15"],
          "circle-stroke-color": "#0b1120",
          "circle-stroke-width": 2,
        },
      });
      m.addLayer({
        id: "patient-labels",
        type: "symbol",
        source: "patients",
        layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1.4], "text-allow-overlap": true },
        paint: { "text-color": "#fde68a", "text-halo-color": "#0b1120", "text-halo-width": 2 },
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
        layout: { "text-field": ["get", "id"], "text-font": FONT, "text-size": 11, "text-allow-overlap": true, "text-ignore-placement": true },
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
