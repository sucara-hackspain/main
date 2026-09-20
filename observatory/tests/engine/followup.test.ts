import { describe, expect, it } from "vitest";
import { Graph, GreedyCoordinator, Simulation, type EdgeData, type GraphData, type Master } from "../../src/engine";
import { FollowupLine, type FollowupPayload, type FollowupReport } from "../../src/phone/followup";
import { normalisePhone } from "../../src/phone/happyrobot";

/** 5 x 5 grid, 100 m streets. */
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
const report = (extra: Partial<FollowupReport>): FollowupReport => ({ reached: "patient", evolution: "same", painNow: 3, painTrend: "stable", mobility: "limited", fever: "no", bleeding: "no", woundWorse: "no", redFlags: "none", soughtCare: "no", alone: "no", street: null, locationErrorM: 100, escalate: "no", escalationReason: null, nextAction: "monitor", text: "sigue igual", ...extra });

describe("follow-up line", () => {
  it("turns a Spanish number into E.164 and keeps E.164 as it is", () => {
    expect(normalisePhone("+623783007")).toBe("+34623783007");
    expect(normalisePhone("623 783 007")).toBe("+34623783007");
    expect(normalisePhone("+15027474736")).toBe("+15027474736");
    expect(normalisePhone("")).toBeUndefined();
  });

  it("rings a low-priority caller back after the wait, and a report that says worse raises the case", async () => {
    const placed: FollowupPayload[] = [];
    const line = new FollowupLine({ afterTicks: 10, place: async (payload) => (placed.push(payload), report({ evolution: "worse", escalate: "yes", escalationReason: "fiebre alta", nextAction: "escalate_operator" })) });
    const sim = new Simulation({
      graph: grid(), seed: 1, master: idle, coordinator: new GreedyCoordinator(), config: { ambulances: 0, fireUnits: 0, rescueUnits: 0, helicopters: 0, drones: 0 },
      followup: (input) => line.tick(input),
    });
    sim.phone({ caller: "family", mechanism: "fall", street: null, node: 12, locationErrorM: 30, conscious: "yes", breathing: "normal", bleeding: "no", trapped: "no", ageGroup: "adult", victims: 1, text: "Llamada real al 112: «se ha caído»", phone: "+34623783007" });
    for (let t = 0; t < 10; t++) await sim.step();
    expect(placed).toHaveLength(0); // due at t10, not before
    await sim.step(); // t10: rings
    expect(placed).toEqual([expect.objectContaining({ callId: "L1", phone: "+34623783007", priority: "low", mechanism: "fall" })]);
    await sim.step(); // t11: the report is filed
    const [incident] = sim.belief.incidents;
    expect(incident).toMatchObject({ priority: 1, triaged: { priority: 1, from: "seguimiento 112" } });
    expect(incident.timeline.at(-1)).toMatchObject({ from: "seguimiento 112", callId: "L1", flag: "alert" });
    line.stop();
  });

  it("does not ring back a case a crew is already on its way to", async () => {
    const placed: FollowupPayload[] = [];
    const line = new FollowupLine({ afterTicks: 2, place: async (payload) => (placed.push(payload), report({})) });
    const sim = new Simulation({ graph: grid(), seed: 1, master: idle, coordinator: new GreedyCoordinator(), config: { ambulances: 0, fireUnits: 0, rescueUnits: 0, helicopters: 0, drones: 0 }, followup: (input) => line.tick(input) });
    sim.phone({ caller: "family", mechanism: "fall", street: null, node: 12, locationErrorM: 30, conscious: "no", breathing: "difficult", bleeding: "no", trapped: "no", ageGroup: "adult", victims: 1, text: "…", phone: "+34600000000" });
    for (let t = 0; t < 4; t++) await sim.step();
    expect(placed).toHaveLength(0);
  });
});
