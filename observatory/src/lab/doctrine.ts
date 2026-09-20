// The thing being learned: the short list of rules the agent reads before every decision. In the lab it is plain
// data, so a hypothesis is a small edit to it and every version can be kept, diffed and played.
import type { RuleKind } from "../memory/seed";

export interface Rule {
  id: string;
  kind: RuleKind;
  title: string;
  body: string;
  /** Generation that brought it in (0 = there from the start). */
  since: number;
}

export interface Doctrine {
  rules: Rule[];
}

export const EMPTY: Doctrine = { rules: [] };

export interface RuleDraft {
  /** Id of the champion's rule this one keeps or rewrites; absent for a new rule. */
  id?: string;
  kind: RuleKind;
  title: string;
  body: string;
}

/**
 * A single change can be pinned on what the games show, but one rule moves less than the noise between two games of
 * the same night. `replace` proposes the whole doctrine at once: effects big enough to see, refined afterwards.
 */
export type Edit =
  | { op: "replace"; rules: RuleDraft[] }
  | { op: "add"; kind: RuleKind; title: string; body: string }
  | { op: "rewrite"; id: string; title: string; body: string }
  | { op: "remove"; id: string };

const PREFIX: Record<RuleKind, string> = { driver: "D", heuristic: "H", antipattern: "A" };
export const MAX_RULES = 14;

/** Ids are never reused, so a rule cited in an old game still means the same rule. `taken` is every id ever given. */
export function applyEdit(doctrine: Doctrine, edit: Edit, generation: number, taken: Iterable<string>): Doctrine | null {
  if (edit.op === "replace") {
    if (edit.rules.length === 0 || edit.rules.length > MAX_RULES) return null;
    const used = new Set([...taken, ...doctrine.rules.map((r) => r.id)]);
    const kept = new Set<string>();
    const rules = edit.rules.map((draft): Rule => {
      const old = draft.id && !kept.has(draft.id) ? doctrine.rules.find((r) => r.id === draft.id) : undefined;
      if (old) {
        kept.add(old.id);
        return { ...old, kind: draft.kind, title: draft.title, body: draft.body };
      }
      let n = 1;
      while (used.has(`${PREFIX[draft.kind]}${n}`)) n++;
      used.add(`${PREFIX[draft.kind]}${n}`);
      return { id: `${PREFIX[draft.kind]}${n}`, kind: draft.kind, title: draft.title, body: draft.body, since: generation };
    });
    return { rules };
  }
  if (edit.op === "add") {
    if (doctrine.rules.length >= MAX_RULES) return null;
    const used = new Set([...taken, ...doctrine.rules.map((r) => r.id)]);
    let n = 1;
    while (used.has(`${PREFIX[edit.kind]}${n}`)) n++;
    return { rules: [...doctrine.rules, { id: `${PREFIX[edit.kind]}${n}`, kind: edit.kind, title: edit.title, body: edit.body, since: generation }] };
  }
  if (!doctrine.rules.some((r) => r.id === edit.id)) return null;
  if (edit.op === "remove") return { rules: doctrine.rules.filter((r) => r.id !== edit.id) };
  return { rules: doctrine.rules.map((r) => (r.id === edit.id ? { ...r, title: edit.title, body: edit.body } : r)) };
}

/** Same layout the agent gets from its long-term memory in a live session. */
export function renderDoctrine(doctrine: Doctrine): string {
  if (doctrine.rules.length === 0) return "";
  const block = (kind: RuleKind, heading: string) => {
    const items = doctrine.rules.filter((r) => r.kind === kind);
    return items.length ? [heading, ...items.map((r) => `- ${r.id} · ${r.title}: ${r.body}`), ""] : [];
  };
  return [
    "DOCTRINA Y MEMORIA (lo aprendido en sesiones anteriores; en cada orden cita en `applies` los ids que has seguido):",
    "",
    ...block("driver", "Qué pesa más cuando no cabe todo:"),
    ...block("heuristic", "Heurísticas:"),
    ...block("antipattern", "Errores ya cometidos que no debes repetir:"),
  ].join("\n").trimEnd();
}

/** What changes between two doctrines, one line per rule. */
export function diffDoctrine(before: Doctrine, after: Doctrine): string {
  const lines: string[] = [];
  for (const rule of after.rules) {
    const old = before.rules.find((r) => r.id === rule.id);
    if (!old) lines.push(`+ ${rule.id} ${rule.title}: ${rule.body}`);
    else if (old.title !== rule.title || old.body !== rule.body) lines.push(`~ ${rule.id} ${rule.title}: ${rule.body}`);
  }
  for (const old of before.rules) if (!after.rules.some((r) => r.id === old.id)) lines.push(`− ${old.id} ${old.title}`);
  return lines.join("\n") || "(sin cambios)";
}

export function describeEdit(edit: Edit): string {
  if (edit.op === "replace") return edit.rules.map((r) => `${r.id ? `~ ${r.id}` : "+"} ${r.title}: ${r.body}`).join("\n");
  if (edit.op === "add") return `+ ${edit.title}: ${edit.body}`;
  if (edit.op === "remove") return `− quitar ${edit.id}`;
  return `~ ${edit.id} → ${edit.title}: ${edit.body}`;
}
