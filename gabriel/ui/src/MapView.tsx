import type { Feature, FeatureCollection } from "geojson";
import { Map as MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { LAYERS, SOURCES } from "./layers";
import type { GraphData, IncidentKind, LonLat, RunMeta, TickRecord, UnitFrame, UnitKind } from "../../src/engine";

export type View = "truth" | "belief";

export interface MapHandle {
  /** Draw the world at a fractional tick index; positions are interpolated between frames. */
  draw(ticks: TickRecord[], playhead: number, view: View): void;
}

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const DEAD_VISIBLE_TICKS = 20;

export const KIND_COLOR: Record<UnitKind, string> = { svb: "#38bdf8", sva: "#c084fc", heli: "#f472b6", fire: "#fb923c", police: "#60a5fa" };
export const INCIDENT_LABEL: Record<IncidentKind, string> = { accident: "ACCIDENTE", fire: "FUEGO", collapse: "DERRUMBE", flood_rescue: "RESCATE", obstacle: "VÍA BLOQUEADA" };
const SEVERITY_COLOR = { critico: "#ef4444", grave: "#f97316", leve: "#facc15" };

const collection = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
const point = (coordinates: LonLat, properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates }, properties });
const line = (coordinates: LonLat[], properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties });

function circle(center: LonLat, radiusM: number, properties: Record<string, unknown>): Feature {
  const ring: LonLat[] = [];
  const dLat = radiusM / 111_320;
  const dLon = dLat / Math.cos((center[1] * Math.PI) / 180);
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    ring.push([center[0] + dLon * Math.cos(a), center[1] + dLat * Math.sin(a)]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties };
}

export function unitState(u: UnitFrame): { label: string; color: string } {
  if (u.broken) return { label: "fuera de servicio", color: "#ef4444" };
  if (u.mission === "to_patient") return { label: `va a por ${u.targetPatientId}`, color: "#f8fafc" };
  if (u.mission === "on_scene") return { label: `con ${u.targetPatientId} (atrapado)`, color: "#f59e0b" };
  if (u.mission === "to_hospital") return { label: `lleva ${u.patientId} → ${u.hospitalId}`, color: "#22c55e" };
  if (u.mission === "to_incident") return { label: `va a ${u.incidentId}`, color: "#f8fafc" };
  if (u.mission === "working") return { label: `trabajando en ${u.incidentId}`, color: "#f59e0b" };
  if (u.patientId) return { label: `con ${u.patientId}, sin destino`, color: "#f59e0b" };
  if (u.mission === "reposition") return { label: "reubicándose", color: "#f8fafc" };
  return { label: "libre", color: "#475569" };
}

export const MapView = forwardRef<MapHandle, { graph: GraphData; meta: RunMeta }>(({ graph, meta }, ref) => {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<[TickRecord[], number, View] | null>(null);

  const draw = (ticks: TickRecord[], playhead: number, view: View) => {
    const m = map.current;
    if (!m || !ready.current) {
      pending.current = [ticks, playhead, view];
      return;
    }
    if (ticks.length === 0) return;
    const i = Math.min(Math.floor(playhead), ticks.length - 1);
    const t = playhead - i;
    const { frame, tick } = ticks[i];
    const next = ticks[i + 1]?.frame;
    const belief = view === "belief";

    const units: Feature[] = [];
    const routes: Feature[] = [];
    frame.units.forEach((u) => {
      const to = next?.units.find((n) => n.id === u.id)?.pos ?? u.pos;
      const pos: LonLat = [u.pos[0] + (to[0] - u.pos[0]) * t, u.pos[1] + (to[1] - u.pos[1]) * t];
      const color = KIND_COLOR[u.kind];
      units.push(point(pos, { label: u.id.replace(/^(SVB|SVA|BOM|POL|HELI)/, (k) => ({ SVB: "B", SVA: "M", BOM: "F", POL: "PL", HELI: "HE" })[k]!), color, state: unitState(u).color, big: u.kind === "heli" ? 1 : 0 }));
      if (u.kind === "heli" && u.destNode !== null) routes.push(line([pos, graph.nodes[u.destNode]], { color, air: 1 }));
      else if (u.route.length > 0) {
        const coords: LonLat[] = [pos];
        u.route.forEach(([edge, forward], step) => {
          const geom = graph.edges[edge].geom;
          const ordered = forward ? geom : [...geom].reverse();
          coords.push(...(step === 0 ? ordered.slice(-1) : ordered));
        });
        routes.push(line(coords, { color, air: 0 }));
      }
    });

    const patients: Feature[] = [];
    for (const p of frame.patients) {
      if (belief && !p.known) continue;
      if (p.status === "waiting") {
        patients.push(point(graph.nodes[p.node], { label: `${p.id}${p.phantom && !belief ? " ¿?" : ` · ${p.ttl}`}`, color: p.phantom && !belief ? "#94a3b8" : SEVERITY_COLOR[p.severity], trapped: p.trapped ? 1 : 0, known: p.known ? 1 : 0, r: p.severity === "critico" ? 9 : 7 }));
      } else if (p.status === "dead" && p.endTick !== null && tick - p.endTick <= DEAD_VISIBLE_TICKS) {
        patients.push(point(graph.nodes[p.node], { label: `${p.id} ✕`, color: "#475569", trapped: 0, known: 1, r: 5 }));
      }
    }

    const hospitals = meta.hospitals.map((h) => {
      const state = frame.hospitals.find((x) => x.id === h.id);
      const occupied = state?.occupied ?? 0;
      return point(graph.nodes[h.node], { label: state?.offline ? `${h.id} CERRADO` : `${h.id} ${h.capacity - occupied}/${h.capacity}`, down: state?.offline || occupied >= h.capacity ? 1 : 0 });
    });

    const incidents = frame.incidents.filter((x) => !belief || x.known).map((x) => point(graph.nodes[x.node], { label: `${x.id} ${INCIDENT_LABEL[x.kind]}`, kind: x.kind, known: x.known ? 1 : 0 }));

    const zones: Feature[] = [];
    for (const z of frame.zones) {
      if (!belief) zones.push(circle(z.center, z.radiusM, { kind: z.kind, layer: "truth" }));
      if (z.knownRadiusM !== null) zones.push(circle(z.center, z.knownRadiusM, { kind: z.kind, layer: belief ? "truth" : "known" }));
    }

    const knownClosed = new Set(frame.knownClosedEdges);
    const closed = frame.closedEdges.filter((e) => !belief || knownClosed.has(e)).map((edge) => line(graph.edges[edge].geom, { known: knownClosed.has(edge) ? 1 : 0 }));

    const set = (id: string, features: Feature[]) => (m.getSource(id) as GeoJSONSource).setData(collection(features));
    set("zones", zones);
    set("routes", routes);
    set("closed", closed);
    set("incidents", incidents);
    set("hospitals", hospitals);
    set("patients", patients);
    set("units", units);
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
     try {
      for (const id of SOURCES) {
        m.addSource(id, { type: "geojson", data: collection([]) });
      }
      for (const layer of LAYERS) m.addLayer(layer);
      ready.current = true;
      if (pending.current) draw(...pending.current);
     } catch (err) {
      console.error("[map] layers failed:", err);
      (window as unknown as { __mapError: string }).__mapError = String(err);
     }
    });

    return () => {
      ready.current = false;
      m.remove();
    };
  }, [graph]);

  return <div ref={container} className="map" />;
});
