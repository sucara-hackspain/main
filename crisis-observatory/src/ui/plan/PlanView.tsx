import { Lock } from "lucide-react";
import { elapsed } from "../engineTrace";
import type { DecisionCard } from "../decisions/model";
import "./plan.css";

// The plan as a thread: every time the coordinator rewrote what it was trying to do, what it did under that plan,
// and how those orders turned out. A plan nobody can follow back to its orders is just a sentence.

interface Version {
  index: number;
  fromTick: number;
  toTick: number;
  plan: string;
  watch: string;
  agent: boolean;
  cards: DecisionCard[];
}

const KIND = { dispatch: "salidas", transport: "traslados", reposition: "posiciones", scout: "reconocimientos", warn: "avisos a sitios", call_zone: "rondas de llamadas" } as const;

export function planVersions(cards: DecisionCard[], lastTick: number): Version[] {
  const versions: Version[] = [];
  for (const card of cards) {
    if (!card.plan) continue;
    const open = versions.at(-1);
    if (open && open.plan === card.plan) {
      open.cards.push(card);
      if (card.watch) open.watch = card.watch;
      continue;
    }
    if (open) open.toTick = card.tick;
    versions.push({ index: versions.length, fromTick: card.tick, toTick: lastTick, plan: card.plan, watch: card.watch, agent: card.source === "llm", cards: [card] });
  }
  return versions;
}

export default function PlanView({ cards, tick, lastTick, seconds, onDecision }: { cards: DecisionCard[]; tick: number; lastTick: number; seconds: number; onDecision: (card: DecisionCard) => void }) {
  const versions = planVersions(cards, lastTick).filter((v) => v.fromTick <= tick);
  if (versions.length === 0) return <div className="app-empty"><strong>Todavía no hay ningún plan escrito</strong><p>El coordinador deja su plan en cada decisión. El despachador por reglas sin registro no escribe ninguno.</p></div>;
  const now = versions.at(-1)!;
  return (
    <div className="plan">
      {[...versions].reverse().map((v) => {
        const taken = v.cards.filter((c) => c.tick <= tick);
        const orders = taken.flatMap((c) => c.orders);
        const byKind = Object.entries(KIND).flatMap(([kind, label]) => { const n = orders.filter((o) => o.kind === kind).length; return n ? [`${n} ${label}`] : []; });
        const own = orders.filter((o) => !o.shared).length;
        const good = orders.filter((o) => o.after?.tone === "good").length, bad = orders.filter((o) => o.after?.tone === "bad").length;
        const holds = [...new Map(taken.flatMap((c) => c.holds).map((h) => [h.unitId, h])).values()];
        const current = v === now;
        return (
          <article key={v.index} className={current ? "is-current" : ""}>
            <aside>
              <b>{current ? "Plan vigente" : `Plan ${v.index + 1}`}</b>
              <span>+{elapsed(v.fromTick, seconds)} → {current ? "ahora" : `+${elapsed(v.toTick, seconds)}`}</span>
              <span>{Math.min(tick, v.toTick) - v.fromTick} ticks · {v.agent ? "agente" : "reglas"}</span>
            </aside>
            <div>
              <p className="plan-text">{v.plan}</p>
              {v.watch && <p className="plan-watch"><b>Vigila:</b> {v.watch}</p>}
              {holds.length > 0 && <ul className="plan-holds">{holds.map((h) => <li key={h.unitId}><Lock size={11} /> {h.unitId} solo para {h.onlyFor}, hasta t{h.untilTick} <small>{h.reason}</small></li>)}</ul>}
              <p className="plan-done">Bajo este plan: {taken.length} decisiones · {byKind.join(" · ") || "sin órdenes"}{own ? ` · ${own} por criterio propio` : ""} · <em data-tone="good">{good} salieron bien</em>{bad ? <> · <em data-tone="bad">{bad} mal</em></> : null}</p>
              <ol className="plan-decisions">
                {taken.slice(current ? -8 : -4).reverse().map((c) => (
                  <li key={c.tick}>
                    <button onClick={() => onDecision(c)}>t{c.tick}</button>
                    <span>{c.orders.slice(0, 4).map((o) => o.text).join(" · ")}{c.orders.length > 4 ? ` · +${c.orders.length - 4}` : ""}</span>
                  </li>
                ))}
              </ol>
            </div>
          </article>
        );
      })}
    </div>
  );
}
