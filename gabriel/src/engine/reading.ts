import type { Graph } from "./graph";
import type { RegistryEntry, Signal } from "./signals";
import type { Answer, Call, SceneKind } from "./types";

// Reading the citizen channel. A reader says, message by message, whether it is about someone in trouble; the desk
// puts what the reader found together with the registry and turns it into leads, and a lead reaches dispatch as one
// more call. Who reads is the experiment: a control room gets through a few messages a tick, keyword rules get
// through all of them and believe the jokes, an agent reads all of them and understands them.

export interface Verdict {
  id: string;
  relevant: boolean;
  /** 0-1: how likely this is a real person in real trouble, here and now. */
  credible: number;
  urgency: "alta" | "media" | "baja";
  mechanism: SceneKind | null;
  trapped: Answer;
  ageGroup: Call["ageGroup"];
  victims: number | null;
  summary: string;
}

export interface Reader {
  readonly name: string;
  /** Verdicts for the messages it got to; the ones it never read are simply absent. */
  read(tick: number, fresh: Signal[]): Verdict[];
}

const REAL = new Set(["worry", "plea", "sighting", "lift"]);
const fromTruth = (s: Signal): Verdict => ({
  id: s.id,
  relevant: REAL.has(s.kind),
  credible: REAL.has(s.kind) ? (s.kind === "lift" ? 0.7 : 0.9) : 0.05,
  urgency: s.kind === "plea" ? "alta" : s.kind === "lift" ? "baja" : "media",
  mechanism: s.kind === "worry" ? "flooded_home" : s.kind === "plea" ? "vehicle_trapped" : null,
  trapped: s.kind === "worry" || s.kind === "plea" ? "yes" : "unknown",
  ageGroup: s.kind === "worry" ? "elderly" : "unknown",
  victims: null,
  summary: s.text,
});

/** People read well and read little: the first `perTick` messages of each tick, and the backlog is never caught up. */
export class HumanReader implements Reader {
  readonly name: string;
  constructor(private readonly perTick: number) {
    this.name = Number.isFinite(perTick) ? `sala (${perTick} mensajes por tick)` : "lector perfecto";
  }
  read(_tick: number, fresh: Signal[]): Verdict[] {
    return fresh.slice(0, this.perTick).map(fromTruth);
  }
}

const ALARM = /socorro|ayuda|atrapad|rescat|no respond|no contesta|no respira|muert|no pued|agua (ya )?(está )?dentro|urgente/i;

/** Rules read everything and understand nothing: a word list cannot tell a plea from a joke about one. */
export class KeywordReader implements Reader {
  readonly name = "reglas por palabras clave";
  read(_tick: number, fresh: Signal[]): Verdict[] {
    return fresh.map((s) => ({ ...fromTruth(s), relevant: ALARM.test(s.text), credible: ALARM.test(s.text) ? 0.7 : 0.05, urgency: "media", mechanism: null, trapped: /atrapad/i.test(s.text) ? "yes" : "unknown", ageGroup: "unknown", summary: s.text }));
  }
}

/** An agent's reading of a night, done once and kept: the night never changes, so neither does what it says. */
export class CachedReader implements Reader {
  readonly name: string;
  constructor(private readonly verdicts: Record<string, Verdict>, name = "agente lector") {
    this.name = name;
  }
  read(_tick: number, fresh: Signal[]): Verdict[] {
    return fresh.flatMap((s) => (this.verdicts[s.id] ? [this.verdicts[s.id]] : []));
  }
}

export interface Lead {
  id: string;
  tick: number;
  node: number;
  street: string | null;
  messages: string[];
  registry: RegistryEntry | null;
  credibility: number;
  urgency: Verdict["urgency"];
  summary: string;
  mechanism: SceneKind | null;
  trapped: Answer;
  ageGroup: Call["ageGroup"];
  victims: number | null;
  /** Truth, for hindsight only: the emergency most of its messages were really about. */
  about: number | null;
}

interface Cluster {
  node: number;
  lastTick: number;
  members: { signal: Signal; verdict: Verdict }[];
  lead: Lead | null;
}

const SAME_PLACE_M = 160;
const SAME_STORY_TICKS = 25;
const REGISTRY_M = 90;
const WORTH_A_CALL = 0.62;
const RANK = { alta: 2, media: 1, baja: 0 } as const;

export interface ReadMessage {
  id: string;
  channel: Signal["channel"];
  node: number | null;
  street: string | null;
  text: string;
  read: boolean;
  relevant: boolean;
  leadId: string | null;
}

export class LeadDesk {
  readonly leads: Lead[] = [];
  readonly stats = { received: 0, read: 0, relevant: 0 };
  /** The last tick's messages as the reader left them: what the supervision screen shows scrolling by. */
  lastTick: ReadMessage[] = [];
  private readonly clusters: Cluster[] = [];
  private readonly byTick = new Map<number, Signal[]>();

  constructor(
    private readonly graph: Graph,
    signals: Signal[],
    private readonly registry: RegistryEntry[],
    readonly reader: Reader,
  ) {
    for (const s of signals) this.byTick.set(s.tick, [...(this.byTick.get(s.tick) ?? []), s]);
  }

  /** One tick of the channel: read what came in, and return the leads that have just become worth acting on. */
  take(tick: number): Lead[] {
    const fresh = this.byTick.get(tick) ?? [];
    const verdicts = new Map(this.reader.read(tick, fresh).map((v) => [v.id, v]));
    this.stats.received += fresh.length;
    this.stats.read += verdicts.size;
    const emitted: Lead[] = [];
    const leadOf = new Map<string, string>();

    for (const signal of fresh) {
      const verdict = verdicts.get(signal.id);
      if (!verdict?.relevant) continue;
      this.stats.relevant++;
      if (signal.node === null) continue;
      let cluster = this.clusters.find((c) => tick - c.lastTick <= SAME_STORY_TICKS && this.graph.distanceM(c.node, signal.node!) <= SAME_PLACE_M);
      if (!cluster) this.clusters.push((cluster = { node: signal.node, lastTick: tick, members: [], lead: null }));
      cluster.lastTick = tick;
      cluster.members.push({ signal, verdict });
      if (cluster.lead) {
        cluster.lead.messages.push(signal.id);
        leadOf.set(signal.id, cluster.lead.id);
        continue;
      }
      const registry = this.registry.find((r) => this.graph.distanceM(r.node, cluster!.node) <= REGISTRY_M) ?? null;
      const doubt = cluster.members.reduce((left, m) => left * (1 - 0.75 * m.verdict.credible), 1);
      const credibility = Math.min(1, 1 - doubt + (registry ? 0.2 : 0));
      if (credibility < WORTH_A_CALL) continue;

      const best = [...cluster.members].sort((a, b) => b.verdict.credible - a.verdict.credible)[0];
      const abouts = cluster.members.flatMap((m) => (m.signal.about === null ? [] : [m.signal.about]));
      cluster.lead = {
        id: `P${this.leads.length + 1}`,
        tick,
        node: cluster.node,
        street: best.signal.street,
        messages: cluster.members.map((m) => m.signal.id),
        registry,
        credibility: Number(credibility.toFixed(2)),
        urgency: cluster.members.map((m) => m.verdict.urgency).sort((a, b) => RANK[b] - RANK[a])[0],
        summary: best.verdict.summary,
        mechanism: cluster.members.find((m) => m.verdict.mechanism)?.verdict.mechanism ?? null,
        trapped: cluster.members.some((m) => m.verdict.trapped === "yes") ? "yes" : "unknown",
        ageGroup: registry ? "elderly" : (cluster.members.find((m) => m.verdict.ageGroup !== "unknown")?.verdict.ageGroup ?? "unknown"),
        victims: cluster.members.find((m) => m.verdict.victims)?.verdict.victims ?? null,
        about: abouts.length * 2 >= cluster.members.length ? abouts[0] : null,
      };
      this.leads.push(cluster.lead);
      emitted.push(cluster.lead);
      for (const m of cluster.members) leadOf.set(m.signal.id, cluster.lead.id);
    }

    this.lastTick = fresh.map((s) => ({ id: s.id, channel: s.channel, node: s.node, street: s.street, text: s.text, read: verdicts.has(s.id), relevant: verdicts.get(s.id)?.relevant ?? false, leadId: leadOf.get(s.id) ?? null }));
    return emitted;
  }
}

/** A lead as dispatch files it: one more call, from the citizen channel, with what the reader could make out. */
export function leadAsCall(lead: Lead): Omit<Call, "id" | "tick"> {
  const sources = `${lead.messages.length} ${lead.messages.length === 1 ? "mensaje" : "mensajes"}${lead.registry ? " + teleasistencia" : ""}`;
  return {
    caller: "bystander",
    mechanism: lead.mechanism,
    node: lead.node,
    locationErrorM: 150,
    street: lead.street,
    conscious: "unknown",
    breathing: lead.urgency === "alta" ? "difficult" : "unknown",
    bleeding: "unknown",
    trapped: lead.trapped,
    ageGroup: lead.ageGroup,
    victims: lead.victims,
    text: `Pista ciudadana ${lead.id} (${sources}, credibilidad ${Math.round(lead.credibility * 100)} %): «${lead.summary}»${lead.registry ? ` · Teleasistencia: ${lead.registry.who}` : ""}`,
    source: "citizen",
  };
}
