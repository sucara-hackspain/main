import React from "react";
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, Clock3, Hospital, LocateFixed, Search, Truck, Waves, Wrench, X } from "lucide-react";
import { priority, sceneLabel, UNIT_KINDS, type RunMeta, type Selection } from "../engineTrace";
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

const can = { carries: "Traslada víctimas", extricates: "Excarcela", wades: "Cruza el agua", flies: "Vuela" };

function EntityRow({ entity, selection, related, onSelect, icon, title, detail, end, tone = "neutral", children }: {
  entity: Selection; selection: Selection | null; related: Set<string>; onSelect: Props["onSelect"];
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
      <span className="situation-row-title"><strong>{entity.id}</strong><span>{title}</span>{end}</span>
      <small>{detail}</small>
      {children}
    </span>
    <ChevronRight size={13} className="situation-row-chevron" />
  </button>;
}

const UnitIcon = ({ kind }: { kind: keyof typeof unitIcon }) =>
  <span className="situation-unit-icon" dangerouslySetInnerHTML={{ __html: unitIcon[kind] }} />;

function Inspector({ s, selection, onSelect, onLocate }: { s: Situation; selection: Selection; onSelect: Props["onSelect"]; onLocate: () => void }) {
  const incident = selection.kind === "incident" ? s.incidents.find((i) => i.id === selection.id) : undefined;
  const unit = selection.kind === "unit" ? s.units.find((u) => u.id === selection.id) : undefined;
  const hospital = selection.kind === "hospital" ? s.hospitals.find((h) => h.id === selection.id) : undefined;
  const scene = selection.kind === "scene" ? s.scenes.find((x) => x.id === selection.id) : undefined;
  const sceneIncident = scene && s.incidents.find((i) => i.sceneId === scene.id);
  const links: { ref: Selection; label: string }[] = [];
  if (incident) {
    for (const u of incident.crews) links.push({ ref: u.ref, label: `${u.id} · ${u.label}` });
    for (const h of new Set(incident.crews.flatMap((u) => u.hospitalId ? [u.hospitalId] : []))) links.push({ ref: { kind: "hospital", id: h }, label: `${h} · Destino` });
    if (incident.sceneId && s.scenes.some((x) => x.id === incident.sceneId)) links.push({ ref: { kind: "scene", id: incident.sceneId }, label: `${incident.sceneId} · Escena real` });
  }
  if (unit?.incidentId) links.push({ ref: { kind: "incident", id: unit.incidentId }, label: `${unit.incidentId} · Incidente` });
  if (unit?.hospitalId) links.push({ ref: { kind: "hospital", id: unit.hospitalId }, label: `${unit.hospitalId} · Destino` });
  if (hospital) for (const u of hospital.incoming) links.push({ ref: u.ref, label: `${u.id} · ${u.victimId}${u.broken || u.stranded ? " · detenido" : ""}` });
  if (sceneIncident) links.push({ ref: sceneIncident.ref, label: `${sceneIncident.id} · Incidente del coordinador` });
  if (!incident && !unit && !hospital && !scene) return null;
  const waiting = scene?.victims.filter((v) => v.status === "waiting") ?? [];
  return <section className="situation-inspector" aria-label="Detalle de la selección">
    <div className="situation-inspector-heading">
      <span className="app-eyebrow">{incident ? "INCIDENTE SELECCIONADO" : unit ? "UNIDAD SELECCIONADA" : hospital ? "HOSPITAL SELECCIONADO" : "ESCENA REAL · SOLO SUPERVISIÓN"}</span>
      <button aria-label="Cerrar detalle" onClick={() => onSelect(null)}><X size={14} /></button>
    </div>
    <h3>{selection.id}<span>{incident ? `P${incident.priority} · ${incident.label}` : unit ? unit.kindLabel : hospital ? hospital.name : scene && sceneLabel(scene.kind)}</span></h3>
    {(incident || unit) && <p>{incident?.line || unit?.detail}</p>}
    <dl>
      {incident && <>
        <dt>Prioridad</dt><dd>P{incident.priority} · {priority[incident.priority].label}</dd>
        {incident.wait !== null && <><dt>{incident.crews.length ? "Abierto hace" : "Lleva esperando"}</dt><dd>{duration(incident.wait, s.seconds)}</dd></>}
        <dt>Ubicación</dt><dd>{incident.located ? "Confirmada por una dotación" : `Aproximada, ±${incident.locationErrorM} m`}</dd>
        {incident.open && (incident.unreachable || incident.cutOffIn !== null) && <><dt>Agua</dt><dd className="danger">
          {incident.unreachable ? "Ninguna calle conocida llega" : incident.cutOffIn === 0 ? "La previsión lo da por aislado" : `La previsión lo aísla en ${duration(incident.cutOffIn!, s.seconds)}`}
        </dd></>}
        {incident.open && <><dt>Unidades</dt><dd>{incident.crews.length ? incident.crews.map((u) => u.id).join(", ") : "Ninguna"}</dd></>}
        {incident.unattended && <><dt>Unidades disponibles</dt><dd>{s.available} de {s.units.length}</dd></>}
      </>}
      {unit && <>
        <dt>Estado</dt><dd>{unit.label}</dd>
        <dt>Puede</dt><dd>{(Object.keys(can) as (keyof typeof can)[]).filter((k) => UNIT_KINDS[unit.kind][k]).map((k) => can[k]).join(" · ")}</dd>
        {unit.victimId && <><dt>Víctima a bordo</dt><dd>{unit.victimId}</dd></>}
      </>}
      {hospital && <>
        <dt>Ocupación actual</dt><dd>{hospital.occupied} de {hospital.capacity} camas</dd>
        <dt>Traslados en camino</dt><dd>{hospital.incoming.length}</dd>
        <dt>Margen previsto</dt><dd className={hospital.margin < 0 ? "danger" : ""}>{hospital.margin} camas</dd>
        <dt>Helipuerto</dt><dd>{hospital.helipad ? "Sí" : "No"}</dd>
      </>}
      {scene && <>
        <dt>Víctimas</dt><dd>{scene.victims.length} · {waiting.length} sin atender</dd>
        <dt>En el agua</dt><dd>{scene.victims.filter((v) => v.inWater).length}</dd>
        <dt>Incidente</dt><dd>{sceneIncident ? sceneIncident.id : "El coordinador todavía no la ha localizado"}</dd>
      </>}
    </dl>
    {hospital && <p className="situation-detail-note">El margen descuenta las víctimas a bordo con este destino, incluidos los traslados detenidos. No son reservas.</p>}
    {scene && <p className="situation-detail-note">La escena real solo la ve la supervisión: el coordinador trabaja con lo que cuentan las llamadas y las dotaciones.</p>}
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
  const visible = (ref: Selection) => matches.has(entityKey(ref));
  const filtered = filter !== "all" || !!query.trim();
  const incidents = s?.incidents.filter((i) => visible(i.ref)) ?? [];
  const units = s?.units.filter((u) => visible(u.ref)) ?? [];
  const hospitals = s?.hospitals.filter((h) => visible(h.ref)) ?? [];
  const closed = s ? s.incidents.length - s.open.length : 0;
  const rowProps = { selection, related, onSelect };
  return <aside className="app-sidebar situation-sidebar" aria-label="Estado de la situación">
    <div className="situation-fixed" ref={fixed}>
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
      {selection && <Inspector s={s} selection={selection} onSelect={onSelect} onLocate={onLocate} />}
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
      {units.length > 0 && <section className="situation-section" aria-label="Unidades"><div className="situation-section-heading"><h3>Unidades <span>{units.length}</span></h3><small>Misión actual</small></div>
        {units.map((u) => <EntityRow key={u.id} {...rowProps} entity={u.ref} icon={u.broken ? <Wrench size={15} /> : <UnitIcon kind={u.kind} />} title={`${u.kindLabel} · ${u.label}`} detail={u.detail} tone={u.tone} />)}
      </section>}
      {hospitals.length > 0 && <section className="situation-section" aria-label="Hospitales"><div className="situation-section-heading"><h3>Hospitales <span>{hospitals.length}</span></h3><small>Capacidad y demanda</small></div>
        {hospitals.map((h) => <EntityRow key={h.id} {...rowProps} entity={h.ref} icon={<Hospital size={15} />} title={h.name} detail={`${h.free} ${h.free === 1 ? "cama libre" : "camas libres"} · ${h.incoming.length} ${h.incoming.length === 1 ? "traslado en camino" : "traslados en camino"}${h.helipad ? " · helipuerto" : ""}`} tone={h.margin < 0 ? "danger" : h.free === 0 ? "warning" : "neutral"}>
          <span className="situation-capacity" role="img" aria-label={`${h.occupied} camas ocupadas de ${h.capacity}; ${h.incoming.length} traslados en camino; margen previsto ${h.margin}`}>
            <span className="situation-capacity-used" style={{ width: `${Math.min(100, h.capacity ? h.occupied / h.capacity * 100 : 0)}%` }} />
            <span className="situation-capacity-incoming" style={{ width: `${Math.min(h.free, h.incoming.length) / Math.max(1, h.capacity) * 100}%` }} />
          </span>
          <span className={`situation-margin ${h.margin < 0 ? "danger" : ""}`}>Margen previsto: <b>{h.margin}</b>{h.margin < 0 && " · demanda superior a capacidad"}</span>
        </EntityRow>)}
      </section>}
      {!filtered && (s.sites.length > 0 || s.gauges.length > 0) && <section className="situation-section situation-water" aria-label="Anticipación"><div className="situation-section-heading"><h3>Anticipación <span>{s.sites.filter((x) => x.floodedTick === null && x.safe < x.people).length} sitios con gente dentro</span></h3><small>Aforos y registro municipal</small></div>
        {s.gauges.map((g) => <p key={g.name}><Waves size={13} /><span><strong>Aforo · {g.name}</strong> · cauce al {Math.round(g.level * 100)} %<small>{g.overflowTick > s.tick ? `Desborda en ~${g.overflowTick - s.tick} ticks` : `Desbordado hace ${s.tick - g.overflowTick} ticks`}</small></span></p>)}
        <dl>
          {s.sites.map((x) => <React.Fragment key={x.id}><dt>{x.id} · {x.name}</dt><dd>{x.floodedTick !== null ? (x.caught ? `${x.caught} atrapados dentro` : "todos a salvo") : `${x.safe}/${x.people} a salvo · ${x.warnedTick === null ? "SIN AVISAR" : "avisados"}${x.arrivalTicks !== null && x.safe < x.people ? ` · agua en ~${x.arrivalTicks} ticks` : ""}`}</dd></React.Fragment>)}
        </dl>
      </section>}
      {!filtered && <section className="situation-section situation-water" aria-label="Agua y cortes"><div className="situation-section-heading"><h3>Agua y cortes</h3><small>Lo que sabe el coordinador</small></div>
        {s.water.zones.length ? s.water.zones.map((z) => <p key={z.id}><Waves size={13} /><span><strong>{z.name}</strong> · radio {z.radiusM} m<small>Mapa oficial de hace {duration(z.ageTicks, s.seconds)}</small></span></p>) : <p className="situation-empty">Ningún mapa oficial de inundación todavía.</p>}
        <dl>
          <dt>Avisos de agua</dt><dd>{s.water.sightings}{s.water.blocked > 0 && ` · ${s.water.blocked} con paso cortado`}</dd>
          <dt>Tramos cortados</dt><dd>{s.water.closed}{s.water.streets > 0 && ` en ${s.water.streets} ${s.water.streets === 1 ? "calle" : "calles"}`}</dd>
          <dt>Realidad (supervisión)</dt><dd>{s.water.real} tramos cortados · {s.water.unreported} sin comunicar</dd>
        </dl>
      </section>}
      {filtered && matches.size === 0 && <div className="situation-no-results"><Search size={20} /><strong>No hay coincidencias</strong><p>Prueba otro filtro o busca por identificador.</p></div>}
    </div>}
    <div className="app-last-update"><span>{error ? "Conexión interrumpida" : `${records} registros recibidos`}</span><span>Solo observación</span></div>
  </aside>;
}
