import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Clock3, Hospital, Search, Truck, Waves, Wrench, X } from "lucide-react";
import type { RunMeta, Selection } from "../engineTrace";
import { unitIcon } from "../map/unitIcons";
import { duration, entityKey, sameEntity, snapshotTime, type Situation, type SituationFilter, type Tone } from "./model";
import "./situation.css";

type Props = {
  id: string;
  runs: RunMeta[];
  onRun: (id: string) => void;
  situation: Situation | null;
  selection: Selection | null;
  onSelect: (ref: Selection | null) => void;
  related: Set<string>;
  matches: Set<string>;
  filter: SituationFilter;
  onFilter: (filter: SituationFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  showClosed: boolean;
  onShowClosed: () => void;
  historical: boolean;
  following: boolean;
  running: boolean;
  records: number;
  error: boolean;

};

function EntityRow({ entity, selection, related, onSelect, icon, title, detail, end, tone = "neutral", compact, children }: {
  entity: Selection; selection: Selection | null; related: Set<string>; onSelect: Props["onSelect"];
  icon: ReactNode; title: string; detail?: string; end?: ReactNode; tone?: Tone;
  /** One line: the detail follows the title and is cut when it does not fit. */
  compact?: boolean; children?: ReactNode;
}) {
  const selected = sameEntity(selection, entity);
  return <button
    className={`situation-row ${compact ? "compact" : ""} ${selected ? "selected" : related.has(entityKey(entity)) ? "related" : ""}`}
    data-entity={entityKey(entity)} data-tone={tone} aria-pressed={selected}
    title={compact ? `${entity.id} · ${title}${detail ? ` · ${detail}` : ""}` : undefined}
    onClick={() => onSelect(selected ? null : entity)}
  >
    <span className="situation-entity-icon">{icon}</span>
    <span className="situation-row-content">
      <span className="situation-row-title"><strong>{entity.id}</strong><span>{title}</span>{end}</span>
      {detail && <small>{detail}</small>}
      {children}
    </span>
    <ChevronRight size={13} className="situation-row-chevron" />
  </button>;
}

/** A section that folds to one line with its summary; open, its list scrolls within a maximum height. */
function Collapsible({ id, label, count, summary, tone = "neutral", open, onToggle, children }: {
  id: string; label: string; count: number; summary: string; tone?: Tone; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return <section className={`situation-section situation-collapsible ${open ? "open" : ""}`} aria-label={label}>
    <h3 className="situation-collapsible-heading">
      <button aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <ChevronRight size={13} className="situation-collapsible-chevron" />
        <span>{label} <span>{count}</span></span>
        <small data-tone={tone}>{summary}</small>
      </button>
    </h3>
    {open && <div id={id} className="situation-collapsible-list">{children}</div>}
  </section>;
}

const UnitIcon = ({ kind }: { kind: keyof typeof unitIcon }) =>
  <span className="situation-unit-icon" dangerouslySetInnerHTML={{ __html: unitIcon[kind] }} />;

export default function SituationSidebar(props: Props) {
  const { id, runs, onRun, situation: s, selection, onSelect, related, matches, filter, onFilter, query, onQuery, showClosed, onShowClosed, historical, following, running, records, error } = props;
  const scroll = useRef<HTMLDivElement>(null);
  const selectedKey = selection && entityKey(selection);
  // Units and hospitals fold away: the incidents come first. A filter or a search opens what it finds.
  const [folded, setFolded] = useState({ units: true, hospitals: true });
  // The detail opens on the map; here the selected row comes into view, where it is.
  useEffect(() => {
    if (!selectedKey || !scroll.current) return;
    const row = scroll.current.querySelector<HTMLElement>(`[data-entity="${selectedKey}"]`);
    if (row && getComputedStyle(scroll.current).overflowY !== "visible") row.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selectedKey]);
  const visible = (ref: Selection) => matches.has(entityKey(ref));
  const filtered = filter !== "all" || !!query.trim();
  const incidents = s?.incidents.filter((i) => visible(i.ref)) ?? [];
  const units = s?.units.filter((u) => visible(u.ref)) ?? [];
  const hospitals = s?.hospitals.filter((h) => visible(h.ref)) ?? [];
  const closed = s ? s.incidents.length - s.open.length : 0;
  const full = s ? s.hospitals.filter((h) => h.free === 0).length : 0;
  const rowProps = { selection, related, onSelect };
  return <aside className="app-sidebar situation-sidebar" aria-label="Estado de la situación">
    <div className="situation-fixed">
      <div className="situation-heading"><div><span className="app-eyebrow">PANORAMA OPERATIVO</span><h2>Estado de la situación</h2></div><span className="situation-clock">{s ? snapshotTime(s) : "—"}</span></div>
      <label className="run-picker"><span>Ejecución</span><select aria-label="Seleccionar ejecución" value={id} onChange={(e) => onRun(e.target.value)}>
        {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString("es-ES")} · {r.id}</option>)}
      </select></label>
      <div className={`situation-time-state ${historical ? "historical" : ""}`}><Clock3 size={12} />{!s ? "Esperando datos" : historical ? "Revisando el pasado" : running ? following ? "Siguiendo la ejecución" : "Último registro recibido" : "Estado final de la ejecución"}</div>
      {s ? <div className="situation-overview">
        <p><strong>{s.open.length} {s.open.length === 1 ? "incidente abierto" : "incidentes abiertos"}</strong>
          <span className={s.unattended ? "situation-warning" : ""}> · {s.unattended} sin unidad</span>
          {s.isolated > 0 && <span className="situation-danger"> · {s.isolated} {s.isolated === 1 ? "aislado" : "aislados"} por el agua</span>}</p>
        <div className="situation-metrics">
          <div><Truck size={14} /><strong data-testid="available-units">{s.available}<small>/{s.units.length}</small></strong><span>Disponibles</span></div>
          <div><Hospital size={14} /><strong>{s.hospitals.reduce((n, h) => n + h.free, 0)}</strong><span>Camas libres</span></div>
          <div data-tone={s.broken ? "danger" : "neutral"}><Wrench size={14} /><strong>{s.broken}</strong><span>Averiadas</span></div>
        </div>
        <section className="situation-balance" aria-label="Balance de la ejecución">
          <p><span className="app-eyebrow">BALANCE DE LA EJECUCIÓN</span><small>Acumulado hasta {snapshotTime(s)}</small></p>
          <div>
            <span><strong data-testid="saved-count">{s.saved}</strong>Salvadas</span>
            <span data-tone={s.dead ? "danger" : "neutral"}><strong>{s.dead}</strong>Fallecidas</span>
            <span><strong>{s.inWater}</strong>Alcanzadas por el agua</span>
          </div>
        </section>
      </div> : <p className="situation-loading">El panorama aparecerá con el primer registro.</p>}
    </div>
    {s && <div className="situation-body" ref={scroll}>
      {/* Right under the balance: where the water is, as far as the coordinator knows, before any list. */}
      <section className="situation-section situation-water" aria-label="Agua y cortes"><div className="situation-section-heading"><h3>Agua y cortes</h3><small>Lo que sabe el coordinador</small></div>
        {s.water.zones.length ? s.water.zones.map((z) => <p key={z.id}><Waves size={13} /><span><strong>{z.name}</strong> · radio {z.radiusM} m<small>Mapa oficial de hace {duration(z.ageTicks, s.seconds)}</small></span></p>) : <p className="situation-empty">Ningún mapa oficial de inundación todavía.</p>}
        <dl>
          <dt>Avisos de agua</dt><dd>{s.water.sightings}{s.water.blocked > 0 && ` · ${s.water.blocked} con paso cortado`}</dd>
          <dt>Tramos cortados</dt><dd>{s.water.closed}{s.water.streets > 0 && ` en ${s.water.streets} ${s.water.streets === 1 ? "calle" : "calles"}`}</dd>
          <dt>Realidad (supervisión)</dt><dd>{s.water.real} tramos cortados · {s.water.unreported} sin comunicar</dd>
        </dl>
      </section>
      <div className="situation-explore">
        <label className="situation-search"><Search size={13} /><input aria-label="Buscar entidades" placeholder="Buscar incidente, unidad, hospital…" value={query} onChange={(e) => onQuery(e.target.value)} />{query && <button aria-label="Borrar búsqueda" onClick={() => onQuery("")}><X size={12} /></button>}</label>
        <div className="situation-filters" aria-label="Filtros de situación">
          {([
            ["all", "Todos", null], ["unattended", "Sin unidad", s.unattended], ["isolated", "Aislados", s.isolated],
            ["broken", "Averiadas", s.broken], ["full", "Sin camas", s.hospitals.filter((h) => h.free === 0).length],
          ] as const).map(([key, label, count]) => <button key={key} aria-pressed={filter === key} onClick={() => onFilter(key)}>{label}{count !== null && <span>{count}</span>}</button>)}
        </div>
        {filtered && <p className="situation-filter-note">{matches.size} resultados · resaltados en el mapa<button onClick={() => { onFilter("all"); onQuery(""); }}>Limpiar</button></p>}
      </div>
      {(incidents.length > 0 || !filtered) && <section className="situation-section" aria-label="Incidentes"><div className="situation-section-heading"><h3>Incidentes <span>{s.open.length} abiertos</span></h3>{closed > 0 && <button aria-expanded={showClosed} onClick={onShowClosed}>{showClosed ? "Ocultar cerrados" : `Cerrados recientes (${closed})`}</button>}</div>
        {incidents.length ? incidents.map((i) => <EntityRow key={i.id} {...rowProps} entity={i.ref} icon={<b className={`situation-priority p${i.priority}`}>P{i.priority}</b>} title={i.label} detail={i.detail} tone={i.tone} end={i.unattended && i.wait !== null ? <em>{duration(i.wait, s.seconds)}</em> : undefined} />) : <p className="situation-empty">No hay incidentes abiertos en este instante.</p>}
      </section>}
      {units.length > 0 && <Collapsible id="situation-units" label="Unidades" count={units.length}
        summary={`${s.available} disponibles · ${s.units.length - s.available - s.broken} ocupadas${s.broken ? ` · ${s.broken} ${s.broken === 1 ? "averiada" : "averiadas"}` : ""}`}
        tone={s.broken ? "danger" : "neutral"}
        open={!folded.units || filtered} onToggle={() => setFolded({ ...folded, units: !folded.units })}>
        {units.map((u) => <EntityRow key={u.id} {...rowProps} compact entity={u.ref} icon={u.broken ? <Wrench size={14} /> : <UnitIcon kind={u.kind} />} title={`${u.kindLabel} · ${u.label}`} detail={u.detail} tone={u.tone} />)}
      </Collapsible>}
      {hospitals.length > 0 && <Collapsible id="situation-hospitals" label="Hospitales" count={hospitals.length}
        summary={`${s.hospitals.reduce((n, h) => n + h.free, 0)} camas libres · ${s.hospitals.reduce((n, h) => n + h.incoming.length, 0)} traslados en camino${full ? ` · ${full} sin camas` : ""}`}
        tone={full ? "warning" : "neutral"}
        open={!folded.hospitals || filtered} onToggle={() => setFolded({ ...folded, hospitals: !folded.hospitals })}>
        {hospitals.map((h) => <EntityRow key={h.id} {...rowProps} entity={h.ref} icon={<Hospital size={14} />} title={h.name}
          end={h.helipad ? <em className="situation-helipad" title="Con helipuerto">H</em> : undefined}
          tone={h.margin < 0 ? "danger" : h.free === 0 ? "warning" : "neutral"}>
          <span className="situation-capacity-line">
            <span className="situation-capacity" role="img" aria-label={`${h.occupied} camas ocupadas de ${h.capacity}; ${h.incoming.length} traslados en camino; margen previsto ${h.margin}`}>
              <span className="situation-capacity-used" style={{ width: `${Math.min(100, h.capacity ? h.occupied / h.capacity * 100 : 0)}%` }} />
              <span className="situation-capacity-incoming" style={{ width: `${Math.min(h.free, h.incoming.length) / Math.max(1, h.capacity) * 100}%` }} />
            </span>
            <span className={h.margin < 0 ? "danger" : ""}>{h.free}/{h.capacity} libres · {h.incoming.length} en camino · margen {h.margin}</span>
          </span>
        </EntityRow>)}
      </Collapsible>}
      {!filtered && (s.sites.length > 0 || s.gauges.length > 0) && <section className="situation-section situation-water" aria-label="Anticipación"><div className="situation-section-heading"><h3>Anticipación <span>{s.sites.filter((x) => x.floodedTick === null && x.safe < x.people).length} sitios con gente dentro</span></h3><small>Aforos y registro municipal</small></div>
        {s.gauges.map((g) => <p key={g.name}><Waves size={13} /><span><strong>Aforo · {g.name}</strong> · cauce al {Math.round(g.level * 100)} %<small>{g.overflowTick > s.tick ? `Desborda en ~${g.overflowTick - s.tick} ticks` : `Desbordado hace ${s.tick - g.overflowTick} ticks`}</small></span></p>)}
        <dl>
          {s.sites.map((x) => <Fragment key={x.id}><dt>{x.id} · {x.name}</dt><dd>{x.floodedTick !== null ? (x.caught ? `${x.caught} atrapados dentro` : "todos a salvo") : `${x.safe}/${x.people} a salvo · ${x.warnedTick === null ? "SIN AVISAR" : "avisados"}${x.arrivalTicks !== null && x.safe < x.people ? ` · agua en ~${x.arrivalTicks} ticks` : ""}`}</dd></Fragment>)}
        </dl>
      </section>}
      {filtered && matches.size === 0 && <div className="situation-no-results"><Search size={20} /><strong>No hay coincidencias</strong><p>Prueba otro filtro o busca por identificador.</p></div>}
    </div>}
    <div className="app-last-update"><span>{error ? "Conexión interrumpida" : `${records} registros recibidos`}</span><span>Solo observación</span></div>
  </aside>;
}
