// What the lab leaves on disk. Everything is append-only text, so a run can be stopped, resumed and audited:
//   lab/games.jsonl     every game ever played, keyed by who played it
//   lab/policies.json   every doctrine ever tried, by key
//   lab/ledger.jsonl    what was decided and why: baselines, generations, the final test
//   lab/status.json     what is running right now (the live report reads it)
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderDoctrine, type Doctrine, type Edit } from "./doctrine";
import type { Game, Policy } from "./play";

export const LAB_DIR = "lab";
const GAMES = `${LAB_DIR}/games.jsonl`;
const POLICIES = `${LAB_DIR}/policies.json`;
const LEDGER = `${LAB_DIR}/ledger.jsonl`;
const STATUS = `${LAB_DIR}/status.json`;

export function policyKey(policy: Policy): string {
  if (policy.kind !== "agent") return policy.kind;
  return `agent:${createHash("sha1").update(renderDoctrine(policy.doctrine)).digest("hex").slice(0, 10)}`;
}

export interface GameRow {
  policy: string;
  at: string;
  game: Game;
}

export interface PolicyInfo {
  label: string;
  doctrine: Doctrine | null;
}

export interface Comparison {
  scenarios: string[];
  candidate: number;
  champion: number;
  /** candidate − champion, in deaths per night: negative is better. */
  delta: number;
}

export type Verdict = "accepted" | "no_gain" | "overfit" | "outdone" | "invalid";

export interface Trial {
  name: string;
  rationale: string;
  expected: string;
  edit: Edit;
  editText: string;
  policy: string;
  train: Comparison | null;
  validation: Comparison | null;
  verdict: Verdict;
  reason: string;
}

export type LedgerEntry =
  | { type: "baseline"; at: string; name: string; policy: string }
  | {
      type: "generation";
      n: number;
      startedAt: string;
      endedAt: string;
      researcher: string;
      analysis: string;
      championBefore: string;
      championAfter: string;
      minibatch: string[];
      trials: Trial[];
    }
  | { type: "test"; at: string; policies: string[] };

export interface RunningGame {
  label: string;
  scenario: string;
  rep: number;
  tick: number;
  ticks: number;
  dead: number;
  startedAt: string;
}

export interface Status {
  running: boolean;
  phase: string;
  generation: number;
  done: number;
  total: number;
  meanGameSeconds: number | null;
  parallel: number;
  games: RunningGame[];
  log: string[];
  updatedAt: string;
}

const lines = <T>(path: string): T[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];

export const readGames = () => lines<GameRow>(GAMES);
export const readLedger = () => lines<LedgerEntry>(LEDGER);
export const readPolicies = (): Record<string, PolicyInfo> => (existsSync(POLICIES) ? JSON.parse(readFileSync(POLICIES, "utf8")) : {});
export const readStatus = (): Status | null => (existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, "utf8")) : null);

export function saveGame(row: GameRow): void {
  mkdirSync(LAB_DIR, { recursive: true });
  appendFileSync(GAMES, JSON.stringify(row) + "\n");
}

export function saveLedger(entry: LedgerEntry): void {
  mkdirSync(LAB_DIR, { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
}

export function savePolicy(key: string, info: PolicyInfo): void {
  const all = readPolicies();
  if (all[key]) return;
  all[key] = info;
  mkdirSync(LAB_DIR, { recursive: true });
  writeFileSync(POLICIES, JSON.stringify(all, null, 2));
}

export function saveStatus(status: Status): void {
  mkdirSync(LAB_DIR, { recursive: true });
  writeFileSync(STATUS, JSON.stringify(status));
}

// ---------- reading the games ----------

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);

/** Mean deaths of a policy on one scenario over its valid repetitions (all of them if none was valid). */
export function deathsOn(games: GameRow[], policy: string, scenario: string): number {
  const rows = games.filter((g) => g.policy === policy && g.game.scenario === scenario);
  const valid = rows.filter((g) => g.game.valid);
  return mean((valid.length ? valid : rows).map((g) => g.game.dead));
}

/** Mean over scenarios of the per-scenario mean: every night weighs the same. NaN if any night is missing. */
export function deathsOver(games: GameRow[], policy: string, scenarios: string[]): number {
  return mean(scenarios.map((id) => deathsOn(games, policy, id)));
}

/** How much the same policy on the same night differs from one game to the next: below this, a difference is noise. */
export function repNoise(games: GameRow[], policy: string, scenarios: string[]): number | null {
  const spreads: number[] = [];
  for (const id of scenarios) {
    const dead = games.filter((g) => g.policy === policy && g.game.scenario === id && g.game.valid).map((g) => g.game.dead);
    if (dead.length >= 2) spreads.push(Math.max(...dead) - Math.min(...dead));
  }
  return spreads.length ? mean(spreads) : null;
}
