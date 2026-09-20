import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONCEPTS, SEED_RULES, type RuleKind } from "./seed";

// The agent's long-term memory, stored as a graph so it can be browsed:
//   nodes  driver | heuristic | antipattern  (rules the agent decides with)
//          concept                            (what rules are about: helicopter, La Fe, water...)
//          episode                            (one session)
//          evidence                           (one thing that happened in a session, judged with hindsight)
//   edges  about, supports, contradicts, derived_from, replaces, applied_in, happened_in

export type NodeKind = RuleKind | "concept" | "episode" | "evidence";
export type RuleStatus = "active" | "candidate" | "retired";
export type EdgeKind = "about" | "supports" | "contradicts" | "derived_from" | "replaces" | "applied_in" | "happened_in";

export interface MemoryNode {
  id: string;
  kind: NodeKind;
  title: string;
  body: string;
  status: RuleStatus | null;
  confidence: number | null;
  origin: string;
  createdSession: string | null;
  updatedSession: string | null;
  data: Record<string, unknown>;
}

export interface MemoryEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  session: string | null;
  note: string;
}

export interface HistoryEntry {
  session: string;
  op: string;
  nodeId: string;
  before: string | null;
  after: string | null;
  reason: string;
}

export const DEFAULT_MEMORY_PATH = "memory/memory.db";
const RULE_KINDS: NodeKind[] = ["driver", "heuristic", "antipattern"];
const SEED_CONFIDENCE = 0.6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  status TEXT, confidence REAL, origin TEXT NOT NULL DEFAULT '',
  created_session TEXT, updated_session TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL,
  session TEXT, note TEXT NOT NULL DEFAULT '', UNIQUE (src, dst, kind, session)
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, tick INTEGER NOT NULL,
  rule_id TEXT NOT NULL, incident_id TEXT, unit_id TEXT
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, op TEXT NOT NULL, node_id TEXT NOT NULL,
  before TEXT, after TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
`;

type Row = Record<string, string | number | null>;

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(path: string = DEFAULT_MEMORY_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.seedIfEmpty();
  }

  close(): void {
    this.db.close();
  }

  private seedIfEmpty(): void {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };
    if (n > 0) return;
    for (const [id, title] of Object.entries(CONCEPTS)) this.putNode({ id: `concept:${id}`, kind: "concept", title, origin: "doctrina inicial" });
    for (const rule of SEED_RULES) {
      this.putNode({ ...rule, status: "active", confidence: SEED_CONFIDENCE, origin: "doctrina inicial" });
      for (const concept of rule.about) this.link(rule.id, `concept:${concept}`, "about");
    }
  }

  // ---------- reading ----------

  private toNode(row: Row): MemoryNode {
    return {
      id: String(row.id),
      kind: row.kind as NodeKind,
      title: String(row.title),
      body: String(row.body),
      status: row.status as RuleStatus | null,
      confidence: row.confidence as number | null,
      origin: String(row.origin),
      createdSession: row.created_session as string | null,
      updatedSession: row.updated_session as string | null,
      data: JSON.parse(String(row.data)),
    };
  }

  node(id: string): MemoryNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toNode(row) : null;
  }

  nodes(): MemoryNode[] {
    return (this.db.prepare("SELECT * FROM nodes ORDER BY kind, id").all() as Row[]).map((r) => this.toNode(r));
  }

  edges(): MemoryEdge[] {
    return (this.db.prepare("SELECT src, dst, kind, session, note FROM edges").all() as Row[]).map((r) => ({
      src: String(r.src),
      dst: String(r.dst),
      kind: r.kind as EdgeKind,
      session: r.session as string | null,
      note: String(r.note),
    }));
  }

  /** Rules the agent decides with: active ones, and candidates on trial. */
  rules(): MemoryNode[] {
    return this.nodes()
      .filter((n) => RULE_KINDS.includes(n.kind) && n.status !== "retired")
      .sort((a, b) => RULE_KINDS.indexOf(a.kind) - RULE_KINDS.indexOf(b.kind) || (b.confidence ?? 0) - (a.confidence ?? 0));
  }

  history(session?: string): HistoryEntry[] {
    const rows = (session
      ? this.db.prepare("SELECT * FROM history WHERE session = ? ORDER BY id").all(session)
      : this.db.prepare("SELECT * FROM history ORDER BY id").all()) as Row[];
    return rows.map((r) => ({ session: String(r.session), op: String(r.op), nodeId: String(r.node_id), before: r.before as string | null, after: r.after as string | null, reason: String(r.reason) }));
  }

  /** How often each rule was cited in a session, and on which incidents. */
  applications(session: string): { ruleId: string; tick: number; incidentId: string | null; unitId: string | null }[] {
    return (this.db.prepare("SELECT rule_id, tick, incident_id, unit_id FROM applications WHERE session = ? ORDER BY tick").all(session) as Row[]).map((r) => ({
      ruleId: String(r.rule_id),
      tick: Number(r.tick),
      incidentId: r.incident_id as string | null,
      unitId: r.unit_id as string | null,
    }));
  }

  /**
   * What goes into every decision: the doctrine, short enough to be read each time.
   * The ids are what the agent cites back in `applies`, which is how rules get measured.
   */
  renderView(maxRules = 28): string {
    const rules = this.rules().slice(0, maxRules);
    const block = (kind: RuleKind, heading: string) => {
      const items = rules.filter((r) => r.kind === kind);
      if (items.length === 0) return [];
      return [heading, ...items.map((r) => `- ${r.id}${r.status === "candidate" ? " (EN PRUEBA)" : ""} · ${r.title}: ${r.body}`), ""];
    };
    return [
      "DOCTRINA Y MEMORIA (lo aprendido en sesiones anteriores; en cada orden cita en `applies` los ids que has seguido):",
      "",
      ...block("driver", "Qué pesa más cuando no cabe todo:"),
      ...block("heuristic", "Heurísticas:"),
      ...block("antipattern", "Errores ya cometidos que no debes repetir:"),
    ].join("\n").trimEnd();
  }

  // ---------- writing ----------

  putNode(node: Partial<MemoryNode> & Pick<MemoryNode, "id" | "kind" | "title">): void {
    this.db
      .prepare(
        `INSERT INTO nodes (id, kind, title, body, status, confidence, origin, created_session, updated_session, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body, status = excluded.status,
           confidence = excluded.confidence, updated_session = excluded.updated_session, data = excluded.data`,
      )
      .run(node.id, node.kind, node.title, node.body ?? "", node.status ?? null, node.confidence ?? null, node.origin ?? "", node.createdSession ?? null, node.updatedSession ?? null, JSON.stringify(node.data ?? {}));
  }

  link(src: string, dst: string, kind: EdgeKind, session: string | null = null, note = ""): void {
    this.db.prepare("INSERT OR IGNORE INTO edges (src, dst, kind, session, note) VALUES (?, ?, ?, ?, ?)").run(src, dst, kind, session, note);
  }

  log(session: string, op: string, nodeId: string, before: string | null, after: string | null, reason: string): void {
    this.db.prepare("INSERT INTO history (session, op, node_id, before, after, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(session, op, nodeId, before, after, reason, new Date().toISOString());
  }

  /** The agent said it followed these rules for this order. Unknown ids are dropped: it may have made one up. */
  recordApplied(session: string, tick: number, ruleIds: string[], incidentId: string | null, unitId: string | null): void {
    const insert = this.db.prepare("INSERT INTO applications (session, tick, rule_id, incident_id, unit_id) VALUES (?, ?, ?, ?, ?)");
    for (const ruleId of new Set(ruleIds)) if (this.node(ruleId)) insert.run(session, tick, ruleId, incidentId, unitId);
  }

  /** Next free id for a rule of this kind (H14, A5...). */
  nextRuleId(kind: RuleKind): string {
    const prefix = { driver: "D", heuristic: "H", antipattern: "A" }[kind];
    const taken = this.nodes().filter((n) => n.kind === kind).map((n) => Number(n.id.slice(1)) || 0);
    return `${prefix}${Math.max(0, ...taken) + 1}`;
  }
}
