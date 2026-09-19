import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRunRecords,
  unitStatus,
  type AmbulanceFrame,
  type GraphData,
  type TickRecord,
} from "../src/ui/runModel";
import { auditItems } from "../src/ui/thoughts/model";
import { remainingRoute } from "../src/ui/map/routes";
const unit: AmbulanceFrame = {
  id: "A1",
  pos: [0.5, 0],
  mission: "to_patient",
  patientId: null,
  targetPatientId: "P1",
  hospitalId: "H1",
  broken: false,
  stranded: false,
  route: [[0, 1]],
};
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
const record: TickRecord = {
  tick: 2,
  frame: {
    ambulances: [unit],
    patients: [],
    hospitals: [],
    closedEdges: [],
    summary: {
      ticks: 3,
      patients: 0,
      saved: 0,
      dead: 0,
      waiting: 0,
      inAmbulance: 0,
      survivalRate: 0,
      meanResponseTicks: 0,
    },
  },
  events: [
    { type: "patient_spawned", tick: 2, patientId: "P1", node: 0, ttl: 10 },
    {
      type: "action_rejected",
      tick: 2,
      action: { type: "dispatch", ambulanceId: "A1", patientId: "P1" },
      reason: "No route",
    },
  ],
  actions: [{ type: "dispatch", ambulanceId: "A1", patientId: "P1" }],
  decision: { source: "fallback", error: "timeout" },
};
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
test("audit separates master from coordinator without claiming engine outcomes as master reasoning", () => {
  const items = auditItems([record]);
  assert.equal(items.length, 2);
  assert.equal(items[0].lane, "master");
  assert.equal(items[1].lane, "coordinator");
  assert.equal(items[1].record.events[1].type, "action_rejected");
  assert.deepEqual(items[1].patients, ["P1"]);
  assert.equal(items[1].record.decision?.source, "fallback");
  assert.equal(items[1].record.decision?.reasons, undefined);
  const arrived = {
    ...record,
    decision: undefined,
    actions: [],
    events: [
      { type: "ambulance_arrived", tick: 2, ambulanceId: "A1", node: 1 },
    ],
  } as TickRecord;
  assert.equal(auditItems([arrived])[0].lane, "world");
});
test("idle without busyUntil is not presented as available", () =>
  assert.equal(
    unitStatus({ ...unit, mission: "idle", targetPatientId: null }),
    "Sin misión",
  ));
test("invalid activity records fail explicitly instead of silently showing an empty fleet", () => {
  assert.doesNotThrow(() => assertRunRecords([record]));
  assert.throws(
    () =>
      assertRunRecords([
        { ...record, frame: { units: [unit] } } as unknown as TickRecord,
      ]),
    /Formato de registros de actividad no válido/,
  );
});
