import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, CheckCheck, ChevronRight, CircleDot, ClipboardList, Clock3, HelpCircle, Layers, MapPin, MessageSquare, Phone, Search, ShieldAlert, Truck, X } from "lucide-react";
import { elapsed, injuryLabel, priority, sceneLabel, triageLabel, unitKind, unitStatus, victimStatus, type Focus, type IncidentFrame, type RunMeta } from "../engineTrace";
import { duration } from "../situation/model";
import { ticketNextStep, ticketStates, type Ticket, type TicketState, type TicketStep } from "./model";
import "./tickets.css";

export function TicketStatus({ state }: { state: TicketState }) {
  return <span className="ticket-status" data-state={state}>
    {state === "resolved" ? <CheckCheck size={12} /> : state === "progress" ? <CircleDot size={12} /> : <span className="ticket-triage-dot" />}
    {ticketStates[state]}
  </span>;
}

export default function TicketsView({ tickets, selected, onSelect, filter, onFilter, query, onQuery, seconds, tick }: {
  tickets: Ticket[]; selected: string | null; onSelect: (id: string) => void;
  filter: TicketState | "all"; onFilter: (state: TicketState | "all") => void;
  query: string; onQuery: (value: string) => void; seconds: number; tick: number;
}) {
  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
  const search = normalize(query.trim());
  const matches = tickets.filter((t) => (filter === "all" || t.state === filter) &&
    (!search || normalize([t.id, t.title, t.location, ...t.crews.map((u) => u.id), ...t.calls.map((c) => c.text)].join(" ")).includes(search)));
  return <section className="tickets-view" aria-label="Tickets de incidencias">
    <header className="tickets-heading">
      <div><span className="app-eyebrow">CENTRO DE COORDINACIÓN</span><h1>Incidencias <span>{tickets.length}</span></h1>
        <p>Cada aviso, su evolución y las decisiones que lo acompañan.</p></div>
      <span className="tickets-snapshot"><Clock3 size={13} />+{elapsed(tick, seconds)}</span>
    </header>
    <div className="tickets-tools">
      <div className="tickets-filters" aria-label="Filtrar tickets por estado">
        {(["all", "triage", "progress", "resolved"] as const).map((state) => <button key={state}
          aria-pressed={filter === state} onClick={() => onFilter(state)} data-state={state}>
          {state === "all" ? "Todos" : ticketStates[state]}<span>{state === "all" ? tickets.length : tickets.filter((t) => t.state === state).length}</span>
        </button>)}
      </div>
      <label className="tickets-search"><Search size={14} /><input aria-label="Buscar incidencias" placeholder="Buscar incidencia, calle o unidad…" value={query} onChange={(e) => onQuery(e.target.value)} />
        {query && <button aria-label="Borrar búsqueda de incidencias" onClick={() => onQuery("")}><X size={13} /></button>}
      </label>
    </div>
    <div className="tickets-table-scroll">
      {matches.length ? <table className="tickets-table">
        <thead><tr><th scope="col">Incidencia</th><th scope="col">Estado</th><th scope="col">Prioridad</th><th scope="col">Unidades</th><th scope="col">Actualización</th></tr></thead>
        <tbody>{matches.map((ticket) => <tr key={ticket.id} data-ticket={ticket.id} className={selected === ticket.id ? "selected" : ""} onClick={() => onSelect(ticket.id)}>
          <td><button className="ticket-open" aria-label={`Abrir incidencia ${ticket.id}: ${ticket.title}`} aria-pressed={selected === ticket.id} onClick={(e) => { e.stopPropagation(); onSelect(ticket.id); }}>
            <span className="ticket-row-icon"><ClipboardList size={16} /></span>
            <span><span className="ticket-row-title"><code>{ticket.id}</code><strong>{ticket.title}</strong></span><small><MapPin size={11} />{ticket.location}
              <span className="ticket-row-counts"><Phone size={10} />{ticket.incident.callIds.length}{(ticket.incident.foci?.length ?? 0) > 1 && <><Layers size={10} />{ticket.incident.foci.length} focos</>}</span></small></span>
          </button></td>
          <td><TicketStatus state={ticket.state} /></td>
          <td><span className="ticket-priority" data-priority={ticket.incident.priority}><i />P{ticket.incident.priority}<span>{priority[ticket.incident.priority].label}</span></span></td>
          <td><span className={`ticket-crews ${ticket.crews.length ? "" : "empty"}`}>{ticket.crews.length ? <><Truck size={13} />{ticket.crews.map((u) => u.id).join(", ")}</> : "Sin asignar"}</span></td>
          <td><span className="ticket-updated">{tick === ticket.updatedTick ? "Ahora" : `Hace ${duration(tick - ticket.updatedTick, seconds)}`}<ChevronRight size={14} /></span></td>
        </tr>)}</tbody>
      </table> : <div className="tickets-empty"><ClipboardList size={28} /><h2>{tickets.length ? "No hay coincidencias" : "Todavía no hay incidencias"}</h2><p>{tickets.length ? "Prueba otro estado o busca por calle o identificador." : "Los avisos aparecerán al avanzar la ejecución."}</p>
        {(query || filter !== "all") && <button onClick={() => { onQuery(""); onFilter("all"); }}>Limpiar filtros</button>}
      </div>}
    </div>
    <footer className="tickets-footer"><span>{matches.length} de {tickets.length} incidencias</span><span><span className="tickets-live-dot" />Datos del instante seleccionado</span></footer>
  </section>;
}


const focusStates: Record<Focus["status"], string> = { reported: "Sin confirmar", located: "Confirmado · hay gente esperando", cleared: "Atendido", not_found: "Descartado por la dotación" };

/** What is going on at the place: one block per focus, all covered by the same trip. */
function Foci({ incident }: { incident: IncidentFrame }) {
  const foci = incident.foci ?? [];
  if (!foci.length) return null;
  return <section className="ticket-foci" aria-label="Qué pasa en el lugar">
    <h3><Layers size={13} />Qué pasa en el lugar <span>{foci.length}</span></h3>
    {foci.length > 1 && <p className="ticket-section-note">Varias cosas en el mismo sitio: es una sola incidencia porque la misma salida las cubre.</p>}
    {foci.map((focus) => <article key={focus.id} data-status={focus.status}>
      <header><code>{focus.id}</code><strong>{focus.mechanism ? sceneLabel(focus.mechanism.value) : "Sin determinar"}</strong><span>{focusStates[focus.status]}</span></header>
      {focus.victims.length ? <ul>{focus.victims.map((v) => <li key={v.id} data-triage={v.triage}><i /><code>{v.id}</code>{injuryLabel(v.injury)}
        <span>{triageLabel[v.triage]}{v.trapped ? " · atrapada" : ""} · {victimStatus[v.status]}</span></li>)}</ul>
        : <p>{focus.status === "reported" ? `${focus.victimsReported ? `${focus.victimsReported.value} persona(s) según los avisos` : "Número de personas por confirmar"} · ubicación ±${focus.locationErrorM} m` : "Sin personas afectadas."}</p>}
      <small>{focus.callIds.length ? `Avisos: ${focus.callIds.join(", ")}` : "Encontrado por la dotación, sin aviso previo"}</small>
    </article>)}
  </section>;
}

/** What callers have said, with who said it, and what nobody has been able to tell yet. */
function Known({ incident }: { incident: IncidentFrame }) {
  const yesNo = (v: "yes" | "no") => v === "yes" ? "Sí" : "No";
  const rows = [
    ["Consciente", incident.conscious && { ...incident.conscious, value: yesNo(incident.conscious.value) }],
    ["Respira", incident.breathing && { ...incident.breathing, value: { normal: "Con normalidad", difficult: "Con dificultad", none: "No respira" }[incident.breathing.value] }],
    ["Sangra mucho", incident.bleeding && { ...incident.bleeding, value: yesNo(incident.bleeding.value) }],
    ["Atrapada", incident.trapped && { ...incident.trapped, value: yesNo(incident.trapped.value) }],
    ["Edad", incident.ageGroup && { ...incident.ageGroup, value: { child: "Menor", adult: "Adulta", elderly: "Mayor" }[incident.ageGroup.value] }],
    ["Personas", incident.victimsReported && { ...incident.victimsReported, value: String(incident.victimsReported.value) }],
  ] as const;
  const missing = rows.filter(([, fact]) => !fact).map(([label]) => label);
  return <section className="ticket-known" aria-label="Lo que se sabe por los avisos">
    <h3><HelpCircle size={13} />Lo que dicen los avisos</h3>
    <dl>{rows.map(([label, fact]) => fact && <div key={label}><dt>{label}</dt><dd>{fact.value}<small>{fact.from} · +{fact.tick}</small></dd></div>)}</dl>
    {missing.length > 0 && <p className="ticket-section-note">Nadie ha sabido decir: {missing.join(", ").toLowerCase()}.</p>}
  </section>;
}

const stepGroups = { all: "Todo", call: "Avisos", decision: "Decisiones", radio: "Radio", update: "Cambios" } as const;

const stepIcons = { call: Phone, action: Truck, assessment: ClipboardList, update: CircleDot, alert: ShieldAlert, resolved: Check };
function TimelineStep({ step, seconds }: { step: TicketStep; seconds: number }) {
  const Icon = stepIcons[step.kind];
  return <li className="ticket-step" data-kind={step.kind}>
    <span className="ticket-step-icon"><Icon size={13} /></span>
    <div><div className="ticket-step-meta"><span>{step.source}</span><time>+{elapsed(step.tick, seconds)}</time></div>
      <h4>{step.title}{step.focusId && <code className="ticket-step-focus">{step.focusId}</code>}</h4>{step.detail && <p>{step.detail}</p>}
      {step.facts && <ul className="ticket-step-facts">{step.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
      {step.reason && <div className="ticket-reason"><MessageSquare size={12} /><div><strong>Motivo de la decisión</strong><p>{step.reason}</p>
        {step.applies && <p className="ticket-rules"><BookOpen size={11} />Doctrina citada{step.applies.map((rule) => <code key={rule}>{rule}</code>)}</p>}</div></div>}
    </div>
  </li>;
}

export function TicketDetail({ ticket, seconds, tick, onLocate, onClose, runs, runId, onRun, records }: {
  ticket: Ticket | null; seconds: number; tick: number; onLocate: (ticket: Ticket) => void; onClose: () => void;
  runs: RunMeta[]; runId: string; onRun: (id: string) => void; records: number;
}) {
  const panel = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null);
  const [group, setGroup] = useState<keyof typeof stepGroups>("all");
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    if (ticket && window.matchMedia("(max-width: 800px)").matches) panel.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [ticket?.id]);
  const next = ticket ? ticketNextStep(ticket) : null;
  const incident = ticket?.incident;
  return <aside className="app-sidebar ticket-detail" aria-label="Detalle de incidencia" ref={panel}>
    <header className="ticket-detail-top"><span><ClipboardList size={15} />Detalle de incidencia</span>{ticket && <button aria-label="Cerrar detalle de incidencia" onClick={onClose}><X size={16} /></button>}</header>
    <label className="run-picker"><span>Ejecución</span><select aria-label="Seleccionar ejecución" value={runId} onChange={(e) => onRun(e.target.value)}>
      {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString("es-ES")} · {r.id}</option>)}
    </select></label>
    {ticket && incident && next ? <div className="ticket-detail-body" ref={body}>
      <section className="ticket-summary">
        <div className="ticket-summary-meta"><code>{ticket.id}</code><TicketStatus state={ticket.state} /></div>
        <h2>{ticket.title}</h2><p className="ticket-location"><MapPin size={14} />{ticket.location}</p>
        <div className="ticket-progress" aria-label={`Estado del ticket: ${ticketStates[ticket.state]}`}>
          {(["triage", "progress", "resolved"] as const).map((state, n) => <span key={state} className={n <= ["triage", "progress", "resolved"].indexOf(ticket.state) ? "reached" : ""}><i>{state === "resolved" ? <Check size={10} /> : n + 1}</i>{ticketStates[state]}</span>)}
        </div>
        <dl className="ticket-facts"><div><dt>Prioridad actual</dt><dd><span className="ticket-priority" data-priority={incident.priority}><i />P{incident.priority} · {priority[incident.priority].label}</span></dd></div>
          <div><dt>Abierta a las</dt><dd>+{elapsed(incident.openedTick, seconds)}</dd></div>
          <div><dt>Personas afectadas</dt><dd>{incident.located ? `${incident.victims.length} confirmadas` : incident.victimsReported ? `${incident.victimsReported.value} según aviso` : "Por confirmar"}</dd></div>
          <div><dt>Ubicación</dt><dd>{incident.located ? "Confirmada por dotación" : `Aproximada · ±${incident.locationErrorM} m`}</dd></div>
          <div><dt>Avisos recibidos</dt><dd>{incident.callIds.length}</dd></div>
          {incident.splitFrom && <div><dt>Separada de</dt><dd><code>{incident.splitFrom}</code> · otro sitio</dd></div>}
        </dl>
        <button type="button" className="ticket-locate" onClick={() => onLocate(ticket)}><MapPin size={16} aria-hidden="true" />Enfocar en el mapa</button>
        {ticket.lastSeenTick < tick && <small className="ticket-archive-note">Se abrirá el último registro de esta incidencia en el mapa.</small>}
      </section>
      <section className="ticket-next" data-state={ticket.state} aria-label="Seguimiento de la incidencia"><span className="ticket-next-icon">{ticket.state === "resolved" ? <CheckCheck size={16} /> : <Clock3 size={16} />}</span><div><span className="app-eyebrow">{ticket.state === "resolved" ? "CIERRE" : "SEGUIMIENTO"}</span><h3>{next.title}</h3><p>{next.detail}</p><small>Según el estado registrado</small></div></section>
      {ticket.crews.length > 0 && <section className="ticket-assigned"><h3>Unidades vinculadas <span>{ticket.crews.length}</span></h3>{ticket.crews.map((u) => <div key={u.id}><Truck size={14} /><strong>{u.id}</strong><span>{unitKind[u.kind].label}<small>{unitStatus(u)}</small></span></div>)}</section>}
      <Foci incident={incident} />
      {!incident.located && <Known incident={incident} />}
      <section className="ticket-history" aria-label="Cronología de la incidencia"><header><h3>Actividad y decisiones <span>{ticket.steps.length}</span></h3><span>Del primer aviso al último parte{incident.timeline?.length ? " · registrado por el motor" : ""}</span></header>
        {ticket.steps.some((s) => s.group) && <div className="ticket-step-filter" aria-label="Filtrar la cronología">{(Object.keys(stepGroups) as (keyof typeof stepGroups)[]).map((g) =>
          <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{stepGroups[g]}<span>{g === "all" ? ticket.steps.length : ticket.steps.filter((s) => s.group === g).length}</span></button>)}</div>}
        <ol>{ticket.steps.filter((s) => group === "all" || s.group === group).map((step) => <TimelineStep key={step.id} step={step} seconds={seconds} />)}</ol>
      </section>
    </div> : <div className="ticket-detail-empty"><span><ClipboardList size={26} /></span><h2>El contexto de cada incidencia</h2><p>Selecciona un ticket para ver sus actuaciones, las decisiones del coordinador y qué falta por confirmar.</p></div>}
    <div className="app-last-update"><span>{records} registros recibidos</span><span>Solo observación</span></div>
  </aside>;
}
