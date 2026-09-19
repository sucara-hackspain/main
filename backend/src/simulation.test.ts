import assert from "node:assert/strict";
import { test } from "node:test";
import { cutStreet, punctureAmbulance, spawnInjured } from "./actions.js";
import { PUNCTURE_REPAIR_TURNS } from "./config.js";
import type { Graph } from "./map/graph.js";
import { RoadMap } from "./map/road-map.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setInboxFile } from "./inbox.js";
import { setRecorderRoot, startRun } from "./recorder.js";
import { step } from "./simulation.js";
import { CallSchema } from "./triage.js";
import type { World } from "./world.js";

// Los tests corren en backend/: nada de tocar la partida real (state.json, runs/, inbox.jsonl).
const SANDBOX = mkdtempSync(join(tmpdir(), "dana-test-"));
setRecorderRoot(SANDBOX);
setInboxFile(join(SANDBOX, "inbox.jsonl"));

// A -500- B -500- C -500- D   (calle "mid" = B-C)
// A ------800------ E ------800------ D
const graph: Graph = {
  nodes: { 1: [0, 0], 2: [0, 0.005], 3: [0, 0.01], 4: [0, 0.015], 5: [0.005, 0.0075] },
  edges: [[1, 2, 500, "west"], [2, 3, 500, "mid"], [3, 4, 500, "east"], [1, 5, 800, "north"], [5, 4, 800, "north"]],
};

test("rescate, desvío por corte, pinchazo y muerte", async () => {
  const map = new RoadMap(graph);
  const w: World = {
    turn: 0,
    base: { position: 1 },
    ambulances: [{ id: "A1", position: 1, target: null, repairTurns: 0 }],
    injured: [],
    cuts: [],
    incidents: [],
    followups: [],
    stats: { rescued: 0, dead: 0 },
    log: [],
    events: [],
    nextInjuredId: 1, nextIncidentId: 1,
    ui: { prevIncidents: [], closed: [], timeline: {} },
  };
  const A1 = w.ambulances[0];

  spawnInjured(w, map, 4, 10); // H1 en D
  await step(w, map);
  assert.equal(A1.position, 2, "600m de presupuesto: llega a B, no a C");
  await step(w, map);
  await step(w, map);
  assert.deepEqual([A1.position, w.stats.rescued, A1.target], [4, 1, null]);

  cutStreet(w, map, "mid");
  spawnInjured(w, map, 1, 10); // H2 en A: la ruta corta está cortada → por E
  await step(w, map);
  assert.equal(A1.position, 5, "desvía por E al estar B-C cortada");
  await step(w, map);
  assert.equal(w.stats.rescued, 2);

  spawnInjured(w, map, 4, 20); // H3 en D
  punctureAmbulance(w, "A1");
  for (let i = 0; i < PUNCTURE_REPAIR_TURNS; i++) await step(w, map);
  assert.equal(A1.position, 1, "pinchada: no se mueve");
  await step(w, map);
  assert.equal(A1.position, 5, "reparada: vuelve a moverse");

  spawnInjured(w, map, 1, 1); // H4 muere este turno (A1 está lejos); A1 llega a D y rescata a H3
  await step(w, map);
  assert.deepEqual([w.stats.dead, w.stats.rescued, w.injured], [1, 3, []]);
});

test("triaje: la prioridad del tablón manda sobre el ttl; calle por nombre; llamada tolerante", async () => {
  const { greedyCoordinator } = await import("./coordinator.js");
  const map = new RoadMap(graph);
  assert.equal(map.findStreet("Carrer de Mid"), 2);
  assert.equal(map.findStreet("carrer de les Mid, nº 12"), 2, "sin tipo de vía, artículos ni número");
  assert.equal(map.findStreet("Calle Inventada"), null);

  const w: World = {
    turn: 0,
    base: { position: 1 },
    ambulances: [{ id: "A1", position: 1, target: null, repairTurns: 0 }],
    injured: [],
    cuts: [],
    incidents: [{ id: "I1", callIds: ["H2"], priority: "critical" }],
    followups: [],
    stats: { rescued: 0, dead: 0 },
    log: [],
    events: [],
    nextInjuredId: 1, nextIncidentId: 1,
    ui: { prevIncidents: [], closed: [], timeline: {} },
  };
  spawnInjured(w, map, 2, 5); // H1 en B, ttl 5, sin triar → medium
  spawnInjured(w, map, 4, 20); // H2 en D, ttl 20, critical en el tablón
  greedyCoordinator(w, map);
  assert.equal(w.ambulances[0].target, "H2", "critical antes que medium aunque su ttl sea mayor");

  const call = CallSchema.parse({ street: "Sueca", victims: "2", mechanism: null, breathing: 7 });
  assert.deepEqual([call.street, call.victims, call.mechanism, call.breathing, call.caller], ["Sueca", 2, null, "unknown", "bystander"]);
  assert.equal(CallSchema.parse({ phone: "623000000" }).phone, "+34623000000", "teléfono nacional → E.164");
});

test("seguimiento: solo con teléfono y prioridad elegible al rescatar; espera su turno; reintento si no contesta; escalado vuelve al tablón", async () => {
  const { FollowupPostSchema, placeFollowupCalls, priorityAfter, receiveFollowup, scheduleFollowup } = await import("./followup.js");
  const { FOLLOWUP_AFTER_TURNS } = await import("./config.js");
  const map = new RoadMap(graph);
  const w: World = {
    turn: 4,
    base: { position: 1 },
    ambulances: [],
    injured: [],
    cuts: [],
    incidents: [{ id: "I1", callIds: ["H1"], priority: "low" }, { id: "I2", callIds: ["H2"], priority: "high" }],
    followups: [],
    stats: { rescued: 0, dead: 0 },
    log: [],
    events: [],
    nextInjuredId: 1, nextIncidentId: 1,
    ui: { prevIncidents: [], closed: [], timeline: {} },
  };
  const call = CallSchema.parse({ street: "Carrer de Mid", phone: "+34600000000", text: "Me he caído" });
  const h1 = spawnInjured(w, map, 2, 20, call); // leve con teléfono → seguimiento real
  const h2 = spawnInjured(w, map, 3, 5, call); // grave → no
  const h3 = spawnInjured(w, map, 4, 20); // sin llamada, sin triar (medium): seguimiento simulado si está activado
  for (const h of [h1, h2, h3]) scheduleFollowup(w, map, h);
  const { FOLLOWUP_SIMULATED, FOLLOWUP_PRIORITIES } = await import("./config.js");
  const due = 4 + FOLLOWUP_AFTER_TURNS;
  const expected = [["H1", "pending", "+34600000000", due], ...(FOLLOWUP_PRIORITIES.includes("high") ? [["H2", "pending", "+34600000000", due]] : []), ...(FOLLOWUP_SIMULATED && FOLLOWUP_PRIORITIES.includes("medium") ? [["H3", "pending", null, due]] : [])];
  assert.deepEqual(w.followups.map((f) => [f.id, f.status, f.call.phone, f.dueTurn]), expected, "según FOLLOWUP_PRIORITIES y FOLLOWUP_SIMULATED del .env");
  w.followups = w.followups.filter((f) => f.id === "H1");
  await placeFollowupCalls(w, map);
  assert.equal(w.followups[0].runId, undefined, "antes de su turno no se llama");

  w.followups[0].status = "calling";
  w.followups[0].tries = 1;
  const noTriage = async () => {};
  const post = (followup: object) => FollowupPostSchema.parse({ callId: "H1", callStatus: "completed", followup });
  await receiveFollowup(w, map, post({ reached: "no_answer", nextAction: "retry_call" }), noTriage);
  assert.deepEqual([w.followups[0].status, w.followups[0].dueTurn], ["pending", 4 + FOLLOWUP_AFTER_TURNS], "no contesta: se reintenta más tarde");
  await receiveFollowup(w, map, post({ reached: "patient", evolution: "worse", escalate: "yes", nextAction: "dispatch_resource", street: "Carrer de East", bleeding: "yes", text: "Sangra otra vez" }), noTriage);
  const back = w.injured.at(-1)!;
  assert.deepEqual([w.followups[0].status, w.followups[0].priority, back.id, back.position, back.call?.bleeding], ["done", "high", "H4", 3, "yes"], "escalado: prioridad high y vuelve como herido nuevo en la calle que dice");
  assert.deepEqual([priorityAfter(FollowupPostSchema.parse({ callId: "x", followup: { evolution: "better", nextAction: "close" } }).followup, "medium"), priorityAfter(FollowupPostSchema.parse({ callId: "x", followup: { evolution: "same", redFlags: "fiebre alta", nextAction: "monitor" } }).followup, "low"), priorityAfter(FollowupPostSchema.parse({ callId: "x", followup: { evolution: "same", nextAction: "monitor" } }).followup, "medium")], ["low", "high", "medium"]);
  await assert.rejects(receiveFollowup(w, map, { ...post({}), callId: "H9" }, noTriage), /desconocido/);
});

test("registro para el Control Center: mapa, unidades, incidentes con expediente, cierre por rescate", async () => {
  const map = new RoadMap(graph);
  const w: World = {
    turn: 0, base: { position: 1 }, ambulances: [{ id: "A1", position: 1, target: null, repairTurns: 0 }], injured: [], cuts: [],
    incidents: [], followups: [], stats: { rescued: 0, dead: 0 }, log: [], events: [], nextInjuredId: 1, nextIncidentId: 1, ui: { prevIncidents: [], closed: [], timeline: {} },
  };
  const root = SANDBOX;
  startRun(w, map);
  const ui = JSON.parse(readFileSync(`${root}/data/valencia-ui.json`, "utf8"));
  assert.deepEqual([ui.nodes.length, ui.edges.length, ui.hospitals[0].node, ui.edges[1].name], [5, 5, 0, "mid"]);

  spawnInjured(w, map, 4, 10, CallSchema.parse({ street: "Carrer de Mid", mechanism: "fall", conscious: "yes", text: "Caída" })); // H1 en D
  w.incidents = [{ id: "I1", callIds: ["H1"], priority: "high", street: "Carrer de Mid", text: "Caída en Mid" }];
  await step(w, map, {}); // A1 → H1, avanza; registro t0
  await step(w, map, {}); // registro t1
  await step(w, map, {}); // llega y rescata; registro t2
  const records = readFileSync(`${root}/runs/${w.runId}/ticks.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(records.map((r) => r.tick), [0, 1, 2]);
  const r0 = records[0];
  assert.deepEqual(r0.events.map((e: { type: string }) => e.type), ["call_received", "scene_created", "action_applied"]);
  assert.deepEqual([r0.frame.units[0].incidentId, r0.frame.units[0].mission, r0.frame.units[0].route.length], ["I1", "to_scene", 2]);
  assert.deepEqual([r0.frame.incidents[0].id, r0.frame.incidents[0].priority, r0.frame.incidents[0].timeline.map((t: { kind: string }) => t.kind)], ["I1", 1, ["call", "order"]]);
  const r2 = records[2];
  assert.ok(r2.events.some((e: { type: string }) => e.type === "victim_delivered"), "rescate = entrega en hospital");
  assert.deepEqual([r2.frame.incidents[0].status, r2.frame.incidents[0].closedReason, r2.frame.summary.saved], ["closed", "resolved", 1]);
  const meta = JSON.parse(readFileSync(`${root}/runs/${w.runId}/meta.json`, "utf8"));
  assert.deepEqual([meta.map, meta.status, meta.hospitals[0].id], ["valencia-ui", "running", "LaFe"]);
});

test("bandeja de webhooks: una llamada y un parte entran con el siguiente step", async () => {
  const { drainInbox, enqueue } = await import("./inbox.js");
  const { existsSync } = await import("node:fs");
  const INBOX_FILE = join(SANDBOX, "inbox.jsonl");
  const map = new RoadMap(graph);
  const w: World = {
    turn: 3, base: { position: 1 }, ambulances: [], injured: [], cuts: [], incidents: [], followups: [], stats: { rescued: 0, dead: 0 }, log: [], events: [], nextInjuredId: 1, nextIncidentId: 1,
    ui: { prevIncidents: [], closed: [], timeline: {} }, runId: "test",
  };
  enqueue("call", { phone: "623000000", call: { street: "Carrer de Mid", text: "Caída" } });
  enqueue("followup", { callId: "H9", followup: { nextAction: "close" } }); // desconocido: se descarta con aviso
  await drainInbox(w, map);
  assert.deepEqual([w.injured[0]?.id, w.injured[0]?.position, w.injured[0]?.call?.phone, existsSync(INBOX_FILE)], ["H1", 2, "+34623000000", false]);
  assert.match(w.log.at(-1)!, /descartada: seguimiento desconocido/);
});
