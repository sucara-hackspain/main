import { describe, expect, it } from "vitest";
import {
  DanaMaster,
  Graph,
  GreedyCoordinator,
  Simulation,
  truthfulObserver,
  type Action,
  type EdgeData,
  type GraphData,
  type Master,
  type MasterAction,
  type SimConfig,
} from "../src/engine";

/** n x n grid, 100 m two-way streets at 36 km/h = 10 s per edge. Node id = row * n + col. Hospital at node 0. */
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
  return new Graph({ name: "grid", bbox: [0, 0, 0.001 * n, 0.001 * n], nodes, edges, hospitals });
}

/** Master that plays a fixed script: tick -> actions. */
function scripted(script: Record<number, MasterAction[]>): Master {
  return { name: "scripted", act: (world) => script[world.tick] ?? [] };
}

const fleet = (f: Partial<SimConfig["fleet"]>) => ({ svb: 0, sva: 0, heli: 0, fire: 0, police: 0, ...f });
const BASE = { speedFactor: 1, pickupTicks: 0, dropoffTicks: 0, discoveryPenaltyTicks: 0 };

/** Perfect information, so these tests are about the rules of the world and not about delays. */
function sim(graph: Graph, script: Record<number, MasterAction[]>, config: Partial<SimConfig>, orders?: (tick: number) => Action[]) {
  return new Simulation({
    graph,
    master: scripted(script),
    coordinator: orders ? { name: "test", decide: ({ tick }) => orders(tick) } : new GreedyCoordinator(),
    observer: truthfulObserver,
    config: { ...BASE, ...config },
  });
}

describe("graph", () => {
  it("routes around a closed road", () => {
    const g = grid(3);
    const open = g.route(0, 2)!;
    expect(open.seconds).toBe(20);
    const detour = g.route(0, 2, new Set([open.steps[0].edge]))!;
    expect(detour.seconds).toBe(40);
  });

  it("lets some vehicles crawl through slow edges instead of avoiding them", () => {
    const g = grid(3);
    const direct = g.route(0, 2)!;
    const slow = { edges: new Set(direct.steps.map((s) => s.edge)), factor: 6 };
    expect(g.route(0, 2, new Set(), slow)!.seconds).toBe(40); // the detour is now cheaper than wading
  });
});

describe("simulation", () => {
  it("picks a patient up and delivers them to hospital", async () => {
    const s = sim(grid(5), { 0: [{ type: "spawn_patient", node: 24, severity: "grave", ttl: 50 }] }, { fleet: fleet({ svb: 1 }) });
    await s.run(20);
    expect(s.world.log.map((e) => e.type)).toEqual(["patient_spawned", "action_applied", "patient_assessed", "patient_picked_up", "patient_delivered"]);
    expect(s.summary()).toMatchObject({ saved: 1, dead: 0, points: 2 });
  });

  it("does not waste a unit on someone it cannot reach in time", async () => {
    const s = sim(grid(5), { 0: [{ type: "spawn_patient", node: 24, severity: "critico", ttl: 1 }] }, { fleet: fleet({ svb: 1 }) });
    await s.run(5);
    expect(s.summary()).toMatchObject({ saved: 0, dead: 1 });
    expect(s.world.units[0].mission).toBe("idle");
  });

  it("a critical patient survives a long ride with a doctor on board but not in a basic ambulance", async () => {
    const ride = async (kind: "svb" | "sva") => {
      const s = sim(grid(9), { 0: [{ type: "spawn_patient", node: 80, severity: "critico", ttl: 11 }] }, { fleet: fleet({ [kind]: 1 }) }, (tick) =>
        tick === 0 ? [{ type: "dispatch", unitId: `${kind.toUpperCase()}1`, patientId: "P1", hospitalId: "H1" }] : [],
      );
      await s.run(30);
      return s.summary().saved;
    };
    expect(await ride("svb")).toBe(0);
    expect(await ride("sva")).toBe(1);
  });

  it("units run into closures nobody told them about, lose time, and share what they found", async () => {
    const g = grid(5);
    const lastEdge = g.route(0, 24)!.steps.at(-1)!.edge;
    const s = new Simulation({
      graph: g,
      master: scripted({ 0: [{ type: "spawn_patient", node: 24, severity: "leve", ttl: 200 }], 1: [{ type: "close_road", edge: lastEdge }] }),
      coordinator: new GreedyCoordinator(),
      // Nobody phones this one in: the only way to learn about it is to drive into it.
      observer: { observe: (events, ...rest) => truthfulObserver.observe(events.filter((e) => e.type !== "incident_started" && e.type !== "road_closed"), ...rest) },
      config: { ...BASE, fleet: fleet({ svb: 1 }), discoveryPenaltyTicks: 2 },
    });
    await s.run(40);
    const types = s.world.log.map((e) => e.type);
    expect(types).toContain("road_discovered");
    expect(s.belief.closedEdges).toContain(lastEdge);
    expect(s.summary().saved).toBe(1);
  });

  it("a trapped patient needs a fire crew; the ambulance waits with them", async () => {
    const script: Record<number, MasterAction[]> = {
      0: [{ type: "start_incident", kind: "collapse", label: "Derrumbe", node: 12, victims: [{ severity: "grave", need: "trauma", trapped: true }] }],
    };
    const alone = sim(grid(5), script, { fleet: fleet({ svb: 1 }) });
    await alone.run(25);
    expect(alone.world.units[0].mission).toBe("on_scene");
    expect(alone.summary().saved).toBe(0);

    const together = sim(grid(5), script, { fleet: fleet({ svb: 1, fire: 1 }) });
    await together.run(40);
    expect(together.world.log.map((e) => e.type)).toContain("patient_extricated");
    expect(together.summary().saved).toBe(1);
    expect(together.world.incidents[0].active).toBe(false);
  });

  it("a fire keeps producing victims until a fire crew puts it out", async () => {
    const script: Record<number, MasterAction[]> = {
      0: [{ type: "start_incident", kind: "fire", label: "Incendio", node: 12, victims: [], fireWork: 10, extraVictims: 20 }],
    };
    const unattended = sim(grid(5), script, { fleet: fleet({}) });
    await unattended.run(60);
    const attended = sim(grid(5), script, { fleet: fleet({ fire: 1 }) });
    await attended.run(60);
    expect(attended.world.incidents[0].active).toBe(false);
    expect(attended.world.patients.length).toBeLessThan(unattended.world.patients.length);
  });

  it("police reopen a road blocked by an incident", async () => {
    const g = grid(5);
    const s = sim(g, { 0: [{ type: "close_road", edge: 7 }] }, { fleet: fleet({ police: 1 }) });
    await s.run(30);
    expect(s.world.closedEdges).not.toContain(7);
    expect(s.world.log.find((e) => e.type === "road_opened")).toMatchObject({ by: "unit" });
  });

  it("a flood closes streets as it grows; fire engines wade in, ambulances cannot", async () => {
    const g = grid(9);
    const s = sim(g, { 0: [{ type: "start_zone", kind: "flood", label: "Riada", center: g.data.nodes[80], radiusM: 150, growthM: 20, maxRadiusM: 350 }] }, { fleet: fleet({ svb: 1, fire: 1 }) }, () => []);
    await s.run(20);
    s.order({ type: "reposition", unitId: "SVB1", node: 80 });
    s.order({ type: "reposition", unitId: "BOM1", node: 80 });
    await s.run(200);
    expect(s.world.floodEdges.length).toBeGreaterThan(10);
    expect(s.world.log.some((e) => e.type === "action_rejected" && e.action.type === "reposition" && e.action.unitId === "SVB1")).toBe(true);
    expect(s.world.units.find((u) => u.id === "BOM1")!.node).toBe(80);
  });

  it("the helicopter flies straight over closures but only lands at helipad hospitals", async () => {
    const g = grid(7);
    const wall = g.data.edges.flatMap((e, i) => (Math.floor(e.a / 7) !== Math.floor(e.b / 7) ? [i] : [])); // cut every north-south street
    const script: Record<number, MasterAction[]> = { 0: [...wall.map((edge) => ({ type: "close_road" as const, edge })), { type: "spawn_patient", node: 48, severity: "grave", ttl: 60 }] };
    const s = sim(g, script, { fleet: fleet({ svb: 1, heli: 1 }) });
    await s.run(40);
    expect(s.world.log.find((e) => e.type === "patient_delivered")).toMatchObject({ unitId: "HELI1" });
  });

  it("reports are late and imprecise: the coordinator learns the real severity on arrival", async () => {
    const s = new Simulation({
      graph: grid(5),
      seed: 3,
      master: scripted({ 0: [{ type: "spawn_patient", node: 24, severity: "grave", ttl: 60 }] }),
      coordinator: new GreedyCoordinator(),
      config: { ...BASE, fleet: fleet({ svb: 1 }) },
    });
    await s.step();
    expect(s.belief.patients).toHaveLength(0); // nobody has called yet
    await s.run(10);
    expect(s.belief.patients[0]).toMatchObject({ id: "P1" });
    await s.run(20);
    expect(s.belief.patients[0]).toMatchObject({ assessed: true, severity: "grave" });
  });

  it("nothing gets out of a zone without coverage until a unit drives by", async () => {
    const g = grid(9);
    const quiet = new Simulation({
      graph: g,
      master: scripted({
        0: [{ type: "start_zone", kind: "no_coverage", label: "Sin red", center: g.data.nodes[80], radiusM: 300 }],
        1: [{ type: "spawn_patient", node: 80, severity: "leve", ttl: 300 }],
      }),
      coordinator: { name: "test", decide: () => [] },
      config: { ...BASE, fleet: fleet({ svb: 1 }) },
    });
    await quiet.run(30);
    expect(quiet.belief.patients).toHaveLength(0);
    quiet.order({ type: "reposition", unitId: "SVB1", node: 71 });
    await quiet.run(30);
    expect(quiet.belief.patients).toHaveLength(1);
  });

  it("rejects invalid orders and tells the coordinator", async () => {
    const s = sim(grid(3), {}, { fleet: fleet({ svb: 1, police: 1 }) }, () => []);
    s.order({ type: "dispatch", unitId: "POL1", patientId: "P99" });
    await s.step();
    const { reports } = await s.step();
    expect(reports.map((r) => r.event.type)).toEqual(["action_rejected"]);
  });

  it("is reproducible: same seed, same history", async () => {
    const run = async (seed: number) => {
      const s = new Simulation({ graph: grid(12), seed, master: new DanaMaster(), coordinator: new GreedyCoordinator() });
      await s.run(120);
      return JSON.stringify(s.world.log);
    };
    const first = await run(42);
    expect(await run(42)).toBe(first);
    expect(await run(43)).not.toBe(first);
  });
});
