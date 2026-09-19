import { lazy, Suspense, useMemo, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, CircleHelp, Clock3, Layers, MapPin, Radio, Search, ShieldAlert, SlidersHorizontal, Truck, Waves, X } from "lucide-react";
import { elapsed, type GraphData, type RunMeta, type TickRecord } from "../engineTrace";
import { duration, type Situation } from "../situation/model";
import { type Pending } from "../interventions/model";
import type { Ticket } from "../tickets/model";
import { buildOperations, number, type Queue, type Sector } from "./model";
import { SCALE_ID } from "./demo";
import "./operations.css";

const OperationsMap = lazy(() => import("./OperationsMap"));
const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export default function OperationsView({ graph, meta, record, records, tickets, situation, pending, sectorId, onSector, onTicket, onQueue, onDecision, runs, onRun, received }: {
  graph: GraphData; meta: RunMeta; record: TickRecord; records: TickRecord[]; tickets: Ticket[]; situation: Situation;
  pending: Pending[]; sectorId: string | null; onSector: (id: string | null) => void;
  onTicket: (id: string, sector: Sector | null) => void; onQueue: (sector: Sector | null, queue: Queue) => void;
  onDecision: (id: string) => void; runs: RunMeta[]; onRun: (id: string) => void; received: number;
}) {
  const operations = useMemo(() => buildOperations(tickets, record, records, graph, situation), [tickets, record, records, graph, situation]);
  const [query, setQuery] = useState(""), [onlyAttention, setOnlyAttention] = useState(false);
  const [sources, setSources] = useState(false);
  const sector = operations.sectors.find((s) => s.id === sectorId) ?? null;
  const scope = sector ?? operations;
  const scopedTickets = sector?.tickets ?? tickets;
  const sectors = operations.sectors.filter((s) => normalize(s.name).includes(normalize(query)) && (!onlyAttention || s.critical || s.blocked || s.gaps || s.stale))
    .sort((a, b) => b.critical - a.critical || b.blocked - a.blocked || b.open - a.open || a.id.localeCompare(b.id));
  const incidentIds = new Set(scopedTickets.map((t) => t.id));
  const decisions = pending.filter((p) => !sector || !p.item.incidentId || incidentIds.has(p.item.incidentId));
  const unitGroups = [{ name: "Disponibles", count: situation.available, className: "available" },
    { name: "Con actividad", count: situation.units.filter((u) => !u.available && !u.broken && !u.stranded).length, className: "busy" },
    { name: "Bloqueadas / averiadas", count: situation.units.filter((u) => u.broken || u.stranded).length, className: "blocked" }];
  const simulated = meta.id === SCALE_ID;
  function select(id: string | null) { onSector(id); }
  return <section className="operations-view" aria-label="Panorama operativo">
    <header className="ops-heading">
      <div><div className="ops-eyebrow"><span className="ops-live-dot" />CENTRO DE COORDINACIÓN <span>/</span> VALÈNCIA</div>
        <h1>Panorama operativo<span className="ops-beta">{simulated ? "Escenario de escala" : "Operaciones"}</span></h1>
        <p>{simulated ? "Datos simulados · 2.400 incidencias y 12.000 llamadas para explorar el sistema." : "La situación del territorio, la respuesta en curso y lo que requiere atención."}</p></div>
      <div className="ops-run"><label htmlFor="ops-run-picker">{simulated ? "SIMULACIÓN" : "EJECUCIÓN"}</label>
        <select id="ops-run-picker" aria-label="Seleccionar ejecución" value={meta.id} onChange={(e) => onRun(e.target.value)}>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.id === SCALE_ID ? "Escenario de escala · 2.400 casos" : `${new Date(r.startedAt).toLocaleString("es-ES")} · ${r.coordinator}`}</option>)}
        </select><span><Clock3 size={11} />+{elapsed(record.tick, situation.seconds)} · <span>{received} registros recibidos</span></span></div>
    </header>
    <div className="ops-metrics" aria-label="Indicadores del territorio">
      <button onClick={() => onQueue(null, "all")}><span>Incidencias abiertas<Layers size={14} /></span><strong data-testid="ops-open">{number(operations.open)}</strong><small>{number(tickets.length - operations.open)} cerradas en el historial<ArrowRight size={12} /></small></button>
      <button className={operations.critical ? "needs-attention" : ""} onClick={() => onQueue(null, "critical")}><span>Urgentes sin atención<ShieldAlert size={14} /></span><strong data-testid="ops-critical">{number(operations.critical)}</strong><small>Prioridad P0 y P1<ArrowRight size={12} /></small></button>
      <div><span>Unidades disponibles<Truck size={14} /></span><strong>{number(situation.available)}<em> / {number(situation.units.length)}</em></strong><small>Según actividad y ocupación</small></div>
      <button onClick={() => setSources(!sources)} aria-expanded={sources}><span>Llamadas recibidas<Radio size={14} /></span><strong data-testid="ops-calls">{number(operations.calls)}</strong><small>Acumuladas hasta este instante<ArrowRight size={12} /></small></button>
    </div>
    <div className="ops-grid">
      <aside className="ops-sectors" aria-label="Situaciones por sector">
        <div className="ops-section-heading"><div><h2>Situaciones <span>{sectors.length}</span></h2><p>Agrupadas por sector territorial</p></div><Layers size={16} /></div>
        <div className="ops-sector-tools"><label><Search size={14} /><input aria-label="Buscar sector" placeholder="Buscar sector…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <button aria-label="Mostrar sectores que requieren atención" title="Sectores que requieren atención" aria-pressed={onlyAttention} onClick={() => setOnlyAttention(!onlyAttention)}><SlidersHorizontal size={14} /></button></div>
        <div className="ops-sector-list">
          {sectors.map((s) => <button className={`ops-sector${sectorId === s.id ? " selected" : ""}`} key={s.id} aria-pressed={sectorId === s.id} aria-label={`Abrir sector ${s.name}`} onClick={() => select(sectorId === s.id ? null : s.id)}>
            <span className="ops-sector-top"><span><i className={s.critical ? "critical" : s.open ? "active" : "quiet"} />SECTOR {s.id.split("-")[1].padStart(2, "0")}</span><ChevronRight size={14} /></span>
            <strong>{s.name}</strong><span className="ops-sector-count"><b>{number(s.open)}</b> incidencias abiertas</span>
            <span className="ops-sector-meta">{s.critical ? <span className="ops-critical-label">{number(s.critical)} urgentes sin atención</span> : <span>{s.open ? "Sin urgencias pendientes" : "Sin incidencias registradas"}</span>}</span>
            <span className="ops-sector-bottom"><span>{s.delta === null ? <><Clock3 size={11} />Sin comparación</> : s.delta > 0 ? <><ArrowUpRight size={12} />Carga +{number(s.delta)}</> : s.delta < 0 ? <><ArrowDownRight size={12} />Carga {number(s.delta)}</> : <>Carga sin cambios</>}</span><span><Truck size={11} />{s.available}/{s.units}</span></span>
            {(s.gaps > 0 || s.stale > 0) && <span className="ops-sector-gap"><CircleHelp size={11} />Información pendiente de actualizar</span>}
          </button>)}
          {!sectors.length && <div className="ops-empty">No hay sectores con estos filtros.<button onClick={() => { setQuery(""); setOnlyAttention(false); }}>Limpiar filtros</button></div>}
        </div>
        <div className="ops-sector-foot"><CircleHelp size={13} /><span>Los sectores conservan cada incidencia. Carga comparada con hace {operations.windowMinutes} min; unidades según su posición.</span></div>
      </aside>
      <div className="ops-center">
        <div className="ops-map-breadcrumb"><button onClick={() => select(null)}><MapPin size={13} />Territorio completo</button>{sector && <><ChevronRight size={12} /><strong>{sector.name}</strong><button className="ops-clear-sector" aria-label="Cerrar sector" onClick={() => select(null)}><X size={13} /></button></>}<span>{sector ? `${number(sector.open)} abiertas` : `${operations.sectors.length} sectores`}</span>{sector && <button className="ops-open-cases" onClick={() => onQueue(sector, "all")}>Ver incidencias<ArrowRight size={13} /></button>}</div>
        <Suspense fallback={<div className="ops-map ops-loading">Preparando el territorio…</div>}>
          <OperationsMap graph={graph} sectors={operations.sectors} selected={sector?.id ?? null} onSector={select} onTicket={(id) => onTicket(id, sector)} />
        </Suspense>
      </div>
      <aside className="ops-attention" aria-label="Atención y capacidad">
        <div className="ops-section-heading"><div><h2>Requiere atención</h2><p>{sector ? `Sector ${sector.name}` : "Todo el territorio"}</p></div><span className="ops-attention-icon"><ShieldAlert size={16} /></span></div>
        <div className="ops-attention-queues">{([
          { key: "critical" as const, count: scope.critical, label: "Urgentes sin atención", description: "P0 / P1 · revisar respuesta", Icon: ShieldAlert },
          { key: "blocked" as const, count: scope.blocked, label: "Acceso comprometido", description: "Incidencias aisladas o equipos bloqueados", Icon: Waves },
          { key: "unconfirmed" as const, count: scope.unconfirmed, label: "Pendientes de confirmar", description: "Ubicación por verificar", Icon: CircleHelp },
        ]).map(({ key, count, label, description, Icon }) => <button key={key} onClick={() => onQueue(sector, key)}><Icon size={15} /><span><strong>{label}</strong><small>{description}</small></span><b>{number(count)}</b><ChevronRight size={12} /></button>)}</div>
        <section className="ops-decisions"><h3>Decisiones pendientes <span>{decisions.length}</span></h3>
          {decisions.slice(0, 3).map(({ item, prescription }) => <button key={item.id} onClick={() => onDecision(item.id)}><span className="ops-decision-dot" /><span><strong>{item.title}</strong><small>{prescription.summary}</small></span><ArrowUpRight size={13} /></button>)}
          {!decisions.length && <p>{simulated ? "La demo permite explorar los casos y su evidencia. Las decisiones se consultan en las ejecuciones del motor." : "Sin decisiones pendientes en este ámbito."}</p>}
          {decisions.length > 3 && <small>{number(decisions.length - 3)} más en Intervenciones</small>}
        </section>
        <section className="ops-capacity"><h3>Capacidad del territorio <Truck size={14} /></h3><div className="ops-capacity-bar" role="img" aria-label={unitGroups.map((g) => `${g.count} ${g.name}`).join(", ")}>{unitGroups.map((g) => <span className={g.className} key={g.name} style={{ flex: g.count }} />)}</div>
          {unitGroups.map((g) => <div className="ops-capacity-row" key={g.name}><span><i className={g.className} />{g.name}</span><strong>{number(g.count)}</strong></div>)}
        </section>
        <section className="ops-sources"><button className="ops-source-toggle" onClick={() => setSources(!sources)} aria-expanded={sources}><h3>Fuentes de información</h3><ChevronRight size={14} className={sources ? "expanded" : ""} /></button>
          <div className="ops-source-row"><span><i className="available" />Llamadas 112</span><b>{number(operations.calls)}</b></div>
          <div className="ops-source-row"><span><i className="available" />Partes operativos</span><b>{number(operations.radio)}</b></div>
          <div className="ops-source-row"><span><i className={record.frame.knownWater.zones.some((z) => z.ageTicks * situation.seconds >= 600) ? "stale" : "available"} />Observaciones de agua</span><b>{record.frame.knownWater.zones.length}</b></div>
          {sources && <div className="ops-source-detail"><p>Última llamada: {operations.lastCall === null ? "sin registros" : `hace ${duration(record.tick - operations.lastCall, situation.seconds)}`}.</p><p>Último parte: {operations.lastRadio === null ? "sin registros" : `hace ${duration(record.tick - operations.lastRadio, situation.seconds)}`}.</p><p>El agua se marca para revisión cuando la observación tiene 10 minutos o más.</p></div>}
          <div className="ops-source-row disconnected"><span><i />Radar meteorológico</span><small>Sin conectar</small></div>
          <div className="ops-source-row disconnected"><span><i />Redes sociales</span><small>Sin conectar</small></div>
          <small className="ops-source-note">{simulated ? "Todos los registros de este escenario son simulados." : "Solo información recibida hasta el instante seleccionado."}</small>
        </section>
      </aside>
    </div>
  </section>;
}
