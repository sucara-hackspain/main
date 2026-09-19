import { useEffect, useRef, useState } from "react";
import * as ml from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { LocateFixed } from "lucide-react";
import {
  patientStatus,
  type GraphData,
  type RunMeta,
  type TickRecord,
} from "../runModel";
import { remainingRoute } from "./routes";
import { entityKey, sameEntity, selectionPosition, type EntityRef, type Situation } from "../situation/model";
import "./map.css";
ml.setWorkerUrl(workerUrl);
const empty: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
export default function RunMap({
  graph,
  meta,
  record,
  selected,
  onSelect,
  situation,
  related,
  matches,
  filtered,
  focusRequest,
}: {
  graph: GraphData;
  meta: RunMeta;
  record: TickRecord;
  selected: EntityRef | null;
  onSelect: (ref: EntityRef) => void;
  situation: Situation;
  related: Set<string>;
  matches: Set<string>;
  filtered: boolean;
  focusRequest: number;
}) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<ml.Map | null>(null),
    callback = useRef(onSelect),
    [ready, setReady] = useState(false),
    [error, setError] = useState(false);
  callback.current = onSelect;
  const focusPosition = useRef<[number, number] | undefined>(undefined);
  focusPosition.current = selected ? selectionPosition(situation, graph, selected) : undefined;
  const selectedKey = selected ? entityKey(selected) : null;
  useEffect(() => {
    if (ready && selectedKey && focusPosition.current) map.current?.easeTo({ center: focusPosition.current, zoom: Math.max(map.current.getZoom(), 13), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350 });
  }, [ready, selectedKey, focusRequest]);
  useEffect(() => {
    if (ready && focusRequest > 0 && window.matchMedia("(max-width: 800px)").matches) host.current?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [ready, focusRequest]);
  const markers = useRef<ml.Marker[]>([]);
  function fit() {
    const [s, w, n, e] = graph.bbox;
    map.current?.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 50, duration: 300 },
    );
  }
  useEffect(() => {
    const [s, w, n, e] = graph.bbox;
    const m = new ml.Map({
      container: host.current!,
      style: "https://tiles.openfreemap.org/styles/positron",
      bounds: [
        [w, s],
        [e, n],
      ],
      fitBoundsOptions: { padding: 50 },
      attributionControl: { compact: true },
    });
    map.current = m;
    m.addControl(
      new ml.NavigationControl({ showCompass: false }),
      "bottom-left",
    );
    m.on("error", () => setError(true));
    m.on("load", () => {
      for (const id of ["run-routes", "run-cuts"])
        m.addSource(id, { type: "geojson", data: empty });
      const theme = getComputedStyle(host.current!);
      m.addLayer({
        id: "run-routes",
        type: "line",
        source: "run-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": theme.getPropertyValue("--info").trim(),
          "line-width": ["case", ["boolean", ["get", "related"], false], 4, 2.5],
          "line-opacity": ["case", ["boolean", ["get", "muted"], false], 0.12, 0.7],
        },
      });
      m.addLayer({
        id: "run-cuts",
        type: "line",
        source: "run-cuts",
        paint: {
          "line-color": theme.getPropertyValue("--destructive").trim(),
          "line-width": 4,
          "line-dasharray": [1.5, 1.5],
          "line-opacity": ["case", ["boolean", ["get", "muted"], false], 0.15, 0.9],
        },
      });
      setReady(true);
      setError(false);
    });
    return () => {
      setReady(false);
      markers.current.forEach((x) => x.remove());
      markers.current = [];
      m.remove();
    };
  }, [graph]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const focusedKey = host.current?.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.entity : undefined;
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    const routeFeatures: GeoJSON.Feature[] = [];
    function marker(el: HTMLElement, pos: [number, number], label: string, ref: EntityRef) {
      const key = entityKey(ref);
      el.dataset.entity = key;
      el.classList.toggle("selected", sameEntity(selected, ref));
      el.classList.toggle("related", related.has(key));
      el.classList.toggle("is-muted", filtered && !matches.has(key) && !related.has(key));
      el.setAttribute("aria-pressed", String(sameEntity(selected, ref)));
      el.onclick = () => callback.current(ref);
      el.title = label;
      el.setAttribute("aria-label", label);
      markers.current.push(
        new ml.Marker({ element: el, anchor: "center" })
          .setLngLat(pos)
          .addTo(m!),
      );
      if (focusedKey === key) el.focus({ preventScroll: true });
    }
    for (const h of meta.hospitals) {
      const el = document.createElement("button");
      el.className = "hospital-base run-hospital";
      el.innerHTML =
        '<span class="hospital-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18M2 22h20M12 6v4M10 8h4M10 14h4M10 18h4"/></svg></span>';
      const text = document.createElement("strong");
      text.textContent = h.id;
      el.append(text);
      const occupied =
        record.frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
      const badge = document.createElement("em");
      badge.textContent = String(h.capacity - occupied);
      el.append(badge);
      const label = `${h.name} · ${h.capacity - occupied}/${h.capacity} camas libres`;
      marker(el, graph.nodes[h.node], label, { kind: "hospital", id: h.id });
    }
    for (const p of record.frame.patients) {
      if (
        (p.status === "delivered" || p.status === "dead") &&
        !related.has(`patient:${p.id}`) && !matches.has(`patient:${p.id}`)
      )
        continue;
      const el = document.createElement("button");
      el.className = `run-patient ${p.status === "dead" ? "deceased" : ""} ${sameEntity(selected, { kind: "patient", id: p.id }) ? "selected" : ""}`;
      el.textContent = p.id;
      el.dataset.patient = p.id;
      const pos = selectionPosition(situation, graph, { kind: "patient", id: p.id });
      if (pos) {
        marker(el, pos, `${p.id} · ${patientStatus[p.status]}`, { kind: "patient", id: p.id });
        if (p.status === "in_ambulance") markers.current.at(-1)?.setOffset([0, -24]);
      }
    }
    for (const a of record.frame.ambulances) {
      const el = document.createElement("button");
      el.className = `ambulance-marker ${a.broken || a.stranded ? "blocked" : ""}`;
      el.dataset.unit = a.id;
      el.dataset.position = a.pos.join(",");
      el.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h11v12H3zM14 10h4l3 4v3h-7M7 8v6m-3-3h6"/><circle cx="7" cy="18" r="2" fill="white"/><circle cx="18" cy="18" r="2" fill="white"/></svg>';
      const label = document.createElement("span");
      label.className = "unit-number";
      label.textContent = a.id;
      el.append(label);
      marker(el, a.pos, `${a.id} · ${situation.units.find((unit) => unit.id === a.id)?.label ?? a.mission}`, { kind: "ambulance", id: a.id });
      if (a.route.length)
        routeFeatures.push({
          type: "Feature",
          properties: { related: related.has(`ambulance:${a.id}`), muted: filtered && !matches.has(`ambulance:${a.id}`) && !related.has(`ambulance:${a.id}`) },
          geometry: {
            type: "LineString",
            coordinates: remainingRoute(a, graph),
          },
        });
    }
    for (const road of situation.roads) {
      const pos = selectionPosition(situation, graph, road.ref);
      if (!pos) continue;
      const el = document.createElement("button");
      el.className = "route-restriction";
      el.textContent = "×";
      marker(el, pos, `${road.name} · Tramo cerrado`, road.ref);
    }
    (m.getSource("run-routes") as ml.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: routeFeatures,
    });
    (m.getSource("run-cuts") as ml.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: record.frame.closedEdges
        .filter((e) => graph.edges[e])
        .map((e) => ({
          type: "Feature",
          properties: { muted: filtered && !matches.has(`road:${e}`) && !related.has(`road:${e}`) },
          geometry: { type: "LineString", coordinates: graph.edges[e].geom },
        })),
    });
  }, [ready, record, graph, meta, selected, situation, related, matches, filtered]);
  return (
    <div className="app-map-wrap operational-map">
      <div ref={host} className="operational-map-canvas" />
      <div className="operational-map-heading">
        <strong>Valencia</strong>
        <small>Posiciones registradas · cada {meta.config.tickSeconds} s</small>
      </div>
      <button className="operational-recenter" onClick={fit}>
        <LocateFixed size={14} />
        Centrar mapa
      </button>
      <div className="operational-legend">
        {filtered && <span className="operational-filter-label">Filtro activo</span>}
        <span>
          <i className="critical" />
          Pacientes
        </span>
        <span>Azul · rutas</span>
        <span>Rojo · cortes</span>
      </div>
      {!ready && (
        <div className="operational-loading">Cargando cartografía…</div>
      )}
      {error && (
        <div className="app-map-error">
          No se ha podido cargar parte de la cartografía. El registro sigue
          disponible.
        </div>
      )}
    </div>
  );
}
