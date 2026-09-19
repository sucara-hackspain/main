import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  GitBranch,
  Layers,
  Map as MapIcon,
  Pause,
  Play,
  Radio,
  RotateCcw,
  X,
} from "lucide-react";
import { useRun, useRuns } from "./useRuns";
import {
  elapsed,
  sameSelection,
  selectionExists,
  type RunMeta,
  type Selection,
} from "./engineTrace";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../theme.css";
import "./control-center.css";
import "./session.css";
import SituationSidebar from "./situation/SituationSidebar";
import {
  buildSituation,
  matchingEntities,
  relatedEntities,
  type SituationFilter,
} from "./situation/model";
import ThoughtsView from "./thoughts/ThoughtsView";
import { auditItems, laneName } from "./thoughts/model";
import DecisionBanner from "./interventions/DecisionBanner";
import DecisionRoom, { PendingDecisionBar } from "./interventions/DecisionRoom";
import { DecisionReceipt } from "./interventions/DecisionParts";
import InterventionInbox from "./interventions/InterventionInbox";
import { useInterventions } from "./interventions/useInterventions";
import { useAlertSound } from "./interventions/sound";
import type { InterventionView, Option } from "./interventions/model";
import TicketsView, { TicketDetail } from "./tickets/TicketsView";
import { buildTickets, type Ticket, type TicketState } from "./tickets/model";

const RunMap = lazy(() => import("./map/RunMap"));
// Read once: a run that mounts while another shows a pending count would take the count as its title.
const pageTitle = document.title;
// ?iteracion=1 keeps the first iteration, a banner above the map, to compare with the second:
// every request takes over the page in a decision room, with the map and the thread to decide.
const iteration =
  new URLSearchParams(window.location.search).get("iteracion") === "1" ? 1 : 2;
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
    [view, setView] = useState<"map" | "flow" | "tickets">("map"),
    [ticketId, setTicketId] = useState<string | null>(null),
    [ticketFilter, setTicketFilter] = useState<TicketState | "all">("all"),
    [ticketQuery, setTicketQuery] = useState(""),
    [entity, setEntity] = useState<Selection | null>(null),
    [filter, setFilter] = useState<SituationFilter>("all"),
    [query, setQuery] = useState(""),
    [showClosed, setShowClosed] = useState(false),
    [focusRequest, setFocusRequest] = useState(0),
    [lane, setLane] = useState<"master" | "coordinator" | null>(null),
    [expanded, setExpanded] = useState<string | null>(null),
    [decisionId, setDecisionId] = useState<string | null>(null),
    [held, setHeld] = useState(false),
    // Left the decision room to look around: the request waits in a bar until the operator returns.
    [investigating, setInvestigating] = useState(false),
    [receipt, setReceipt] = useState<{
      id: string;
      label: string;
      key: number;
    } | null>(null);
  const current = ticks[Math.min(index, ticks.length - 1)],
    seconds = meta?.config.tickSeconds ?? 30;
  const interventions = useInterventions({ ticks, current, graph, meta });
  const { pending, router } = interventions;
  const sound = useAlertSound();
  const { chime } = sound;
  // A new request brings the operator back to the room. If it opens while time moves on its own
  // it sounds, and during the replay it also stops it; pressing play again carries on.
  // Scrubbing by hand stays silent.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const fresh = pending.filter((x) => !asked.current.has(x.item.id));
    asked.current = new Set(pending.map((x) => x.item.id));
    if (!fresh.length) return;
    setInvestigating(false);
    if ((playing || follow) && iteration === 2) chime();
    if (playing) {
      setPlaying(false);
      setHeld(true);
    }
  }, [pending, playing, follow, chime]);
  const urgent = pending.length > 0;
  useEffect(() => {
    const title = pending.length
      ? `(${pending.length}) Decisión pendiente · ${pageTitle}`
      : pageTitle;
    document.title = title;
    // In another tab, a pending request blinks the title.
    const blink =
      urgent &&
      setInterval(() => {
        document.title =
          document.hidden && document.title === title
            ? "⚠ DECISIÓN REQUERIDA"
            : title;
      }, 1000);
    return () => {
      if (blink) clearInterval(blink);
      document.title = pageTitle;
    };
  }, [pending.length, urgent]);
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
  const tickets = useMemo(() => buildTickets(visible, seconds), [visible, seconds]);
  const selectedTicket = tickets.find((ticket) => ticket.id === ticketId) ?? null;
  const selection =
    entity && selectionExists(entity, current, meta) ? entity : null;
  // The situation at the selected instant, from what is known up to it.
  const situation = useMemo(
    () => (current && meta ? buildSituation(current, meta, visible, graph) : null),
    [current, meta, visible, graph],
  );
  const related = useMemo(
    () => (situation ? relatedEntities(situation, selection) : new Set<string>()),
    [situation, selection],
  );
  const matches = useMemo(
    () =>
      situation ? matchingEntities(situation, filter, query, showClosed) : new Set<string>(),
    [situation, filter, query, showClosed],
  );
  const filtered = filter !== "all" || !!query.trim();
  useEffect(() => {
    if (entity && current && !selectionExists(entity, current, meta)) setEntity(null);
  }, [current, meta, entity]);
  const items = all.filter(
    (x) =>
      (!lane ||
        (lane === "master"
          ? x.lane !== "coordinator"
          : x.lane === "coordinator")) &&
      (!selection || x.refs.includes(selection.id)),
  );
  function seek(i: number) {
    setIndex(i);
    setPlaying(false);
    setFollow(false);
    setExpanded(null);
    setHeld(false);
  }
  function seekTick(tick: number) {
    const i = ticks.findIndex((r) => r.tick === tick);
    if (i >= 0) seek(i);
  }
  function decide(item: InterventionView, option: Option, prescribed: Option) {
    interventions.decide(item, option, prescribed);
    if (iteration === 2)
      setReceipt({ id: item.id, label: option.label, key: Date.now() });
    const others = pending.filter((x) => x.item.id !== item.id);
    if (held && others.length === 0) {
      setHeld(false);
      setPlaying(true);
    }
  }
  /** Pick a request from the queue: it opens the room again. */
  function activate(id: string) {
    setDecisionId(id);
    if (pending.some((x) => x.item.id === id)) setInvestigating(false);
  }
  function chooseEntity(value: Selection | null) {
    setEntity(value);
    setExpanded(null);
  }
  function chooseIncident(id: string | null) {
    chooseEntity(id ? { kind: "incident", id } : null);
  }
  function locateTicket(ticket: Ticket) {
    // Closed incidents leave the engine's current frame after twenty ticks.
    if (!current?.frame.incidents.some((i) => i.id === ticket.id)) seekTick(ticket.lastSeenTick);
    setFilter("all");
    setQuery("");
    chooseIncident(ticket.id);
    setView("map");
    setFocusRequest((n) => n + 1);
  }
  const room =
    iteration === 2 &&
    !investigating &&
    pending.length > 0 &&
    current &&
    meta &&
    graph &&
    router && (
      <DecisionRoom
        pending={pending}
        activeId={decisionId}
        record={current}
        records={ticks}
        items={all}
        meta={meta}
        graph={graph}
        router={router}
        seconds={seconds}
        held={held}
        sound={sound}
        onActive={setDecisionId}
        onDecide={decide}
        onLeave={() => setInvestigating(true)}
        onOpenThread={(item) => {
          setInvestigating(true);
          setView("flow");
          setLane(null);
          chooseIncident(item.incidentId);
        }}
      />
    );
  const banner = iteration === 1 && current && (
    <DecisionBanner
      pending={pending}
      activeId={decisionId}
      tick={current.tick}
      seconds={seconds}
      held={held}
      shortcuts={!room}
      onActive={setDecisionId}
      onDecide={decide}
      onUndo={interventions.undo}
      onLocate={(incidentId) => {
        chooseIncident(incidentId);
        setView("map");
        setFocusRequest((n) => n + 1);
      }}
      onReveal={(auditId) => {
        setView("flow");
        setExpanded(auditId);
      }}
    />
  );
  // While the room is open everything else stays out of reach.
  const blocked = Boolean(room);
  return (
    <main className="app-layout">
      <section className="app-workspace" inert={blocked}>
        {iteration === 2 && investigating && urgent && current && (
          <PendingDecisionBar
            pending={pending}
            tick={current.tick}
            seconds={seconds}
            held={held}
            onReturn={() => setInvestigating(false)}
          />
        )}
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
              aria-pressed={view === "tickets"}
              className={view === "tickets" ? "is-active" : ""}
              onClick={() => {
                if (selection?.kind === "incident") setTicketId(selection.id);
                setView("tickets");
              }}
            >
              <ClipboardList size={14} />
              Incidencias
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
          {current && (
            <InterventionInbox
              pending={pending}
              history={interventions.history}
              activeId={decisionId}
              tick={current.tick}
              seconds={seconds}
              nextTick={interventions.nextTick}
              onActive={activate}
              onSeek={seekTick}
              onUndo={interventions.undo}
            />
          )}
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
        {view !== "tickets" && <div className="app-scope">
          <div>
            <button
              className={!selection && !lane && !filtered ? "is-active" : ""}
              onClick={() => {
                chooseEntity(null);
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
                {selection.id}
                <X size={12} />
              </button>
            )}
            {view === "flow" && (["master", "coordinator"] as const).map((key) => (
              <button key={key} aria-pressed={lane === key} className={lane === key ? "app-filter" : ""} onClick={() => setLane(lane === key ? null : key)}>{laneName[key]}</button>
            ))}
          </div>
          <span>
            {view === "map"
              ? `${current?.frame.incidents.filter((i) => i.status === "open").length ?? 0} incidentes abiertos`
              : `${items.length} registros`}{" "}
            · +{elapsed(current?.tick ?? 0, seconds)}
          </span>
        </div>}
        {banner}
        <div className="app-stage">
          {!current ? (
            <div className="app-empty">
              {error
                ? "No hay registros compatibles disponibles."
                : "Esperando el primer registro de actividad…"}
            </div>
          ) : view === "tickets" ? (
            <TicketsView tickets={tickets} selected={selectedTicket?.id ?? null} onSelect={setTicketId}
              filter={ticketFilter} onFilter={setTicketFilter} query={ticketQuery} onQuery={setTicketQuery}
              seconds={seconds} tick={current.tick} />
          ) : view === "map" ? (
            graph &&
            meta && (
              <Suspense fallback={<div className="app-empty">Cargando mapa…</div>}>
                <RunMap
                  graph={graph}
                  meta={meta}
                  record={current}
                  selected={selection}
                  onSelect={(ref) =>
                    chooseEntity(sameSelection(selection, ref) ? null : ref)
                  }
                  focusRequest={focusRequest}
                  related={related}
                  matches={matches}
                  filtered={filtered}
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
        </div>
        <div className="app-playback">
          <div className="app-playback-title">
            <span>
              <Activity size={13} />
              Línea temporal
            </span>
            <span>
              {follow
                ? "Siguiendo el último registro"
                : held
                  ? "Historial en pausa · decisión pendiente"
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
                setHeld(false);
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
                setHeld(false);
              }}
              title="Seguir los nuevos registros de actividad"
            >
              <Radio size={13} />
              {meta?.status === "running" ? "Seguir ejecución" : "Ir al final"}
            </button>
          </div>
        </div>
      </section>
      <div className="app-sidebar-slot" inert={blocked}>
        {view === "tickets" ? <TicketDetail ticket={selectedTicket} seconds={seconds} tick={current?.tick ?? 0}
          onLocate={locateTicket} onClose={() => setTicketId(null)} runs={runs} runId={id} onRun={onRun} records={ticks.length} /> : <SituationSidebar
          id={id}
          runs={runs}
          onRun={onRun}
          situation={situation}
          selection={selection}
          onSelect={chooseEntity}
          onLocate={() => {
            setView("map");
            setFocusRequest((n) => n + 1);
          }}
          related={related}
          matches={matches}
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          showClosed={showClosed}
          onShowClosed={() => setShowClosed(!showClosed)}
          historical={!!current && current.tick < (ticks.at(-1)?.tick ?? 0)}
          following={follow}
          running={meta?.status === "running"}
          records={ticks.length}
          error={!!(error || listError)}
        />}
      </div>
      {room}
      {receipt && (
        <DecisionReceipt
          key={receipt.key}
          className="snackbar"
          label={receipt.label}
          onUndo={() => interventions.undo(receipt.id)}
          onClose={() => setReceipt(null)}
        />
      )}
    </main>
  );
}
