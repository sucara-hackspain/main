import { useEffect, useMemo, useRef, useState } from "react";
import {
  clock,
  describe,
  describeAction,
  type Call,
  type GraphData,
  type ObservedEvent,
  type RunMeta,
  type TickRecord,
} from "../../src/engine";
import { IncidentBoard, IncidentDetail } from "./Incidents";
import { KnowledgeGraph } from "./Knowledge";
import { MemoryGraph } from "./Memory";
import { ambulanceState, KIND_COLORS, KIND_LABELS, MapView, PRIORITY_COLORS, type MapHandle, type ViewMode } from "./MapView";

const POLL_MS = 1500;
const SPEEDS = [1, 2, 5, 10, 20];

const EVENT_TONE: Partial<Record<ObservedEvent["type"], string>> = {
  call_received: "call",
  scene_assessed: "radio",
  scene_not_found: "warn",
  flood_bulletin: "water",
  road_blocked_found: "water",
  victim_delivered: "good",
  victim_treated: "good",
  victim_died: "bad",
  flood_started: "water",
  flood_grew: "water",
  road_closed: "warn",
  unit_broken: "warn",
  unit_stranded: "warn",
  hospital_full: "warn",
  action_rejected: "bad",
  action_applied: "order",
};
/** Things the coordinator is never told: only shown in the "Realidad" view. */
const TRUTH_ONLY = new Set<ObservedEvent["type"]>(["scene_created", "victim_died", "flood_started", "flood_grew"]);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export function App() {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [ticks, setTicks] = useState<TickRecord[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [follow, setFollow] = useState(true);
  const [speed, setSpeed] = useState(5);
  const [mode, setMode] = useState<ViewMode>("belief");
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "board" | "graph" | "memory">("map");

  const mapRef = useRef<MapHandle>(null);
  const playhead = useRef(0);
  const live = useRef({ ticks, playing, follow, speed, mode, selected });
  live.current = { ticks, playing, follow, speed, mode, selected };

  // Run list, newest first. The newest run is selected on load.
  useEffect(() => {
    const load = () =>
      getJson<RunMeta[]>("/api/runs")
        .then((list) => {
          setRuns(list);
          setRunId((current) => current ?? list[0]?.id ?? null);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  // Selected run: load everything, then keep polling for new ticks while it is running.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let loaded = 0;
    let timer: ReturnType<typeof setTimeout>;
    setTicks([]);
    setMeta(null);
    setSelected(null);
    playhead.current = 0;
    setIndex(0);

    const poll = async () => {
      try {
        const data = await getJson<{ meta: RunMeta; ticks: TickRecord[] }>(`/api/runs/${runId}?from=${loaded}`);
        if (cancelled) return;
        loaded += data.ticks.length;
        setMeta(data.meta);
        if (data.ticks.length) setTicks((prev) => [...prev, ...data.ticks]);
        if (data.meta.status !== "running") return;
      } catch {
        // dev server restarting: try again
      }
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    if (!meta) return;
    if (graph?.name === meta.map) return;
    getJson<GraphData>(`/api/graph/${meta.map}`).then(setGraph);
  }, [meta?.map]);

  // Playback clock. The map is drawn imperatively every frame; React only re-renders when the tick changes.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const { ticks, playing, follow, speed, mode, selected } = live.current;
      const end = Math.max(ticks.length - 1, 0);
      if (follow) playhead.current = end;
      else if (playing) playhead.current = Math.min(playhead.current + dt * speed, end);
      mapRef.current?.draw(ticks, playhead.current, mode, selected);
      setIndex(Math.floor(playhead.current));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const isLive = meta?.status === "running";
  const current = ticks[Math.min(index, ticks.length - 1)];
  const tickSeconds = meta?.config.tickSeconds ?? 30;

  const calls = useMemo(() => {
    const byId = new Map<string, Call>();
    for (const record of ticks) for (const call of record.calls) byId.set(call.id, call);
    return byId;
  }, [ticks]);

  const feed = useMemo(() => {
    const items: { key: string; tick: number; tone: string; text: string; detail?: string[]; badge?: string }[] = [];
    for (const record of ticks.slice(0, index + 1)) {
      const d = record.decision;
      if (d && d.source !== "rules") {
        items.push({
          key: `d${record.tick}`,
          tick: record.tick,
          tone: d.source === "llm" ? "llm" : "bad",
          badge: d.source === "llm" ? `IA · ${((d.ms ?? 0) / 1000).toFixed(1)} s` : "FALLBACK",
          text: d.situation ?? "",
          detail: record.actions.map((a, i) => `${describeAction(a)}${d.reasons?.[i] ? ` — ${d.reasons[i]}` : ""}${d.applies?.[i]?.length ? ` [${d.applies[i].join(", ")}]` : ""}`),
        });
      }
      record.events.forEach((e, i) => {
        if (e.type === "action_applied" && d?.source === "llm") return; // already inside the decision card
        if (mode === "belief" && TRUTH_ONLY.has(e.type)) return;
        items.push({
          key: `e${record.tick}-${i}`,
          tick: e.tick,
          tone: TRUTH_ONLY.has(e.type) ? "truth" : (EVENT_TONE[e.type] ?? "info"),
          text: describe(e),
        });
      });
    }
    return items.reverse().slice(0, 120);
  }, [ticks, index, mode]);

  const marks = useMemo(
    () =>
      ticks.flatMap((r, i) => {
        const tone = r.events.some((e) => e.type === "victim_died")
          ? "bad"
          : r.events.some((e) => e.type === "road_blocked_found" || e.type === "unit_broken")
            ? "warn"
            : r.decision?.source === "llm"
              ? "llm"
              : null;
        return tone ? [{ i, tone }] : [];
      }),
    [ticks],
  );

  const seek = (value: number) => {
    playhead.current = value;
    setFollow(false);
    setPlaying(false);
  };

  const summary = current?.frame.summary;
  const open = (current?.frame.incidents ?? [])
    .filter((i) => i.status === "open")
    .sort((a, b) => a.priority - b.priority || a.openedTick - b.openedTick);
  const detail = current?.frame.incidents.find((i) => i.id === selected);

  return (
    <div className="app">
      <main className="stage">
        {graph && meta ? <MapView ref={mapRef} graph={graph} meta={meta} /> : <div className="empty">{runs.length ? "Cargando…" : "No hay simulaciones. Lanza una con: pnpm run-sim"}</div>}

        {current && view === "board" && (
          <IncidentBoard frame={current.frame} tick={current.tick} tickSeconds={tickSeconds} selected={selected} onSelect={setSelected} />
        )}
        {current && meta && view === "graph" && (
          <KnowledgeGraph frame={current.frame} meta={meta} calls={calls} selected={selected} onSelect={setSelected} />
        )}
        {view === "memory" && <MemoryGraph />}
        <div className="views">
          <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>Mapa</button>
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
            Incidencias <b>{open.length}</b>
          </button>
          <button className={view === "graph" ? "on" : ""} onClick={() => setView("graph")}>Qué sabe el agente</button>
          <button className={view === "memory" ? "on" : ""} onClick={() => setView("memory")}>Memoria</button>
        </div>

        <div className="transport">
          <button
            className="primary"
            onClick={() => {
              if (follow) setFollow(false);
              else if (playhead.current >= ticks.length - 1) playhead.current = 0;
              setPlaying(follow ? false : !playing);
            }}
          >
            {playing && !follow ? "❚❚" : "▶"}
          </button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s} ticks/s
              </option>
            ))}
          </select>
          <div className="scrubber">
            <div className="marks">
              {marks.map((m) => (
                <i key={m.i} className={m.tone} style={{ left: `${(m.i / Math.max(ticks.length - 1, 1)) * 100}%` }} />
              ))}
            </div>
            <input type="range" min={0} max={Math.max(ticks.length - 1, 0)} step={0.01} value={Math.min(playhead.current, ticks.length - 1)} onChange={(e) => seek(Number(e.target.value))} />
          </div>
          <span className="clock">
            {clock(current?.tick ?? 0, tickSeconds)} · t{current?.tick ?? 0}/{meta?.ticks ?? 0}
          </span>
          <button className={follow ? "live on" : "live"} onClick={() => setFollow(!follow)} title="Seguir el último tick">
            ● {isLive ? "EN VIVO" : "FINAL"}
          </button>
        </div>
      </main>

      <aside className="panel">
        <header>
          <h1>Coordinación de emergencias</h1>
          <select value={runId ?? ""} onChange={(e) => (setFollow(true), setRunId(e.target.value))}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.status === "running" ? "● " : ""}
                {r.coordinator}
                {r.model ? ` (${r.model})` : ""} · seed {r.seed} · {r.startedAt.slice(11, 16)}
              </option>
            ))}
          </select>
          <div className="modes">
            <button className={mode === "belief" ? "on" : ""} onClick={() => setMode("belief")}>Lo que sabe el coordinador</button>
            <button className={mode === "truth" ? "on" : ""} onClick={() => setMode("truth")}>Realidad</button>
          </div>
        </header>

        <section className="kpis">
          <div className="good"><b>{summary?.saved ?? 0}</b><span>atendidos</span></div>
          <div className="bad"><b>{summary?.dead ?? 0}</b><span>muertos</span></div>
          <div><b>{(summary?.waiting ?? 0) + (summary?.inAmbulance ?? 0)}</b><span>abiertos</span></div>
          <div><b>{summary ? Math.round(summary.survivalRate * 100) : 100}%</b><span>supervivencia</span></div>
        </section>

        <section>
          <h2>Unidades</h2>
          <ul className="fleet">
            {current?.frame.units.map((a) => {
              const state = ambulanceState(a);
              return (
                <li key={a.id} title={KIND_LABELS[a.kind]}>
                  <i style={{ background: state.color, borderColor: KIND_COLORS[a.kind] }} />
                  <b>{a.id}</b>
                  <span>{state.label}</span>
                </li>
              );
            })}
          </ul>
          <p className="kinds">
            {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => (
              <span key={k}><i style={{ borderColor: KIND_COLORS[k] }} /> {KIND_LABELS[k]}</span>
            ))}
          </p>
        </section>

        <section>
          <h2>Hospitales · camas libres</h2>
          <ul className="hospitals">
            {meta?.hospitals.map((h) => {
              const occupied = current?.frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
              return (
                <li key={h.id} title={h.name}>
                  <b>{h.id}</b>
                  <span className="name">{h.helipad ? "🚁 " : ""}{h.name}</span>
                  <span className="beds"><i style={{ width: `${(occupied / h.capacity) * 100}%` }} /></span>
                  <span>{h.capacity - occupied}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="incidents">
          <h2>Incidentes abiertos · {open.length}</h2>
          <ul>
            {open.map((inc) => (
              <li key={inc.id} className={inc.id === selected ? "on" : ""} onClick={() => setSelected(inc.id === selected ? null : inc.id)}>
                <b style={{ background: PRIORITY_COLORS[inc.priority] }}>P{inc.priority}</b>
                <span>{inc.line.split(" · ").slice(2).join(" · ")}</span>
                <em>{inc.id}</em>
              </li>
            ))}
            {open.length === 0 && <li className="none">ninguno</li>}
          </ul>
          {detail && current && (
            <IncidentDetail incident={detail} frame={current.frame} calls={calls} mode={mode} tickSeconds={tickSeconds} onClose={() => setSelected(null)} />
          )}
        </section>

        <section className="feed">
          <h2>
            Qué está pasando · tramos cortados: {current?.frame.knownClosedEdges.length ?? 0} conocidos
            {mode === "truth" ? ` de ${current?.frame.closedEdges.length ?? 0} reales` : ""}
          </h2>
          <ol>
            {feed.map((item) => (
              <li key={item.key} className={item.tone}>
                <time>{clock(item.tick, tickSeconds).slice(0, 5)}</time>
                <div>
                  {item.badge && <em>{item.badge}</em>}
                  <p>{item.text}</p>
                  {item.detail?.map((d, i) => <p key={i} className="detail">→ {d}</p>)}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  );
}
