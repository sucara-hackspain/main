import { useEffect, useRef, useState } from "react";
import * as ml from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { LocateFixed } from "lucide-react";
import {
  elapsed,
  priority,
  unitKind,
  unitStatus,
  type GraphData,
  type RunMeta,
  type TickRecord,
} from "../engineTrace";
import { circle } from "../map/routes";
import { hospitalIcon, unitIcon } from "../map/unitIcons";
import type { IncidentScene } from "./scene";
import "../map/map.css";

ml.setWorkerUrl(workerUrl);
const empty: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const round = { "line-cap": "round", "line-join": "round" } as const;
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

type IncidentMapProps = {
  graph: GraphData;
  meta: RunMeta;
  record: TickRecord;
  scene: IncidentScene;
  /** The map frames the scene again when this changes: a new request, or paging to another. */
  focusKey: string;
  /** Option under the pointer: its trip stands out and the other options fade. */
  preview: string | null;
  seconds: number;
};

/** The map framed on one request: who is involved, what each option would do and what caused it. */
export default function IncidentMap({
  graph,
  meta,
  record,
  scene,
  focusKey,
  preview,
  seconds,
}: IncidentMapProps) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<ml.Map | null>(null),
    markers = useRef<ml.Marker[]>([]),
    [ready, setReady] = useState(false),
    [error, setError] = useState(false);
  const bounds = scene.bounds ?? graph.bbox;
  const box = (b: number[]): ml.LngLatBoundsLike =>
    scene.bounds
      ? [
          [b[0], b[1]],
          [b[2], b[3]],
        ]
      : [
          [b[1], b[0]],
          [b[3], b[2]],
        ];
  function fit(duration = 450) {
    map.current?.fitBounds(box(bounds), { padding: 64, maxZoom: 16, duration });
  }

  useEffect(() => {
    const m = new ml.Map({
      container: host.current!,
      style: "https://tiles.openfreemap.org/styles/positron",
      bounds: box(bounds),
      fitBoundsOptions: { padding: 64, maxZoom: 16 },
      attributionControl: { compact: true },
    });
    map.current = m;
    m.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right");
    m.on("error", () => setError(true));
    m.on("load", () => {
      const theme = getComputedStyle(host.current!);
      const color = (name: string) => theme.getPropertyValue(name).trim();
      for (const id of [
        "incident-water-real",
        "incident-water-known",
        "incident-area",
        "incident-cuts",
        "incident-cause",
        "incident-lines",
      ])
        m.addSource(id, { type: "geojson", data: empty });
      const kind = (...kinds: string[]) =>
        ["in", ["get", "kind"], ["literal", kinds]] as ml.ExpressionSpecification;
      const prescribed = ["get", "prescribed"] as ml.ExpressionSpecification;
      const faded = ["case", ["get", "dim"], 0.18, 1] as ml.ExpressionSpecification;
      m.addLayer({
        id: "incident-water-real",
        type: "fill",
        source: "incident-water-real",
        paint: { "fill-color": color("--info"), "fill-opacity": 0.14 },
      });
      m.addLayer({
        id: "incident-water-known",
        type: "line",
        source: "incident-water-known",
        paint: {
          "line-color": color("--info-foreground"),
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
      m.addLayer({
        id: "incident-area",
        type: "fill",
        source: "incident-area",
        paint: { "fill-color": color("--destructive"), "fill-opacity": 0.07 },
      });
      m.addLayer({
        id: "incident-area-edge",
        type: "line",
        source: "incident-area",
        paint: {
          "line-color": color("--destructive"),
          "line-width": 1.5,
          "line-dasharray": [1, 1.5],
        },
      });
      m.addLayer({
        id: "incident-cuts",
        type: "line",
        source: "incident-cuts",
        paint: {
          "line-color": color("--destructive"),
          "line-width": 2.5,
          "line-dasharray": [1.5, 1.5],
          "line-opacity": 0.7,
        },
      });
      m.addLayer({
        id: "incident-mission",
        type: "line",
        source: "incident-lines",
        filter: kind("mission"),
        layout: round,
        paint: { "line-color": color("--info"), "line-width": 2.5, "line-opacity": 0.55 },
      });
      m.addLayer({
        id: "incident-before",
        type: "line",
        source: "incident-lines",
        filter: kind("before"),
        layout: round,
        paint: {
          "line-color": color("--muted-foreground"),
          "line-width": 3,
          "line-dasharray": [1.2, 1.4],
          "line-opacity": 0.85,
        },
      });
      m.addLayer({
        id: "incident-alternative",
        type: "line",
        source: "incident-lines",
        filter: ["all", kind("option", "leg"), ["!", prescribed]],
        layout: round,
        paint: {
          "line-color": color("--info"),
          "line-width": ["case", ["get", "active"], 5, 3.5],
          "line-dasharray": [1.6, 1.2],
          "line-opacity": faded,
        },
      });
      m.addLayer({
        id: "incident-proposed",
        type: "line",
        source: "incident-lines",
        filter: ["all", kind("option", "leg"), prescribed],
        layout: round,
        paint: {
          "line-color": color("--success"),
          "line-width": ["case", ["==", ["get", "kind"], "leg"], 3.5, ["get", "active"], 6.5, 5],
          "line-opacity": faded,
        },
      });
      m.addLayer({
        id: "incident-cause-glow",
        type: "line",
        source: "incident-cause",
        paint: {
          "line-color": color("--destructive"),
          "line-width": 16,
          "line-opacity": 0.28,
          "line-blur": 6,
        },
      });
      m.addLayer({
        id: "incident-cause",
        type: "line",
        source: "incident-cause",
        layout: round,
        paint: { "line-color": color("--destructive"), "line-width": 6 },
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
    // One map per street graph; the scene only moves the camera (see the focusKey effect).
  }, [graph]);

  useEffect(() => {
    if (ready) fit();
    // Reframe for a new request, not on every record.
  }, [ready, focusKey]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    const { frame } = record;
    const focus = new Set([...scene.incidents, ...scene.units, ...scene.hospitals]);
    // Time an option needs: next to the unit it sends, or to the hospital for a transfer.
    const etas = new Map<string, { eta: number; prescribed: boolean }>();
    for (const l of scene.lines) {
      const at = l.hospitalId ?? l.unitId;
      if (l.kind !== "option" || l.eta === undefined || !at) continue;
      if (!etas.has(at) || l.prescribed)
        etas.set(at, { eta: l.eta, prescribed: Boolean(l.prescribed) });
    }
    function tag(el: HTMLElement, id: string) {
      const eta = etas.get(id);
      if (!eta) return;
      const span = document.createElement("span");
      span.className = `incident-eta ${eta.prescribed ? "prescribed" : ""}`;
      span.textContent = elapsed(eta.eta, seconds);
      el.append(span);
    }
    const arrives = (id: string) => {
      const eta = etas.get(id);
      return eta ? [`Llegaría en ${elapsed(eta.eta, seconds)}`] : [];
    };
    function place(
      el: HTMLElement,
      pos: [number, number],
      label: string,
      popup: HTMLElement,
      offset: [number, number] = [0, 0],
    ) {
      el.title = label;
      el.setAttribute("aria-label", label);
      markers.current.push(
        new ml.Marker({ element: el, anchor: "center", offset })
          .setLngLat(pos)
          .setPopup(new ml.Popup({ offset: 16 }).setDOMContent(popup))
          .addTo(m!),
      );
    }
    function card(title: string, ...lines: string[]) {
      const content = document.createElement("div");
      content.className = "fleet-popup";
      const strong = document.createElement("strong");
      strong.textContent = title;
      content.append(strong);
      for (const text of lines) {
        const span = document.createElement("span");
        span.textContent = text;
        content.append(span);
      }
      return content;
    }
    // Context first, so what matters is drawn on top.
    const order = <T extends { id: string }>(xs: T[]) =>
      [...xs].sort((a, b) => Number(focus.has(a.id)) - Number(focus.has(b.id)));

    for (const h of order(meta.hospitals)) {
      const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
      const free = h.capacity - occupied;
      const el = document.createElement("button");
      el.className = `hospital-base run-hospital ${focus.has(h.id) ? "incident-destination" : "incident-dim"}`;
      el.innerHTML = hospitalIcon;
      const text = document.createElement("strong");
      text.textContent = h.id;
      const badge = document.createElement("em");
      badge.textContent = String(free);
      el.append(text, badge);
      if (h.helipad) {
        const pad = document.createElement("i");
        pad.className = "helipad";
        pad.textContent = "H";
        el.append(pad);
      }
      tag(el, h.id);
      place(
        el,
        graph.nodes[h.node],
        `${h.name} · ${free}/${h.capacity} camas libres${h.helipad ? " · helipuerto" : ""}`,
        card(h.name, `${free} camas libres de ${h.capacity}`, ...(h.helipad ? ["Con helipuerto"] : []), ...arrives(h.id)),
      );
    }

    const incidents = frame.incidents.filter(
      (i) => i.status === "open" || focus.has(i.id),
    );
    for (const i of order(incidents)) {
      const inFocus = focus.has(i.id);
      const el = document.createElement("button");
      el.className = `run-incident p${i.priority} ${inFocus ? "incident-focus" : "incident-dim"}`;
      el.innerHTML = `<b>P${i.priority}</b>`;
      el.append(i.id);
      if (i.unreachable) el.insertAdjacentHTML("beforeend", '<i class="flag">≈</i>');
      el.dataset.incident = i.id;
      place(
        el,
        graph.nodes[i.node],
        `${i.id} · P${i.priority} ${priority[i.priority].label.toLowerCase()}`,
        card(
          `${i.id} · P${i.priority} ${priority[i.priority].label.toLowerCase()}`,
          i.line,
          i.located ? "Ubicación confirmada" : `Ubicación aproximada, ±${i.locationErrorM} m`,
          ...(i.cutOffIn !== null ? [`El agua lo aísla en ${elapsed(i.cutOffIn, seconds)}`] : []),
        ),
      );
    }

    // Units parked together: spread them sideways, the one the recommendation sends in its place and on top.
    const sent = scene.lines.find((l) => l.kind === "option" && l.prescribed)?.unitId;
    const units = order(frame.units).sort(
      (a, b) => Number(a.id === sent) - Number(b.id === sent),
    );
    const together = new Map<string, number>();
    for (const u of units) together.set(u.pos.join(","), (together.get(u.pos.join(",")) ?? 0) + 1);
    const placed = new Map<string, number>();
    for (const u of units) {
      const key = u.pos.join(",");
      const index = placed.get(key) ?? 0;
      placed.set(key, index + 1);
      const shift: [number, number] = [-(together.get(key)! - 1 - index) * 30, 0];
      const inFocus = focus.has(u.id);
      const el = document.createElement("button");
      el.className = `ambulance-marker unit-marker ${u.broken || u.stranded ? "blocked" : ""} ${inFocus ? "incident-unit" : "incident-dim"}`;
      el.dataset.kind = u.kind;
      el.dataset.unit = u.id;
      el.innerHTML = unitIcon[u.kind];
      const label = document.createElement("span");
      label.className = "unit-number";
      label.textContent = u.id;
      el.append(label);
      tag(el, u.id);
      place(
        el,
        u.pos,
        `${u.id} · ${unitKind[u.kind].label} · ${unitStatus(u)}`,
        card(
          `${u.id} · ${unitKind[u.kind].label}`,
          unitStatus(u),
          ...(u.victimId ? [`A bordo: ${u.victimId}`] : []),
          ...arrives(u.id),
        ),
        shift,
      );
    }

    const known = frame.knownClosedEdges.filter(
      (e) => graph.edges[e] && !scene.cause.includes(e),
    );
    (m.getSource("incident-cuts") as ml.GeoJSONSource).setData(
      collection(known.map((e) => line(graph.edges[e].geom))),
    );
    (m.getSource("incident-cause") as ml.GeoJSONSource).setData(
      collection(scene.cause.filter((e) => graph.edges[e]).map((e) => line(graph.edges[e].geom))),
    );
    (m.getSource("incident-water-known") as ml.GeoJSONSource).setData(
      collection(frame.knownWater.zones.map((z) => line(circle(graph.nodes[z.node], z.radiusM)))),
    );
    (m.getSource("incident-water-real") as ml.GeoJSONSource).setData(
      collection(frame.floods.map((f) => area(circle(graph.nodes[f.node], f.radiusM)))),
    );
    (m.getSource("incident-area") as ml.GeoJSONSource).setData(
      collection(
        incidents
          .filter((i) => focus.has(i.id) && !i.located && i.locationErrorM > 0)
          .map((i) => area(circle(graph.nodes[i.node], i.locationErrorM))),
      ),
    );
  }, [ready, record, scene, graph, meta, seconds]);

  // Lines apart from markers: previewing an option must not close an open popup.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource("incident-lines") as ml.GeoJSONSource).setData(
      collection(
        scene.lines.map((l) =>
          line(l.coords, {
            kind: l.kind,
            prescribed: Boolean(l.prescribed),
            active: preview !== null && l.optionId === preview,
            dim: preview !== null && l.optionId !== undefined && l.optionId !== preview,
          }),
        ),
      ),
    );
  }, [ready, scene, preview]);

  const has = (kind: string, prescribed?: boolean) =>
    scene.lines.some(
      (l) => l.kind === kind && (prescribed === undefined || Boolean(l.prescribed) === prescribed),
    );
  const cause = [
    ...new Set(scene.cause.map((e) => graph.edges[e]?.name).filter(Boolean)),
  ];
  return (
    <div className="incident-map operational-map">
      <div ref={host} className="operational-map-canvas" />
      <div className="operational-map-heading">
        <strong>Mapa del incidente</strong>
        <small>
          {cause.length
            ? `Lo que la bloqueó: ${cause.slice(0, 2).join(", ")}${cause.length > 2 ? "…" : ""}`
            : "Encuadrado en lo que afecta a esta decisión"}
        </small>
      </div>
      <button className="operational-recenter" onClick={() => fit()}>
        <LocateFixed size={14} />
        Centrar
      </button>
      <div className="incident-legend">
        {has("option", true) && (
          <span>
            <i className="proposed" />
            Recomendada
          </span>
        )}
        {has("option", false) && (
          <span>
            <i className="alternative" />
            Alternativa
          </span>
        )}
        {has("before") && (
          <span>
            <i className="before" />
            Ruta que tenía
          </span>
        )}
        {has("mission") && (
          <span>
            <i className="mission" />
            Misiones en curso
          </span>
        )}
        {scene.cause.length > 0 && (
          <span>
            <i className="cause" />
            Lo que la bloqueó
          </span>
        )}
        <span>
          <i className="cut" />
          Cortes conocidos
        </span>
        <span>
          <i className="water" />
          Agua conocida
        </span>
      </div>
      {!ready && <div className="operational-loading">Cargando cartografía…</div>}
      {error && (
        <div className="app-map-error">
          No se ha podido cargar parte de la cartografía. El incidente sigue
          disponible en el panel.
        </div>
      )}
    </div>
  );
}
