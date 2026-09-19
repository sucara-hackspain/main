import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  LayoutDashboard,
  Pause,
  Play,
  Radio,
  RotateCcw,
  X,
} from "lucide-react";
import { useRun, useRuns } from "./useRuns";
import {
  elapsed,
  type RunMeta,
} from "./engineTrace";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../theme.css";
import "./control-center.css";
import "./session.css";
import { buildSituation } from "./situation/model";
import { auditItems } from "./audit/model";
import DecisionBanner from "./interventions/DecisionBanner";
import DecisionRoom, { PendingDecisionBar } from "./interventions/DecisionRoom";
import { DecisionReceipt } from "./interventions/DecisionParts";
import InterventionInbox from "./interventions/InterventionInbox";
import { useInterventions } from "./interventions/useInterventions";
import { useAlertSound } from "./interventions/sound";
import type { InterventionView, Option } from "./interventions/model";
import TicketsView, { TicketDetail } from "./tickets/TicketsView";
import { buildTickets, type Ticket, type TicketState } from "./tickets/model";
import OperationsView from "./operations/OperationsView";
import { SCALE_ID, scaleMeta } from "./operations/demo";
import { inQueue, queueLabels, sectorDefinitions, sectorIndex, type Queue, type Sector } from "./operations/model";

// Read once: a run that mounts while another shows a pending count would take the count as its title.
const pageTitle = document.title;
const noRecords: import("./engineTrace").TickRecord[] = [];
// The operations queue is the default; earlier banner and interruption layouts remain opt-in.
const params = new URLSearchParams(window.location.search);
const iteration = params.get("iteracion") === "1" ? 1 : params.get("iteracion") === "2" ? 2 : 3;
export default function ControlCenter() {
  const { runs: recordedRuns, error, loaded } = useRuns();
  const runs = useMemo(() => [...recordedRuns, scaleMeta], [recordedRuns]);
  const [selected, setSelected] = useState(params.get("escala") === "1" ? SCALE_ID : "");
  const id = selected || recordedRuns[0]?.id;
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
              "Aquí aparecerán las ejecuciones y sus incidencias."}
          </p>
          {loaded && (
            <p>Los nuevos registros aparecerán aquí automáticamente.</p>
          )}
          <button onClick={() => setSelected(SCALE_ID)}>Explorar escenario simulado · 2.400 casos</button>
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
    [follow, setFollow] = useState(iteration === 3 && !params.has("inicio")),
    [speed, setSpeed] = useState(2),
    [view, setView] = useState<"operations" | "tickets">(iteration === 3 ? "operations" : "tickets"),
    [sectorId, setSectorId] = useState<string | null>(null),
    [ticketScope, setTicketScope] = useState<{ sectorId: string | null; queue: Queue } | null>(null),
    [ticketId, setTicketId] = useState<string | null>(null),
    [ticketFilter, setTicketFilter] = useState<TicketState | "all">("all"),
    [ticketQuery, setTicketQuery] = useState(""),
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
  const interventions = useInterventions({ ticks: id === SCALE_ID ? noRecords : ticks, current,
    graph: id === SCALE_ID ? null : graph, meta: id === SCALE_ID ? null : meta });
  const { pending, router } = interventions;
  const sound = useAlertSound();
  const { chime } = sound;
  // Legacy layouts interrupt playback; the operations queue leaves navigation under operator control.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const fresh = pending.filter((x) => !asked.current.has(x.item.id));
    asked.current = new Set(pending.map((x) => x.item.id));
    if (!fresh.length) return;
    if (iteration === 3) return;
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
  const scopedTickets = useMemo(() => ticketScope ? tickets.filter((t) =>
    (!ticketScope.sectorId || !graph || `sector-${sectorIndex(graph.nodes[t.incident.node], graph) + 1}` === ticketScope.sectorId) && inQueue(t, ticketScope.queue)) : tickets,
    [tickets, ticketScope, graph]);
  const scopeName = ticketScope?.sectorId && graph ? sectorDefinitions(graph).find((s) => s.id === ticketScope.sectorId)?.name : null;
  const selectedTicket = tickets.find((ticket) => ticket.id === ticketId) ?? null;
  // Only the operations overview needs the territorial summary.
  const situation = useMemo(
    () => (view === "operations" && current && meta ? buildSituation(current, meta, visible, graph) : null),
    [view, current, meta, visible, graph],
  );
  const workspace = useRef<HTMLElement>(null);
  useEffect(() => {
    if (view === "operations" && window.matchMedia("(max-width: 800px)").matches)
      workspace.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [view]);
  function seek(i: number) {
    setIndex(i);
    setPlaying(false);
    setFollow(false);
    setHeld(false);
  }
  function seekTick(tick: number) {
    const i = ticks.findIndex((r) => r.tick === tick);
    if (i >= 0) seek(i);
  }
  function decide(item: InterventionView, option: Option, prescribed: Option) {
    interventions.decide(item, option, prescribed);
    if (iteration !== 1)
      setReceipt({ id: item.id, label: option.label, key: Date.now() });
    if (iteration === 3) setDecisionId(null);
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
  function openTicketSector(ticket: Ticket) {
    setSectorId(graph ? `sector-${sectorIndex(graph.nodes[ticket.incident.node], graph) + 1}` : null);
    setTicketId(ticket.id);
    setView("operations");
  }
  function openOperationsQueue(sector: Sector | null, queue: Queue, selectedId: string | null = null) {
    setTicketScope({ sectorId: sector?.id ?? null, queue });
    setTicketFilter("all");
    setTicketQuery("");
    setTicketId(selectedId);
    setView("tickets");
  }
  const room =
    iteration !== 1 &&
    (iteration === 2 || pending.some((p) => p.item.id === decisionId)) &&
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
        const ticket = tickets.find((t) => t.id === incidentId);
        if (ticket) openTicketSector(ticket);
      }}
    />
  );
  // While the room is open everything else stays out of reach.
  const blocked = Boolean(room);
  return (
    <main className={`app-layout${view === "operations" ? " operations-layout" : ""}`}>
      <section className="app-workspace" inert={blocked} ref={workspace}>
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
            <button aria-pressed={view === "operations"} className={view === "operations" ? "is-active" : ""} onClick={() => setView("operations")}>
              <LayoutDashboard size={14} />Operaciones
            </button>
            <button
              aria-pressed={view === "tickets"}
              className={view === "tickets" ? "is-active" : ""}
              onClick={() => setView("tickets")}
            >
              <ClipboardList size={14} />
              Incidencias
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
            VALENCIA <span>{id === SCALE_ID ? "DATOS SIMULADOS · ESCENARIO DE ESCALA" : "GESTIÓN"}</span>
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
        {banner}
        {view === "tickets" && ticketScope && <div className="ticket-scope"><span>{scopeName ?? "Todo el territorio"} · {queueLabels[ticketScope.queue]}</span><button onClick={() => setTicketScope(null)}>Quitar ámbito <X size={12} /></button></div>}
        <div className="app-stage">
          {!current ? (
            <div className="app-empty">
              {error
                ? "No hay registros compatibles disponibles."
                : "Esperando el primer registro de actividad…"}
              {view === "operations" && <label className="run-picker"><span>Ejecución</span><select aria-label="Seleccionar ejecución" value={id} onChange={(e) => onRun(e.target.value)}>{runs.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}</select></label>}
            </div>
          ) : view === "operations" && graph && meta && situation ? (
            <OperationsView graph={graph} meta={meta} record={current} records={visible} tickets={tickets} situation={situation}
              pending={pending} sectorId={sectorId} onSector={setSectorId} onTicket={(id, sector) => openOperationsQueue(sector, "all", id)}
              onQueue={openOperationsQueue} onDecision={activate} runs={runs} onRun={onRun} received={ticks.length} />
          ) : view === "tickets" ? (
            <TicketsView tickets={scopedTickets} selected={selectedTicket?.id ?? null} onSelect={setTicketId}
              filter={ticketFilter} onFilter={setTicketFilter} query={ticketQuery} onQuery={setTicketQuery}
              seconds={seconds} tick={current.tick} />
          ) : (
            <div className="app-empty">Preparando operaciones…</div>
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
      {view === "tickets" && <div className="app-sidebar-slot" inert={blocked}>
        <TicketDetail ticket={selectedTicket} seconds={seconds} tick={current?.tick ?? 0}
          onOpenSector={openTicketSector} onClose={() => setTicketId(null)} runs={runs} runId={id} onRun={onRun} records={ticks.length} />
      </div>}
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
