import { test } from "node:test";
import assert from "node:assert/strict";
import type { Frame, IncidentFrame, RunMeta, TickRecord, UnitFrame } from "../src/ui/engineTrace";
import { buildSituation, matchingEntities, relatedEntities } from "../src/ui/situation/model";

const config = {
  tickSeconds: 30, ambulances: 3, fireUnits: 1, rescueUnits: 1, helicopters: 0, hospitals: 2, hospitalCapacity: 2,
  ambulanceSpeedFactor: 1, pickupTicks: 2, dropoffTicks: 3, treatTicks: 4, extricateTicks: 5, searchRadiusM: 300,
} as RunMeta["config"];
const meta = {
  id: "situation-test", map: "test", seed: 1, ticks: 10, coordinator: "greedy", model: null, config,
  hospitals: [
    { id: "H1", name: "Hospital General", node: 0, capacity: 2, helipad: true },
    { id: "H2", name: "Clínico", node: 1, capacity: 1, helipad: false },
  ],
  startedAt: "2026-09-19T00:00:00Z", status: "finished", summary: null,
} as RunMeta;
const unit = (id: string, kind: UnitFrame["kind"], extra: Partial<UnitFrame> = {}): UnitFrame => ({
  id, kind, pos: [0, 0], mission: "idle", incidentId: null, victimId: null, hospitalId: null,
  broken: false, stranded: false, route: [], ...extra,
});
const incident = (id: string, extra: Partial<IncidentFrame> = {}): IncidentFrame => ({
  id, status: "open", closedReason: null, mergedInto: null, emergencyId: null, openedTick: 1, updatedTick: 1,
  node: 0, locationErrorM: 150, located: false, sceneId: null, callIds: ["L1"], mechanism: null,
  conscious: null, breathing: null, bleeding: null, trapped: null, ageGroup: null, victimsReported: null,
  victims: [], priority: 1, unreachable: false, history: [], line: `${id} · P1`, cutOffIn: null, ...extra,
});
const record = (tick: number, frame: Partial<Frame>, events: TickRecord["events"] = []): TickRecord => ({
  tick, events, calls: [], actions: [],
  frame: {
    units: [], scenes: [], incidents: [], floods: [], knownWater: { zones: [], sightings: [] },
    knownClosedEdges: [], hospitals: [{ id: "H1", occupied: 1 }, { id: "H2", occupied: 1 }], closedEdges: [],
    summary: { ticks: tick, victims: 3, saved: 1, dead: 0, waiting: 1, inAmbulance: 1, survivalRate: 1, inWater: 0, reachableSurvivalRate: 1, meanResponseTicks: 2 },
    ...frame,
  },
});

test("freeing, picking up, treating and unloading keep a crew busy for as long as the engine's rules say", () => {
  const onScene = record(2, { units: [unit("A1", "ambulance", { mission: "to_hospital", incidentId: "C1", victimId: "V2", hospitalId: "H1" }), unit("B1", "fire")] }, [
    { type: "victim_freed", tick: 2, victimId: "V1", unitId: "B1", incidentId: "C1" },
    { type: "victim_picked_up", tick: 2, victimId: "V2", unitId: "A1", incidentId: "C1" },
    { type: "victim_treated", tick: 2, victimId: "V3", unitId: "B1", incidentId: "C1" },
  ]);
  const s = buildSituation(onScene, meta, [onScene], null);
  assert.deepEqual(s.units.map((u) => [u.id, u.label, u.available]), [["A1", "Recogiendo", false], ["B1", "Atendiendo en el lugar", false]]);
  assert.equal(s.units[0].detail, "V2 a bordo en 1 min · después, traslado a H1");
  const unloading = record(6, { units: [unit("A1", "ambulance"), unit("B1", "fire")] }, [
    { type: "victim_delivered", tick: 6, victimId: "V2", unitId: "A1", hospitalId: "H1" },
  ]);
  assert.deepEqual(buildSituation(unloading, meta, [onScene, unloading], null).units.map((u) => u.label), ["Descargando", "Atendiendo en el lugar"]);
  const later = record(11, { units: [unit("A1", "ambulance"), unit("B1", "fire")] });
  const free = buildSituation(later, meta, [onScene, unloading, later], null);
  assert.deepEqual(free.units.map((u) => [u.label, u.available]), [["Disponible", true], ["Disponible", true]]);
  assert.equal(free.available, 2);
});

test("broken and stranded units are never available; a breakdown shows when it will be repaired", () => {
  const r = record(3, { units: [unit("A1", "ambulance", { broken: true }), unit("R1", "rescue", { stranded: true, mission: "to_scene", incidentId: "C2" })] }, [
    { type: "unit_broken", tick: 3, unitId: "A1", untilTick: 9 },
  ]);
  const s = buildSituation(r, meta, [r], null);
  assert.deepEqual(s.units.map((u) => [u.label, u.detail, u.available]), [
    ["Averiada", "Reparación prevista en 3 min", false],
    ["Sin ruta conocida", "Ningún camino conocido llega a C2", false],
  ]);
  assert.equal(s.broken, 1);
});

test("hospital demand counts victims on board, stopped transfers included, never a hospital picked before the pickup", () => {
  const r = record(5, { units: [
    unit("A1", "ambulance", { mission: "to_hospital", incidentId: "C1", victimId: "V1", hospitalId: "H1" }),
    unit("A2", "ambulance", { broken: true, incidentId: "C2", victimId: "V2", hospitalId: "H1" }),
    unit("A3", "ambulance", { mission: "to_scene", incidentId: "C3", hospitalId: "H1" }),
  ] });
  const [h1, h2] = buildSituation(r, meta, [r], null).hospitals;
  assert.deepEqual(h1.incoming.map((u) => u.id), ["A1", "A2"]);
  assert.deepEqual([h1.free, h1.margin, h2.free], [1, -1, 0]);
});

test("the past only knows what had happened by then, and never the run's final balance", () => {
  const now = record(4, { units: [unit("A1", "ambulance", { mission: "to_hospital", victimId: "V1", hospitalId: "H1" })] });
  const future = record(5, { units: [unit("A1", "ambulance", { broken: true })] }, [
    { type: "victim_delivered", tick: 5, victimId: "V1", unitId: "A1", hospitalId: "H1" },
    { type: "unit_broken", tick: 5, unitId: "A1", untilTick: 20 },
  ]);
  const s = buildSituation(now, { ...meta, summary: { ...now.frame.summary, saved: 999 } }, [now, future], null);
  assert.equal(s.units[0].label, "Traslado a H1");
  assert.equal(s.saved, now.frame.summary.saved);
});

test("selecting an incident ties its crews, their hospital and the real scene; filters keep the global counts", () => {
  const r = record(6, {
    units: [unit("A1", "ambulance", { mission: "to_scene", incidentId: "C1", hospitalId: "H2" }), unit("B1", "fire", { broken: true }), unit("R1", "rescue")],
    incidents: [
      incident("C3", { priority: 3, status: "closed", closedReason: "resolved" }),
      incident("C2", { unreachable: true }),
      incident("C1", { priority: 0, sceneId: "S1" }),
    ],
    scenes: [{ id: "S1", kind: "flooded_home", node: 0, resolved: false, victims: [] }],
  });
  const s = buildSituation(r, meta, [r], null);
  assert.deepEqual(s.incidents.map((i) => [i.id, i.label]), [["C1", "Unidad en camino"], ["C2", "Sin acceso por carretera"], ["C3", "Resuelto"]]);
  const tied = ["hospital:H2", "incident:C1", "scene:S1", "unit:A1"];
  assert.deepEqual([...relatedEntities(s, { kind: "incident", id: "C1" })].sort(), tied);
  assert.deepEqual([...relatedEntities(s, { kind: "scene", id: "S1" })].sort(), tied);
  assert.deepEqual([...matchingEntities(s, "unattended", "", false)], ["incident:C2"]);
  assert.deepEqual([...matchingEntities(s, "isolated", "", false)], ["incident:C2"]);
  assert.deepEqual([...matchingEntities(s, "broken", "", false)], ["unit:B1"]);
  assert.deepEqual([...matchingEntities(s, "full", "", false)], ["hospital:H2"]);
  assert.deepEqual([...matchingEntities(s, "all", "c3", false)], []);
  assert.deepEqual([...matchingEntities(s, "all", "c3", true)], ["incident:C3"]);
  assert.deepEqual([s.open.length, s.unattended, s.isolated], [2, 1, 1]);
});

test("a place cut off by the water stays flagged until a crew that wades or flies is on its way", () => {
  const label = (frame: Partial<Frame>) => {
    const r = record(7, frame);
    return buildSituation(r, meta, [r], null).incidents[0].label;
  };
  const cut = incident("C4", { cutOffIn: 0 });
  assert.equal(label({ incidents: [cut], units: [unit("A1", "ambulance", { mission: "to_scene", incidentId: "C4" })] }), "Aislado por el agua");
  assert.equal(label({ incidents: [cut], units: [unit("R1", "rescue", { mission: "to_scene", incidentId: "C4" })] }), "Unidad en camino");
  assert.equal(label({ incidents: [incident("C5", { priority: 2, cutOffIn: 4 })] }), "El agua lo aísla en 2 min");
});

test("water and closures set what the coordinator knows against what is real", () => {
  const r = record(8, {
    knownClosedEdges: [0], closedEdges: [0, 1, 2],
    knownWater: { zones: [{ id: "Z1", name: "Barranco del Poyo", node: 0, radiusM: 400, ageTicks: 6 }], sightings: [{ node: 0, kind: "blocked", ageTicks: 1 }, { node: 1, kind: "wet", ageTicks: 2 }] },
  });
  const { water } = buildSituation(r, meta, [r], null);
  assert.deepEqual([water.zones.length, water.sightings, water.blocked, water.closed, water.real, water.unreported], [1, 2, 1, 1, 3, 2]);
});

test("an incident is waiting while nobody who can reach it is on it, whatever its ticket says", () => {
  const state = (incidents: IncidentFrame[], units: UnitFrame[] = []) => {
    const r = record(9, { incidents, units });
    return buildSituation(r, meta, [r], null).incidents.map((i) => i.attention);
  };
  assert.deepEqual(state([incident("C1")]), ["waiting"]);
  assert.deepEqual(state([incident("C1")], [unit("A1", "ambulance", { mission: "to_scene", incidentId: "C1" })]), ["attended"]);
  // Cut off by the water: an ambulance on its way does not count, a boat does.
  assert.deepEqual(state([incident("C2", { cutOffIn: 0 })], [unit("A1", "ambulance", { mission: "to_scene", incidentId: "C2" })]), ["waiting"]);
  assert.deepEqual(state([incident("C2", { unreachable: true })], [unit("R1", "rescue", { mission: "to_scene", incidentId: "C2" })]), ["attended"]);
  assert.deepEqual(state([incident("C3", { status: "closed", closedReason: "resolved" })]), ["resolved"]);
});
