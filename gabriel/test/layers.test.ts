import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { expect, it } from "vitest";
import { LAYERS, SOURCES } from "../ui/src/layers";

it("map overlay layers are a valid MapLibre style", () => {
  const sources = Object.fromEntries(SOURCES.map((id) => [id, { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } }]));
  const errors = validateStyleMin({ version: 8, glyphs: "https://example.com/{fontstack}/{range}.pbf", sources, layers: LAYERS });
  expect(errors.map((e) => e.message)).toEqual([]);
});
