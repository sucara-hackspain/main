import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleDot,
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
  actionText,
  auditItems,
  elapsed,
  eventText,
  patientStatus,
  unitStatus,
  type AuditItem,
  type RunMeta,
} from "./model";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../happyrobot-theme.css";
import "../v2.css";
import "./backend.css";
const RunMap = lazy(() => import("./RunMap"));
const laneName = {
  master: "Master · entorno",
  coordinator: "Coordinador",
  world: "Motor · evolución",
};
const runLabel = (r: RunMeta) =>
  `${r.coordinator}${r.model ? ` / ${r.model}` : ""} · semilla ${r.seed} · ${new Date(r.startedAt).toLocaleString("es-ES")}`;
export default function BackendV2() {
  const { runs, error, loaded } = useRuns();
  const [selected, setSelected] = useState("");
  const id = selected || runs[0]?.id;
  return (
    <div className="v2 backend-v2">
      {id ? (
        <Session
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
              ? "Sin conexión con Gabriel"
              : loaded
                ? "No hay ejecuciones todavía"
                : "Conectando con Gabriel…"}
          </h1>
          <p>
            {error ||
              "La V2 muestra las ejecuciones guardadas por el simulador."}
          </p>
          {loaded && (
            <>
              <code>npm run sim:local</code>
              <p>La ejecución aparecerá aquí automáticamente.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
function Session({
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
  const activity = useRef<HTMLDivElement>(null),
    flow = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (activity.current)
      activity.current.scrollTop = activity.current.scrollHeight;
    if (playing || follow) {
      if (flow.current) flow.current.scrollTop = flow.current.scrollHeight;
    }
  }, [index, playing, follow]);
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
    requestAnimationFrame(() =>
      document
        .getElementById(`audit-${item.id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }
  function choosePatient(value: string | null) {
    setPatient(value);
    setExpanded(null);
  }
  const title = (item: AuditItem) =>
    item.event ? eventText(item.event, seconds) : item.title;
  return (
    <main className="v2-layout">
      <section className="v2-workspace">
        <div className="v2-toolbar">
          <div className="v2-tabs">
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
        <div className="v2-context run-context">
          <span className="v2-eyebrow">
            VALENCIA <span>GABRIEL / V2</span>
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
        <div className="v2-scope">
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
              <button className="v2-filter" onClick={() => choosePatient(null)}>
                {patient}
                <X size={12} />
              </button>
            )}
            {lane && (
              <button className="v2-filter" onClick={() => setLane(null)}>
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
          <div className="v2-empty">
            {error
              ? "No hay registros compatibles disponibles."
              : "Esperando el primer registro del simulador…"}
          </div>
        ) : view === "map" ? (
          graph &&
          meta && (
            <Suspense fallback={<div className="v2-empty">Cargando mapa…</div>}>
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
          <>
            <div className="v2-lanes">
              <div>
                <span className="v2-agent-icon">
                  <Waves size={16} />
                </span>
                <div>
                  <strong>Master y entorno</strong>
                  <span>Avisos y evolución del mundo</span>
                </div>
              </div>
              <div>
                <span className="v2-agent-icon">
                  <Bot size={16} />
                </span>
                <div>
                  <strong>Coordinador</strong>
                  <span>Órdenes y resultados del motor</span>
                </div>
              </div>
            </div>
            <div className="v2-flow" ref={flow}>
              {items.length === 0 && (
                <div className="v2-empty">
                  Sin actividad en este contexto y momento.
                </div>
              )}
              {items.map((item, i) => (
                <div key={item.id}>
                  {(i === 0 || items[i - 1].tick !== item.tick) && (
                    <div className="v2-turn-label">
                      <span>+{elapsed(item.tick, seconds)}</span>
                      <strong>Registro de simulación</strong>
                    </div>
                  )}
                  <div
                    className={`v2-event-row ${item.lane === "coordinator" ? "coordinator" : "master"}`}
                    id={`audit-${item.id}`}
                  >
                    <article
                      className={`v2-event ${expanded === item.id ? "selected" : ""}`}
                    >
                      <button
                        className="v2-event-button"
                        aria-expanded={expanded === item.id}
                        onClick={() =>
                          setExpanded(expanded === item.id ? null : item.id)
                        }
                      >
                        <span className="v2-event-meta">
                          <span>
                            {item.lane === "coordinator" ? (
                              <Bot size={12} />
                            ) : item.lane === "world" ? (
                              <Activity size={12} />
                            ) : (
                              <Waves size={12} />
                            )}{" "}
                            {laneName[item.lane]}
                          </span>
                          <span>
                            {item.record.decision && item.lane === "coordinator"
                              ? sourceName(item.record.decision.source)
                              : "Evento"}
                          </span>
                        </span>
                        <strong>{title(item)}</strong>
                        <span className="v2-event-tags">
                          {[...item.patients, ...item.units].map((id) => (
                            <span key={id}>{id}</span>
                          ))}
                          <ChevronRight size={12} />
                        </span>
                      </button>
                      {expanded === item.id && (
                        <AuditDetail item={item} seconds={seconds} />
                      )}
                    </article>
                  </div>
                </div>
              ))}
              <div className="v2-history-end">
                <CircleDot size={12} />
                Hasta +{elapsed(current.tick, seconds)} · solo registros
                recibidos
              </div>
            </div>
          </>
        )}
        <div className="v2-playback">
          <div className="v2-playback-title">
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
          <div className="v2-controls">
            <button
              className="v2-play"
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
            <output className="v2-turn-total" aria-label="Tiempo simulado">
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
              title="Seguir los registros que escribe el backend"
            >
              <Radio size={13} />
              {meta?.status === "running" ? "Seguir ejecución" : "Ir al final"}
            </button>
          </div>
        </div>
      </section>
      <aside className="v2-sidebar">
        <div className="v2-sidebar-title">
          <div>
            <span className="v2-eyebrow">SIMULADOR CONECTADO</span>
            <h2>Centro de coordinación</h2>
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
        <div className="v2-agent-cards">
          {(["master", "coordinator"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={lane === key}
              className={lane === key ? "is-active" : ""}
              onClick={() => setLane(lane === key ? null : key)}
            >
              <span className="v2-agent-icon">
                {key === "master" ? <Waves size={15} /> : <Bot size={15} />}
              </span>
              <span>
                <strong>{key === "master" ? "Master" : "Coordinador"}</strong>
                <small>
                  {key === "master"
                    ? "Escenario aleatorio"
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
        <section className="v2-cases">
          <div className="v2-section-title">
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
              <p className="v2-muted">No hay avisos en este momento.</p>
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
        <section className="v2-resources">
          <div className="v2-section-title">
            <h3>
              Flota{" "}
              <span>{current?.frame.ambulances.length ?? 0} ambulancias</span>
            </h3>
          </div>
          <div className="v2-unit-list">
            {current?.frame.ambulances.map((a) => (
              <button
                className={`v2-unit ${a.broken || a.stranded ? "danger" : ""}`}
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
        <section className="v2-observation">
          <div className="v2-section-title">
            <h3>
              {patient ? `${patient} · seguimiento` : "Registro compartido"}
            </h3>
            {patient && (
              <button onClick={() => choosePatient(null)}>
                Ver todo <X size={12} />
              </button>
            )}
          </div>
          <div className="v2-activity" ref={activity}>
            {items.slice(-150).map((item) => (
              <button
                key={item.id}
                className={`v2-log ${expanded === item.id ? "selected" : ""}`}
                onClick={() => reveal(item)}
              >
                <span className="v2-log-icon">
                  {item.lane === "coordinator" ? (
                    <Bot size={13} />
                  ) : item.lane === "world" ? (
                    <Activity size={13} />
                  ) : (
                    <Waves size={13} />
                  )}
                </span>
                <span>
                  <small>
                    +{elapsed(item.tick, seconds)} · {laneName[item.lane]}
                  </small>
                  <strong>{title(item)}</strong>
                  <span>{item.patients.join(" · ")}</span>
                </span>
                <ArrowUpRight size={12} />
              </button>
            ))}
            {items.length === 0 && (
              <p className="v2-muted">Sin actividad en este contexto.</p>
            )}
          </div>
        </section>
        <div className="v2-last-update">
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
function sourceName(source: string) {
  return source === "llm"
    ? "IA"
    : source === "fallback"
      ? "Respaldo por reglas"
      : "Reglas";
}
function AuditDetail({ item, seconds }: { item: AuditItem; seconds: number }) {
  const d = item.record.decision;
  return (
    <div className="v2-event-detail">
      {item.event ? (
        <>
          <label>EVENTO REGISTRADO</label>
          <p>{eventText(item.event, seconds)}</p>
          {item.event.type === "patient_spawned" && (
            <p>
              Nodo {item.event.node} · TTL inicial{" "}
              {elapsed(item.event.ttl, seconds)}. El backend actual no registra
              una categoría clínica de gravedad.
            </p>
          )}
          <details className="run-json">
            <summary>Ver datos del evento</summary>
            <pre>{JSON.stringify(item.event, null, 2)}</pre>
          </details>
        </>
      ) : (
        <>
          <label>DECISIÓN · {sourceName(d?.source ?? "rules")}</label>
          <p>
            {d?.situation ||
              "El coordinador no ha registrado un resumen de situación."}
          </p>
          {d?.ms !== undefined && (
            <p>
              Duración: {(d.ms / 1000).toFixed(1)} s
              {d.costUsd !== undefined
                ? ` · coste: $${d.costUsd.toFixed(4)}`
                : ""}
            </p>
          )}
          {d?.error && <p className="danger">{d.error}</p>}
          <label>ÓRDENES Y RESULTADOS</label>
          {item.record.actions.length === 0 ? (
            <p>
              Sin nuevas órdenes. No implica que hayan terminado las misiones en
              curso.
            </p>
          ) : (
            item.record.actions.map((a, i) => {
              const result = item.record.events.find(
                (e) =>
                  (e.type === "action_applied" ||
                    e.type === "action_rejected") &&
                  JSON.stringify(e.action) === JSON.stringify(a),
              );
              return (
                <div className="run-order" key={i}>
                  <strong>{actionText(a)}</strong>
                  <p>
                    {d?.reasons?.[i] ||
                      "Sin justificación registrada para esta orden."}
                  </p>
                  <span
                    className={
                      result?.type === "action_rejected" ? "danger" : ""
                    }
                  >
                    {result?.type === "action_rejected"
                      ? `Rechazada: ${result.reason}`
                      : result?.type === "action_applied"
                        ? `Aceptada · ETA ${elapsed(result.etaTicks, seconds)}`
                        : "Sin confirmación del motor"}
                  </span>
                </div>
              );
            })
          )}
          <label>CONTEXTO AUDITABLE</label>
          <p>
            El registro contiene el resultado del motor. No incluye una copia
            del conocimiento del coordinador ni los informes que recibió.
          </p>
        </>
      )}
    </div>
  );
}
