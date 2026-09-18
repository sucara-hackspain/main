import { describe, expect, it } from "vitest";
import {
  Graph,
  GreedyCoordinator,
  RandomMaster,
  Simulation,
  type EdgeData,
  type GraphData,
  type Master,
  type MasterAction,
} from "../src/engine";

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

const CONFIG = { ambulances: 1, ambulanceSpeedFactor: 1, pickupTicks: 0, dropoffTicks: 0 };

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
  it("picks a patient up and delivers them to hospital", async () => {
    const sim = new Simulation({
      graph: grid(5),
      master: scripted({ 0: [{ type: "spawn_patient", node: 24, ttl: 50 }] }),
      coordinator: new GreedyCoordinator(),
      config: CONFIG,
    });
    await sim.run(20);
    expect(sim.world.log.map((e) => e.type)).toEqual([
      "patient_spawned",
      "action_applied",
      "patient_picked_up",
      "patient_delivered",
    ]);
    expect(sim.summary()).toMatchObject({ saved: 1, dead: 0 });
    expect(sim.world.hospitals[0].occupied).toBe(1);
  });

  it("lets a patient die when nobody can reach them in time", async () => {
    const sim = new Simulation({
      graph: grid(5),
      master: scripted({ 0: [{ type: "spawn_patient", node: 24, ttl: 1 }] }),
      coordinator: new GreedyCoordinator(),
      config: CONFIG,
    });
    await sim.run(5);
    expect(sim.summary()).toMatchObject({ saved: 0, dead: 1 });
    // Triage: the ambulance was never sent.
    expect(sim.world.ambulances[0].mission).toBe("idle");
  });

  it("reroutes an ambulance when the road ahead is closed", async () => {
    const g = grid(5);
    const lastEdge = g.route(0, 24)!.steps.at(-1)!.edge;
    const sim = new Simulation({
      graph: g,
      master: scripted({
        0: [{ type: "spawn_patient", node: 24, ttl: 50 }],
        1: [{ type: "close_road", edge: lastEdge }],
      }),
      coordinator: new GreedyCoordinator(),
      config: CONFIG,
    });
    await sim.run(20);
    expect(sim.world.log.some((e) => e.type === "ambulance_rerouted")).toBe(true);
    expect(sim.summary().saved).toBe(1);
  });

  it("freezes a broken-down ambulance until it is repaired", async () => {
    const sim = new Simulation({
      graph: grid(5),
      master: scripted({
        0: [{ type: "spawn_patient", node: 24, ttl: 80 }],
        1: [{ type: "puncture", ambulanceId: "A1", ticks: 10 }],
      }),
      coordinator: new GreedyCoordinator(),
      config: CONFIG,
    });
    await sim.run(5);
    const stuckAt = sim.world.ambulances[0].node;
    await sim.run(5);
    expect(sim.world.ambulances[0].node).toBe(stuckAt);
    await sim.run(20);
    expect(sim.summary().saved).toBe(1);
  });

  it("turns ambulances away from a full hospital", async () => {
    const sim = new Simulation({
      graph: grid(5),
      master: scripted({ 0: [{ type: "spawn_patient", node: 6, ttl: 50 }] }),
      // Ignores capacity on purpose.
      coordinator: {
        name: "test",
        decide: ({ reports }) =>
          reports.some((r) => r.event.type === "patient_spawned")
            ? [{ type: "dispatch", ambulanceId: "A1", patientId: "P1", hospitalId: "H1" }]
            : [],
      },
      config: { ...CONFIG, hospitalCapacity: 0 },
    });
    await sim.run(10);
    expect(sim.world.log.some((e) => e.type === "hospital_full")).toBe(true);
    expect(sim.world.ambulances[0]).toMatchObject({ patientId: "P1", mission: "idle" });
  });

  it("rejects invalid orders and tells the coordinator", async () => {
    const sim = new Simulation({ graph: grid(3), master: scripted({}), coordinator: { name: "test", decide: () => [] } });
    sim.order({ type: "dispatch", ambulanceId: "A1", patientId: "P99" });
    await sim.step();
    const { reports } = await sim.step();
    expect(reports.map((r) => r.event.type)).toEqual(["action_rejected"]);
  });

  it("is reproducible: same seed, same history", async () => {
    const run = async (seed: number) => {
      const sim = new Simulation({
        graph: grid(8),
        seed,
        master: new RandomMaster({ pPatient: 0.3, pRoadClosure: 0.1, pPuncture: 0.02 }),
        coordinator: new GreedyCoordinator(),
        config: { ambulances: 3 },
      });
      await sim.run(150);
      return JSON.stringify(sim.world.log);
    };
    const first = await run(42);
    expect(await run(42)).toBe(first);
    expect(await run(43)).not.toBe(first);
  });
});
