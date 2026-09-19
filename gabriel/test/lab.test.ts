import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CallObserver, Graph, GreedyCoordinator, Simulation, type Action, type Coordinator, type GraphData } from "../src/engine";
import { applyEdit, diffDoctrine, EMPTY, renderDoctrine } from "../src/lab/doctrine";
import { readResearchOutput } from "../src/lab/researcher";
import { generateScenario, ScriptedMaster, type ScenarioSpec } from "../src/lab/scenario";

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const SPEC: ScenarioSpec = { id: "T1", family: "test", split: "train", title: "test", seed: 9, floods: [0] };

/** Sends nobody anywhere. */
const idle: Coordinator = { name: "idle", decide: (): Action[] => [] };

async function night(coordinator: Coordinator, ticks: number) {
  const scenario = generateScenario(SPEC, graph);
  const sim = new Simulation({ graph, seed: scenario.seed, master: new ScriptedMaster(scenario), coordinator, config: scenario.config });
  await sim.run(ticks);
  return sim;
}

describe("lab: a scenario is the same night whoever coordinates", () => {
  it("is written the same way every time", () => {
    expect(JSON.stringify(generateScenario(SPEC, graph))).toBe(JSON.stringify(generateScenario(SPEC, graph)));
  });

  it("stops new emergencies before the end, so what is open can play out", () => {
    const scenario = generateScenario(SPEC, graph);
    const last = Math.max(...scenario.script.filter((s) => s.action.type === "spawn_scene").map((s) => s.tick));
    expect(last).toBeLessThan(scenario.eventTicks);
    expect(scenario.ticks).toBeGreaterThan(scenario.eventTicks);
  });

  it("gives two different coordinators the same scenes, victims and first calls", async () => {
    const [a, b] = await Promise.all([night(idle, 40), night(new GreedyCoordinator(), 40)]);
    const scenes = (sim: Simulation) => sim.world.scenes.map((s) => `${s.id}@${s.node}:${s.kind}:${s.victimIds.length}`);
    expect(scenes(a)).toEqual(scenes(b));
    expect(scenes(a).length).toBeGreaterThan(5);
    // The first call about each scene is rolled from the scene's own dice, not from a stream the coordinator can shift.
    const firstCalls = (sim: Simulation) => {
      const seen = new Map<string, string>();
      for (const call of sim.belief.calls) {
        const scene = (sim.observer as CallObserver).sceneOfCall.get(call.id)!;
        if (!seen.has(scene)) seen.set(scene, `${call.caller}@${call.node}`);
      }
      return [...seen].sort();
    };
    // A scene a crew dealt with before anyone phoned has no call at all: compare the ones both nights heard about.
    const heardByBoth = new Set(firstCalls(b).map(([scene]) => scene));
    const shared = firstCalls(a).filter(([scene]) => heardByBoth.has(scene));
    expect(shared.length).toBeGreaterThan(5);
    expect(firstCalls(b).filter(([scene]) => shared.some(([id]) => id === scene))).toEqual(shared);
  });
});

describe("lab: a hypothesis is one edit to the doctrine", () => {
  it("adds, rewrites and removes without ever reusing an id", () => {
    const one = applyEdit(EMPTY, { op: "add", kind: "heuristic", title: "a", body: "b" }, 1, [])!;
    expect(one.rules.map((r) => r.id)).toEqual(["H1"]);
    const removed = applyEdit(one, { op: "remove", id: "H1" }, 2, ["H1"])!;
    const again = applyEdit(removed, { op: "add", kind: "heuristic", title: "c", body: "d" }, 3, ["H1"])!;
    expect(again.rules.map((r) => r.id)).toEqual(["H2"]);
    expect(applyEdit(one, { op: "rewrite", id: "H9", title: "x", body: "y" }, 2, [])).toBeNull();
    expect(renderDoctrine(EMPTY)).toBe("");
    expect(renderDoctrine(again)).toContain("H2 · c: d");
  });

  it("takes a whole doctrine, keeping the ids of the rules it keeps", () => {
    const one = applyEdit(EMPTY, { op: "add", kind: "heuristic", title: "a", body: "b" }, 1, [])!;
    const next = applyEdit(one, { op: "replace", rules: [{ id: "H1", kind: "heuristic", title: "a", body: "mejor" }, { kind: "heuristic", title: "nueva", body: "x" }, { kind: "driver", title: "peso", body: "y" }] }, 2, ["H1"])!;
    expect(next.rules.map((r) => `${r.id}@${r.since}`)).toEqual(["H1@1", "H2@2", "D1@2"]);
    expect(diffDoctrine(one, next)).toContain("~ H1");
    expect(diffDoctrine(next, one)).toContain("− H2");
  });

  it("drops a malformed doctrine instead of playing it", () => {
    const out = readResearchOutput({ analysis: "x", hypotheses: [{ name: "ok", rules: [{ kind: "driver", title: "t", body: "b" }, { kind: "heuristic", title: "sin cuerpo" }] }, { name: "vacía", rules: [] }] });
    expect(out.hypotheses).toHaveLength(1);
    expect(out.hypotheses[0].edit).toEqual({ op: "replace", rules: [{ id: undefined, kind: "driver", title: "t", body: "b" }] });
  });

});
