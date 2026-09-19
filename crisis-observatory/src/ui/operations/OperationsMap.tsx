import { useEffect, useRef, useState } from "react";
import * as ml from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { LocateFixed, Minus, Plus } from "lucide-react";
import type { GraphData } from "../engineTrace";
import type { Ticket } from "../tickets/model";
import { number, type IncidentFocus, type Sector } from "./model";
ml.setWorkerUrl(workerUrl);
const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const empty = collection([]);

export default function OperationsMap({ graph, sectors, selected, selectedTicket, focus, onFocusHandled, onSector, onTicket }: {
  graph: GraphData; sectors: Sector[]; selected: string | null; selectedTicket: Ticket | null;
  focus: IncidentFocus | null; onFocusHandled: (focus: IncidentFocus) => void;
  onSector: (id: string | null) => void; onTicket: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null), map = useRef<ml.Map | null>(null);
  const callbacks = useRef({ onSector, onTicket, onFocusHandled });
  callbacks.current = { onSector, onTicket, onFocusHandled };
  const [ready, setReady] = useState(false), [basemapError, setBasemapError] = useState(false);
  const markers = useRef<ml.Marker[]>([]);
  const reset = () => {
    const [s, w, n, e] = graph.bbox;
    map.current?.fitBounds([[w, s], [e, n]], { padding: 20, duration: 400 });
  };
  useEffect(() => {
    setReady(false);
    setBasemapError(false);
    const [s, w, n, e] = graph.bbox;
    // Local street geometry remains useful when external background tiles are unavailable.
    const streets = collection(graph.edges.map((edge) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: edge.geom } })));
    const abort = new AbortController();
    let disposed = false, cleanup = () => {};
    async function initialize() {
      let style: ml.StyleSpecification = { version: 8, sources: {}, layers: [
        { id: "background", type: "background", paint: { "background-color": "#f0f3f1" } },
      ] };
      const timeout = setTimeout(() => abort.abort(), 3000);
      try {
        const response = await fetch("https://tiles.openfreemap.org/styles/positron", { signal: abort.signal });
        if (!response.ok) throw new Error("Cartografía no disponible");
        const remote = await response.json() as ml.StyleSpecification;
        if (remote.version !== 8 || !remote.layers || !remote.sources) throw new Error("Cartografía no válida");
        style = remote;
      } catch { if (!disposed) setBasemapError(true); }
      finally { clearTimeout(timeout); }
      if (disposed) return;
      style = { ...style, sources: { ...style.sources, "ops-streets": { type: "geojson", data: streets,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
        layers: [...style.layers, { id: "ops-streets", type: "line", source: "ops-streets", paint: { "line-color": "#d5ddda", "line-width": .7 } }] };
      const m = new ml.Map({ container: host.current!, bounds: [[w, s], [e, n]], fitBoundsOptions: { padding: 30 },
        attributionControl: { compact: true }, style });
    map.current = m;
    m.on("error", (e) => { if ("sourceId" in e && !["ops-streets", "sectors", "cases"].includes(String(e.sourceId))) setBasemapError(true); });
    m.on("movestart", () => { if (host.current) host.current.dataset.rendered = "false"; });
    m.on("idle", () => { if (host.current) host.current.dataset.rendered = "true"; });
    m.on("style.load", () => {
      m.addSource("sectors", { type: "geojson", data: empty });
      m.addSource("cases", { type: "geojson", data: empty, cluster: true, clusterMaxZoom: 14, clusterRadius: 42 });
      m.addLayer({ id: "sector-fill", type: "fill", source: "sectors", paint: {
        "fill-color": ["case", [">", ["get", "critical"], 0], "#dca05f", "#7b9f96"],
        "fill-opacity": ["case", ["boolean", ["get", "selected"], false], .17, .055],
      } });
      m.addLayer({ id: "sector-edge", type: "line", source: "sectors", paint: {
        "line-color": ["case", ["boolean", ["get", "selected"], false], "#26745f", "#84958c"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 2, 1], "line-dasharray": [3, 3], "line-opacity": .5,
      } });
      m.addLayer({ id: "clusters", type: "circle", source: "cases", filter: ["has", "point_count"], paint: {
        "circle-color": "#26745f", "circle-radius": ["step", ["get", "point_count"], 10, 20, 15, 100, 21],
        "circle-stroke-color": "#fff", "circle-stroke-width": 2, "circle-opacity": .85,
      } });
      m.addLayer({ id: "cases", type: "circle", source: "cases", filter: ["!", ["has", "point_count"]], paint: {
        "circle-radius": 5, "circle-color": ["match", ["get", "priority"], 0, "#c45e45", 1, "#c68a3c", "#64877d"],
        "circle-stroke-width": 1.5, "circle-stroke-color": "#fff",
      } });
      m.addLayer({ id: "case-targets", type: "circle", source: "cases", filter: ["!", ["has", "point_count"]], paint: {
        "circle-radius": 12, "circle-opacity": 0,
      } });
      m.on("click", "case-targets", (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (id) callbacks.current.onTicket(String(id));
      });
      m.on("click", "clusters", async (event) => {
        const f = event.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        try {
          const zoom = await (m.getSource("cases") as ml.GeoJSONSource).getClusterExpansionZoom(Number(f.properties.cluster_id));
          if (map.current === m) m.easeTo({ center: f.geometry.coordinates as [number, number], zoom });
        } catch { /* A source may be removed while the operator changes views. */ }
      });
      for (const layer of ["case-targets", "clusters"]) {
        m.on("mouseenter", layer, () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", layer, () => { m.getCanvas().style.cursor = ""; });
      }
      setReady(true);
    });
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(host.current!);
    cleanup = () => { resize.disconnect(); markers.current.forEach((marker) => marker.remove()); markers.current = []; map.current = null; m.remove(); };
    }
    void initialize();
    return () => { disposed = true; abort.abort(); cleanup(); };
  }, [graph]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const polygons = sectors.flatMap((sector): GeoJSON.Feature[] => {
      if (!sector.bounds) return [];
      const [[w, s], [e, n]] = sector.bounds;
      return [{ type: "Feature", properties: { critical: sector.critical, selected: selected === sector.id },
        geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }];
    });
    (m.getSource("sectors") as ml.GeoJSONSource).setData(collection(polygons));
    const sector = sectors.find((s) => s.id === selected);
    (m.getSource("cases") as ml.GeoJSONSource).setData(collection((sector?.tickets ?? []).flatMap((t): GeoJSON.Feature[] => {
      const pos = graph.nodes[t.incident.node];
      return t.incident.status === "open" && pos ? [{ type: "Feature", properties: { id: t.id, priority: t.incident.priority }, geometry: { type: "Point", coordinates: pos } }] : [];
    })));
    markers.current.forEach((marker) => marker.remove());
    markers.current = sectors.flatMap((s) => {
      if (!s.center || (selected && s.id !== selected)) return [];
      const el = document.createElement("button");
      el.className = `ops-map-marker${s.critical ? " has-critical" : ""}${selected === s.id ? " selected" : ""}`;
      el.setAttribute("aria-label", `Explorar sector ${s.name}: ${s.open} incidencias abiertas`);
      el.setAttribute("aria-pressed", String(selected === s.id));
      const title = document.createElement("span"); title.textContent = s.name;
      const count = document.createElement("strong"); count.textContent = number(s.open);
      const caption = document.createElement("small"); caption.textContent = s.critical ? `${number(s.critical)} urgentes` : "abiertas";
      el.append(title, count, caption);
      el.onclick = () => callbacks.current.onSector(selected === s.id ? null : s.id);
      return [new ml.Marker({ element: el, anchor: selected ? "bottom" : "center", offset: selected ? [0, -24] : [0, 0] }).setLngLat(s.center).addTo(m)];
    });
  }, [ready, sectors, selected, graph]);
  useEffect(() => {
    const position = selectedTicket && graph.nodes[selectedTicket.incident.node];
    if (!ready || !map.current || !selectedTicket || !position?.every(Number.isFinite)) return;
    // One independent marker also locates archived cases, without adding them to the open-case clusters.
    const el = document.createElement("button");
    el.className = "ops-map-incident-marker";
    el.setAttribute("aria-label", `Incidencia seleccionada ${selectedTicket.id}: ${selectedTicket.title}`);
    el.style.setProperty("--incident-color", selectedTicket.incident.status === "closed" ? "#82908a" : selectedTicket.incident.priority === 0 ? "#c45e45" : selectedTicket.incident.priority === 1 ? "#c68a3c" : "#64877d");
    const label = document.createElement("span"); label.textContent = selectedTicket.id;
    el.append(label);
    el.onclick = (event) => { event.stopPropagation(); callbacks.current.onTicket(selectedTicket.id); };
    const marker = new ml.Marker({ element: el, anchor: "center" }).setLngLat(position).addTo(map.current);
    return () => { marker.remove(); };
  }, [ready, selectedTicket, graph]);
  useEffect(() => {
    if (!ready || focus) return;
    const sector = sectors.find((s) => s.id === selected);
    if (sector?.bounds) map.current?.fitBounds(sector.bounds, { padding: 65, duration: 450 });
    else reset();
    // Only a sector change frames its bounds. Consuming a focus request must not undo the incident camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selected, graph]);
  useEffect(() => {
    const m = map.current, hostElement = host.current;
    if (!ready || !m || !hostElement || !focus) return;
    const rect = hostElement.getBoundingClientRect();
    const panel = hostElement.closest(".ops-grid")?.querySelector(".ops-incident-panel")?.getBoundingClientRect();
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (panel) {
      if (panel.left > rect.left) right = Math.min(right, panel.left);
      else bottom = Math.min(bottom, panel.top);
    }
    const offset: [number, number] = [(left + right) / 2 - rect.left - rect.width / 2, (top + bottom) / 2 - rect.top - rect.height / 2];
    m.easeTo({ center: focus.position, zoom: Math.max(16, m.getZoom()), offset, duration: 450 });
    callbacks.current.onFocusHandled(focus);
  }, [ready, focus]);
  return <div className="ops-map" aria-label="Mapa de sectores operativos" data-inspecting={Boolean(selectedTicket)}>
    <div className="ops-map-canvas" ref={host} />
    <div className="ops-map-caption"><span className="ops-live-dot" />{selected ? "Incidencias de la zona" : "Visión territorial"}<span>VALÈNCIA</span></div>
    <div className="ops-map-tools"><button aria-label="Acercar mapa de operaciones" onClick={() => map.current?.zoomIn()}><Plus size={16} /></button>
      <button aria-label="Alejar mapa de operaciones" onClick={() => map.current?.zoomOut()}><Minus size={16} /></button>
      <button aria-label="Encuadrar territorio completo" onClick={() => { callbacks.current.onSector(null); reset(); }}><LocateFixed size={16} /></button></div>
    <div className="ops-map-legend"><span><i />Sector operativo</span>{selected && <span><i className="case" />Incidencias agrupadas</span>}</div>
    {basemapError && <span className="ops-map-offline">Cartografía base sin conexión · callejero local</span>}
  </div>;
}
