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
import { ambulanceActivity, ambulanceAvailability, buildSituation, matchingEntities, relatedEntities, entityExists } from "../src/ui/situation/model";
import type { RunMeta } from "../src/ui/runModel";
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

test("new engine traces are rejected explicitly instead of being treated as legacy patients", () => {
  assert.throws(() => assertRunRecords([{
    tick: 0,
    frame: { units: [], scenes: [], incidents: [], hospitals: [], closedEdges: [] },
    events: [], calls: [], actions: [],
  }]), /nuevo formato de unidades e incidentes/);
  assert.throws(() => assertRunRecords(null), /Formato de registros/);
  assert.throws(() => assertRunRecords([null]), /Formato de registros/);
});

const meta: RunMeta = {
  id: "situation-test", map: "test", seed: 1, ticks: 10, coordinator: "rules", model: null,
  config: { tickSeconds: 30, ambulances: 3, hospitals: 1, hospitalCapacity: 2, ambulanceSpeedFactor: 1, pickupTicks: 2, dropoffTicks: 3, ttlDecayInAmbulance: 0.5 }, hospitals: [{ id: "H1", name: "Hospital", node: 0, capacity: 2 }],
  startedAt: "2026-09-19T00:00:00Z", status: "finished", summary: null,
};

test("frontend distinguishes loading and unloading from availability using the supplied busy deadline", () => {
  const pickup = { ...unit, patientId: "P1", targetPatientId: null, mission: "to_hospital" as const, busyUntil: 3, etaTicks: 0 };
  assert.equal(ambulanceActivity(pickup, 1, 30).label, "Recogiendo");
  assert.equal(ambulanceAvailability(pickup, 1), false);
  const unloading = { ...unit, mission: "idle" as const, patientId: null, targetPatientId: null, hospitalId: null, route: [], busyUntil: 6 };
  assert.equal(ambulanceAvailability(unloading, 3), false);
  assert.equal(ambulanceActivity(unloading, 3, 30).label, "Descargando");
  assert.equal(ambulanceAvailability(unloading, 5), false);
  assert.equal(ambulanceAvailability(unloading, 6), true);
});

test("legacy idle units are unknown, while broken and stranded units are never available", () => {
  const idle = { ...unit, mission: "idle" as const, targetPatientId: null, hospitalId: null, route: [] };
  assert.equal(ambulanceAvailability(idle, 5), null);
  assert.equal(ambulanceActivity(idle, 5, 30).label, "Sin misión");
  assert.equal(ambulanceAvailability({ ...idle, busyUntil: 0, broken: true }, 5), false);
  assert.equal(ambulanceAvailability({ ...idle, busyUntil: 0, stranded: true }, 5), false);
  const s = buildSituation({ ...record, frame: { ...record.frame, ambulances: [idle] } }, meta, [record], graph);
  assert.equal(s.unknownAvailability, 1);
  assert.equal(s.available, 0);
});

function operationalRecord(): TickRecord {
  return { ...record, tick: 5, frame: { ...record.frame,
    ambulances: [
      { ...unit, id: "A2", mission: "to_hospital", patientId: "P2", targetPatientId: null, busyUntil: 0, broken: true, brokenUntil: 9 },
      { ...unit, id: "A1", busyUntil: 0 },
    ],
    patients: [
      { id: "P1", node: 0, status: "waiting", ttl: 10, endTick: null, spawnTick: 2 },
      { id: "P2", node: 0, status: "in_ambulance", ttl: 10, endTick: null, spawnTick: 0, pickupTick: 3 },
      { id: "P3", node: 0, status: "waiting", ttl: 10, endTick: null },
    ], hospitals: [{ id: "H1", occupied: 2 }], closedEdges: [0],
  } };
}

test("hospital demand counts on-board transfers including a breakdown, without counting preassigned pickups", () => {
  const r = operationalRecord();
  const s = buildSituation(r, meta, [r], graph);
  assert.equal(s.hospitals[0].occupied, 2);
  assert.equal(s.hospitals[0].incoming.length, 1);
  assert.equal(s.hospitals[0].margin, -1);
  assert.equal(s.cases[1].label, "Bloqueado");
  assert.equal(s.unassigned, 1);
  assert.equal(s.cases[0].label, "En recogida");
  assert.deepEqual(s.units.map((a) => a.id), ["A1", "A2"]);
});

test("history enrichment excludes later events and never uses the final run balance", () => {
  const r = operationalRecord();
  const future: TickRecord = { ...r, tick: 10, events: [
    { type: "patient_spawned", tick: 10, patientId: "P3", node: 0, ttl: 10 },
    { type: "patient_picked_up", tick: 10, patientId: "P1", ambulanceId: "A1" },
  ] };
  const s = buildSituation(r, { ...meta, summary: { ...r.frame.summary, saved: 999 } }, [r, future], graph);
  assert.equal(s.cases[0].wait, 3);
  assert.equal(s.cases[1].wait, 3);
  assert.equal(s.cases[2].wait, null);
  assert.equal(s.saved, r.frame.summary.saved);
  assert.equal(entityExists(record, meta, { kind: "patient", id: "P1" }), false);
  assert.equal(entityExists(r, meta, { kind: "road", id: "0" }), true);
});

test("case selection connects its unit, destination and closed route; filters keep global counts intact", () => {
  const r = operationalRecord(), s = buildSituation(r, meta, [r], graph);
  assert.deepEqual([...relatedEntities(s, { kind: "patient", id: "P1" })].sort(), ["ambulance:A1", "hospital:H1", "patient:P1", "road:0"]);
  assert.deepEqual([...matchingEntities(s, "unassigned", "", false)], ["patient:P3"]);
  assert.deepEqual([...matchingEntities(s, "broken", "", false)], ["ambulance:A2"]);
  assert.deepEqual([...matchingEntities(s, "full", "", false)], ["hospital:H1"]);
  assert.deepEqual([...matchingEntities(s, "all", "p3", false)], ["patient:P3"]);
  assert.equal(s.active.length, 3);
  assert.equal(s.hospitals.length, 1);
});
