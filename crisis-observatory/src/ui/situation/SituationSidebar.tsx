import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, Clock3, Hospital, LocateFixed, MapPin, Search, Truck, Users, Wrench, X } from "lucide-react";
import type { RunMeta } from "../runModel";
import { duration, entityKey, sameEntity, snapshotTime, type EntityRef, type Situation, type SituationFilter, type Tone } from "./model";
import "./situation.css";

type Props = {
  id: string;
  runs: RunMeta[];
  onRun: (id: string) => void;
  situation: Situation | null;
  selection: EntityRef | null;
  onSelect: (ref: EntityRef | null) => void;
  onLocate: () => void;
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

function EntityRow({ entity, selection, related, onSelect, icon, title, detail, end, tone = "neutral", children }: {
  entity: EntityRef; selection: EntityRef | null; related: Set<string>; onSelect: Props["onSelect"];
  icon: ReactNode; title: string; detail: string; end?: ReactNode; tone?: Tone; children?: ReactNode;
}) {
  const selected = sameEntity(selection, entity);
  return <button
    className={`situation-row ${selected ? "selected" : related.has(entityKey(entity)) ? "related" : ""}`}
    data-entity={entityKey(entity)} data-tone={tone} aria-pressed={selected}
    onClick={() => onSelect(selected ? null : entity)}
  >
    <span className="situation-entity-icon">{icon}</span>
    <span className="situation-row-content">
      <span className="situation-row-title"><strong>{entity.kind === "road" ? "" : entity.id}</strong><span>{title}</span>{end}</span>
      <small>{detail}</small>
      {children}
    </span>
    <ChevronRight size={13} className="situation-row-chevron" />
  </button>;
}

function Inspector({ s, selection, onSelect, onLocate }: { s: Situation; selection: EntityRef; onSelect: Props["onSelect"]; onLocate: () => void }) {
  const patient = selection.kind === "patient" ? s.cases.find((p) => p.id === selection.id) : undefined;
  const unit = selection.kind === "ambulance" ? s.units.find((a) => a.id === selection.id) : patient?.unit;
  const hospital = selection.kind === "hospital" ? s.hospitals.find((h) => h.id === selection.id) : undefined;
  const road = selection.kind === "road" ? s.roads.find((r) => r.id === selection.id) : undefined;
  const links: { ref: EntityRef; label: string }[] = [];
  if (patient?.unit) links.push({ ref: patient.unit.ref, label: `${patient.unit.id} · ${patient.unit.label}` });
  if (patient?.hospitalId) links.push({ ref: { kind: "hospital", id: patient.hospitalId }, label: `${patient.hospitalId} · Hospital` });
  if (selection.kind === "ambulance" && unit) {
    const p = unit.patientId || unit.targetPatientId;
    if (p) links.push({ ref: { kind: "patient", id: p }, label: `${p} · Caso vinculado` });
    if (unit.hospitalId) links.push({ ref: { kind: "hospital", id: unit.hospitalId }, label: `${unit.hospitalId} · Destino` });
  }
  if (hospital) for (const a of hospital.incoming) links.push({ ref: a.ref, label: `${a.id} · ${a.patientId}${a.broken || a.stranded ? " · detenido" : ""}` });
  if (road) for (const a of road.units) links.push({ ref: a.ref, label: `${a.id} · Recorrido por este tramo` });
  const affectedRoads = unit ? s.roads.filter((r) => r.units.some((a) => a.id === unit.id)) : [];
  for (const r of affectedRoads) links.push({ ref: r.ref, label: `${r.name} · Corte en el recorrido` });
  if (!patient && !unit && !hospital && !road) return null;
  return <section className="situation-inspector" aria-label="Detalle de la selección">
    <div className="situation-inspector-heading">
      <span className="app-eyebrow">{patient ? "CASO SELECCIONADO" : unit ? "AMBULANCIA SELECCIONADA" : hospital ? "HOSPITAL SELECCIONADO" : "CORTE SELECCIONADO"}</span>
      <button aria-label="Cerrar detalle" onClick={() => onSelect(null)}><X size={14} /></button>
    </div>
    <h3>{road ? road.name : selection.id}<span>{patient?.label || unit?.label || hospital?.name}</span></h3>
    {(patient || unit) && <p>{patient?.detail || unit?.detail}</p>}
    <dl>
      {patient?.wait != null && <><dt>{patient.status === "waiting" ? "Lleva esperando" : patient.pickedUp ? "Espera hasta recogida" : "Tiempo de espera"}</dt><dd>{duration(patient.wait, s.seconds)}</dd></>}
      {patient?.active && <><dt>Tiempo vital restante</dt><dd>{duration(patient.ttl, s.seconds)}</dd></>}
      {patient?.unassigned && <><dt>Unidades disponibles</dt><dd>{s.available}{s.unknownAvailability ? ` · ${s.unknownAvailability} sin confirmar` : ` de ${s.units.length}`}</dd></>}
      {unit && <><dt>{patient ? "Estado de la unidad" : "Siguiente paso"}</dt><dd>{unit.detail}</dd></>}
      {hospital && <>
        <dt>Ocupación actual</dt><dd>{hospital.occupied} de {hospital.capacity} camas</dd>
        <dt>Traslados en camino</dt><dd>{hospital.incoming.length}</dd>
        <dt>Margen previsto</dt><dd className={hospital.margin < 0 ? "danger" : ""}>{hospital.margin} camas</dd>
      </>}
      {road && <><dt>Estado</dt><dd>Cerrado en este instante</dd><dt>En el recorrido de</dt><dd>{road.units.length ? road.units.map((a) => a.id).join(", ") : "Ninguna unidad registrada"}</dd></>}
    </dl>
    {hospital && <p className="situation-detail-note">El margen descuenta pacientes a bordo con este destino, incluidos los traslados detenidos. No son reservas.</p>}
    {links.length > 0 && <div className="situation-linked" aria-label="Entidades relacionadas">
      {links.map(({ ref, label }) => <button key={entityKey(ref)} onClick={() => onSelect(ref)}>{label}<ChevronRight size={12} /></button>)}
    </div>}
    <button className="situation-locate" onClick={onLocate}><LocateFixed size={13} />Ver en el mapa<ArrowUpRight size={12} /></button>
  </section>;
}

export default function SituationSidebar(props: Props) {
  const { id, runs, onRun, situation: s, selection, onSelect, onLocate, related, matches, filter, onFilter, query, onQuery, showClosed, onShowClosed, historical, following, running, records, error } = props;
  const scroll = useRef<HTMLDivElement>(null);
  const fixed = useRef<HTMLDivElement>(null);
  const selectedKey = selection && entityKey(selection);
  useEffect(() => {
    if (!selectedKey || !scroll.current) return;
    if (getComputedStyle(scroll.current).overflowY === "visible") {
      window.scrollTo({ top: scroll.current.getBoundingClientRect().top + window.scrollY - (fixed.current?.offsetHeight ?? 0) - 8, behavior: "instant" });
    } else scroll.current.scrollTo({ top: 0, behavior: "instant" });
  }, [selectedKey]);
  const visible = (ref: EntityRef) => matches.has(entityKey(ref));
  const filtered = filter !== "all" || !!query.trim();
  const units = s?.units.filter((a) => visible(a.ref)) ?? [];
  const hospitals = s?.hospitals.filter((h) => visible(h.ref)) ?? [];
  const cases = s?.cases.filter((p) => visible(p.ref)) ?? [];
  const roads = s?.roads.filter((r) => visible(r.ref)) ?? [];
  const rowProps = { selection, related, onSelect };
  return <aside className="app-sidebar situation-sidebar" aria-label="Estado de la situación">
    <div className="situation-fixed" ref={fixed}>
      <div className="situation-heading"><div><span className="app-eyebrow">PANORAMA OPERATIVO</span><h2>Estado de la situación</h2></div><span className="situation-clock">{s ? snapshotTime(s) : "—"}</span></div>
      <label className="run-picker"><span>Ejecución</span><select aria-label="Seleccionar ejecución" value={id} onChange={(e) => onRun(e.target.value)}>
        {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString("es-ES")} · {r.id}</option>)}
      </select></label>
      <div className={`situation-time-state ${historical ? "historical" : ""}`}><Clock3 size={12} />{!s ? "Esperando datos" : historical ? "Revisando el pasado" : running ? following ? "Siguiendo la ejecución" : "Último registro recibido" : "Estado final de la ejecución"}</div>
      {s ? <div className="situation-overview">
        <p><strong>{s.active.length} {s.active.length === 1 ? "caso activo" : "casos activos"}</strong><span className={s.unassigned ? "situation-warning" : ""}> · {s.unassigned} sin asignar</span></p>
        <div className="situation-metrics">
          <div><Truck size={14} /><strong data-testid="available-units">{s.available}<small>/{s.units.length}</small></strong><span>{s.unknownAvailability ? "Libres confirmadas" : "Disponibles"}</span></div>
          <div><Hospital size={14} /><strong>{s.hospitals.reduce((n, h) => n + h.free, 0)}</strong><span>Camas libres</span></div>
          <div data-tone={s.broken ? "danger" : "neutral"}><Wrench size={14} /><strong>{s.broken}</strong><span>Averiadas</span></div>
        </div>
        {s.unknownAvailability > 0 && <p className="situation-unknown">{s.unknownAvailability} {s.unknownAvailability === 1 ? "unidad sin disponibilidad confirmada" : "unidades sin disponibilidad confirmada"}</p>}
      </div> : <p className="situation-loading">El panorama aparecerá con el primer registro.</p>}
    </div>
    {s && <div className="situation-body" ref={scroll}>
      {selection && <Inspector s={s} selection={selection} onSelect={onSelect} onLocate={onLocate} />}
      <div className="situation-explore">
        <label className="situation-search"><Search size={13} /><input aria-label="Buscar entidades" placeholder="Buscar caso, unidad, hospital…" value={query} onChange={(e) => onQuery(e.target.value)} />{query && <button aria-label="Borrar búsqueda" onClick={() => onQuery("")}><X size={12} /></button>}</label>
        <div className="situation-filters" aria-label="Filtros de situación">
          {([
            ["all", "Todos", null], ["unassigned", "Sin asignar", s.unassigned], ["broken", "Averiadas", s.broken], ["full", "Sin camas", s.hospitals.filter((h) => h.free === 0).length],
          ] as const).map(([key, label, count]) => <button key={key} aria-pressed={filter === key} onClick={() => onFilter(key)}>{label}{count !== null && <span>{count}</span>}</button>)}
        </div>
        {filtered && <p className="situation-filter-note">{matches.size} resultados · resaltados en el mapa<button onClick={() => { onFilter("all"); onQuery(""); }}>Limpiar</button></p>}
      </div>
      {units.length > 0 && <section className="situation-section" aria-label="Ambulancias"><div className="situation-section-heading"><h3>Ambulancias <span>{units.length}</span></h3><small>Misión actual</small></div>
        {units.map((a) => <EntityRow key={a.id} {...rowProps} entity={a.ref} icon={a.broken ? <Wrench size={15} /> : <Truck size={15} />} title={`${a.label}${a.patientId || a.targetPatientId ? ` · ${a.patientId || a.targetPatientId}` : ""}${a.hospitalId ? ` → ${a.hospitalId}` : ""}`} detail={a.detail} tone={a.tone} />)}
      </section>}
      {hospitals.length > 0 && <section className="situation-section" aria-label="Hospitales"><div className="situation-section-heading"><h3>Hospitales <span>{hospitals.length}</span></h3><small>Capacidad y demanda</small></div>
        {hospitals.map((h) => <EntityRow key={h.id} {...rowProps} entity={h.ref} icon={<Hospital size={15} />} title={h.name} detail={`${h.free} ${h.free === 1 ? "cama libre" : "camas libres"} · ${h.incoming.length} ${h.incoming.length === 1 ? "traslado en camino" : "traslados en camino"}`} tone={h.margin < 0 ? "danger" : h.free === 0 ? "warning" : "neutral"}>
          <span className="situation-capacity" role="img" aria-label={`${h.occupied} camas ocupadas de ${h.capacity}; ${h.incoming.length} traslados en camino; margen previsto ${h.margin}`}>
            <span className="situation-capacity-used" style={{ width: `${Math.min(100, h.capacity ? h.occupied / h.capacity * 100 : 0)}%` }} />
            <span className="situation-capacity-incoming" style={{ width: `${Math.min(h.free, h.incoming.length) / Math.max(1, h.capacity) * 100}%` }} />
          </span>
          <span className={`situation-margin ${h.margin < 0 ? "danger" : ""}`}>Margen previsto: <b>{h.margin}</b>{h.margin < 0 && " · demanda superior a capacidad"}</span>
        </EntityRow>)}
      </section>}
      {(cases.length > 0 || !filtered) && <section className="situation-section" aria-label="Casos"><div className="situation-section-heading"><h3>Casos <span>{s.active.length} activos</span></h3><button aria-expanded={showClosed} onClick={onShowClosed}>{showClosed ? "Ocultar cerrados" : `Cerrados (${s.cases.length - s.active.length})`}</button></div>
        {cases.length ? cases.map((p) => <EntityRow key={p.id} {...rowProps} entity={p.ref} icon={p.status === "delivered" ? <Check size={15} /> : <Users size={15} />} title={p.label} detail={p.detail} tone={p.tone} end={p.status === "waiting" && p.wait != null ? <em>{duration(p.wait, s.seconds)}</em> : undefined} />) : <p className="situation-empty">No hay casos activos en este instante.</p>}
      </section>}
      {(roads.length > 0 || !filtered) && <section className="situation-section" aria-label="Cortes de tráfico"><div className="situation-section-heading"><h3>Cortes de tráfico <span>{roads.length}</span></h3><small>Activos en este instante</small></div>
        {roads.length ? roads.map((r) => <EntityRow key={r.id} {...rowProps} entity={r.ref} icon={<MapPin size={15} />} title={r.name} detail={r.units.length ? `En el recorrido de ${r.units.map((a) => a.id).join(", ")}` : "Tramo cerrado"} tone={r.units.length ? "danger" : "warning"} />) : <p className="situation-empty">No hay cortes activos.</p>}
      </section>}
      {filtered && matches.size === 0 && <div className="situation-no-results"><Search size={20} /><strong>No hay coincidencias</strong><p>Prueba otro filtro o busca por identificador.</p></div>}
      <section className="situation-balance" aria-label="Balance de la ejecución"><span className="app-eyebrow">BALANCE DE LA EJECUCIÓN</span><div><span><strong data-testid="saved-count">{s.saved}</strong>Ingresados</span><span><strong>{s.dead}</strong>Fallecidos</span></div><small>Acumulado hasta {snapshotTime(s)}</small></section>
    </div>}
    <div className="app-last-update"><span>{error ? "Conexión interrumpida" : `${records} registros recibidos`}</span><span>Solo observación</span></div>
  </aside>;
}
