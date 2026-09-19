// pnpm lab:moments — picks the hard moments out of every night: the ticks where there is a real choice to make.
// A whole night is 27 decisions and most of them anyone would take the same way; a moment is 3 decisions where it matters.
import { readFileSync, writeFileSync } from "node:fs";
import { believedWater, buildBriefing, cutOffForecast, Graph, GreedyCoordinator, infoGaps, Simulation, UNIT_KINDS, unitsNeeded, type Action, type Coordinator, type DecideInput, type GraphData } from "../engine";
import { loadScenarios, ScriptedMaster, type MomentRef, type Scenario } from "./scenario";

const DECISIONS = 3;
const MIN_GAP_TICKS = 7;

interface Candidate {
  tick: number;
  score: number;
  why: string;
}

/** Plays the night as the dispatcher would, and notes down how hard each tick's choice was. */
class Probe implements Coordinator {
  readonly name = "probe";
  readonly seen: Candidate[] = [];
  private readonly rules = new GreedyCoordinator();

  decide(input: DecideInput): Action[] {
    const { belief, graph, tick } = input;
    if (buildBriefing(input).actionable) {
      const free = belief.units.filter((u) => (UNIT_KINDS[u.kind].carries || UNIT_KINDS[u.kind].extricates) && u.mission === "idle" && !u.victimId && u.brokenUntil === null).length;
      const open = belief.incidents.filter((i) => i.status === "open");
      const wanting = open.filter((i) => { const need = unitsNeeded(i, belief.units); return need.carriers + need.fire > 0; });
      const urgent = wanting.filter((i) => i.priority <= 1).length;
      const cutOffIn = cutOffForecast(believedWater(belief), belief.hospitals, graph);
      const closing = wanting.filter((i) => { const left = cutOffIn(i.node); return left !== null && left <= 20; }).length;
      const blind = infoGaps(belief, graph, tick, 4).filter((g) => g.score >= 30).length;
      const observers = belief.units.filter((u) => UNIT_KINDS[u.kind].observes && !UNIT_KINDS[u.kind].carries && u.mission === "idle" && u.brokenUntil === null).length;

      const reasons: string[] = [];
      let score = 0;
      if (free > 0 && wanting.length > free) {
        score += 2 + Math.min(4, wanting.length - free) + Math.min(3, urgent);
        reasons.push(`${wanting.length} avisos esperando unidad (${urgent} graves) y ${free} libres`);
      }
      if (free > 0 && closing > 0) {
        score += 3;
        reasons.push(`${closing} a punto de quedar aislados por el agua`);
      }
      if (observers > 0 && blind > 0) {
        score += 1;
        reasons.push(`${blind} zonas a ciegas y ${observers} drones libres`);
      }
      if (score >= 3) this.seen.push({ tick, score, why: reasons.join("; ") });
    }
    return this.rules.decide(input);
  }
}

export async function pickMoments(night: Scenario, graph: Graph, wanted: number): Promise<MomentRef[]> {
  const probe = new Probe();
  const sim = new Simulation({ graph, seed: night.seed, master: new ScriptedMaster(night), coordinator: probe, config: night.config });
  await sim.run(night.eventTicks);
  const picked: Candidate[] = [];
  for (const candidate of [...probe.seen].sort((a, b) => b.score - a.score || a.tick - b.tick)) {
    if (picked.length >= wanted) break;
    if (picked.every((p) => Math.abs(p.tick - candidate.tick) >= MIN_GAP_TICKS)) picked.push(candidate);
  }
  return picked.sort((a, b) => a.tick - b.tick).map((c) => ({ id: `${night.id}@${c.tick}`, night: night.id, tick: c.tick, decisions: DECISIONS, why: c.why }));
}

if (process.argv[1]?.endsWith("moments.ts")) {
  const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
  const out: MomentRef[] = [];
  for (const night of loadScenarios()) {
    const moments = await pickMoments(night, graph, 5);
    out.push(...moments);
    console.log(`${night.id} ${night.split.padEnd(10)} ${moments.map((m) => `t${m.tick}`).join(" ")}`);
    for (const m of moments) console.log(`     t${m.tick}: ${m.why}`);
  }
  writeFileSync("lab/moments.json", JSON.stringify(out, null, 2));
  const count = (split: string) => out.filter((m) => loadScenarios().find((n) => n.id === m.night)!.split === split).length;
  console.log(`${out.length} momentos: ${count("train")} de entrenamiento, ${count("validation")} de validación, ${count("test")} de test → lab/moments.json`);
}
