import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSignals, CallObserver, Graph, GreedyCoordinator, HumanReader, KeywordReader, LeadDesk, type Reader, Simulation, type Action, type Coordinator, type GraphData } from "../src/engine";
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

describe("sites: people who are fine until the water arrives", () => {
  const G: ScenarioSpec = { id: "TG", family: "test", split: "train", title: "test", seed: 11, floods: [0], floodTicks: [10], sites: 4 };

  async function nightWith(coordinator: Coordinator) {
    const scenario = generateScenario(G, graph);
    const sim = new Simulation({ graph, seed: scenario.seed, master: new ScriptedMaster(scenario), coordinator, config: scenario.config });
    await sim.run(scenario.ticks);
    return sim;
  }

  it("puts the sites and the gauge in the script, and the gauge warns before the water is out", () => {
    const scenario = generateScenario(G, graph);
    expect(scenario.script.filter((s) => s.action.type === "place_site")).toHaveLength(4);
    const readings = scenario.script.filter((s) => s.action.type === "gauge_reading");
    expect(readings[0].tick).toBe(0);
    expect(readings.some((s) => s.tick < 10 && s.action.type === "gauge_reading" && s.action.level < 1)).toBe(true);
  });

  it("catches everyone inside if nobody acts, and nobody if the registry is acted on in time", async () => {
    const [ignored, acted] = await Promise.all([nightWith(new GreedyCoordinator()), nightWith(new GreedyCoordinator(undefined, true))]);
    const caught = (sim: Simulation) => sim.world.log.flatMap((e) => (e.type === "site_flooded" ? [e.caught] : [])).reduce((a, b) => a + b, 0);
    expect(caught(ignored)).toBeGreaterThan(20);
    expect(caught(acted)).toBeLessThan(caught(ignored) / 4);
    expect(acted.summary().dead).toBeLessThan(ignored.summary().dead);
  });

  it("refuses more warnings in a tick than there are outbound lines", async () => {
    const scenario = generateScenario(G, graph);
    const everyone: Coordinator = { name: "all", decide: ({ belief }) => belief.sites.filter((s) => s.warnedTick === null).map((s) => ({ type: "warn", unitId: "112", siteId: s.id }) as Action) };
    const sim = new Simulation({ graph, seed: scenario.seed, master: new ScriptedMaster(scenario), coordinator: everyone, config: { ...scenario.config, outboundLines: 2 } });
    await sim.run(2);
    expect(sim.world.sites.filter((s) => s.warnedTick !== null).length).toBeLessThanOrEqual(4);
    expect(sim.world.log.some((e) => e.type === "action_rejected" && e.reason.includes("outbound"))).toBe(true);
  });
});

describe("citizen channel: the same night always says the same things, and who reads it decides what is found", () => {
  const H: ScenarioSpec = { id: "TH", family: "test", split: "train", title: "test", seed: 21, floods: [0], blackoutTick: 3, volume: 2, dana: { pSilent: 0.35, pSilentFlood: 0.5, pSilentInWater: 0.8 } };

  it("is written from the script alone, mostly noise, with traces of the silent scenes", () => {
    const scenario = generateScenario(H, graph);
    const a = buildSignals(scenario.script, graph, scenario.seed, scenario.ticks, 2);
    const b = buildSignals(scenario.script, graph, scenario.seed, scenario.ticks, 2);
    expect(a.signals.map((s) => s.text)).toEqual(b.signals.map((s) => s.text));
    const real = a.signals.filter((s) => s.about !== null);
    expect(real.length).toBeGreaterThan(10);
    expect(real.length / a.signals.length).toBeLessThan(0.1);
    const silent = scenario.script.flatMap((x) => (x.action.type === "spawn_scene" && x.action.silent ? [x.action.node] : []));
    expect(silent.every((node) => real.some((s) => s.about === node))).toBe(true);
  });

  it("a room reads little and well, keywords read everything and believe the jokes, a perfect reader finds the most", () => {
    const scenario = generateScenario(H, graph);
    const night = buildSignals(scenario.script, graph, scenario.seed, scenario.ticks, 2);
    const desk = (reader: Reader) => {
      const d = new LeadDesk(graph, night.signals, night.registry, reader);
      for (let tick = 0; tick < scenario.ticks; tick++) d.take(tick);
      return d;
    };
    const [room, words, perfect] = [desk(new HumanReader(6)), desk(new KeywordReader()), desk(new HumanReader(Infinity))];
    expect(room.stats.read).toBeLessThan(perfect.stats.read / 3);
    expect(room.leads.every((l) => l.about !== null)).toBe(true);
    expect(words.leads.filter((l) => l.about === null).length).toBeGreaterThan(words.leads.filter((l) => l.about !== null).length);
    expect(perfect.leads.filter((l) => l.about !== null).length).toBeGreaterThan(room.leads.length);
  });

  it("a lead reaches dispatch as one more call, and phoning round a zone turns silence into calls", async () => {
    const scenario = generateScenario(H, graph);
    const night = buildSignals(scenario.script, graph, scenario.seed, scenario.ticks, 2);
    const sim = new Simulation({ graph, seed: scenario.seed, master: new ScriptedMaster(scenario), coordinator: new GreedyCoordinator(undefined, false, true), config: scenario.config, signals: { night, reader: new HumanReader(Infinity) } });
    await sim.run(40);
    expect(sim.belief.calls.some((c) => c.source === "citizen")).toBe(true);
    expect(sim.world.log.some((e) => e.type === "outbound_placed")).toBe(true);
    expect(sim.world.outages.length).toBe(1);
  });
});
