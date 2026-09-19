import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Layers,
  Map as MapIcon,
  Pause,
  PhoneIncoming,
  Play,
  Radio,
  RotateCcw,
  X,
} from "lucide-react";
import { useRun, useRuns } from "./useRuns";
import {
  elapsed,
  type RunMeta,
} from "./runModel";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../theme.css";
import "./control-center.css";
import "./session.css";
import ThoughtsView from "./thoughts/ThoughtsView";
import { auditItems, laneName } from "./thoughts/model";
import SituationSidebar from "./situation/SituationSidebar";
import { buildSituation, entityExists, matchingEntities, relatedEntities, sameEntity, type EntityRef, type SituationFilter } from "./situation/model";
import CallIntake from "./calls/CallIntake";

const RunMap = lazy(() => import("./map/RunMap"));
export default function ControlCenter() {
  const { runs, error, loaded } = useRuns();
  const [selected, setSelected] = useState("");
  const [callOpen, setCallOpen] = useState(() => new URLSearchParams(window.location.search).get("call") === "demo");
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
          onOpenCall={() => setCallOpen(true)}
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
          <button className="call-launch" onClick={() => setCallOpen(true)}>
            <PhoneIncoming size={15} /> Ver llamada de ejemplo
          </button>
        </div>
      )}
      <CallIntake open={callOpen} onOpen={() => setCallOpen(true)} onClose={() => setCallOpen(false)} />
    </div>
  );
}
function RunSession({
  id,
  runs,
  onRun,
  listError,
  onOpenCall,
}: {
  id: string;
  runs: RunMeta[];
  onRun: (id: string) => void;
  listError: string;
  onOpenCall: () => void;
}) {
  const { meta, ticks, graph, error } = useRun(id);
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [follow, setFollow] = useState(false),
    [speed, setSpeed] = useState(2),
    [view, setView] = useState<"map" | "flow">("map"),
    [entity, setEntity] = useState<EntityRef | null>(null),
    [filter, setFilter] = useState<SituationFilter>("all"),
    [query, setQuery] = useState(""),
    [focusRequest, setFocusRequest] = useState(0),
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
  const situation = useMemo(() => current && meta ? buildSituation(current, meta, visible, graph) : null, [current, meta, visible, graph]);
  const selection = entity && entityExists(current, meta, entity) ? entity : null;
  const related = useMemo(() => situation ? relatedEntities(situation, selection) : new Set<string>(), [situation, selection]);
  const matches = useMemo(() => situation ? matchingEntities(situation, filter, query, showClosed) : new Set<string>(), [situation, filter, query, showClosed]);
  const patient = selection?.kind === "patient" ? selection.id : selection?.kind === "ambulance"
    ? (current?.frame.ambulances.find((a) => a.id === selection.id)?.patientId || current?.frame.ambulances.find((a) => a.id === selection.id)?.targetPatientId || null)
    : null;
  useEffect(() => { if (entity && !entityExists(current, meta, entity)) setEntity(null); }, [current, meta, entity]);
  const items = all.filter(
    (x) =>
      (!lane ||
        (lane === "master"
          ? x.lane !== "coordinator"
          : x.lane === "coordinator")) &&
      (!patient || x.patients.includes(patient)),
  );
  function seek(i: number) {
    setIndex(i);
    setPlaying(false);
    setFollow(false);
    setExpanded(null);
  }
  function chooseEntity(value: EntityRef | null) {
    setEntity(value);
    setExpanded(null);
  }
  function choosePatient(value: string | null) {
    chooseEntity(value ? { kind: "patient", id: value } : null);
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
          <button className="call-launch" onClick={onOpenCall}>
            <PhoneIncoming size={14} /> Entrada por llamada <span>Demo</span>
          </button>
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
              className={!selection && !lane && filter === "all" && !query ? "is-active" : ""}
              onClick={() => {
                choosePatient(null);
                setLane(null);
                setFilter("all");
                setQuery("");
              }}
            >
              <Layers size={13} />
              Contexto global
            </button>
            {selection && (
              <button className="app-filter" onClick={() => chooseEntity(null)}>
                {selection.kind === "road" ? `Corte ${selection.id}` : selection.id}
                <X size={12} />
              </button>
            )}
            {view === "flow" && (["master", "coordinator"] as const).map((key) => (
              <button key={key} aria-pressed={lane === key} className={lane === key ? "app-filter" : ""} onClick={() => setLane(lane === key ? null : key)}>{laneName[key]}</button>
            ))}
          </div>
          <span>
            {view === "map" ? `${situation?.active.length ?? 0} casos activos` : `${items.length} registros`} · +{elapsed(current?.tick ?? 0, seconds)}
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
                selected={selection}
                onSelect={(ref) => chooseEntity(sameEntity(selection, ref) ? null : ref)}
                situation={situation!}
                related={related}
                matches={matches}
                filtered={filter !== "all" || !!query.trim()}
                focusRequest={focusRequest}
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
      <SituationSidebar
        id={id} runs={runs} onRun={onRun} situation={situation}
        selection={selection} onSelect={chooseEntity}
        onLocate={() => { setView("map"); setFocusRequest((n) => n + 1); }}
        related={related} matches={matches}
        filter={filter} onFilter={setFilter} query={query} onQuery={setQuery}
        showClosed={showClosed} onShowClosed={() => setShowClosed(!showClosed)}
        historical={!!current && current.tick < (ticks.at(-1)?.tick ?? 0)}
        following={follow} running={meta?.status === "running"}
        records={ticks.length} error={!!(error || listError)}
      />
    </main>
  );
}
