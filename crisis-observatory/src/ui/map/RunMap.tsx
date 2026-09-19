import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as ml from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Eye, EyeOff, LocateFixed } from "lucide-react";
import {
  elapsed,
  priority,
  sameSelection,
  selectionPosition,
  unitKind,
  unitStatus,
  type GraphData,
  type RunMeta,
  type Selection,
  type TickRecord,
} from "../engineTrace";
import { circle, remainingRoute } from "./routes";
import { hospitalIcon, unitIcon } from "./unitIcons";
import "./map.css";
ml.setWorkerUrl(workerUrl);
const empty: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features,
});
const line = (coordinates: [number, number][], properties = {}): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "LineString", coordinates },
});
const area = (ring: [number, number][], properties = {}): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "Polygon", coordinates: [ring] },
});
const worst = ["red", "yellow", "green", "black"] as const;

export default function RunMap({
  graph,
  meta,
  record,
  selected,
  onSelect,
  focusRequest,
  related,
  matches,
  filtered,
  detail,
}: {
  graph: GraphData;
  meta: RunMeta;
  record: TickRecord;
  selected: Selection | null;
  /** A marker was picked; null closes the selection. */
  onSelect: (ref: Selection | null) => void;
  focusRequest: number;
  /** Entities tied to the selection, as `kind:id`. */
  related: Set<string>;
  /** Entities the situation panel's filter and search leave in, as `kind:id`. */
  matches: Set<string>;
  filtered: boolean;
  /** The selection's detail, in a modal anchored to it on the map. */
  detail?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<ml.Map | null>(null),
    callback = useRef(onSelect),
    [ready, setReady] = useState(false),
    [error, setError] = useState(false),
    // Reality: the real water, the real scenes and closures nobody has reported. The coordinator sees none of it.
    [reality, setReality] = useState(true);
  callback.current = onSelect;
  const seconds = meta.config.tickSeconds;
  const focusPosition = useRef<[number, number] | undefined>(undefined);
  focusPosition.current = selected
    ? selectionPosition(selected, record, meta, graph)
    : undefined;
  const selectedKey = selected ? `${selected.kind}:${selected.id}` : null;
  useEffect(() => {
    if (ready && selectedKey && focusPosition.current)
      map.current?.easeTo({
        center: focusPosition.current,
        zoom: Math.max(map.current.getZoom(), 13),
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350,
      });
  }, [ready, selectedKey, focusRequest]);
  useEffect(() => {
    if (ready && focusRequest > 0 && window.matchMedia("(max-width: 800px)").matches)
      host.current?.scrollIntoView({ block: "center", behavior: "instant" });
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
    m.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-left");
    m.on("error", () => setError(true));
    // A click on the map itself, not on a marker, closes the detail.
    m.on("click", (e) => {
      if ((e.originalEvent.target as HTMLElement).classList.contains("maplibregl-canvas"))
        callback.current(null);
    });
    m.on("load", () => {
      const theme = getComputedStyle(host.current!);
      const color = (name: string) => theme.getPropertyValue(name).trim();
      for (const id of [
        "water-real",
        "water-known",
        "incident-area",
        "routes",
        "cuts-unknown",
        "cuts-known",
        "sightings",
      ])
        m.addSource(id, { type: "geojson", data: empty });
      m.addLayer({
        id: "water-real",
        type: "fill",
        source: "water-real",
        paint: {
          "fill-color": color("--info"),
          "fill-opacity": ["case", ["==", ["get", "part"], "core"], 0.3, 0.12],
        },
      });
      m.addLayer({
        id: "water-known",
        type: "line",
        source: "water-known",
        paint: {
          "line-color": color("--info-foreground"),
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
      const tone = [
        "match",
        ["get", "priority"],
        0,
        color("--destructive"),
        1,
        color("--warning"),
        2,
        color("--info"),
        color("--muted-foreground"),
      ] as ml.ExpressionSpecification;
      m.addLayer({
        id: "incident-area",
        type: "fill",
        source: "incident-area",
        paint: { "fill-color": tone, "fill-opacity": 0.08 },
      });
      m.addLayer({
        id: "incident-area-edge",
        type: "line",
        source: "incident-area",
        paint: { "line-color": tone, "line-width": 1.5, "line-dasharray": [1, 1.5] },
      });
      m.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color("--info"),
          "line-width": ["case", ["boolean", ["get", "related"], false], 4, 2.5],
          "line-opacity": ["case", ["boolean", ["get", "muted"], false], 0.15, 0.7],
        },
      });
      m.addLayer({
        id: "cuts-unknown",
        type: "line",
        source: "cuts-unknown",
        paint: {
          "line-color": color("--muted-foreground"),
          "line-width": 2,
          "line-dasharray": [1, 1.5],
          "line-opacity": 0.55,
        },
      });
      m.addLayer({
        id: "cuts-known",
        type: "line",
        source: "cuts-known",
        paint: {
          "line-color": color("--destructive"),
          "line-width": 3,
          "line-dasharray": [1.5, 1.5],
          "line-opacity": 0.85,
        },
      });
      m.addLayer({
        id: "sightings",
        type: "circle",
        source: "sightings",
        paint: {
          "circle-radius": 3.5,
          "circle-color": [
            "case",
            ["==", ["get", "kind"], "blocked"],
            color("--destructive"),
            color("--info"),
          ],
          "circle-stroke-color": color("--card"),
          "circle-stroke-width": 1,
          "circle-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 0.95, 60, 0.3],
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
    const { frame } = record;
    const focusedKey = host.current?.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)?.dataset.entity
      : undefined;
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    const muted = (key: string) => filtered && !matches.has(key) && !related.has(key);
    function marker(el: HTMLElement, pos: [number, number], label: string, ref: Selection) {
      const key = `${ref.kind}:${ref.id}`;
      const selectedNow = sameSelection(selected, ref);
      el.dataset.entity = key;
      el.classList.toggle("selected", selectedNow);
      el.classList.toggle("related", related.has(key));
      el.classList.toggle("is-muted", muted(key));
      el.setAttribute("aria-pressed", String(selectedNow));
      el.onclick = (e) => {
        e.stopPropagation();
        callback.current(ref);
      };
      el.title = label;
      el.setAttribute("aria-label", label);
      markers.current.push(
        new ml.Marker({ element: el, anchor: "center" }).setLngLat(pos).addTo(m!),
      );
      if (focusedKey === key) el.focus({ preventScroll: true });
    }

    for (const h of meta.hospitals) {
      const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
      const el = document.createElement("button");
      el.className = "hospital-base run-hospital";
      el.innerHTML = hospitalIcon;
      const text = document.createElement("strong");
      text.textContent = h.id;
      const badge = document.createElement("em");
      badge.textContent = String(h.capacity - occupied);
      el.append(text, badge);
      if (h.helipad) {
        const pad = document.createElement("i");
        pad.className = "helipad";
        pad.textContent = "H";
        el.append(pad);
      }
      marker(
        el,
        graph.nodes[h.node],
        `${h.name} · ${h.capacity - occupied}/${h.capacity} camas libres${h.helipad ? " · helipuerto" : ""}`,
        { kind: "hospital", id: h.id },
      );
    }

    if (reality)
      for (const scene of frame.scenes) {
        const waiting = scene.victims.filter(
          (v) => v.status === "waiting" || v.status === "in_ambulance",
        );
        const triage =
          worst.find((t) => waiting.some((v) => v.triage === t)) ?? "green";
        const el = document.createElement("button");
        el.className = `run-scene ${waiting.length ? "" : "resolved"}`;
        el.dataset.triage = triage;
        el.textContent = String(waiting.length);
        marker(
          el,
          graph.nodes[scene.node],
          `${scene.id} (realidad) · ${waiting.length} de ${scene.victims.length} víctimas esperando`,
          { kind: "scene", id: scene.id },
        );
      }

    for (const incident of frame.incidents) {
      if (incident.status !== "open" && !sameSelection(selected, { kind: "incident", id: incident.id }))
        continue;
      const el = document.createElement("button");
      el.className = `run-incident p${incident.priority} ${incident.status === "open" ? "" : "closed"}`;
      el.dataset.priority = String(incident.priority);
      el.innerHTML = `<b>P${incident.priority}</b>`;
      el.append(incident.id);
      const notes: string[] = [];
      if (incident.unreachable) {
        el.insertAdjacentHTML("beforeend", '<i class="flag">≈</i>');
        notes.push("sin acceso por carretera");
      }
      if (incident.cutOffIn !== null) {
        el.classList.add("cut-off");
        notes.push(`el agua lo aísla en ${elapsed(incident.cutOffIn, seconds)}`);
      }
      marker(
        el,
        graph.nodes[incident.node],
        `${incident.id} · P${incident.priority} ${priority[incident.priority].label.toLowerCase()}${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
        { kind: "incident", id: incident.id },
      );
    }

    const routes: GeoJSON.Feature[] = [];
    for (const u of frame.units) {
      const el = document.createElement("button");
      el.className = `ambulance-marker unit-marker ${u.broken || u.stranded ? "blocked" : ""}`;
      el.dataset.kind = u.kind;
      el.dataset.unit = u.id;
      el.dataset.position = u.pos.join(",");
      el.innerHTML = unitIcon[u.kind];
      const label = document.createElement("span");
      label.className = "unit-number";
      label.textContent = u.id;
      el.append(label);
      marker(el, u.pos, `${u.id} · ${unitKind[u.kind].label} · ${unitStatus(u)}`, {
        kind: "unit",
        id: u.id,
      });
      if (u.route.length)
        routes.push(
          line(remainingRoute(u, graph), {
            related: related.has(`unit:${u.id}`),
            muted: muted(`unit:${u.id}`),
          }),
        );
    }

    const known = new Set(frame.knownClosedEdges);
    const edge = (e: number) => graph.edges[e]?.geom;
    (m.getSource("routes") as ml.GeoJSONSource).setData(collection(routes));
    (m.getSource("cuts-known") as ml.GeoJSONSource).setData(
      collection(frame.knownClosedEdges.filter(edge).map((e) => line(edge(e)!))),
    );
    (m.getSource("cuts-unknown") as ml.GeoJSONSource).setData(
      collection(
        reality
          ? frame.closedEdges.filter((e) => !known.has(e) && edge(e)).map((e) => line(edge(e)!))
          : [],
      ),
    );
    (m.getSource("water-real") as ml.GeoJSONSource).setData(
      collection(
        reality
          ? frame.floods.flatMap((f) => [
              area(circle(graph.nodes[f.node], f.fringeM), { part: "fringe" }),
              area(circle(graph.nodes[f.node], f.radiusM), { part: "core" }),
            ])
          : [],
      ),
    );
    (m.getSource("water-known") as ml.GeoJSONSource).setData(
      collection(frame.knownWater.zones.map((z) => line(circle(graph.nodes[z.node], z.radiusM)))),
    );
    (m.getSource("sightings") as ml.GeoJSONSource).setData(
      collection(
        frame.knownWater.sightings.map((w) => ({
          type: "Feature",
          properties: { kind: w.kind, age: w.ageTicks },
          geometry: { type: "Point", coordinates: graph.nodes[w.node] },
        })),
      ),
    );
    (m.getSource("incident-area") as ml.GeoJSONSource).setData(
      collection(
        frame.incidents
          .filter((i) => i.status === "open" && !i.located && i.locationErrorM > 0)
          .map((i) => area(circle(graph.nodes[i.node], i.locationErrorM), { priority: i.priority })),
      ),
    );
  }, [ready, record, graph, meta, selected, reality, seconds, related, matches, filtered]);

  // The detail opens where the selection is and follows it as it moves. The selection is centred on
  // the map, so it fits beside it, to its left; on a phone it is a sheet at the bottom of the map.
  const popupNode = useMemo(() => document.createElement("div"), []);
  const popup = useRef<ml.Popup | null>(null);
  const showing = Boolean(detail);
  useEffect(() => {
    const m = map.current,
      at = focusPosition.current;
    if (!m || !ready || !showing || !at) {
      popup.current?.remove();
      return;
    }
    popup.current ??= new ml.Popup({
      anchor: "right",
      closeButton: false,
      closeOnClick: false,
      closeOnMove: false,
      focusAfterOpen: false,
      maxWidth: "none",
      offset: 30,
      className: "entity-popover",
    }).setDOMContent(popupNode);
    popup.current.setLngLat(at);
    if (!popup.current.isOpen()) popup.current.addTo(m);
  }, [ready, showing, selectedKey, record, popupNode]);
  useEffect(() => () => void popup.current?.remove(), []);
  // MapLibre places the popup before React has filled it: place it again once it has a size.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const p = popup.current;
      if (p?.isOpen()) p.setLngLat(p.getLngLat());
    });
    observer.observe(popupNode);
    return () => observer.disconnect();
  }, [popupNode]);
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="alertdialog"]')) callback.current(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showing]);

  return (
    <div className="app-map-wrap operational-map">
      <div ref={host} className="operational-map-canvas" />
      {showing && createPortal(detail, popupNode)}
      <div className="operational-map-heading">
        <strong>Valencia</strong>
        <small>Posiciones registradas · cada {seconds} s</small>
      </div>
      <div className="run-map-tools">
        <button
          aria-pressed={reality}
          onClick={() => setReality(!reality)}
          title="La realidad de la simulación: el agua real, las escenas y los cortes que nadie ha comunicado. El coordinador no la ve."
        >
          {reality ? <Eye size={14} /> : <EyeOff size={14} />}
          Realidad
        </button>
        <button className="operational-recenter" onClick={fit}>
          <LocateFixed size={14} />
          Centrar mapa
        </button>
      </div>
      <div className="operational-legend run-legend">
        {filtered && <span className="operational-filter-label">Filtro activo</span>}
        <span>
          <i className="swatch incident" />
          Incidentes P0–P3
        </span>
        <span>
          <i className="swatch water-known" />
          Agua conocida
        </span>
        <span>
          <i className="swatch cut-known" />
          Cortes conocidos
        </span>
        {reality && (
          <>
            <span>
              <i className="swatch water-real" />
              Agua real
            </span>
            <span>
              <i className="swatch cut-unknown" />
              Cortes sin comunicar
            </span>
            <span>
              <i className="swatch scene" />
              Escenas reales
            </span>
          </>
        )}
      </div>
      {!ready && <div className="operational-loading">Cargando cartografía…</div>}
      {error && (
        <div className="app-map-error">
          No se ha podido cargar parte de la cartografía. El registro sigue
          disponible.
        </div>
      )}
    </div>
  );
}
