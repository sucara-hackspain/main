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

/** One change at a time, so whatever the games show can be pinned on it. */
export type Edit =
  | { op: "add"; kind: RuleKind; title: string; body: string }
  | { op: "rewrite"; id: string; title: string; body: string }
  | { op: "remove"; id: string };

const PREFIX: Record<RuleKind, string> = { driver: "D", heuristic: "H", antipattern: "A" };
export const MAX_RULES = 14;

/** Ids are never reused, so a rule cited in an old game still means the same rule. `taken` is every id ever given. */
export function applyEdit(doctrine: Doctrine, edit: Edit, generation: number, taken: Iterable<string>): Doctrine | null {
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

export function describeEdit(edit: Edit): string {
  if (edit.op === "add") return `+ ${edit.title}: ${edit.body}`;
  if (edit.op === "remove") return `− quitar ${edit.id}`;
  return `~ ${edit.id} → ${edit.title}: ${edit.body}`;
}
