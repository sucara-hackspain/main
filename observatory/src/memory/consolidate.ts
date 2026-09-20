import { writeFileSync } from "node:fs";
import { MAX_RULES, type DreamOp, type DreamOutput } from "./dream-protocol";
import type { Evaluation } from "./evaluate";
import { CONCEPTS } from "./seed";
import type { MemoryNode, MemoryStore } from "./store";

// Turns a night into memory: the session becomes an episode, what happened becomes evidence, and the
// dream's operations reshape the doctrine. Nothing is ever deleted: retired rules and every change
// stay in the graph, so it can always be asked "why does the agent believe this?".

const REINFORCE = 0.1;
const WEAKEN = 0.15;
const CANDIDATE_CONFIDENCE = 0.5;
const PROMOTE_AT = 0.6;
const RETIRE_BELOW = 0.25;
const MAX_ADDS = 4;

export interface Consolidation {
  applied: { op: string; nodeId: string; summary: string }[];
  skipped: { op: DreamOp; why: string }[];
}

/** Stores the session and its findings. Safe to call before (or without) a dream. */
export function recordEpisode(store: MemoryStore, evaluation: Evaluation): string {
  const { session, summary: s } = evaluation;
  const episode = `episode:${session}`;
  store.putNode({
    id: episode,
    kind: "episode",
    title: `${evaluation.coordinator} · semilla ${evaluation.seed} · ${(s.survivalRate * 100).toFixed(0)} %`,
    body: "",
    origin: session,
    createdSession: session,
    data: { summary: s, counts: evaluation.counts, decisions: evaluation.decisions, hospitalLoad: evaluation.hospitalLoad, coordinator: evaluation.coordinator, seed: evaluation.seed, ticks: evaluation.ticks, at: new Date().toISOString() },
  });
  for (const f of evaluation.findings) {
    store.putNode({ id: f.id, kind: "evidence", title: f.title, body: f.detail, origin: session, createdSession: session, data: { kind: f.kind, good: f.good, tick: f.tick, incidentIds: f.incidentIds } });
    store.link(f.id, episode, "happened_in", session);
  }
  for (const use of evaluation.ruleUse) store.link(use.ruleId, episode, "applied_in", session, `citada ${use.times} veces`);
  return episode;
}

export function consolidate(store: MemoryStore, evaluation: Evaluation, dream: DreamOutput, dreamer: string): Consolidation {
  const { session } = evaluation;
  const episode = `episode:${session}`;
  const result: Consolidation = { applied: [], skipped: [] };
  const evidenceIds = new Set(evaluation.findings.map((f) => f.id));
  const evidenceOf = (op: DreamOp) => (op.evidence ?? []).map((e) => (e.includes(":") ? e : `${session}:${e}`)).filter((e) => evidenceIds.has(e));
  const snapshot = (n: MemoryNode) => JSON.stringify({ title: n.title, body: n.body, status: n.status, confidence: n.confidence });
  const save = (before: MemoryNode | null, after: MemoryNode, op: string, reason: string, summary: string) => {
    store.putNode({ ...after, updatedSession: session });
    store.log(session, op, after.id, before ? snapshot(before) : null, snapshot(after), reason);
    result.applied.push({ op, nodeId: after.id, summary });
  };
  const liveRule = (id: string | undefined): MemoryNode | null => {
    const node = id ? store.node(id) : null;
    return node && node.status !== "retired" && ["driver", "heuristic", "antipattern"].includes(node.kind) ? node : null;
  };

  const episodeNode = store.node(episode)!;
  store.putNode({ ...episodeNode, body: dream.lessons, data: { ...episodeNode.data, dreamer } });

  let adds = 0;
  for (const op of dream.ops) {
    const evidence = evidenceOf(op);
    switch (op.op) {
      case "reinforce":
      case "weaken": {
        const rule = liveRule(op.id);
        if (!rule) { result.skipped.push({ op, why: "no such live rule" }); break; }
        if (evidence.length === 0) { result.skipped.push({ op, why: "no evidence cited" }); break; }
        const delta = op.op === "reinforce" ? REINFORCE : -WEAKEN;
        const after = { ...rule, confidence: Math.min(0.95, Math.max(0.05, (rule.confidence ?? 0.5) + delta)) };
        // A rule on trial earns its place when a later session backs it; a rule nobody can defend goes.
        if (op.op === "reinforce" && rule.status === "candidate" && rule.createdSession !== session && after.confidence >= PROMOTE_AT) after.status = "active";
        if (after.confidence < RETIRE_BELOW) after.status = "retired";
        for (const e of evidence) store.link(e, rule.id, op.op === "reinforce" ? "supports" : "contradicts", session, op.reason);
        save(rule, after, after.status !== rule.status ? (after.status === "active" ? "promote" : "retire") : op.op, op.reason, `${rule.id} ${rule.confidence?.toFixed(2)} → ${after.confidence.toFixed(2)}${after.status !== rule.status ? ` (${after.status})` : ""}`);
        break;
      }
      case "rewrite": {
        const rule = liveRule(op.id);
        if (!rule || !op.body) { result.skipped.push({ op, why: "no such live rule, or no new text" }); break; }
        for (const e of evidence) store.link(e, rule.id, "supports", session, op.reason);
        save(rule, { ...rule, title: op.title || rule.title, body: op.body }, "rewrite", op.reason, `${rule.id} reescrita`);
        break;
      }
      case "retire": {
        const rule = liveRule(op.id);
        if (!rule) { result.skipped.push({ op, why: "no such live rule" }); break; }
        for (const e of evidence) store.link(e, rule.id, "contradicts", session, op.reason);
        save(rule, { ...rule, status: "retired" }, "retire", op.reason, `${rule.id} retirada`);
        break;
      }
      case "add":
      case "merge": {
        const merged = op.op === "merge" ? (op.ids ?? []).map(liveRule).filter((r): r is MemoryNode => r !== null) : [];
        if (!op.title || !op.body) { result.skipped.push({ op, why: "no title or body" }); break; }
        if (op.op === "merge" && merged.length < 2) { result.skipped.push({ op, why: "merge needs two live rules" }); break; }
        if (op.op === "add" && (evidence.length === 0 || ++adds > MAX_ADDS || store.rules().length >= MAX_RULES)) {
          result.skipped.push({ op, why: evidence.length === 0 ? "no evidence cited" : "memory is full or too many additions" });
          break;
        }
        const kind = op.kind ?? merged[0]?.kind ?? "heuristic";
        const node: MemoryNode = {
          id: store.nextRuleId(kind as "driver" | "heuristic" | "antipattern"),
          kind,
          title: op.title,
          body: op.body,
          // A merge inherits the standing of what it replaces; a new idea starts on trial.
          status: op.op === "merge" ? "active" : "candidate",
          confidence: op.op === "merge" ? Math.max(...merged.map((r) => r.confidence ?? 0.5)) : CANDIDATE_CONFIDENCE,
          origin: `sueño de ${session}`,
          createdSession: session,
          updatedSession: session,
          data: {},
        };
        save(null, node, op.op, op.reason, `${node.id} ${op.op === "merge" ? `sustituye a ${merged.map((r) => r.id).join(", ")}` : "en prueba"}: ${node.title}`);
        store.link(node.id, episode, "derived_from", session, op.reason);
        const about = new Set([...(op.about ?? []), ...merged.flatMap((r) => store.edges().filter((e) => e.src === r.id && e.kind === "about").map((e) => e.dst.replace("concept:", "")))]);
        for (const concept of about) if (concept in CONCEPTS) store.link(node.id, `concept:${concept}`, "about");
        for (const e of evidence) store.link(e, node.id, "supports", session, op.reason);
        for (const old of merged) {
          store.link(node.id, old.id, "replaces", session, op.reason);
          save(old, { ...old, status: "retired" }, "retire", `fusionada en ${node.id}`, `${old.id} fusionada en ${node.id}`);
        }
        break;
      }
      default:
        result.skipped.push({ op, why: "unknown operation" });
    }
  }
  return result;
}

/** The doctrine as the agent reads it, written next to the database so it shows up in git diffs. */
export function exportMemory(store: MemoryStore, path = "memory/MEMORY.md"): void {
  const rules = store.rules();
  const episodes = store.nodes().filter((n) => n.kind === "episode").length;
  writeFileSync(path, `${store.renderView()}\n\n---\n${rules.filter((r) => r.status === "active").length} reglas activas, ${rules.filter((r) => r.status === "candidate").length} en prueba, tras ${episodes} sesiones. Generado desde memory/memory.db: no editar a mano.\n`);
}
