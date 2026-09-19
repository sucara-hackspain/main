// pnpm lab:ab — the same agent, the same moments, two harnesses: the reactive dispatcher it was ("basic") against the one
// that can stage units, hold some back and keep a notebook ("plan"). No doctrine in either: this measures the harness.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Graph, type GraphData } from "../engine";
import { EMPTY } from "./doctrine";
import { play, pool, type Policy } from "./play";
import { loadPlayables } from "./scenario";
import { LAB_DIR, policyKey, readGames, saveGame, savePolicy } from "./store";

const { values } = parseArgs({ options: { reps: { type: "string", default: "2" }, parallel: { type: "string", default: "40" }, only: { type: "string" } } });
const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const moments = loadPlayables().filter((s) => s.split !== "test" && (!values.only || s.id.startsWith(values.only)));
const arms: [string, Policy][] = [
  ["greedy", { kind: "greedy" }],
  ["registry", { kind: "registry" }],
  ["basic", { kind: "agent", doctrine: EMPTY, harness: "basic" }],
  ["plan", { kind: "agent", doctrine: EMPTY, harness: "plan" }],
];

const games = readGames();
const jobs: { arm: string; policy: Policy; key: string; moment: (typeof moments)[number]; rep: number }[] = [];
for (const [arm, policy] of arms) {
  const key = policyKey(policy);
  savePolicy(key, { label: arm, doctrine: null });
  for (const moment of moments) {
    const have = games.filter((g) => g.policy === key && g.game.scenario === moment.id).length;
    for (let rep = have; rep < (policy.kind === "agent" ? Number(values.reps) : 1); rep++) jobs.push({ arm, policy, key, moment, rep });
  }
}
console.log(`${moments.length} momentos, ${jobs.length} partidas por jugar`);
let done = 0;
await pool(jobs, Number(values.parallel), async ({ arm, policy, key, moment, rep }) => {
  const game = await play(moment, policy, graph, { rep });
  const row = { policy: key, at: new Date().toISOString(), game };
  saveGame(row);
  games.push(row);
  console.log(`${new Date().toTimeString().slice(0, 8)} [${++done}/${jobs.length}] ${arm} ${moment.id} r${rep}: ${game.dead} muertos${policy.kind === "agent" ? ` (${game.llm.calls} decisiones, ${game.llm.fallbacks} sin respuesta)` : ""}`);
});

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const deaths = (arm: Policy, id: string) => games.filter((g) => g.policy === policyKey(arm) && g.game.scenario === id && g.game.valid).map((g) => g.game.dead);
const rows = moments.flatMap((m) => {
  const [g, r, b, p] = arms.map(([, policy]) => deaths(policy, m.id));
  return g.length && b.length && p.length ? [{ id: m.id, family: m.family, why: m.handover?.why ?? "", greedy: mean(g), registry: r.length ? mean(r) : NaN, basic: mean(b), plan: mean(p) }] : [];
});
const diff = rows.map((r) => r.plan - r.basic);
const sd = Math.sqrt(mean(diff.map((d) => (d - mean(diff)) ** 2)) * (diff.length / Math.max(1, diff.length - 1)));
const summary = {
  moments: rows.length,
  greedy: mean(rows.map((r) => r.greedy)),
  registry: mean(rows.map((r) => r.registry)),
  basic: mean(rows.map((r) => r.basic)),
  plan: mean(rows.map((r) => r.plan)),
  planMinusBasic: mean(diff),
  standardError: sd / Math.sqrt(diff.length),
  planBetter: diff.filter((d) => d < 0).length,
  same: diff.filter((d) => d === 0).length,
  planWorse: diff.filter((d) => d > 0).length,
  byFamily: Object.fromEntries([...new Set(rows.map((r) => r.family))].map((f) => [f, mean(rows.filter((r) => r.family === f).map((r) => r.plan - r.basic))])),
};
writeFileSync(`${LAB_DIR}/ab.json`, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
