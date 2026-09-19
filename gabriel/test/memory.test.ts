import { describe, expect, it } from "vitest";
import { CallObserver, Graph, GreedyCoordinator, makeVictim, Rng, Simulation, makeTickRecord, type EdgeData, type GraphData, type MasterAction, type TickRecord } from "../src/engine";
import { consolidate, recordEpisode } from "../src/memory/consolidate";
import { buildDreamInput, readDreamOutput } from "../src/memory/dream-protocol";
import { evaluate, type Evaluation } from "../src/memory/evaluate";
import { MemoryStore } from "../src/memory/store";

function grid(n: number): Graph {
  const nodes: GraphData["nodes"] = [];
  const edges: EdgeData[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) nodes.push([c * 0.001, r * 0.001]);
  const link = (a: number, b: number) => edges.push({ a, b, len: 100, kph: 36, oneway: false, geom: [nodes[a], nodes[b]] });
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (c + 1 < n) link(r * n + c, r * n + c + 1);
    if (r + 1 < n) link(r * n + c, (r + 1) * n + c);
  }
  return new Graph({ name: "grid", bbox: [0, 0, 1, 1], nodes, edges, hospitals: [{ name: "Test Hospital", lon: 0, lat: 0, node: 0, emergency: true }] });
}

async function session(script: Record<number, MasterAction[]>, ticks: number) {
  const graph = grid(5);
  const sim = new Simulation({
    graph,
    master: { act: (w) => script[w.tick] ?? [] },
    coordinator: new GreedyCoordinator(),
    observer: new CallObserver({ callers: ["family"] }),
    config: { ambulances: 1, fireUnits: 0, rescueUnits: 0, helicopters: 0, ambulanceSpeedFactor: 1, pickupTicks: 0, dropoffTicks: 0 },
  });
  const records: TickRecord[] = [];
  for (let i = 0; i < ticks; i++) records.push(makeTickRecord(await sim.step(), sim.world, sim.belief, graph));
  return evaluate({ session: "s1", coordinator: "greedy", seed: 1, sim, records, applications: [{ ruleId: "H5", incidentId: "C1" }] });
}

const victim = (injury: Parameters<typeof makeVictim>[0], ttl: number | null, trapped = false) => ({ ...makeVictim(injury, new Rng(1)), ttl, trapped });

describe("evaluation", () => {
  it("names the cause of a death and credits a critical save", async () => {
    const late = await session({ 0: [{ type: "spawn_scene", kind: "collapse", node: 24, victims: [victim("cardiac_arrest", 2)] }] }, 12);
    expect(late.findings.map((f) => f.kind)).toEqual(["death_late"]);
    expect(late.findings[0].detail).toContain("antes de que llegara nadie");

    const saved = await session({ 0: [{ type: "spawn_scene", kind: "collapse", node: 24, victims: [victim("cardiac_arrest", 60)] }] }, 20);
    expect(saved.findings.map((f) => f.kind)).toEqual(["saved_critical"]);
  });

  it("flags an ambulance sent alone to a trapped victim, with the doctrine cited on that incident", async () => {
    const e = await session({ 0: [{ type: "spawn_scene", kind: "building_collapse", node: 24, victims: [victim("polytrauma", 300, true)] }] }, 12);
    const wasted = e.findings.find((f) => f.kind === "wasted_trapped_no_fire")!;
    expect(wasted.incidentIds).toEqual(["C1"]);
    expect(wasted.ruleIds).toEqual(["H5"]);
  });
});

describe("memory", () => {
  const evaluation = (session: string, findings: number): Evaluation => ({
    session,
    coordinator: "test",
    seed: 1,
    ticks: 10,
    summary: { ticks: 10, victims: 2, saved: 1, dead: 1, waiting: 0, inAmbulance: 0, survivalRate: 0.5, inWater: 0, reachableSurvivalRate: 0.5, meanResponseTicks: 5 },
    counts: {},
    criticalResponseTicks: 5,
    hospitalLoad: [],
    decisions: { llm: 1, fallback: 0, meanMs: 1000 },
    ruleUse: [{ ruleId: "H5", times: 2 }],
    findings: Array.from({ length: findings }, (_, i) => ({ id: `${session}:E${i + 1}`, kind: "death_late" as const, good: false, tick: 5, incidentIds: ["C1"], sceneId: "S1", victimId: "V1", title: "t", detail: "d", ruleIds: ["H5"] })),
  });

  it("starts from the seed doctrine and renders it with citable ids", () => {
    const store = new MemoryStore(":memory:");
    expect(store.rules().length).toBe(28);
    const view = store.renderView();
    expect(view).toContain("- D1 ·");
    expect(view).toContain("- A3 ·");
    expect(view.split("\n").length).toBeLessThan(40);
  });

  it("ignores rule ids the agent made up", () => {
    const store = new MemoryStore(":memory:");
    store.recordApplied("s1", 3, ["H5", "H99", "H5"], "C1", "A1");
    expect(store.applications("s1").map((a) => a.ruleId)).toEqual(["H5"]);
  });

  it("reshapes the doctrine from a dream and keeps the trail", () => {
    const store = new MemoryStore(":memory:");
    const first = evaluation("s1", 2);
    recordEpisode(store, first);
    const changes = consolidate(
      store,
      first,
      {
        lessons: "Lección.",
        ops: [
          { op: "reinforce", id: "H10", evidence: ["E1"], reason: "se cumplió" },
          { op: "weaken", id: "H13", evidence: ["E2"], reason: "salió mal" },
          { op: "add", kind: "heuristic", title: "Nueva", body: "Haz X cuando Y.", about: ["water", "not-a-concept"], evidence: ["E1"], reason: "patrón" },
          { op: "merge", ids: ["H5", "A1"], kind: "heuristic", title: "Atrapado", body: "Bomberos siempre.", reason: "dicen lo mismo" },
          { op: "reinforce", id: "H1", evidence: [], reason: "sin pruebas" },
          { op: "retire", id: "H404", reason: "no existe" },
        ],
      },
      "test",
    );
    expect(changes.skipped.map((s) => s.why)).toEqual(["no evidence cited", "no such live rule"]);
    expect(store.node("H10")!.confidence).toBeCloseTo(0.7);
    expect(store.node("H13")!.confidence).toBeCloseTo(0.45);
    expect(store.node("H17")).toMatchObject({ status: "candidate", confidence: 0.5, origin: "sueño de s1" });
    expect(store.node("H18")).toMatchObject({ status: "active", title: "Atrapado" });
    expect(store.node("H5")!.status).toBe("retired");
    expect(store.renderView()).toContain("H17 (EN PRUEBA)");
    expect(store.renderView()).not.toContain("- H5 ·");
    const edges = store.edges();
    expect(edges).toContainEqual(expect.objectContaining({ src: "s1:E1", dst: "H10", kind: "supports" }));
    expect(edges).toContainEqual(expect.objectContaining({ src: "H18", dst: "H5", kind: "replaces" }));
    expect(edges.filter((e) => e.src === "H17" && e.kind === "about").map((e) => e.dst)).toEqual(["concept:water"]);
    expect(store.history("s1").map((h) => h.op)).toEqual(["reinforce", "weaken", "add", "merge", "retire", "retire"]);

    // A rule on trial becomes doctrine only when a later night backs it.
    const second = evaluation("s2", 1);
    recordEpisode(store, second);
    consolidate(store, second, { lessons: "", ops: [{ op: "reinforce", id: "H17", evidence: ["E1"], reason: "otra vez" }] }, "test");
    expect(store.node("H17")).toMatchObject({ status: "active", confidence: 0.6 });
    expect(buildDreamInput(second, store)).toContain("H17 [heuristic, activa");
  });

  it("reads a dream wrapped the way the platform wraps node outputs", () => {
    const out = readDreamOutput({ data: { response: JSON.stringify({ lessons: "ok", ops: '[{"op":"retire","id":"H1","reason":"r"}]' }) } });
    expect(out).toEqual({ lessons: "ok", ops: [{ op: "retire", id: "H1", reason: "r" }] });
  });
});
