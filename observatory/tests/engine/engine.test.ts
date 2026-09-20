import { describe, expect, it } from "vitest";
import {
  CallObserver,
  createBelief,
  createWorld,
  DEFAULT_CONFIG,
  Graph,
  GreedyCoordinator,
  makeVictim,
  RandomMaster,
  Rng,
  Simulation,
  type EdgeData,
  type GraphData,
  type InjuryKind,
  type Master,
  type MasterAction,
  type AssessedVictim,
  type Call,
  type ObservedEvent,
  type SceneKind,
  type VictimSpec,
  applyTriage,
  infoGaps,
  updateBelief,
} from "../../src/engine";

/** n x n grid, 100 m two-way streets at 36 km/h = 10 s per edge. Node id = row * n + col. */
function grid(n: number): Graph {
  const nodes: GraphData["nodes"] = [];
  const edges: EdgeData[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) nodes.push([c * 0.001, r * 0.001]);
  const link = (a: number, b: number) =>
    edges.push({ a, b, len: 100, kph: 36, oneway: false, geom: [nodes[a], nodes[b]] });
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (c + 1 < n) link(r * n + c, r * n + c + 1);
      if (r + 1 < n) link(r * n + c, (r + 1) * n + c);
    }
  }
  const hospitals = [{ name: "Test Hospital", lon: 0, lat: 0, node: 0, emergency: true }];
  return new Graph({ name: "grid", bbox: [0, 0, 1, 1], nodes, edges, hospitals });
}

/** Master that plays a fixed script: tick -> actions. */
function scripted(script: Record<number, MasterAction[]>): Master {
  return { act: (world) => script[world.tick] ?? [] };
}

const CONFIG = { ambulances: 1, fireUnits: 0, rescueUnits: 0, helicopters: 0, drones: 0, ambulanceSpeedFactor: 1, pickupTicks: 0, dropoffTicks: 0, treatTicks: 0, extricateTicks: 0 };

function victim(injury: InjuryKind, ttl: number | null = null): VictimSpec {
  return { ...makeVictim(injury, new Rng(1)), ttl, trapped: false };
}

function scene(node: number, victims: VictimSpec[], kind: SceneKind = "traffic"): MasterAction {
  return { type: "spawn_scene", kind, node, victims };
}

/** Family callers give the exact spot, which keeps these scenarios deterministic. */
function sim(graph: Graph, script: Record<number, MasterAction[]>, config = CONFIG) {
  return new Simulation({
    graph,
    master: scripted(script),
    coordinator: new GreedyCoordinator(),
    observer: new CallObserver({ callers: ["family"] }),
    config,
  });
}


describe("graph", () => {
  it("routes around a closed road", () => {
    const g = grid(3);
    const open = g.route(0, 2)!;
    expect(open.seconds).toBe(20);
    const detour = g.route(0, 2, new Set([open.steps[0].edge]))!;
    expect(detour.seconds).toBe(40);
    expect(detour.steps.map((s) => s.edge)).not.toContain(open.steps[0].edge);
  });

  it("returns null when every way in is closed", () => {
    const g = grid(2);
    const intoCorner = g.data.edges.flatMap((e, i) => (e.a === 3 || e.b === 3 ? [i] : []));
    expect(g.route(0, 3, new Set(intoCorner))).toBeNull();
  });
});

describe("simulation", () => {
  it("hears a call, opens an incident, and the crew delivers the victim", async () => {
    const s = sim(grid(5), { 0: [scene(24, [victim("polytrauma", 60)])] });
    await s.run(25);
    const types = s.world.log.map((e) => e.type);
    expect(types).toEqual(["scene_created", "action_applied", "scene_assessed", "victim_picked_up", "victim_delivered"]);
    expect(s.summary()).toMatchObject({ saved: 1, dead: 0 });
    expect(s.belief.incidents).toHaveLength(1);
    expect(s.belief.incidents[0]).toMatchObject({ status: "closed", closedReason: "resolved", located: true });
  });

  it("never tells the coordinator the diagnosis or the time left before a crew is there", async () => {
    const s = sim(grid(5), { 0: [scene(24, [victim("cardiac_arrest", 40)], "collapse")] });
    while (s.belief.incidents.length === 0) await s.step();
    const incident = s.belief.incidents[0];
    expect(incident.victims).toEqual([]);
    expect(JSON.stringify(s.belief)).not.toContain("cardiac_arrest");
    expect(JSON.stringify(s.belief.calls)).not.toContain("ttl");
    // Not breathing is enough for the protocol to call it a P0.
    expect(incident.priority).toBe(0);
  });

  it("attaches several calls about the same place to one incident", async () => {
    const s = new Simulation({
      graph: grid(5),
      seed: 5,
      master: scripted({ 0: [scene(12, [victim("polytrauma", 90), victim("fracture"), victim("minor")])] }),
      coordinator: { name: "idle", decide: () => [] },
      config: CONFIG,
    });
    await s.run(20);
    expect(s.belief.calls.length).toBeGreaterThan(1);
    expect(s.belief.incidents.filter((i) => !i.mergedInto)).toHaveLength(1);
    expect(s.belief.incidents[0].callIds).toHaveLength(s.belief.calls.length);
  });

  it("finds the scene even when the caller was vague about where", async () => {
    const s = new Simulation({
      graph: grid(9),
      master: scripted({ 0: [scene(40, [victim("hemorrhage", 80)])] }),
      coordinator: new GreedyCoordinator(),
      observer: new CallObserver({ callers: ["driver"] }),
      config: CONFIG,
    });
    await s.run(40);
    expect(s.summary().saved).toBe(1);
    expect(s.belief.incidents[0]).toMatchObject({ node: 40, located: true, locationErrorM: 0 });
  });

  it("takes the worst victim first and treats minor ones on the spot", async () => {
    const s = sim(grid(5), { 0: [scene(6, [victim("minor"), victim("hemorrhage", 70), victim("minor")])] }, { ...CONFIG, ambulances: 2 });
    await s.run(30);
    const firstPickup = s.world.log.find((e) => e.type === "victim_picked_up");
    expect(firstPickup).toMatchObject({ victimId: "V2" });
    expect(s.world.victims.map((v) => v.status)).toEqual(["treated", "delivered", "treated"]);
    expect(s.world.hospitals[0].occupied).toBe(1);
  });

  it("lets a cardiac arrest die if nobody gets there in time, and only learns it on scene", async () => {
    const s = sim(grid(5), { 0: [scene(24, [victim("cardiac_arrest", 3)], "collapse")] });
    await s.run(20);
    expect(s.summary()).toMatchObject({ saved: 0, dead: 1 });
    const assessed = s.world.log.find((e) => e.type === "scene_assessed");
    expect(assessed).toMatchObject({ victims: [{ triage: "black" }] });
    expect(s.belief.incidents[0].status).toBe("closed");
  });

  it("closes the incident when the crew finds nobody", async () => {
    const s = new Simulation({ graph: grid(5), master: scripted({}), coordinator: { name: "test", decide: () => [] }, config: CONFIG });
    s.order({ type: "dispatch", unitId: "A1", incidentId: "C9", node: 24 });
    await s.run(12);
    expect(s.world.log.some((e) => e.type === "scene_not_found")).toBe(true);
    expect(s.world.units[0].mission).toBe("idle");
  });

  it("reroutes an ambulance when the road ahead is closed", async () => {
    const g = grid(5);
    const lastEdge = g.route(0, 24)!.steps.at(-1)!.edge;
    const s = sim(g, { 0: [scene(24, [victim("polytrauma", 90)])], 3: [{ type: "close_road", edge: lastEdge }] });
    await s.run(30);
    expect(s.world.log.some((e) => e.type === "unit_rerouted")).toBe(true);
    expect(s.summary().saved).toBe(1);
  });

  it("freezes a broken-down ambulance until it is repaired", async () => {
    const s = sim(grid(5), {
      0: [scene(24, [victim("hypothermia", 100)], "flooded_home")],
      4: [{ type: "puncture", unitId: "A1", ticks: 10 }],
    });
    await s.run(8);
    const stuckAt = s.world.units[0].node;
    await s.run(5);
    expect(s.world.units[0].node).toBe(stuckAt);
    await s.run(25);
    expect(s.summary().saved).toBe(1);
  });

  it("turns ambulances away from a full hospital", async () => {
    const s = sim(grid(5), { 0: [scene(24, [victim("fracture")], "fall")] }, { ...CONFIG, hospitalCapacity: 0 } as typeof CONFIG);
    // Greedy respects capacity, so force the hospital by hand.
    while (s.belief.incidents.length === 0) await s.step();
    s.order({ type: "dispatch", unitId: "A1", incidentId: "C1", node: 24, hospitalId: "H1" });
    await s.run(12);
    expect(s.world.log.some((e) => e.type === "hospital_full")).toBe(true);
    expect(s.world.units[0]).toMatchObject({ victimId: "V1", mission: "idle" });
  });

  it("rejects invalid orders and tells the coordinator", async () => {
    const s = new Simulation({ graph: grid(3), master: scripted({}), coordinator: { name: "test", decide: () => [] } });
    s.order({ type: "transport", unitId: "A1", hospitalId: "H1" });
    await s.step();
    const { reports } = await s.step();
    expect(reports.map((r) => r.event.type)).toEqual(["action_rejected"]);
  });

  it("is reproducible: same seed, same history", async () => {
    const run = async (seed: number) => {
      const s = new Simulation({
        graph: grid(8),
        seed,
        master: new RandomMaster({ pScene: 0.3, pRoadClosure: 0.1, pPuncture: 0.02 }),
        coordinator: new GreedyCoordinator(),
        config: { ambulances: 3, fireUnits: 1, rescueUnits: 1, helicopters: 1 },
      });
      await s.run(150);
      return JSON.stringify([s.world.log, s.belief.calls]);
    };
    const first = await run(42);
    expect(await run(42)).toBe(first);
    expect(await run(43)).not.toBe(first);
  });
});

describe("incidents: one place, one response", () => {
  const graph = grid(9);
  const call = (id: string, node: number, mechanism: SceneKind | null, extra: Partial<Call> = {}): Call => ({
    id, tick: 0, caller: "family", mechanism, node, locationErrorM: 40, street: null, conscious: "yes", breathing: "normal",
    bleeding: "no", trapped: "no", ageGroup: "adult", victims: 1, text: `aviso ${id}`, ...extra,
  });
  const hurt = (id: string, status: AssessedVictim["status"] = "waiting"): AssessedVictim => ({ id, injury: "fracture", triage: "yellow", status, trapped: false });
  /** A belief fed by hand, tick by tick, with whatever the coordinator would have heard. */
  function heard() {
    const world = createWorld(graph, { ...DEFAULT_CONFIG, ...CONFIG });
    const belief = createBelief(world);
    let id = 1;
    const hear = (tick: number, ...events: ({ type: string } & Record<string, unknown>)[]) => {
      world.tick = tick;
      return updateBelief(belief, events.map((e) => ({ id: id++, tick, source: "system" as const, confidence: 1, event: { ...e, tick } as ObservedEvent })), world, graph);
    };
    return { world, belief, hear, live: () => belief.incidents.filter((i) => !i.mergedInto) };
  }

  it("keeps different things on the same corner in one incident, as two foci", () => {
    const { hear, live } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") }, { type: "call_received", call: call("L2", 41, "fall", { breathing: "none" }) });
    expect(live()).toHaveLength(1);
    const [incident] = live();
    expect(incident.foci.map((f) => f.mechanism?.value)).toEqual(["traffic", "fall"]);
    // The headline follows the worst focus: that is where the next crew goes.
    expect(incident).toMatchObject({ priority: 0, node: 41, callIds: ["L1", "L2"] });
  });

  it("opens another incident for something that is somewhere else", () => {
    const { hear, live } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") }, { type: "call_received", call: call("L2", 44, "traffic") });
    expect(live()).toHaveLength(2);
  });

  it("takes the 112 triage agent's priority as a floor, until a crew is on the spot", () => {
    const { hear, live, belief } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, "fall", { ageGroup: "elderly" }) });
    const [incident] = live();
    expect(incident.priority).toBe(3);
    // The agent bumps an elderly casualty a level; the engine's grouping stays (it would have opened a new incident: noted, not done).
    applyTriage(belief, { callId: "L1", matchedIncidentId: "I1", matchedNewIncident: true, reasoning: "mayor, consciente", incidents: [{ id: "I1", callIds: ["L1"], priority: "medium" }] }, 1);
    expect(incident).toMatchObject({ priority: 2, triaged: { priority: 2, tick: 1 } });
    expect(incident.timeline.at(-1)).toMatchObject({ kind: "update", from: "triaje 112", callId: "L1" });
    // A second call the rules make P1: the floor never holds anything down.
    hear(2, { type: "call_received", call: call("L2", 40, "fall", { tick: 2, bleeding: "yes" }) });
    expect(incident.priority).toBe(1);
    // The crew finds one yellow: what it radios beats the agent's reading of the calls.
    applyTriage(belief, { callId: "L2", matchedIncidentId: "C1", matchedNewIncident: false, reasoning: "sangra", incidents: [{ id: "C1", callIds: ["L1", "L2"], priority: "critical" }] }, 3);
    expect(incident.priority).toBe(0);
    hear(5, { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S1", kind: "fall", node: 40, inSight: false, victims: [hurt("V1")] });
    expect(incident.priority).toBe(2);
  });

  it("runs the 112 desk without holding the tick: generated calls and verdicts land on the following ticks", async () => {
    const graph = grid(5);
    const s = new Simulation({
      graph, seed: 1, master: scripted({}), coordinator: new GreedyCoordinator(), config: { ...CONFIG, ambulances: 0 },
      desk: {
        everyTicks: 2,
        triageEvery: 2,
        generate: async () => [{ caller: "family", mechanism: "fall", street: null, node: 12, locationErrorM: 30, conscious: "yes", breathing: "normal", bleeding: "no", trapped: "no", ageGroup: "elderly", victims: 1, text: "Un familiar: «se ha caído»" }],
        triage: async ({ calls }) => calls.map((c) => ({ callId: c.id, matchedIncidentId: "I1", matchedNewIncident: true, reasoning: "mayor", incidents: [{ id: "I1", callIds: [c.id], priority: "high" as const }] })),
      },
    });
    await s.step(); // t0, desk turn: the generator is set going; nothing has come in yet
    expect(s.belief.calls).toHaveLength(0);
    await s.step(); // t1: its call enters like a phoned one, and the rules file it
    expect(s.belief.calls.map((c) => c.source)).toEqual(["agent"]);
    expect(s.belief.incidents[0].priority).toBe(3);
    await s.step(); // t2, desk turn: triage set going for L1
    expect(s.belief.incidents[0].triaged).toBeNull();
    await s.step(); // t3: the verdict is folded in before the coordinator decides
    expect(s.belief.incidents[0]).toMatchObject({ priority: 1, triaged: { priority: 1, tick: 3 } });
    await s.settle();
  });

  it("joins a late call to the incident while it is open, and starts a new one once it is closed", () => {
    const { hear, live, belief } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") });
    hear(60, { type: "call_received", call: call("L2", 40, "traffic", { tick: 60 }) });
    expect(live()).toHaveLength(1);
    hear(61, { type: "scene_not_found", unitId: "A1", incidentId: "C1", node: 40 });
    expect(belief.incidents[0]).toMatchObject({ status: "closed", closedReason: "not_found" });
    hear(70, { type: "call_received", call: call("L3", 40, "traffic", { tick: 70 }) });
    expect(live().map((i) => i.id)).toEqual(["C1", "C2"]);
  });

  it("stays open until every focus is dealt with", () => {
    const { world, hear, live } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") }, { type: "call_received", call: call("L2", 41, "fall") });
    hear(5,
      { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S1", kind: "traffic", node: 40, inSight: false, victims: [hurt("V1")] },
      { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S2", kind: "fall", node: 41, inSight: true, victims: [hurt("V2")] },
    );
    hear(6, { type: "victim_picked_up", victimId: "V1", unitId: "A1", incidentId: "C1" });
    const [incident] = live();
    expect(incident.foci.map((f) => f.status)).toEqual(["cleared", "located"]);
    expect(incident).toMatchObject({ status: "open", node: 41 });
    hear(9, { type: "victim_picked_up", victimId: "V2", unitId: "A2", incidentId: "C1" });
    expect(incident).toMatchObject({ status: "closed", closedReason: "resolved" });
  });

  it("drops a reported focus the crew on the spot does not see", () => {
    const { world, hear, live } = heard();
    // Only what must be within the crew's sight: a vaguer caller could mean somewhere it cannot see from there.
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") }, { type: "call_received", call: call("L2", 41, "fall", { locationErrorM: 20 }) });
    hear(5, { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S1", kind: "traffic", node: 40, inSight: false, victims: [hurt("V1")] });
    expect(live()[0].foci.map((f) => f.status)).toEqual(["located", "not_found"]);
  });

  it("takes what a crew finds nearby for what a vague caller meant", () => {
    const { hear, live } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, null, { caller: "driver", locationErrorM: 400 }) });
    expect(hear(5, { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S7", kind: "fall", node: 43, inSight: false, victims: [hurt("V7")] })).toEqual([]);
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ located: true, node: 43, foci: [{ status: "located", callIds: ["L1"] }] });
  });

  it("splits off what a crew finds somewhere else on its way round", () => {
    const { world, hear, live, belief } = heard();
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") });
    const retags = hear(5, { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S7", kind: "fall", node: 44, inSight: false, victims: [hurt("V7")] });
    expect(live()).toHaveLength(2);
    expect(belief.incidents[1]).toMatchObject({ id: "C2", splitFrom: "C1", located: true, node: 44 });
    expect(belief.incidents[0]).toMatchObject({ status: "open", located: false });
    expect(retags).toEqual([{ unitId: "A1", incidentId: "C2" }]);
  });

  it("merges two incidents that turn out to be the same place", () => {
    const { world, hear, live, belief } = heard();
    // A driver who could not say where, and a relative who could: too far apart to know they are the same.
    hear(0, { type: "call_received", call: call("L1", 40, "traffic") });
    hear(1, { type: "call_received", call: call("L2", 43, null, { tick: 1, locationErrorM: 100 }) });
    expect(live()).toHaveLength(2);
    hear(5, { type: "scene_assessed", unitId: "A1", incidentId: "C1", sceneId: "S1", kind: "traffic", node: 41, inSight: false, victims: [hurt("V1")] });
    hear(8, { type: "scene_assessed", unitId: "A2", incidentId: "C2", sceneId: "S1", kind: "traffic", node: 41, inSight: false, victims: [hurt("V1")] });
    expect(live().map((i) => i.id)).toEqual(["C1"]);
    expect(belief.incidents[1]).toMatchObject({ closedReason: "merged", mergedInto: "C1" });
    expect(live()[0].callIds).toEqual(["L1", "L2"]);
  });

  it("writes the case file as it goes: the call, the order and its reason, what the crew radioed, the closing", async () => {
    const s = sim(grid(5), { 0: [scene(12, [victim("hemorrhage", 90)])] });
    await s.run(30);
    const [incident] = s.belief.incidents;
    const kinds = incident.timeline.map((e) => e.kind);
    for (const kind of ["call", "order", "radio", "closed"] as const) expect(kinds).toContain(kind);
    const order = incident.timeline.find((e) => e.kind === "order")!;
    expect(order).toMatchObject({ unitId: "A1", accepted: true, decidedBy: "rules", action: { type: "dispatch", incidentId: incident.id } });
    expect(order.etaTicks).toBeGreaterThan(0);
    expect(incident.timeline.map((e) => e.tick)).toEqual([...incident.timeline.map((e) => e.tick)].sort((a, b) => a - b));
  });

  it("files the supervisor's orders as the operator's", async () => {
    const s = new Simulation({ graph: grid(5), master: scripted({ 0: [scene(12, [victim("hemorrhage", 90)])] }), coordinator: { name: "idle", decide: () => [] }, observer: new CallObserver({ callers: ["family"] }), config: CONFIG });
    await s.run(6);
    s.order({ type: "dispatch", unitId: "A1", incidentId: "C1", node: 12 });
    await s.run(1);
    expect(s.belief.incidents[0].timeline.find((e) => e.kind === "operator")).toMatchObject({ from: "operador", accepted: true, decidedBy: "operator" });
  });
});

describe("flood", () => {
  it("spreads and makes covered streets impassable, without anyone telling the coordinator", async () => {
    const g = grid(9);
    const s = sim(g, { 0: [{ type: "start_flood", name: "test", node: 0, radiusM: 50, growthM: 30, maxRadiusM: 400 }] });
    await s.run(20);
    expect(s.world.floods[0].radiusM).toBe(400);
    expect(g.route(80, 1, new Set(s.world.closedEdges))).toBeNull();
    expect(g.route(80, 44, new Set(s.world.closedEdges))).not.toBeNull();
    expect(s.belief.closedEdges).toEqual([]);
    expect(s.belief.floods).toEqual([]);
  });

  it("learns of the water late, from an official map that is already old", async () => {
    const s = sim(grid(9), { 0: [{ type: "start_flood", name: "test", node: 0, radiusM: 100, growthM: 10, maxRadiusM: 600 }] });
    await s.run(25);
    expect(s.belief.floods[0]).toMatchObject({ radiusM: 250, asOfTick: 14 });
    expect(s.world.floods[0].radiusM).toBe(350);
    expect(s.belief.closedEdges.length).toBeGreaterThan(0);
    expect(s.belief.closedEdges.length).toBeLessThan(s.world.closedEdges.length);
  });

  it("has crews find the water themselves, radio it in and turn back", async () => {
    const g = grid(9);
    const s = sim(g, {
      0: [{ type: "start_flood", name: "test", node: 80, radiusM: 250, growthM: 0, maxRadiusM: 250 }],
      1: [scene(80, [victim("drowning", 200)], "flooded_home")],
    });
    await s.run(23);
    const found = s.world.log.find((e) => e.type === "road_blocked_found");
    expect(found).toMatchObject({ unitId: "A1", flooded: true });
    expect(s.belief.waterSightings.some((w) => w.kind === "blocked")).toBe(true);
    expect(s.belief.incidents[0]).toMatchObject({ status: "open", unreachable: true });
    expect(s.world.units[0].mission).not.toBe("to_scene");
    expect(s.summary()).toMatchObject({ inWater: 1 });
  });

  it("never reopens a street that is under water", async () => {
    const g = grid(9);
    const edge = g.route(0, 1)!.steps[0].edge;
    const s = sim(g, {
      0: [{ type: "start_flood", name: "test", node: 0, radiusM: 250, growthM: 0, maxRadiusM: 250 }],
      2: [{ type: "open_road", edge }],
    });
    await s.run(4);
    expect(s.world.closedEdges).toContain(edge);
  });
});

describe("units", () => {
  // Stations are looked up by coordinates, which on the toy grid all land on the same corner.
  const config = (extra: object) => ({ ...CONFIG, ...extra });

  it("needs firefighters before an ambulance can take a trapped victim", async () => {
    const trapped = { ...victim("polytrauma", 200), trapped: true };
    const alone = sim(grid(5), { 0: [scene(24, [trapped], "building_collapse")] });
    await alone.run(40);
    expect(alone.world.victims[0].status).toBe("waiting");

    const withFire = sim(grid(5), { 0: [scene(24, [trapped], "building_collapse")] }, config({ fireUnits: 1 }) as typeof CONFIG);
    await withFire.run(60);
    expect(withFire.world.log.some((e) => e.type === "victim_freed" && e.unitId === "B1")).toBe(true);
    expect(withFire.world.victims[0].status).toBe("delivered");
  });

  it("sends a rescue crew through the water to someone no ambulance can reach", async () => {
    const s = sim(
      grid(9),
      {
        0: [{ type: "start_flood", name: "test", node: 80, radiusM: 250, growthM: 0, maxRadiusM: 250 }],
        1: [scene(80, [victim("hypothermia", 400)], "flooded_home")],
      },
      config({ rescueUnits: 1 }) as typeof CONFIG,
    );
    await s.run(120);
    expect(s.belief.incidents[0].unreachable).toBe(true);
    const pickup = s.world.log.find((e) => e.type === "victim_picked_up");
    expect(pickup).toMatchObject({ unitId: "R1" });
    expect(s.summary().saved).toBe(1);
  });

  it("flies the helicopter in a straight line and only to a helipad", async () => {
    const s = new Simulation({
      graph: grid(9),
      master: scripted({ 0: [scene(80, [victim("cardiac_arrest", 60)], "collapse")] }),
      coordinator: { name: "test", decide: () => [] },
      observer: new CallObserver({ callers: ["family"] }),
      config: config({ ambulances: 0, helicopters: 1 }),
    });
    s.world.hospitals[0].helipad = false;
    s.order({ type: "dispatch", unitId: "HEL1", incidentId: "C1", node: 80, hospitalId: "H1" });
    await s.step();
    expect(s.world.log.at(-1)).toMatchObject({ type: "action_rejected", reason: "hospital has no helipad" });

    s.world.hospitals[0].helipad = true;
    s.order({ type: "dispatch", unitId: "HEL1", incidentId: "C1", node: 80, hospitalId: "H1" });
    await s.run(6);
    expect(s.world.units[0].route).toEqual([]);
    expect(s.summary().saved).toBe(1);
  });
});

describe("reconocimiento", () => {
  /** One drone, nothing else: the only way anything gets known is by going to look. */
  const silentRun = (seed: number) =>
    new Simulation({
      graph: grid(9),
      seed,
      // Nobody calls about this one. It sits 5 blocks from where the drone is parked.
      master: scripted({ 0: [{ type: "spawn_scene", kind: "traffic", node: 40, victims: [victim("polytrauma", 300)], silent: true }] }),
      coordinator: { name: "idle", decide: () => [] },
      observer: new CallObserver({ callers: ["family"] }),
      config: { ...CONFIG, ambulances: 0, drones: 1 },
    });

  it("una escena muda no genera ni una llamada: el coordinador no sabe que existe", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = silentRun(seed);
      await s.run(40);
      expect(s.belief.calls).toEqual([]);
      expect(s.belief.incidents).toEqual([]);
      expect(s.world.victims[0].status).toBe("waiting");
    }
  });

  it("un dron encuentra lo que nadie ha llamado, pero nunca lo confirma", async () => {
    const found = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = silentRun(seed);
      // Four passes over the same spot: even a good camera misses things on a single look.
      for (let pass = 0; pass < 4; pass++) {
        s.order({ type: "scout", unitId: "D1", node: 40 });
        await s.run(6);
      }
      if (s.belief.incidents.length === 0) continue;
      found.push(seed);
      const incident = s.belief.incidents[0];
      // An aerial sighting opens the incident without ever confirming it: no triage, no exact spot.
      expect(incident.located).toBe(false);
      expect(incident.victims).toEqual([]);
      expect(incident.locationErrorM).toBeGreaterThan(0);
      expect(incident.seenTick).not.toBeNull();
      expect(incident.history.some((h) => h.from === "dron D1")).toBe(true);
    }
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it("lo que ve el dron no siempre es lo mismo ni siempre es todo", async () => {
    const reads = [];
    for (let seed = 1; seed <= 12; seed++) {
      const s = new Simulation({
        graph: grid(9),
        seed,
        master: scripted({
          0: [
            // Three people outdoors and one inside a flooded ground floor: the second is far harder to see.
            { type: "spawn_scene", kind: "traffic", node: 40, victims: [victim("polytrauma", 300), victim("fracture"), victim("minor")], silent: true },
            { type: "spawn_scene", kind: "flooded_home", node: 42, victims: [victim("hypothermia", 300)], silent: true },
          ],
        }),
        coordinator: { name: "idle", decide: () => [] },
        config: { ...CONFIG, ambulances: 0, drones: 1 },
      });
      s.order({ type: "scout", unitId: "D1", node: 40 });
      await s.run(6);
      // The world log holds the truth of what was in sight; the belief only ever gets the read of it.
      expect(s.world.log.some((e) => e.type === "area_surveyed")).toBe(true);
      expect(JSON.stringify(s.world.log)).not.toContain("drone_report");
      reads.push({ seen: s.belief.incidents.length, people: s.belief.incidents.flatMap((i) => i.foci.map((f) => f.peopleSeen?.value ?? null)) });
    }
    // The same flight over the same place is not the same report twice: sometimes both scenes, sometimes one, sometimes a different count.
    expect(new Set(reads.map((r) => r.seen)).size).toBeGreaterThan(1);
    expect(new Set(reads.map((r) => JSON.stringify(r.people))).size).toBeGreaterThan(1);
  });

  it("lee el silencio de una zona como un hueco que hay que ir a mirar", async () => {
    const s = new Simulation({
      graph: grid(14),
      seed: 3,
      // Everything that happens, and therefore every call, is in one corner of the map.
      master: scripted({
        0: [scene(15, [victim("polytrauma", 400)])],
        4: [scene(17, [victim("fracture")])],
        8: [scene(31, [victim("minor")])],
      }),
      coordinator: { name: "idle", decide: () => [] },
      observer: new CallObserver({ callers: ["family"] }),
      config: { ...CONFIG, ambulances: 0, drones: 1 },
    });
    await s.run(30);
    const gaps = infoGaps(s.belief, s.graph, s.world.tick);
    const silence = gaps.filter((g) => g.kind === "silence");
    expect(silence.length).toBeGreaterThan(0);
    expect(silence[0].why).toContain("alrededor sí llaman");
    // The heuristic says out loud that silence has two readings, and that only a look tells them apart.
    expect(silence[0].why).toContain("cobertura");
  });

  it("el coordinador greedy manda el dron a mirar en vez de dejarlo parado", async () => {
    const s = new Simulation({
      graph: grid(9),
      seed: 2,
      master: scripted({ 0: [scene(40, [victim("polytrauma", 400)])] }),
      coordinator: new GreedyCoordinator(),
      // A passer-by: the location is vague, which is exactly when looking first pays off.
      observer: new CallObserver({ callers: ["driver"] }),
      config: { ...CONFIG, ambulances: 1, drones: 1 },
    });
    await s.run(12);
    const scouts = s.world.log.filter((e) => e.type === "action_applied" && e.action.type === "scout");
    expect(scouts.length).toBeGreaterThan(0);
    expect(s.world.log.some((e) => e.type === "area_surveyed")).toBe(true);
  });
});

describe("agentic master", () => {
  it("turns the master's wishes into what the engine can do, and drops what the map does not have", async () => {
    const { buildMasterTurn, readMasterOutput, toMasterActions } = await import("../../src/masters/protocol");
    const graph = grid(9);
    const world = createWorld(graph, { ...DEFAULT_CONFIG, ...CONFIG });
    const turn = buildMasterTurn(world, graph, new Rng(3), 1, 10, "test");
    expect(JSON.parse(turn.payload.places).length).toBeGreaterThan(4);
    expect(turn.payload.places).not.toContain('"node"');

    // As the platform hands it back: the reply under a couple of envelopes.
    const output = readMasterOutput({ data: { response: {
      narration: "Empieza a llover con fuerza.",
      scenes: [{ place: 0, kind: "traffic", victims: 2, severity: "critico", trapped: true, silent: false }, { place: 99, kind: "fall", victims: 1, severity: "leve", trapped: false, silent: false }],
      flood: [{ source: 0, strength: "rapida" }], cut: ["Carrer que no existe"], puncture: ["A1"],
    } } });
    const { actions, dropped } = toMasterActions(output, turn, world, graph, new Rng(3));
    expect(actions.map((a) => a.type)).toEqual(["narrate", "start_flood", "spawn_scene", "puncture"]);
    expect(dropped).toEqual(["scene at place 99 (fall)", 'street "Carrer que no existe"']);
    const scene = actions.find((a) => a.type === "spawn_scene")!;
    expect(scene).toMatchObject({ kind: "traffic", node: turn.places[0].node, silent: false });
    if (scene.type === "spawn_scene") {
      expect(scene.victims).toHaveLength(2);
      expect(scene.victims[0]).toMatchObject({ injury: "hemorrhage", trapped: true });
    }
  });

  it("lets an agent word the 112 calls without touching what they say", async () => {
    const s = new Simulation({
      graph: grid(5), master: scripted({ 0: [scene(12, [victim("hemorrhage", 90)])] }), coordinator: new GreedyCoordinator(),
      observer: new CallObserver({ callers: ["family"] }), config: CONFIG, callWriter: async (call) => `reescrita ${call.id}`,
    });
    await s.run(10);
    expect(s.belief.calls[0]).toMatchObject({ text: "reescrita L1", node: 12 });
    expect(s.belief.incidents[0].timeline[0]).toMatchObject({ kind: "call", text: "reescrita L1" });
  });
});

describe("the real 112 line", () => {
  it("finds a street the way a caller says it", () => {
    const data = { name: "t", bbox: [0, 0, 1, 1] as [number, number, number, number], nodes: [[0, 0], [0.001, 0], [0.002, 0], [0.003, 0]] as [number, number][], hospitals: [],
      edges: [
        { a: 0, b: 1, len: 100, kph: 30, oneway: false, name: "Carrer de Sueca", geom: [] },
        { a: 1, b: 2, len: 100, kph: 30, oneway: false, name: "Avinguda del Regne de València", geom: [] },
        { a: 2, b: 3, len: 100, kph: 30, oneway: false, name: "Carrer de València", geom: [] },
      ] };
    const graph = new Graph(data as unknown as GraphData);
    expect(graph.findStreet("calle Sueca")).toBe(0);
    expect(graph.findStreet("en la avenida Reino de Valencia")).toBe(1);
    expect(graph.findStreet("Avenida Regne de Valencia, número 12")).toBe(1);
    expect(graph.findStreet("carrer valencia")).toBe(2);
    expect(graph.findStreet("Sueca 2, puerta A, junto al garaje")).toBe(0);
    expect(graph.findStreet("Gran Vía")).toBeNull();
  });

  it("turns a phoned-in call into an emergency that is really there, and into a call like any other", async () => {
    const s = new Simulation({ graph: grid(5), master: scripted({}), coordinator: new GreedyCoordinator(), config: CONFIG });
    await s.run(3);
    s.phone({ caller: "family", mechanism: "vehicle_trapped", node: 12, street: null, locationErrorM: 25, conscious: "no", breathing: "none", bleeding: "unknown", trapped: "yes", ageGroup: "child", victims: 2, text: "Llamada real" });
    await s.run(1);
    const [call] = s.belief.calls;
    expect(call).toMatchObject({ id: "L1", tick: 3, node: 12, source: "phone", trapped: "yes" });
    expect(s.belief.incidents[0]).toMatchObject({ priority: 0, callIds: ["L1"] });
    const victims = s.world.victims.filter((v) => v.sceneId === s.world.scenes[0].id);
    expect(victims).toHaveLength(2);
    expect(victims[0]).toMatchObject({ injury: "drowning", trapped: true });
    expect(victims[0].age).toBeLessThan(16);
    expect((s.observer as CallObserver).sceneOfCall.get("L1")).toBe(s.world.scenes[0].id);
    await s.run(30);
    expect(s.world.log.some((e) => e.type === "scene_assessed")).toBe(true);
  });

  it("reads the operator's record forgivingly", async () => {
    const { toPhoneCall } = await import("../../src/phone/happyrobot");
    expect(toPhoneCall({ caller: "neighbour", mechanism: "null", street: "Calle Sueca", locationErrorM: "100", conscious: "yes", breathing: "weird", victims: "2", node: 0, text: "Se ha caído mi padre" }))
      .toMatchObject({ caller: "bystander", mechanism: null, street: "Calle Sueca", locationErrorM: 100, conscious: "yes", breathing: "unknown", trapped: "unknown", victims: 2 });
  });
});
