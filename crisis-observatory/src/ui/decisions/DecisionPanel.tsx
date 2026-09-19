import { ChevronLeft, ChevronRight, Eye, Lock, MapPin, Phone, Radio, Route, Scale, Truck } from "lucide-react";
import { elapsed } from "../engineTrace";
import type { DecisionCard, OrderLine } from "./model";
import "./decisions.css";

const ICON = { dispatch: Truck, transport: Route, reposition: MapPin, scout: Eye, warn: Phone } as const;
const SOURCE = { llm: "Agente", fallback: "Respaldo por reglas", rules: "Reglas" } as const;

function Order({ order, focused, onFocus }: { order: OrderLine; focused: boolean; onFocus: (key: string | null) => void }) {
  const Icon = ICON[order.kind];
  return (
    <li className={`decision-order ${focused ? "is-focused" : ""} ${order.shared ? "" : "is-own"}`} onMouseEnter={() => onFocus(order.key)} onMouseLeave={() => onFocus(null)}>
      <Icon size={14} aria-hidden />
      <div>
        <strong>{order.text}{order.etaTicks ? <span> · ETA {order.etaTicks}</span> : null}</strong>
        {order.reason && <p>{order.reason}</p>}
        <div className="decision-order-meta">
          {order.applies.map((id) => <code key={id}>{id}</code>)}
          {!order.shared && <em>decisión propia: las reglas no lo habrían hecho</em>}
        </div>
        {order.after && <small data-tone={order.after.tone}>Después: {order.after.text}</small>}
      </div>
    </li>
  );
}

export default function DecisionPanel({ cards, card, seconds, focus, onFocus, onGo }: {
  cards: DecisionCard[];
  card: DecisionCard | null;
  seconds: number;
  focus: string | null;
  onFocus: (key: string | null) => void;
  onGo: (card: DecisionCard) => void;
}) {
  if (!card) return <aside className="app-sidebar decision-panel"><p className="decision-empty">Esta ejecución no tiene decisiones registradas.</p></aside>;
  const previous = cards[card.index - 1], next = cards[card.index + 1];
  return (
    <aside className="app-sidebar decision-panel" aria-label="Ficha de decisión">
      <header>
        <div>
          <span className="app-eyebrow">DECISIÓN {card.index + 1} DE {cards.length}</span>
          <h2>+{elapsed(card.tick, seconds)} <span>tick {card.tick} · {SOURCE[card.source]}{card.ms ? ` · ${(card.ms / 1000).toFixed(1)} s` : ""}</span></h2>
        </div>
        <nav>
          <button aria-label="Decisión anterior" disabled={!previous} onClick={() => previous && onGo(previous)}><ChevronLeft size={15} /></button>
          <button aria-label="Decisión siguiente" disabled={!next} onClick={() => next && onGo(next)}><ChevronRight size={15} /></button>
        </nav>
      </header>

      <section>
        <h3><Radio size={13} /> Vio</h3>
        {card.saw.length ? <ul className="decision-saw">{card.saw.map((line, n) => <li key={n} className={n === 0 ? "is-summary" : ""}>{line}</li>)}</ul> : <p className="decision-muted">{card.situation || "Sin resumen de lo que tenía delante."}</p>}
      </section>

      {(card.plan || card.watch || (card.situation && card.saw.length > 0 && card.situation !== card.saw[0])) && <section>
        <h3><Scale size={13} /> Pensó</h3>
        {card.situation && card.situation !== card.saw[0] && <p className="decision-situation">{card.situation}</p>}
        {card.plan && <blockquote>{card.plan}</blockquote>}
        {card.watch && <p className="decision-watch"><b>Vigila:</b> {card.watch}</p>}
      </section>}

      <section>
        <h3><Truck size={13} /> Ordenó <span>{card.orders.length}</span></h3>
        <ul className="decision-orders">{card.orders.map((o) => <Order key={o.key} order={o} focused={focus === o.key} onFocus={onFocus} />)}</ul>
        {card.holds.length > 0 && <ul className="decision-holds">{card.holds.map((h) => <li key={h.unitId}><Lock size={12} /> <b>{h.unitId}</b> reservada solo para {h.onlyFor} hasta el tick {h.untilTick}<small>{h.reason}</small></li>)}</ul>}
      </section>

      {card.compared && <section>
        <h3><Scale size={13} /> Distinto de las reglas</h3>
        {card.rulesOnly.length === 0 && card.orders.every((o) => o.shared)
          ? <p className="decision-muted">Nada: el despachador por reglas habría ordenado lo mismo con este parte.</p>
          : <>
            {card.orders.some((o) => !o.shared) && <p className="decision-diff">Hizo por su cuenta: {card.orders.filter((o) => !o.shared).map((o) => o.text).join(" · ")}</p>}
            {card.rulesOnly.length > 0 && <p className="decision-diff is-rules">Las reglas habrían hecho, y no hizo: {card.rulesOnly.map((o) => o.text).join(" · ")}</p>}
          </>}
      </section>}
    </aside>
  );
}

export function DecisionStrip({ cards, active, onGo }: { cards: DecisionCard[]; active: DecisionCard | null; onGo: (card: DecisionCard) => void }) {
  return (
    <div className="decision-strip" role="tablist" aria-label="Decisiones de la ejecución">
      {cards.map((c) => {
        const own = c.compared && (c.rulesOnly.length > 0 || c.orders.some((o) => !o.shared));
        const bad = c.orders.some((o) => o.after?.tone === "bad");
        return (
          <button key={c.tick} role="tab" aria-selected={active?.tick === c.tick} className={`${own ? "is-own" : ""} ${bad ? "is-bad" : ""}`} onClick={() => onGo(c)} title={c.situation}>
            <b>t{c.tick}</b><span>{c.orders.length}</span>
          </button>
        );
      })}
    </div>
  );
}
