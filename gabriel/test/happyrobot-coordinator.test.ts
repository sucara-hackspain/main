import { describe, expect, it } from "vitest";
import { HappyRobotCoordinator } from "../src/coordinators/happyrobot";
import { Graph, Simulation, type EdgeData, type GraphData, type Master } from "../src/engine";

function grid(n = 5): Graph {
  const nodes: GraphData["nodes"] = [];
  const edges: EdgeData[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) nodes.push([c * 0.001, r * 0.001]);
  const link = (a: number, b: number) => edges.push({ a, b, len: 100, kph: 36, oneway: false, geom: [nodes[a], nodes[b]] });
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (c + 1 < n) link(r * n + c, r * n + c + 1);
    if (r + 1 < n) link(r * n + c, (r + 1) * n + c);
  }
  return new Graph({ name: "grid", bbox: [0, 0, 1, 1], nodes, edges, hospitals: [{ name: "H", lon: 0, lat: 0, node: 0, emergency: true }] });
}
const idle: Master = { act: () => [] };

describe("HappyRobot coordinator", () => {
  it("decides in the background: the tick goes on, and the orders land on the tick the run comes back", async () => {
    let answer!: (output: unknown) => void;
    const prompts: string[] = [];
    const coordinator = new HappyRobotCoordinator({
      apiKey: "test", workflowId: "w", nodeId: "n", everyTicks: 6, harness: "basic", background: true,
      run: (prompt) => new Promise((resolve) => ((prompts.push(prompt)), (answer = resolve))),
    });
    const sim = new Simulation({ graph: grid(), seed: 1, master: idle, coordinator, config: { ambulances: 1, fireUnits: 0, rescueUnits: 0, helicopters: 0, drones: 0 } });
    sim.phone({ caller: "family", mechanism: "fall", street: null, node: 12, locationErrorM: 30, conscious: "yes", breathing: "difficult", bleeding: "no", trapped: "no", ageGroup: "adult", victims: 1, text: "…" });
    const t0 = await sim.step(); // the call comes in: the run is fired, nothing is ordered yet
    expect(prompts).toHaveLength(1);
    expect(t0.decision).toMatchObject({ source: "rules", actions: [] });
    const t1 = await sim.step(); // still thinking
    expect(t1.decision?.actions ?? []).toHaveLength(0);
    expect(sim.world.units[0].mission).toBe("idle");
    answer({ situation: "una caída, mando la ambulancia", actions: JSON.stringify([{ type: "dispatch", unitId: "A1", incidentId: "C1", reason: "es la única", applies: [] }]), plan: "", watch: "" });
    await coordinator.settle();
    const t2 = await sim.step(); // no news this tick, but the decision has landed: it is applied now
    expect(t2.decision).toMatchObject({ source: "llm", actions: [{ type: "dispatch", unitId: "A1", incidentId: "C1" }] });
    expect(t2.decision?.situation).toContain("decidido en t0");
    expect(sim.world.units[0]).toMatchObject({ mission: "to_scene", incidentId: "C1" });
  });
});
