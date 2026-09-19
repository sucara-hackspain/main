import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Route,
  Megaphone,
  Scale,
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
import EntityCard from "./situation/EntityCard";
import {
  buildSituation,
  matchingEntities,
  relatedEntities,
  type SituationFilter,
} from "./situation/model";
import DecisionPanel, { DecisionStrip } from "./decisions/DecisionPanel";
import { decisionCards } from "./decisions/model";
import SignalsView from "./signals/SignalsView";
import PressView from "./press/PressView";
import PlanView from "./plan/PlanView";
import "./press/press.css";
import { channelView } from "./signals/model";
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

const RunMap = lazy(() => import("./map/RunMap"));
const ASK_FOR_APPROVAL = false;
const NO_PENDING: ReturnType<typeof useInterventions>["pending"] = [];

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
              "Aquí aparecerán las ejecuciones y sus incidencias."}
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
    // Incidents first: the operator starts from what is happening, then goes to the territory.
    [view, setView] = useState<"map" | "tickets" | "decisions" | "signals" | "press" | "plan">("tickets"),
    [leadFocus, setLeadFocus] = useState<string | null>(null),
    [orderFocus, setOrderFocus] = useState<string | null>(null),
    [ticketId, setTicketId] = useState<string | null>(null),
    [ticketFilter, setTicketFilter] = useState<TicketState | "all">("all"),
    [ticketQuery, setTicketQuery] = useState(""),
    [entity, setEntity] = useState<Selection | null>(null),
    [filter, setFilter] = useState<SituationFilter>("all"),
    [query, setQuery] = useState(""),
    [showClosed, setShowClosed] = useState(false),
    [focusRequest, setFocusRequest] = useState(0),
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
  const { router } = interventions;
  // Approvals are switched off for now: the coordinator acts on its own and nothing takes over the screen,
  // pauses the replay or rings. Set ASK_FOR_APPROVAL back to true to have the operator asked again.
  const pending = ASK_FOR_APPROVAL ? interventions.pending : NO_PENDING;
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
  // Decisions are read with hindsight: what came of each order is looked up in the ticks that followed.
  const cards = useMemo(() => (graph && meta ? decisionCards(ticks, graph, meta) : []), [ticks, graph, meta]);
  const channel = useMemo(() => {
    if (!graph) return null;
    const rad = Math.PI / 180;
    const distanceM = (a: number, b: number) => {
      const [lon1, lat1] = graph.nodes[a], [lon2, lat2] = graph.nodes[b];
      const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad), y = (lat2 - lat1) * rad;
      return Math.sqrt(x * x + y * y) * 6371000;
    };
    return channelView(visible, distanceM);
  }, [visible, graph]);
  const notes = useMemo(() => visible.flatMap((r) => (r.press ? [r.press] : [])), [visible]);
  const card = useMemo(() => [...cards].reverse().find((c) => c.tick <= (current?.tick ?? 0)) ?? cards[0] ?? null, [cards, current]);
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
              aria-pressed={view === "map"}
              className={view === "map" ? "is-active" : ""}
              onClick={() => setView("map")}
            >
              <MapIcon size={14} />
              Territorio
            </button>
            <button
              aria-pressed={view === "decisions"}
              className={view === "decisions" ? "is-active" : ""}
              onClick={() => {
                setView("decisions");
                const nearest = [...cards].reverse().find((c) => c.tick <= (current?.tick ?? 0)) ?? cards[0];
                if (nearest) seekTick(nearest.tick);
              }}
            >
              <Scale size={14} />
              Decisiones
            </button>
            <button aria-pressed={view === "plan"} className={view === "plan" ? "is-active" : ""} onClick={() => setView("plan")}>
              <Route size={14} />
              Plan
            </button>
            <button aria-pressed={view === "press"} className={view === "press" ? "is-active" : ""} onClick={() => setView("press")}>
              <Megaphone size={14} />
              Prensa{notes.length ? ` · ${notes.length}` : ""}
            </button>
            <button aria-pressed={view === "signals"} className={view === "signals" ? "is-active" : ""} onClick={() => setView("signals")}>
              <Radio size={14} />
              Señales{channel ? ` · ${channel.leads.length}` : ""}
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
              className={!selection && !filtered ? "is-active" : ""}
              onClick={() => {
                chooseEntity(null);
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
          </div>
          <span>
            {current?.frame.incidents.filter((i) => i.status === "open").length ?? 0} incidentes abiertos{" "}
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
          ) : view === "plan" ? (
            <PlanView cards={cards} tick={current.tick} lastTick={ticks.at(-1)?.tick ?? 0} seconds={seconds} onDecision={(c) => { setView("decisions"); seekTick(c.tick); }} />
          ) : view === "press" ? (
            <PressView notes={notes} seconds={seconds} every={10} />
          ) : view === "signals" ? (
            <SignalsView view={channel} seconds={seconds} focus={leadFocus} onFocus={setLeadFocus} />
          ) : (
            graph &&
            meta && (
              <Suspense fallback={<div className="app-empty">Cargando mapa…</div>}>
                {view === "decisions" && <DecisionStrip cards={cards} active={card} onGo={(c) => seekTick(c.tick)} />}
                <RunMap
                  signals={channel ? { heat: channel.heat, leads: channel.leads.map((l) => ({ id: l.id, node: l.node, credibility: l.credibility, tone: l.outcome.tone })), focus: leadFocus } : null}
                  explain={view === "decisions" && card ? {
                    orders: card.orders.map((o) => ({ key: o.key, kind: o.kind, from: o.from, to: o.to, own: card.compared && !o.shared })),
                    rules: card.rulesOnly.map((o) => ({ from: o.from, to: o.to })),
                    held: card.holds.map((h) => h.unitId),
                    waterAhead: card.waterAhead,
                    focus: orderFocus,
                  } : null}
                  graph={graph}
                  meta={meta}
                  record={current}
                  selected={selection}
                  onSelect={(ref) =>
                    chooseEntity(ref && sameSelection(selection, ref) ? null : ref)
                  }
                  focusRequest={focusRequest}
                  related={related}
                  matches={matches}
                  filtered={filtered}
                  detail={
                    selection &&
                    situation && (
                      <EntityCard
                        s={situation}
                        selection={selection}
                        graph={graph}
                        ticket={
                          selection.kind === "incident"
                            ? (tickets.find((t) => t.id === selection.id) ?? null)
                            : null
                        }
                        onSelect={chooseEntity}
                        onOpenTicket={(incidentId) => {
                          setTicketId(incidentId);
                          setView("tickets");
                        }}
                      />
                    )
                  }
                />
              </Suspense>
            )
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
        {view === "decisions" ? <DecisionPanel cards={cards} card={card} seconds={seconds} focus={orderFocus} onFocus={setOrderFocus} onGo={(c) => seekTick(c.tick)} /> : view === "tickets" ? <TicketDetail ticket={selectedTicket} seconds={seconds} tick={current?.tick ?? 0}
          onLocate={locateTicket} onClose={() => setTicketId(null)} runs={runs} runId={id} onRun={onRun} records={ticks.length} /> : <SituationSidebar
          id={id}
          runs={runs}
          onRun={onRun}
          situation={situation}
          selection={selection}
          onSelect={(ref) => {
            chooseEntity(ref);
            // On a phone the map is above the list: bring it into view, where the detail opens.
            if (ref && view === "map") setFocusRequest((n) => n + 1);
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
