import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Hospital,
  Layers,
  Map as MapIcon,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Truck,
  Waves,
  X,
} from "lucide-react";
import { useRun, useRuns } from "./useRuns";
import {
  elapsed,
  patientStatus,
  unitStatus,
  type RunMeta,
} from "./runModel";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../theme.css";
import "./control-center.css";
import "./session.css";
import ThoughtsView from "./thoughts/ThoughtsView";
import ActivityLog from "./thoughts/ActivityLog";
import { auditItems, laneName, type AuditItem } from "./thoughts/model";

const RunMap = lazy(() => import("./map/RunMap"));
const runLabel = (r: RunMeta) =>
  `${r.coordinator}${r.model ? ` / ${r.model}` : ""} · ${new Date(r.startedAt).toLocaleString("es-ES")}`;
export default function ControlCenter() {
  const { runs, error, loaded } = useRuns();
  const [selected, setSelected] = useState("");
  const id = selected || runs[0]?.id;
  return (
    <div className="control-center run-session">
      {id ? (
        <RunSession
          key={id}
          id={id}
          runs={runs}
          onRun={setSelected}
          listError={error}
        />
      ) : (
        <div className="run-empty">
          <Radio size={24} />
          <h1>
            {error
              ? "Sin conexión con el servicio de datos"
              : loaded
                ? "No hay ejecuciones todavía"
                : "Conectando con el servicio de datos…"}
          </h1>
          <p>
            {error ||
              "Aquí aparecerán las ejecuciones y la actividad de los agentes."}
          </p>
          {loaded && (
            <p>Los nuevos registros aparecerán aquí automáticamente.</p>
          )}
        </div>
      )}
    </div>
  );
}
function RunSession({
  id,
  runs,
  onRun,
  listError,
}: {
  id: string;
  runs: RunMeta[];
  onRun: (id: string) => void;
  listError: string;
}) {
  const { meta, ticks, graph, error } = useRun(id);
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [follow, setFollow] = useState(false),
    [speed, setSpeed] = useState(2),
    [view, setView] = useState<"map" | "flow">("map"),
    [patient, setPatient] = useState<string | null>(null),
    [lane, setLane] = useState<"master" | "coordinator" | null>(null),
    [expanded, setExpanded] = useState<string | null>(null),
    [showClosed, setShowClosed] = useState(false);
  const current = ticks[Math.min(index, ticks.length - 1)],
    seconds = meta?.config.tickSeconds ?? 30;
  useEffect(() => {
    if (follow) setIndex(Math.max(0, ticks.length - 1));
  }, [follow, ticks.length]);
  useEffect(() => {
    if (!playing || follow) return;
    const timer = setInterval(
      () => setIndex((i) => Math.min(i + 1, Math.max(0, ticks.length - 1))),
      1000 / speed,
    );
    return () => clearInterval(timer);
  }, [playing, follow, speed, ticks.length]);
  useEffect(() => {
    if (playing && index >= ticks.length - 1) setPlaying(false);
  }, [index, ticks.length, playing]);
  const visible = useMemo(() => ticks.slice(0, index + 1), [ticks, index]);
  const all = useMemo(() => auditItems(visible), [visible]);
  const items = all.filter(
    (x) =>
      (!lane ||
        (lane === "master"
          ? x.lane !== "coordinator"
          : x.lane === "coordinator")) &&
      (!patient || x.patients.includes(patient)),
  );
  const births = useMemo(
    () =>
      new Map(
        visible.flatMap((r) =>
          r.events
            .filter((e) => e.type === "patient_spawned")
            .map((e) => [e.patientId, r.tick] as const),
        ),
      ),
    [visible],
  );
  const active =
    current?.frame.patients.filter(
      (p) => p.status === "waiting" || p.status === "in_ambulance",
    ) ?? [];
  const closed =
    current?.frame.patients.filter(
      (p) => p.status === "delivered" || p.status === "dead",
    ) ?? [];
  const patients = [...active, ...(showClosed ? closed : [])].sort(
    (a, b) =>
      (births.get(b.id) ?? 0) - (births.get(a.id) ?? 0) || a.ttl - b.ttl,
  );
  const summary = current?.frame.summary;
  function seek(i: number) {
    setIndex(i);
    setPlaying(false);
    setFollow(false);
    setExpanded(null);
  }
  function reveal(item: AuditItem) {
    setView("flow");
    setExpanded(item.id);
  }
  function choosePatient(value: string | null) {
    setPatient(value);
    setExpanded(null);
  }
  return (
    <main className="app-layout">
      <section className="app-workspace">
        <div className="app-toolbar">
          <div className="app-tabs">
            <button
              aria-pressed={view === "map"}
              className={view === "map" ? "is-active" : ""}
              onClick={() => setView("map")}
            >
              <MapIcon size={14} />
              Territorio
            </button>
            <button
              aria-pressed={view === "flow"}
              className={view === "flow" ? "is-active" : ""}
              onClick={() => setView("flow")}
            >
              <GitBranch size={14} />
              Actividad de los agentes
            </button>
          </div>
        </div>
        <div className="app-context run-context">
          <span className="app-eyebrow">
            VALENCIA <span>GESTIÓN</span>
          </span>
          <span
            className={`run-status ${meta?.status === "failed" ? "danger" : ""}`}
          >
            <i />
            {meta?.status === "running"
              ? "Ejecución en curso"
              : meta?.status === "failed"
                ? "Ejecución fallida"
                : meta
                  ? "Ejecución finalizada"
                  : "Conectando…"}
          </span>
        </div>
        {(error || listError) && (
          <div className="run-error" role="alert">
            {error || listError}{" "}
            {ticks.length > 0 && "Se conserva el último registro recibido."}
          </div>
        )}
        <div className="app-scope">
          <div>
            <button
              className={!patient && !lane ? "is-active" : ""}
              onClick={() => {
                choosePatient(null);
                setLane(null);
              }}
            >
              <Layers size={13} />
              Contexto global
            </button>
            {patient && (
              <button className="app-filter" onClick={() => choosePatient(null)}>
                {patient}
                <X size={12} />
              </button>
            )}
            {lane && (
              <button className="app-filter" onClick={() => setLane(null)}>
                {laneName[lane]}
                <X size={12} />
              </button>
            )}
          </div>
          <span>
            {items.length} registros · +{elapsed(current?.tick ?? 0, seconds)}
          </span>
        </div>
        {!current ? (
          <div className="app-empty">
            {error
              ? "No hay registros compatibles disponibles."
              : "Esperando el primer registro de actividad…"}
          </div>
        ) : view === "map" ? (
          graph &&
          meta && (
            <Suspense fallback={<div className="app-empty">Cargando mapa…</div>}>
              <RunMap
                graph={graph}
                meta={meta}
                record={current}
                selected={patient}
                onSelect={(p) => choosePatient(patient === p ? null : p)}
              />
            </Suspense>
          )
        ) : (
          <ThoughtsView
            items={items}
            seconds={seconds}
            tick={current.tick}
            autoScroll={playing || follow}
            expanded={expanded}
            onExpand={setExpanded}
          />
        )}
        <div className="app-playback">
          <div className="app-playback-title">
            <span>
              <Activity size={13} />
              Línea temporal
            </span>
            <span>
              {follow
                ? "Siguiendo el último registro"
                : playing
                  ? "Reproduciendo historial"
                  : "Historial pausado"}{" "}
              · {seconds} s por registro
            </span>
          </div>
          <div className="app-controls">
            <button
              className="app-play"
              disabled={ticks.length < 2}
              title={playing ? "Pausar historial" : "Reproducir historial"}
              aria-label={playing ? "Pausar historial" : "Reproducir historial"}
              onClick={() => {
                setFollow(false);
                if (index >= ticks.length - 1) setIndex(0);
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              aria-label="Registro anterior"
              disabled={index === 0}
              onClick={() => seek(index - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              aria-label="Registro siguiente"
              disabled={index >= ticks.length - 1}
              onClick={() => seek(index + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <input
              type="range"
              aria-label="Navegar por el historial"
              min={0}
              max={Math.max(0, ticks.length - 1)}
              step={1}
              value={index}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <output className="app-turn-total" aria-label="Tiempo transcurrido">
              +{elapsed(current?.tick ?? 0, seconds)}
            </output>
            <select
              className="playback-speed"
              aria-label="Velocidad del historial"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              {[1, 2, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n * seconds}×
                </option>
              ))}
            </select>
            <button aria-label="Volver al inicio" onClick={() => seek(0)}>
              <RotateCcw size={14} />
            </button>
            <button
              className={`run-follow ${follow ? "selected" : ""}`}
              aria-pressed={follow}
              onClick={() => {
                setFollow(!follow);
                setPlaying(false);
              }}
              title="Seguir los nuevos registros de actividad"
            >
              <Radio size={13} />
              {meta?.status === "running" ? "Seguir ejecución" : "Ir al final"}
            </button>
          </div>
        </div>
      </section>
      <aside className="app-sidebar">
        <div className="app-sidebar-title">
          <div>
            <span className="app-eyebrow">CENTRO OPERATIVO</span>
            <h2>Control Center</h2>
          </div>
          <Radio size={17} />
        </div>
        <label className="run-picker">
          <span>Ejecución</span>
          <select
            aria-label="Seleccionar ejecución"
            value={id}
            onChange={(e) => onRun(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <div className="app-agent-cards">
          {(["master", "coordinator"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={lane === key}
              className={lane === key ? "is-active" : ""}
              onClick={() => setLane(lane === key ? null : key)}
            >
              <span className="app-agent-icon">
                {key === "master" ? <Waves size={15} /> : <Bot size={15} />}
              </span>
              <span>
                <strong>{key === "master" ? "Master" : "Coordinador"}</strong>
                <small>
                  {key === "master"
                    ? "Entorno operativo"
                    : meta?.coordinator || "Conectando"}
                </small>
              </span>
            </button>
          ))}
        </div>
        <div className="run-kpis">
          <div>
            <strong>{summary?.saved ?? 0}</strong>
            <span>En hospital</span>
          </div>
          <div className="danger">
            <strong>{summary?.dead ?? 0}</strong>
            <span>Fallecidos</span>
          </div>
          <div>
            <strong>{active.length}</strong>
            <span>En atención</span>
          </div>
          <div>
            <strong>{current?.frame.closedEdges.length ?? 0}</strong>
            <span>Cortes</span>
          </div>
        </div>
        <section className="app-cases">
          <div className="app-section-title">
            <h3>
              Avisos <span>{active.length} activos</span>
            </h3>
            <button
              aria-expanded={showClosed}
              onClick={() => setShowClosed(!showClosed)}
            >
              {showClosed ? "Ocultar cerrados" : `Cerrados (${closed.length})`}
            </button>
          </div>
          <div className="run-patient-list">
            {patients.length === 0 && (
              <p className="app-muted">No hay avisos en este momento.</p>
            )}
            {patients.map((p) => {
              const fresh = (births.get(p.id) ?? -1) === (current?.tick ?? 0);
              const unit = current?.frame.ambulances.find(
                (a) => a.patientId === p.id || a.targetPatientId === p.id,
              );
              return (
                <button
                  className={`run-case ${patient === p.id ? "selected" : ""}`}
                  key={p.id}
                  aria-pressed={patient === p.id}
                  onClick={() => choosePatient(patient === p.id ? null : p.id)}
                >
                  <span className="run-case-id">
                    {p.id}
                    {fresh && <b>NUEVO</b>}
                  </span>
                  <span>
                    <strong>{patientStatus[p.status]}</strong>
                    <small>
                      {unit ? unit.id : "Sin unidad vinculada"} · nodo {p.node}
                    </small>
                  </span>
                  <span className={p.status === "dead" ? "danger" : "run-ttl"}>
                    {p.status === "waiting" || p.status === "in_ambulance" ? (
                      <>TTL {elapsed(p.ttl, seconds)}</>
                    ) : p.status === "delivered" ? (
                      "Ingresado"
                    ) : (
                      "Fallecido"
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="app-resources">
          <div className="app-section-title">
            <h3>
              Flota{" "}
              <span>{current?.frame.ambulances.length ?? 0} ambulancias</span>
            </h3>
          </div>
          <div className="app-unit-list">
            {current?.frame.ambulances.map((a) => (
              <button
                className={`app-unit ${a.broken || a.stranded ? "danger" : ""}`}
                key={a.id}
                disabled={!a.patientId && !a.targetPatientId}
                onClick={() => choosePatient(a.patientId || a.targetPatientId)}
                title={unitStatus(a)}
              >
                <Truck size={14} />
                <strong>{a.id}</strong>
                <span>{unitStatus(a)}</span>
                <small>{a.patientId || a.targetPatientId || "—"}</small>
              </button>
            ))}
          </div>
          <details className="run-hospitals">
            <summary>
              <Hospital size={13} />
              Hospitales · capacidad actual
            </summary>
            {meta?.hospitals.map((h) => (
              <div key={h.id}>
                <span>
                  {h.id} · {h.name}
                </span>
                <strong>
                  {h.capacity -
                    (current?.frame.hospitals.find((x) => x.id === h.id)
                      ?.occupied ?? 0)}
                  /{h.capacity}
                </strong>
              </div>
            ))}
          </details>
        </section>
        <ActivityLog
          items={items}
          seconds={seconds}
          tick={current?.tick ?? 0}
          patient={patient}
          expanded={expanded}
          onSelectPatient={choosePatient}
          onReveal={reveal}
        />
        <div className="app-last-update">
          <span>
            {error
              ? "Conexión interrumpida"
              : `${ticks.length} registros recibidos`}
          </span>
          <span>Solo observación</span>
        </div>
      </aside>
    </main>
  );
}
