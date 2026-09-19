// pnpm lab — the training loop. Each generation: study how the champion doctrine fared on the training nights, let the
// researcher propose single changes to it, play each change on the same nights, and keep a change only if it saves lives
// in training AND does no harm on nights the researcher has never seen.
//
//   pnpm lab                          one generation, then stop (look at lab/report.html before going on)
//   pnpm lab --generations 8          keeps going from wherever the ledger ends
//   pnpm lab --baselines-only         just the references
//   pnpm lab --test                   the final exam: champion and references on the test nights. Once.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pace } from "../coordinators/hr-wait";
import { Graph, type GraphData } from "../engine";
import { HAND_WRITTEN } from "./baselines";
import { applyEdit, describeEdit, diffDoctrine, EMPTY, type Doctrine } from "./doctrine";
import { play, type Game, type Policy } from "./play";
import { writeReport } from "./report";
import { buildResearchInput, ClaudeResearcher, type PastTrial } from "./researcher";
import { loadPlayables, type Scenario } from "./scenario";
import { deathsOn, deathsOver, policyKey, readGames, readLedger, readPolicies, saveGame, saveLedger, savePolicy, saveStatus, type Comparison, type GameRow, type RunningGame, type Status, type Trial } from "./store";

const { values } = parseArgs({
  options: {
    generations: { type: "string", default: "1" },
    hypotheses: { type: "string", default: "3" },
    reps: { type: "string", default: "2" },
    /** Games per night for a hypothesis. One is enough to sort the promising from the rest; the winner gets the full count. */
    "candidate-reps": { type: "string", default: "2" },
    parallel: { type: "string", default: "24" },
    model: { type: "string", default: "claude-opus-5" },
    /** A change must save at least this many lives per night in training to be worth a validation. */
    "min-gain": { type: "string", default: "0.5" },
    /** ...and may cost at most this many on the validation nights. */
    "max-harm": { type: "string", default: "0.25" },
    /** Stop after this many generations in a row with nothing accepted. */
    patience: { type: "string", default: "4" },
    "baselines-only": { type: "boolean", default: false },
    "no-hand-written": { type: "boolean", default: false },
    test: { type: "boolean", default: false },
  },
});

const REPS = Number(values.reps);
const PARALLEL = Number(values.parallel);
const MIN_GAIN = Number(values["min-gain"]);
const MAX_HARM = Number(values["max-harm"]);

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const scenarios = loadPlayables();
const bySplit = (split: Scenario["split"]) => scenarios.filter((s) => s.split === split);
const TRAIN = bySplit("train");
const VALIDATION = bySplit("validation");
const TEST = bySplit("test");
const ids = (list: Scenario[]) => list.map((s) => s.id);

// ---------- playing games, a few at a time, never the same one twice ----------

let games: GameRow[] = readGames();
const status: Status = { running: true, phase: "arrancando", generation: 0, done: 0, total: 0, meanGameSeconds: null, parallel: PARALLEL, games: [], log: [], updatedAt: "" };
const durations: number[] = [];

const say = (line: string) => {
  const stamped = `${new Date().toTimeString().slice(0, 8)}  ${line}`;
  console.log(stamped);
  status.log = [...status.log, stamped].slice(-40);
  publish();
};

let lastPublished = 0;
function publish(force = true): void {
  if (!force && Date.now() - lastPublished < 3000) return;
  lastPublished = Date.now();
  status.updatedAt = new Date().toISOString();
  status.platform = { requests: pace.requests, rateLimited: pace.rateLimited, spacingMs: pace.spacingMs() };
  saveStatus(status);
  writeReport();
}

let free = PARALLEL;
const queue: (() => void)[] = [];
const slot = async () => {
  if (free > 0) return void free--;
  await new Promise<void>((resolve) => queue.push(resolve));
};
const release = () => {
  const next = queue.shift();
  if (next) next();
  else free++;
};

async function playOnce(scenario: Scenario, policy: Policy, key: string, label: string, rep: number): Promise<void> {
  await slot();
  const running: RunningGame = { label, scenario: scenario.id, rep, tick: 0, ticks: scenario.ticks, dead: 0, startedAt: new Date().toISOString() };
  status.games.push(running);
  try {
    let game: Game | null = null;
    // A game the platform mostly failed to answer is played again once: it says nothing about the doctrine.
    for (let attempt = 0; attempt < 2 && !game?.valid; attempt++) {
      game = await play(scenario, policy, graph, {
        rep,
        onTick: (tick, dead) => {
          running.tick = tick + 1;
          running.dead = dead;
          publish(false);
        },
      });
      if (!game.valid) say(`${label} · ${scenario.id} r${rep}: ${game.llm.fallbacks} de ${game.llm.calls} decisiones sin respuesta de la plataforma${attempt === 0 ? ", se repite" : ", se queda como no válida"}`);
    }
    const row = { policy: key, at: new Date().toISOString(), game: game! };
    saveGame(row);
    games.push(row);
    if (policy.kind === "agent") durations.push(game!.seconds);
    status.meanGameSeconds = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    say(`${label} · ${scenario.id} r${rep}: ${game!.dead} muertos de ${game!.victims}${policy.kind === "agent" ? ` (${game!.llm.calls} decisiones, ${Math.round(game!.seconds)} s)` : ""}`);
  } finally {
    status.games = status.games.filter((g) => g !== running);
    status.done++;
    release();
    publish();
  }
}

interface Batch {
  policy: Policy;
  label: string;
  on: Scenario[];
  reps?: number;
}

/** Plays whatever is still missing from these batches, all batches sharing the same slots. */
async function ensure(batches: Batch[]): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const batch of batches) {
    const key = policyKey(batch.policy);
    savePolicy(key, { label: batch.label, doctrine: batch.policy.kind === "agent" ? batch.policy.doctrine : null });
    const reps = batch.policy.kind === "agent" ? (batch.reps ?? REPS) : 1;
    for (const scenario of batch.on) {
      const have = games.filter((g) => g.policy === key && g.game.scenario === scenario.id).length;
      for (let rep = have; rep < reps; rep++) jobs.push(playOnce(scenario, batch.policy, key, batch.label, rep));
    }
  }
  status.total += jobs.length;
  await Promise.all(jobs);
}

const compare = (candidate: string, champion: string, on: Scenario[]): Comparison => {
  const c = deathsOver(games, candidate, ids(on));
  const k = deathsOver(games, champion, ids(on));
  return { scenarios: ids(on), candidate: c, champion: k, delta: c - k };
};

const fmt = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;

// ---------- the run ----------

const agent = (doctrine: Doctrine): Policy => ({ kind: "agent", doctrine });

async function baselines(on: Scenario[], withHandWritten = !values["no-hand-written"]): Promise<void> {
  const known = new Set(readLedger().flatMap((e) => (e.type === "baseline" ? [e.name] : [])));
  const list: [string, Policy][] = [
    ["Despachador por reglas (greedy)", { kind: "greedy" }],
    ["Greedy con información perfecta", { kind: "informed" }],
    ...(withHandWritten ? ([["Agente con la doctrina escrita a mano", agent(HAND_WRITTEN)]] as [string, Policy][]) : []),
  ];
  // One game per night is enough for a reference line; the champion gets the repetitions.
  await ensure(list.map(([label, policy]) => ({ policy, label, on, reps: 1 })));
  for (const [name, policy] of list) if (!known.has(name)) saveLedger({ type: "baseline", at: new Date().toISOString(), name, policy: policyKey(policy) });
}

function currentChampion(): { doctrine: Doctrine; generation: number; taken: Set<string> } {
  const policies = readPolicies();
  let doctrine = EMPTY;
  let generation = 0;
  const taken = new Set<string>();
  for (const entry of readLedger()) {
    if (entry.type !== "generation") continue;
    generation = entry.n;
    doctrine = policies[entry.championAfter]?.doctrine ?? doctrine;
    for (const trial of entry.trials) for (const rule of policies[trial.policy]?.doctrine?.rules ?? []) taken.add(rule.id);
  }
  return { doctrine, generation, taken };
}

/** The moments where the agent did worst against the dispatcher, with what it ordered: the most instructive thing there is. */
function momentCases(rows: GameRow[]): string[] | undefined {
  const cases = rows.flatMap((row) => {
    const moment = TRAIN.find((s) => s.id === row.game.scenario)?.handover;
    if (!moment || !row.game.decisions) return [];
    const rules = deathsOn(games, "greedy", row.game.scenario);
    const orders = row.game.decisions.map((d) => `    t${d.tick} «${d.situation}» ${d.orders.length ? d.orders.join(" | ") : "(sin órdenes)"}`);
    return [{ lost: row.game.dead - rules, text: [`- [${row.game.scenario}] ${moment.why} → ${row.game.dead} muertos (reglas: ${rules})`, ...orders].join("\n") }];
  });
  if (cases.length === 0) return undefined;
  return cases.sort((a, b) => b.lost - a.lost).slice(0, 14).map((c) => c.text.slice(0, 1500));
}

function pastTrials(): PastTrial[] {
  return readLedger().flatMap((entry) =>
    entry.type === "generation"
      ? entry.trials.map((t) => ({ generation: entry.n, name: t.name, edit: t.editText, trainDelta: t.train?.delta ?? 0, validationDelta: t.validation?.delta ?? null, verdict: t.reason }))
      : [],
  );
}

async function generation(n: number, champion: Doctrine, taken: Set<string>): Promise<Doctrine> {
  const startedAt = new Date().toISOString();
  status.generation = n;
  const championPolicy = agent(champion);
  const championKey = policyKey(championPolicy);
  const championLabel = n === 1 && champion.rules.length === 0 ? "G0 · sin doctrina" : `G${n - 1} · campeona`;

  status.phase = `G${n}: la campeona juega entrenamiento y validación`;
  say(`── Generación ${n} ── campeona con ${champion.rules.length} reglas`);
  await ensure([{ policy: championPolicy, label: championLabel, on: [...TRAIN, ...VALIDATION] }]);
  say(`campeona: ${deathsOver(games, championKey, ids(TRAIN)).toFixed(2)} muertos/noche en entrenamiento, ${deathsOver(games, championKey, ids(VALIDATION)).toFixed(2)} en validación`);

  status.phase = `G${n}: el investigador estudia las partidas de entrenamiento`;
  publish();
  const trainGames = games.filter((g) => g.policy === championKey && TRAIN.some((s) => s.id === g.game.scenario));
  const ruleUse = new Map<string, number>();
  for (const g of trainGames) for (const u of g.game.ruleUse) ruleUse.set(u.ruleId, (ruleUse.get(u.ruleId) ?? 0) + u.times);
  const researcher = new ClaudeResearcher(values.model);
  const input = buildResearchInput({
    generation: n,
    doctrine: champion,
    trainDeaths: TRAIN.map((s) => ({ scenario: s.id, family: s.family, victims: s.stats.victims, dead: deathsOn(games, championKey, s.id), greedy: deathsOn(games, "greedy", s.id), informed: deathsOn(games, "informed", s.id) })),
    findings: trainGames.flatMap((g) => g.game.findings.map((finding) => ({ scenario: g.game.scenario, finding }))),
    ruleUse: [...ruleUse].map(([ruleId, times]) => ({ ruleId, times })).sort((a, b) => b.times - a.times),
    past: pastTrials(),
    wanted: Number(values.hypotheses),
    moments: momentCases(trainGames),
  });
  const thinking = Date.now();
  const research = await researcher.propose(input);
  say(`investigador (${Math.round((Date.now() - thinking) / 1000)} s): ${research.analysis}`);

  // One rule moves less than the noise, so doctrines are proposed whole and judged on every training night.
  const minibatch = TRAIN;

  const trials: (Trial & { doctrine: Doctrine | null })[] = research.hypotheses.slice(0, Number(values.hypotheses)).map((h) => {
    const doctrine = applyEdit(champion, h.edit, n, taken);
    const policy = doctrine ? policyKey(agent(doctrine)) : "";
    return { name: h.name, rationale: h.rationale, expected: h.expected, edit: h.edit, editText: doctrine ? diffDoctrine(champion, doctrine) : describeEdit(h.edit), policy, doctrine, train: null, validation: null, verdict: "invalid", reason: doctrine ? "" : "cambio imposible sobre la doctrina actual" };
  });
  for (const t of trials) say(`doctrina «${t.name}»:\n${t.editText}`);

  status.phase = `G${n}: ${trials.length} hipótesis juegan ${minibatch.length} noches de entrenamiento`;
  const playable = trials.filter((t) => t.doctrine);
  await ensure(playable.map((t) => ({ policy: agent(t.doctrine!), label: `G${n} · ${t.name}`, on: minibatch, reps: Number(values["candidate-reps"]) })));
  for (const t of playable) {
    t.train = compare(t.policy, championKey, minibatch);
    t.verdict = t.train.delta <= -MIN_GAIN ? "outdone" : "no_gain";
    t.reason = t.verdict === "no_gain" ? `no mejora en entrenamiento (Δ${fmt(t.train.delta)}, hacía falta ≤ −${MIN_GAIN})` : `mejoraba en entrenamiento (Δ${fmt(t.train.delta)}), pero otra hipótesis se probó antes`;
    say(`«${t.name}»: entrenamiento Δ${fmt(t.train.delta)} muertos/noche`);
  }

  // Everything that won in training goes in together: early on most sound rules help, and one rule per generation
  // would take all night. The combination and the best single change face the nights nobody studied in the same
  // wave; the combination is preferred, the single change is the fallback if the mix does harm.
  let next = champion;
  const winners = playable.filter((t) => t.verdict === "outdone").sort((a, b) => a.train!.delta - b.train!.delta);
  const contenders = winners.slice(0, winners.some((t) => t.edit.op === "replace") ? 2 : 1);
  // Whole doctrines are alternatives to each other: there is nothing to add up.
  if (winners.length > 1 && winners.every((t) => t.edit.op !== "replace")) {
    let doctrine: Doctrine = champion;
    const members: typeof winners = [];
    for (const t of winners) {
      const merged = applyEdit(doctrine, t.edit, n, taken);
      if (!merged) continue;
      doctrine = merged;
      members.push(t);
    }
    const combo = { name: `Combinación de ${members.length}`, rationale: `Las ${members.length} hipótesis que ganaron en entrenamiento, juntas: ${members.map((t) => `«${t.name}»`).join(", ")}.`, expected: "", edit: members[0].edit, editText: members.map((t) => t.editText).join("\n"), policy: policyKey(agent(doctrine)), doctrine, train: null, validation: null, verdict: "invalid" as const, reason: "", members };
    trials.push(combo);
    contenders.unshift(combo);
  }
  if (contenders.length) {
    status.phase = `G${n}: ${contenders.map((t) => `«${t.name}»`).join(" y ")} se examinan en validación`;
    await ensure(contenders.map((t, i) => ({ policy: agent(t.doctrine!), label: `G${n} · ${t.name}`, on: i === 0 ? [...TRAIN, ...VALIDATION] : VALIDATION })));
  }
  for (const t of contenders) {
    t.train ??= compare(t.policy, championKey, minibatch);
    t.validation = compare(t.policy, championKey, VALIDATION);
    const members = "members" in t ? (t.members as typeof winners) : [t];
    if (next !== champion) {
      // Already in, as part of the combination: its own validation is kept for the record.
    } else if (t.train.delta > -MIN_GAIN) {
      t.verdict = "no_gain";
      t.reason = `junta no mejora en entrenamiento (Δ${fmt(t.train.delta)})`;
    } else if (t.validation.delta <= MAX_HARM) {
      next = t.doctrine!;
      for (const m of [t, ...members]) {
        m.verdict = "accepted";
        m.reason = m === t ? `aceptada: entrenamiento Δ${fmt(t.train.delta)}, validación Δ${fmt(t.validation.delta)}` : `aceptada dentro de la combinación (sola: entrenamiento Δ${fmt(m.train!.delta)})`;
      }
      say(`«${t.name}» ACEPTADA (entrenamiento Δ${fmt(t.train.delta)}, validación Δ${fmt(t.validation.delta)})`);
    } else {
      t.verdict = "overfit";
      t.reason = `sobreajuste: gana en entrenamiento (Δ${fmt(t.train.delta)}) y pierde en validación (Δ${fmt(t.validation.delta)})`;
      say(`«${t.name}» rechazada por sobreajuste (validación Δ${fmt(t.validation.delta)})`);
    }
  }
  if (next === champion) say("ninguna hipótesis aceptada: la campeona sigue");

  // The new champion is measured on every night before anyone builds on it.
  if (next !== champion) {
    status.phase = `G${n}: la nueva campeona completa entrenamiento y validación`;
    await ensure([{ policy: agent(next), label: `G${n} · campeona`, on: [...TRAIN, ...VALIDATION] }]);
  }

  saveLedger({
    type: "generation",
    n,
    startedAt,
    endedAt: new Date().toISOString(),
    researcher: researcher.name,
    analysis: research.analysis,
    championBefore: championKey,
    championAfter: policyKey(agent(next)),
    minibatch: ids(minibatch),
    trials: trials.map(({ doctrine: _doctrine, ...t }) => ({ ...t, members: undefined })),
  });
  for (const t of trials) for (const rule of t.doctrine?.rules ?? []) taken.add(rule.id);
  return next;
}

try {
  if (values.test) {
    status.phase = "examen final: noches de test";
    const { doctrine } = currentChampion();
    await baselines(TEST);
    await ensure([
      { policy: agent(EMPTY), label: "G0 · sin doctrina", on: TEST },
      { policy: agent(doctrine), label: "Campeona final", on: TEST },
    ]);
    saveLedger({ type: "test", at: new Date().toISOString(), policies: [policyKey(agent(EMPTY)), policyKey(agent(doctrine))] });
    say(`TEST: sin doctrina ${deathsOver(games, policyKey(agent(EMPTY)), ids(TEST)).toFixed(2)} → campeona ${deathsOver(games, policyKey(agent(doctrine)), ids(TEST)).toFixed(2)} muertos/noche`);
  } else {
    status.phase = "referencias";
    say(`laboratorio: ${TRAIN.length} noches de entrenamiento, ${VALIDATION.length} de validación, ${TEST.length} de test guardadas · ${PARALLEL} partidas a la vez`);
    // The rule-based references take seconds. The hand-written doctrine costs as much as a champion, so it plays last:
    // the learning curve should not wait for a reference line.
    await baselines([...TRAIN, ...VALIDATION], false);
    if (!values["baselines-only"]) {
      let { doctrine, generation: done, taken } = currentChampion();
      let dry = 0;
      for (let i = 0; i < Number(values.generations) && dry < Number(values.patience); i++) {
        const next = await generation(++done, doctrine, taken);
        dry = next === doctrine ? dry + 1 : 0;
        doctrine = next;
      }
    }
    status.phase = "referencia: el agente con la doctrina escrita a mano";
    await baselines([...TRAIN, ...VALIDATION]);
  }
  status.phase = "parado";
} catch (err) {
  status.phase = `FALLO: ${err instanceof Error ? err.message : err}`;
  console.error(err);
  process.exitCode = 1;
} finally {
  status.running = false;
  status.games = [];
  publish();
}
