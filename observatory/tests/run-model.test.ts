import { test } from "node:test";
import assert from "node:assert/strict";
import { auditItems } from "../src/ui/audit/model";
import type { GraphData, TickRecord } from "../src/ui/engineTrace";
import { remainingRoute } from "../src/ui/map/routes";
const unit = { pos: [0.5, 0] as [number, number], route: [[0, 1]] as [number, 0 | 1][] };
const graph = {
  nodes: [
    [0, 0],
    [1, 1],
  ],
  edges: [
    {
      a: 0,
      b: 1,
      len: 100,
      kph: 30,
      oneway: false,
      geom: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
  ],
  hospitals: [],
  name: "test",
  bbox: [0, 0, 1, 1],
} as GraphData;
test("route starts at GPS and preserves bends, in either traversal direction", () => {
  assert.deepEqual(remainingRoute(unit, graph), [
    [0.5, 0],
    [1, 0],
    [1, 1],
  ]);
  assert.deepEqual(
    remainingRoute({ ...unit, pos: [1, 0.5], route: [[0, 0]] }, graph),
    [
      [1, 0.5],
      [1, 0],
      [0, 0],
    ],
  );
});
test("activity reads the engine model: calls, crews and the coordinator, each tied to its incident", () => {
  const order = { type: "dispatch", unitId: "A1", incidentId: "C1", node: 3, hospitalId: "H1" } as const;
  const call = {
    id: "L1", tick: 2, caller: "family", mechanism: "flooded_home", node: 3, locationErrorM: 150,
    street: "Carrer Major", conscious: "yes", breathing: "normal", bleeding: "no", trapped: "yes",
    ageGroup: "elderly", victims: 2, text: "Un familiar: «Se inunda la planta baja.»",
  } as const;
  const engineRecord = {
    tick: 2,
    frame: { units: [], scenes: [], incidents: [{ id: "C1", callIds: ["L1"] }], floods: [], knownWater: { zones: [], sightings: [] }, knownClosedEdges: [], hospitals: [], closedEdges: [], summary: {} },
    events: [
      { type: "call_received", tick: 2, call },
      { type: "scene_created", tick: 2, sceneId: "S1", kind: "flooded_home", node: 3, victims: 2 },
      { type: "action_rejected", tick: 2, action: order, reason: "unit is broken down" },
      { type: "road_blocked_found", tick: 2, unitId: "B1", node: 4, edges: [7], flooded: true },
    ],
    calls: [call],
    actions: [order],
    decision: { source: "fallback", error: "timeout" },
  } as unknown as TickRecord;
  const items = auditItems([engineRecord]);
  assert.deepEqual(
    items.map((x) => [x.lane, x.event?.type ?? "decision", x.refs]),
    [
      ["call", "call_received", ["L1", "C1"]],
      ["master", "scene_created", ["S1"]],
      // The order's rejection belongs to the decision card; the crew's report is the engine's.
      ["world", "road_blocked_found", ["B1"]],
      ["coordinator", "decision", ["A1", "C1"]],
    ],
  );
  assert.equal(items[3].record.decision?.source, "fallback");
});
