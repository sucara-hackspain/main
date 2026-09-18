import type { LayerSpecification, SymbolLayerSpecification } from "maplibre-gl";

// Kept apart from the component so the style can be validated in a test without a browser.

export const SOURCES = ["zones", "routes", "closed", "incidents", "hospitals", "patients", "units"] as const;

const FONT = ["Noto Sans Regular"];
const halo = { "text-halo-color": "#0b1120", "text-halo-width": 2 };
const label = (size: number, offset: [number, number]): SymbolLayerSpecification["layout"] => ({
  "text-field": ["get", "label"],
  "text-font": FONT,
  "text-size": size,
  "text-offset": offset,
  "text-allow-overlap": true,
});

/** Bottom to top. */
export const LAYERS: LayerSpecification[] = [
  {
    id: "zones-fill",
    type: "fill",
    source: "zones",
    filter: ["==", ["get", "layer"], "truth"],
    paint: {
      "fill-color": ["match", ["get", "kind"], "flood", "#2563eb", "#94a3b8"],
      "fill-opacity": ["match", ["get", "kind"], "flood", 0.35, 0.16],
    },
  },
  {
    id: "zones-line",
    type: "line",
    source: "zones",
    paint: {
      "line-color": ["match", ["get", "kind"], "flood", "#60a5fa", "#cbd5e1"],
      "line-width": ["match", ["get", "layer"], "known", 2, 1],
      "line-dasharray": [3, 2],
    },
  },
  {
    id: "routes",
    type: "line",
    source: "routes",
    filter: ["==", ["get", "air"], 0],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.7 },
  },
  {
    id: "routes-air",
    type: "line",
    source: "routes",
    filter: ["==", ["get", "air"], 1],
    paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [2, 2] },
  },
  {
    // Closed, but dispatch does not know yet.
    id: "closed-unknown",
    type: "line",
    source: "closed",
    filter: ["==", ["get", "known"], 0],
    paint: { "line-color": "#991b1b", "line-width": 4, "line-dasharray": [1, 1] },
  },
  {
    id: "closed",
    type: "line",
    source: "closed",
    filter: ["==", ["get", "known"], 1],
    layout: { "line-cap": "round" },
    paint: { "line-color": "#ef4444", "line-width": 6 },
  },
  {
    id: "incidents",
    type: "circle",
    source: "incidents",
    paint: {
      "circle-radius": 16,
      "circle-color": ["match", ["get", "kind"], "fire", "#ea580c", "collapse", "#a16207", "accident", "#be123c", "flood_rescue", "#1d4ed8", "#64748b"],
      "circle-opacity": ["case", ["==", ["get", "known"], 1], 0.45, 0.15],
      "circle-stroke-color": "#f8fafc",
      "circle-stroke-width": 1,
      "circle-stroke-opacity": ["case", ["==", ["get", "known"], 1], 0.9, 0.3],
    },
  },
  { id: "incident-labels", type: "symbol", source: "incidents", layout: label(10, [0, 2.2]), paint: { "text-color": "#f8fafc", ...halo } },
  {
    id: "hospitals",
    type: "circle",
    source: "hospitals",
    paint: {
      "circle-radius": 9,
      "circle-color": ["case", ["==", ["get", "down"], 1], "#7f1d1d", "#f8fafc"],
      "circle-stroke-color": "#ef4444",
      "circle-stroke-width": 3,
    },
  },
  { id: "hospital-labels", type: "symbol", source: "hospitals", layout: label(12, [0, 1.5]), paint: { "text-color": "#f8fafc", ...halo } },
  {
    id: "patients",
    type: "circle",
    source: "patients",
    paint: {
      "circle-radius": ["get", "r"],
      "circle-color": ["get", "color"],
      // Faint = it has happened but nobody has told dispatch yet.
      "circle-opacity": ["case", ["==", ["get", "known"], 1], 1, 0.3],
      "circle-stroke-color": ["case", ["==", ["get", "trapped"], 1], "#f8fafc", "#0b1120"],
      "circle-stroke-width": ["case", ["==", ["get", "trapped"], 1], 3, 2],
    },
  },
  { id: "patient-labels", type: "symbol", source: "patients", layout: label(11, [0, -1.4]), paint: { "text-color": "#fde68a", ...halo } },
  {
    id: "units",
    type: "circle",
    source: "units",
    paint: {
      "circle-radius": ["case", ["==", ["get", "big"], 1], 13, 10],
      "circle-color": ["get", "color"],
      "circle-stroke-color": ["get", "state"],
      "circle-stroke-width": 3,
    },
  },
  { id: "unit-labels", type: "symbol", source: "units", layout: { ...label(10, [0, 0]), "text-ignore-placement": true }, paint: { "text-color": "#0b1120" } },
];
