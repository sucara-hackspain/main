import type { TickRecord } from "../engineTrace";

// The citizen channel as the supervisor sees it: everything that came in on one side, the little the reader made of it
// on the other, and each lead tied back to the messages, the registry and the incident it became.

type Channel = NonNullable<TickRecord["frame"]["channel"]>;
export type Message = Channel["fresh"][number] & { tick: number };

export interface LeadView {
  id: string;
  tick: number;
  node: number;
  street: string | null;
  summary: string;
  credibility: number;
  urgency: string;
  registry: string | null;
  evidence: Message[];
  /** Inside a district without power: why nobody phoned about it. */
  dark: boolean;
  incidentId: string | null;
  outcome: { tone: "good" | "bad" | "neutral"; text: string };
}

export interface ChannelView {
  reader: string;
  received: number;
  read: number;
  relevant: number;
  /** What a control room would have got through by now, at six messages a tick. */
  roomWouldHaveRead: number;
  messages: Message[];
  leads: LeadView[];
  rounds: { zone: string; tick: number; found: number | null }[];
  heat: { node: number; relevant: boolean }[];
}

const ROOM_PER_TICK = 6;
const SHOWN = 220;

export function channelView(records: TickRecord[], distanceM: (a: number, b: number) => number): ChannelView | null {
  const last = records.at(-1);
  const channel = last?.frame.channel;
  if (!last || !channel) return null;
  const all: Message[] = records.flatMap((r) => (r.frame.channel?.fresh ?? []).map((m) => ({ ...m, tick: r.tick })));
  const byId = new Map(all.map((m) => [m.id, m]));
  const calls = records.flatMap((r) => r.calls);
  const outages = last.frame.outages ?? [];

  const leads = channel.leads.map((lead): LeadView => {
    const call = calls.find((c) => c.source === "citizen" && c.text.includes(`Pista ciudadana ${lead.id} `));
    const incident = call ? last.frame.incidents.find((i) => i.callIds.includes(call.id)) : undefined;
    const closed = incident?.status === "closed";
    const outcome: LeadView["outcome"] = !incident
      ? { tone: "neutral", text: call ? "pasada a la sala; el incidente ya no está en pantalla" : "aún sin pasar a la sala" }
      : incident.located
        ? { tone: "good", text: `confirmada por una dotación: ${incident.victims.length} víctima(s) en ${incident.id}` }
        : closed && incident.closedReason === "not_found"
          ? { tone: "bad", text: `falsa: la dotación llegó a ${incident.id} y no había nadie` }
          : { tone: "neutral", text: `abierta como ${incident.id} (P${incident.priority}), sin confirmar todavía` };
    return {
      ...lead,
      evidence: lead.messages.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      dark: outages.some((o) => distanceM(o.node, lead.node) <= o.radiusM),
      incidentId: incident?.id ?? null,
      outcome,
    };
  });

  return {
    reader: channel.reader,
    received: channel.received,
    read: channel.read,
    relevant: channel.relevant,
    roomWouldHaveRead: Math.min(channel.received, ROOM_PER_TICK * (last.tick + 1)),
    messages: all.slice(-SHOWN).reverse(),
    leads: [...leads].reverse(),
    rounds: [...(last.frame.outbound ?? [])].reverse(),
    heat: all.filter((m) => m.node !== null && last.tick - m.tick <= 12).map((m) => ({ node: m.node!, relevant: m.relevant })),
  };
}
