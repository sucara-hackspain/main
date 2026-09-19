import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GraphData,
  IncidentFrame,
  RunMeta,
  TickRecord,
  UnitFrame,
  UnitKind,
} from "../src/ui/engineTrace";
import {
  detectInterventions,
  interventionsAt,
  prescribe,
} from "../src/ui/interventions/model";
import type { Router } from "../src/ui/interventions/routing";
import { incidentScene, incidentThread } from "../src/ui/interventions/scene";
import { auditItems } from "../src/ui/thoughts/model";

const unit = (id: string, kind: UnitKind, patch: Partial<UnitFrame> = {}): UnitFrame => ({
  id,
  kind,
  pos: [0, 0],
  mission: "idle",
  incidentId: null,
  victimId: null,
  hospitalId: null,
  broken: false,
  stranded: false,
  route: [],
  ...patch,
});
const incident = (id: string, patch: Partial<IncidentFrame> = {}): IncidentFrame => ({
  id,
  status: "open",
  closedReason: null,
  mergedInto: null,
  emergencyId: null,
  openedTick: 0,
  updatedTick: 0,
  node: 3,
  locationErrorM: 150,
  located: false,
  sceneId: null,
  callIds: ["L1"],
  mechanism: null,
  conscious: null,
  breathing: null,
  bleeding: null,
  trapped: null,
  ageGroup: null,
  victimsReported: null,
  victims: [],
  priority: 1,
  unreachable: false,
  history: [],
  line: `${id} · P1`,
  cutOffIn: null,
  ...patch,
});
const record = (
  tick: number,
  units: UnitFrame[],
  incidents: IncidentFrame[],
  patch: Partial<TickRecord> = {},
): TickRecord => ({
  tick,
  frame: {
    units,
    scenes: [],
    incidents,
    floods: [],
    knownWater: { zones: [], sightings: [] },
    knownClosedEdges: [],
    // H1 is full; H2 has beds and a helipad.
    hospitals: [
      { id: "H1", occupied: 14 },
      { id: "H2", occupied: 0 },
    ],
    closedEdges: [],
    summary: {
      ticks: tick,
      victims: 0,
      saved: 0,
      dead: 0,
      waiting: 0,
      inAmbulance: 0,
      survivalRate: 1,
      inWater: 0,
      reachableSurvivalRate: 1,
      meanResponseTicks: 0,
    },
  },
  events: [],
  calls: [],
  actions: [],
  ...patch,
});
/** The same situation for `n` ticks: requests only open once it has stood a while. */
const standing = (n: number, units: UnitFrame[], incidents: IncidentFrame[]) =>
  Array.from({ length: n }, (_, t) => record(t, units, incidents));
const meta = {
  config: { tickSeconds: 30, ambulanceSpeedFactor: 1.3 },
  hospitals: [
    { id: "H1", name: "Lleno", node: 1, capacity: 14, helipad: false },
    { id: "H2", name: "Con camas", node: 2, capacity: 14, helipad: true },
  ],
} as RunMeta;
// A1 is 6 ticks from anywhere, B1 4, R1 8, HEL1 3; nobody else has a way.
const eta: Record<string, number> = { A1: 6, B1: 4, R1: 8, HEL1: 3 };
const nodes: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [1, 1],
];
const router: Router = {
  eta: (u) => eta[u.id] ?? Infinity,
  etaFrom: () => 2,
  path: (u, node) => (eta[u.id] ? [u.pos, nodes[node]] : null),
  pathFrom: (_kind, from, node) => [nodes[from], nodes[node]],
};
const first = (records: TickRecord[]) => {
  const [item] = detectInterventions(records);
  return { item, plan: prescribe(item, records.at(-1)!, meta, router)! };
};

test("a P1 incident nobody works on, with units free, asks after standing three ticks", () => {
  const free = [unit("A1", "ambulance"), unit("R1", "rescue")];
  assert.deepEqual(detectInterventions(standing(2, free, [incident("C1")])), []);
  const { item, plan } = first(standing(3, free, [incident("C1")]));
  assert.deepEqual(
    [item.kind, item.severity, item.openedTick, item.incidentId],
    ["unassigned", "critical", 2, "C1"],
  );
  assert.equal(plan.options[0].label, "Enviar A1 a C1");
  // The order is the engine's own Action, heading on to the hospital with beds.
  assert.deepEqual(plan.options[0].action, {
    type: "dispatch",
    unitId: "A1",
    incidentId: "C1",
    node: 3,
    hospitalId: "H2",
  });
  assert.deepEqual(
    plan.options.map((o) => o.id),
    ["dispatch:A1", "dispatch:R1", "hold", "escalate"],
  );
});

test("trapped people call for someone who can free them first", () => {
  const free = [unit("A1", "ambulance"), unit("B1", "fire")];
  const trapped = incident("C1", { trapped: { value: "yes", from: "L1", tick: 0 } });
  const { plan } = first(standing(3, free, [trapped]));
  assert.equal(plan.options[0].id, "dispatch:B1");
  // Firefighters carry nobody: no hospital leg.
  assert.equal(plan.options[0].action?.type === "dispatch" && plan.options[0].action.hospitalId, undefined);
});

test("an urgent place the water cut off only gets water or air units", () => {
  const units = [unit("A1", "ambulance"), unit("R1", "rescue"), unit("HEL1", "helicopter")];
  const { item, plan } = first(standing(3, units, [incident("C1", { priority: 0, cutOffIn: 0 })]));
  assert.deepEqual([item.kind, item.title], ["unreachable", "El agua ha aislado C1"]);
  assert.deepEqual(
    plan.options.map((o) => o.id),
    ["dispatch:HEL1", "dispatch:R1", "escalate", "wait"],
  );
  // Already cut off: no countdown to the water.
  assert.equal(plan.deadlineTick, null);
});

test("less urgent isolated places share one request instead of one each", () => {
  const places = [
    incident("C1", { priority: 2, unreachable: true }),
    incident("C2", { priority: 3, cutOffIn: 0 }),
  ];
  const all = detectInterventions(standing(4, [unit("A1", "ambulance")], places));
  assert.deepEqual(
    all.map((x) => [x.kind, x.severity]),
    [["water", "warning"]],
  );
  const plan = prescribe(all[0], record(3, [unit("A1", "ambulance")], places), meta, router)!;
  assert.match(plan.summary, /^2 incidentes P2–P3 aislados/);
  assert.equal(plan.options[0].label, "Pedir embarcaciones externas");
});

test("the water forecast counts down, and a unit that arrives before it closes is the recommendation", () => {
  const { item, plan } = first(
    standing(3, [unit("A1", "ambulance")], [incident("C1", { cutOffIn: 10 })]),
  );
  assert.deepEqual([item.kind, item.severity], ["cutoff", "critical"]);
  assert.deepEqual([plan.deadlineTick, plan.deadlineSource], [2 + 10, "water"]);
  assert.equal(plan.options[0].label, "Enviar A1 ahora");
  assert.match(plan.rationale, /margen 00:02:00/);
});

test("a victim on board with no hospital: a helicopter only goes where there is a helipad", () => {
  const heli = unit("HEL1", "helicopter", { victimId: "V1", incidentId: "C1" });
  const { item, plan } = first(standing(2, [heli], []));
  assert.deepEqual([item.kind, item.victimId], ["loaded", "V1"]);
  assert.deepEqual(plan.options[0].action, {
    type: "transport",
    unitId: "HEL1",
    hospitalId: "H2",
  });
});

test("a unit stuck on its way asks to hand the incident to another, and settles when it moves again", () => {
  const stuck = unit("A1", "ambulance", { mission: "to_scene", incidentId: "C1", stranded: true });
  const records = [
    record(0, [stuck, unit("B1", "fire"), unit("R1", "rescue")], [incident("C1")]),
    record(1, [{ ...stuck, stranded: false }, unit("B1", "fire"), unit("R1", "rescue")], [incident("C1")]),
  ];
  const [item] = detectInterventions(records);
  assert.deepEqual(
    [item.kind, item.title, item.closedTick, item.outcome],
    ["stranded", "A1 sin ruta conocida hacia C1", 1, "A1 recuperó una ruta conocida"],
  );
  const plan = prescribe(item, records[0], meta, router)!;
  assert.equal(plan.options[0].label, "Reasignar C1 a R1");
});

test("saturation: urgent incidents wait and no unit is free for three ticks", () => {
  const busy = unit("A1", "ambulance", { mission: "to_hospital", victimId: "V0" });
  const all = detectInterventions(
    standing(3, [busy], [incident("C1"), incident("C2", { priority: 0 })]),
  );
  assert.deepEqual(
    all.map((x) => [x.kind, x.severity]),
    [["surge", "critical"]],
  );
});

test("rule fallback and rejected orders ask for supervision with their evidence", () => {
  const order = { type: "dispatch", unitId: "A1", incidentId: "C9", node: 3 } as const;
  const records = [
    record(0, [], [], {
      decision: { source: "fallback", error: "claude timed out" },
      events: [{ type: "action_rejected", tick: 0, action: order, reason: "unit is broken down" }],
    }),
    record(1, [], [], { decision: { source: "llm" } }),
  ];
  const [fallback, rejected] = detectInterventions(records);
  assert.deepEqual(
    [fallback.kind, fallback.severity, fallback.closedTick, fallback.outcome],
    ["fallback", "warning", 1, "La IA volvió a decidir"],
  );
  assert.match(prescribe(fallback, records[0], meta, router)!.summary, /claude timed out/);
  assert.match(prescribe(rejected, records[0], meta, router)!.summary, /A1 → C9 · unit is broken down/);
});

test("the view at a tick hides later outcomes and later decisions", () => {
  const all = detectInterventions([
    ...standing(4, [unit("A1", "ambulance")], [incident("C1")]),
    record(4, [unit("A1", "ambulance", { mission: "to_scene", incidentId: "C1" })], [incident("C1")]),
  ]);
  assert.deepEqual(interventionsAt(all, 1, {}), []);
  const [open] = interventionsAt(all, 3, {});
  assert.deepEqual([open.status, open.outcome], ["pending", null]);
  const [expired] = interventionsAt(all, 4, {});
  assert.deepEqual([expired.status, expired.outcome], ["expired", "El coordinador envió A1"]);
  const decision = {
    interventionId: all[0].id,
    optionId: "hold",
    label: "No enviar unidad por ahora",
    approved: false,
    tick: 3,
    at: "2026-09-19T08:00:00.000Z",
  };
  const [decided] = interventionsAt(all, 4, { [all[0].id]: decision });
  assert.deepEqual([decided.status, decided.decision], ["decided", decision]);
  // Before the operator answered, the request is still open: a replay asks again.
  const [before] = interventionsAt(all, 2, { [all[0].id]: decision });
  assert.deepEqual([before.status, before.decision], ["pending", undefined]);
});

// Streets 0-1-2 run east (edges 0 and 1); edge 2 goes north from 1 to node 3, where C1 is.
const streets = {
  name: "test",
  bbox: [0, 0, 1, 2],
  nodes,
  edges: [
    { a: 0, b: 1, len: 100, kph: 36, oneway: false, geom: [[0, 0], [1, 0]] },
    { a: 1, b: 2, len: 100, kph: 36, oneway: false, geom: [[1, 0], [2, 0]] },
    { a: 1, b: 3, len: 100, kph: 36, oneway: false, geom: [[1, 0], [1, 1]] },
  ],
  hospitals: [],
} as GraphData;
const call = {
  id: "L1", tick: 1, caller: "family", mechanism: "flooded_home", node: 3, locationErrorM: 150,
  street: "Carrer Major", conscious: "yes", breathing: "normal", bleeding: "no", trapped: "no",
  ageGroup: "elderly", victims: 1, text: "Un familiar: «Se inunda la planta baja.»",
} as const;
const order = { type: "dispatch", unitId: "A1", incidentId: "C1", node: 3, hospitalId: "H2" } as const;
const story = [
  record(1, [unit("A1", "ambulance"), unit("R1", "rescue", { pos: [2, 0] })], [incident("C1", { openedTick: 1 })], {
    events: [
      { type: "call_received", tick: 1, call },
      { type: "call_received", tick: 1, call: { ...call, id: "L9" } },
      { type: "action_applied", tick: 1, action: order, etaTicks: 4 },
    ],
    actions: [order],
    decision: { source: "rules" },
  }),
  record(4, [unit("A1", "ambulance", { pos: [0.5, 0], mission: "to_scene", incidentId: "C1", route: [[0, 1], [2, 1]] }), unit("R1", "rescue", { pos: [2, 0] })], [incident("C1", { openedTick: 1 })]),
  record(5, [unit("A1", "ambulance", { pos: [1, 0], mission: "to_scene", incidentId: "C1", stranded: true }), unit("R1", "rescue", { pos: [2, 0] })], [incident("C1", { openedTick: 1 })], {
    events: [
      { type: "road_blocked_found", tick: 5, unitId: "A1", node: 1, edges: [2], flooded: true },
      { type: "unit_stranded", tick: 5, unitId: "A1", incidentId: "C1" },
    ],
    decision: { source: "rules" },
  }),
];
story[0].frame.incidents[0].callIds = ["L1"];

test("the incident map shows what each option does, the route the unit had and what stopped it", () => {
  const item = detectInterventions(story).find((x) => x.kind === "stranded")!;
  const plan = prescribe(item, story[2], meta, router)!;
  const scene = incidentScene(item, plan, story[2], story, meta, streets, router);
  assert.deepEqual(
    [scene.incidents, scene.units, scene.blocked, scene.hospitals, scene.cause],
    [["C1"], ["A1", "R1"], "A1", ["H2"], [2]],
  );
  assert.deepEqual(
    scene.lines.map((l) => [l.kind, l.optionId ?? null, Boolean(l.prescribed)]),
    [
      ["option", "dispatch:R1", true],
      ["leg", "dispatch:R1", true],
      ["before", null, false],
    ],
  );
  assert.deepEqual([scene.lines[0].unitId, scene.lines[0].eta], ["R1", 8]);
});

test("the thread tells the incident's story: its calls, its crew and what the coordinator decided", () => {
  const item = detectInterventions(story).find((x) => x.kind === "stranded")!;
  const thread = incidentThread(item, auditItems(story), story[2]);
  assert.deepEqual(
    thread.map((x) => [x.tick, x.lane, x.event?.type ?? "decision", x.mark ?? null]),
    [
      [1, "call", "call_received", null],
      [1, "coordinator", "decision", null],
      [5, "world", "road_blocked_found", "cause"],
      [5, "world", "unit_stranded", "opened"],
      [5, "coordinator", "decision", null],
    ],
  );
});
