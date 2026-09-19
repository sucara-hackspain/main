import { useState } from "react";
import { Cpu, MessageCircle, Phone, PhoneOutgoing, Radio, ShieldQuestion, Zap } from "lucide-react";
import { elapsed } from "../engineTrace";
import type { ChannelView, LeadView, Message } from "./model";
import "./signals.css";

const CHANNEL = { red: { label: "red social", Icon: Radio }, whatsapp: { label: "WhatsApp municipal", Icon: MessageCircle }, iot: { label: "sensor", Icon: Cpu } } as const;
const n = (x: number) => x.toLocaleString("es-ES");

function Row({ m, seconds, active, onLead }: { m: Message; seconds: number; active: boolean; onLead: (id: string | null) => void }) {
  const { Icon, label } = CHANNEL[m.channel];
  const state = !m.read ? "unread" : m.relevant ? "relevant" : "noise";
  return (
    <li className={`signal-row is-${state} ${active ? "is-active" : ""}`} onMouseEnter={() => m.leadId && onLead(m.leadId)} onMouseLeave={() => m.leadId && onLead(null)}>
      <Icon size={12} aria-label={label} />
      <p>{m.text}<small>{m.street ?? "sin ubicación"} · +{elapsed(m.tick, seconds)}{m.leadId ? ` · → ${m.leadId}` : !m.read ? " · nadie lo leyó" : ""}</small></p>
    </li>
  );
}

function LeadCard({ lead, seconds, active, onLead }: { lead: LeadView; seconds: number; active: boolean; onLead: (id: string | null) => void }) {
  return (
    <li className={`lead-card ${active ? "is-active" : ""}`} data-tone={lead.outcome.tone} onMouseEnter={() => onLead(lead.id)} onMouseLeave={() => onLead(null)}>
      <header>
        <strong>{lead.id} · {lead.street ?? "ubicación aproximada"}</strong>
        <span className="lead-cred" style={{ "--cred": lead.credibility } as React.CSSProperties}>credibilidad {Math.round(lead.credibility * 100)} %</span>
      </header>
      <p className="lead-summary">«{lead.summary}»</p>
      <ul className="lead-evidence">
        {lead.evidence.map((m) => <li key={m.id}><MessageCircle size={11} /> {CHANNEL[m.channel].label}, +{elapsed(m.tick, seconds)}: «{m.text}»</li>)}
        {lead.registry && <li><ShieldQuestion size={11} /> Teleasistencia, a menos de 90 m: {lead.registry}</li>}
        {lead.dark && <li><Zap size={11} /> Zona sin luz: allí apenas se puede llamar al 112</li>}
        <li><Phone size={11} /> {lead.heardBy112 ? `El 112 ya tenía una llamada de ese sitio (${lead.heardBy112}): la pista lo corrobora` : `Ninguna llamada al 112 desde ese sitio cuando salió la pista (+${elapsed(lead.tick, seconds)})`}</li>
      </ul>
      <footer data-tone={lead.outcome.tone}>{lead.outcome.text}</footer>
    </li>
  );
}

export default function SignalsView({ view, seconds, focus, onFocus }: { view: ChannelView | null; seconds: number; focus: string | null; onFocus: (id: string | null) => void }) {
  if (!view) return <div className="app-empty signals-empty"><Radio size={22} /><strong>Esta ejecución no tiene canal ciudadano</strong><p>Se grabó sin redes ni mensajería: la sala solo oyó el 112, la radio y los drones.</p></div>;
  const [show, setShow] = useState<"all" | "relevant" | "unread">("all");
  const shown = view?.messages.filter((m) => (show === "all" ? true : show === "relevant" ? m.relevant : !m.read)) ?? [];
  const real = view.leads.filter((l) => l.outcome.tone === "good").length;
  const wrong = view.leads.filter((l) => l.outcome.tone === "bad").length;
  return (
    <div className="signals">
      <div className="signals-head">
        <div className="signals-funnel">
          <div><b>{n(view.received)}</b><span>mensajes recibidos</span></div>
          <i>→</i>
          <div><b>{n(view.read)}</b><span>leídos por {view.reader}</span></div>
          <i>→</i>
          <div><b>{n(view.relevant)}</b><span>hablan de alguien en apuros</span></div>
          <i>→</i>
          <div><b>{view.leads.length}</b><span>pistas pasadas a la sala</span></div>
          <i>→</i>
          <div data-tone="good"><b>{real}</b><span>confirmadas{wrong ? ` · ${wrong} falsas` : ""}</span></div>
        </div>
        <p className="signals-room">Una sala con operadores habría alcanzado a leer <b>{n(view.roomWouldHaveRead)}</b> de esos {n(view.received)} mensajes ({Math.round((100 * view.roomWouldHaveRead) / Math.max(1, view.received))} %).</p>
      </div>
      <div className="signals-columns">
        <section aria-label="Lo que llega">
          <h3>Lo que llega <span>en crudo, lo último arriba</span>
            <div className="signals-filter" role="group" aria-label="Filtrar mensajes">
              {([["all", "Todo"], ["relevant", "Alguien en apuros"], ["unread", "Nadie lo leyó"]] as const).map(([key, label]) => <button key={key} aria-pressed={show === key} onClick={() => setShow(key)}>{label}</button>)}
            </div>
          </h3>
          <ul className="signal-list">{shown.map((m) => <Row key={m.id} m={m} seconds={seconds} active={!!m.leadId && m.leadId === focus} onLead={onFocus} />)}</ul>
        </section>
        <section aria-label="Lo que se saca">
          <h3>Lo que se saca <span>pistas con su cadena de evidencia</span></h3>
          {view.leads.length === 0 ? <p className="signals-none">Todavía ninguna pista. Con este lector, lo que no se lee no existe.</p> : <ul className="lead-list">{view.leads.map((l) => <LeadCard key={l.id} lead={l} seconds={seconds} active={focus === l.id} onLead={onFocus} />)}</ul>}
          {view.rounds.length > 0 && <>
            <h3 className="signals-rounds-title"><PhoneOutgoing size={13} /> Llamadas salientes <span>rondas casa por casa a zonas en silencio</span></h3>
            <ul className="round-list">{view.rounds.map((r) => <li key={`${r.zone}:${r.tick}`} data-state={r.found === null ? "calling" : r.found ? "found" : "empty"}><b>{r.zone}</b> +{elapsed(r.tick, seconds)} · {r.found === null ? "llamando…" : r.found ? `${r.found} vecino(s) sabían de alguien en apuros` : "nadie sabía de nadie"}</li>)}</ul>
          </>}
        </section>
      </div>
    </div>
  );
}
