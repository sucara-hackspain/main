import { useEffect, useMemo, useRef, useState } from "react";
import { clock, describe, describeAction, type GraphData, type RunMeta, type TickRecord, type WorldEvent } from "../../src/engine";
import { AMBULANCE_COLORS, ambulanceState, MapView, type MapHandle } from "./MapView";

const POLL_MS = 1500;
const SPEEDS = [1, 2, 5, 10, 20];

const EVENT_TONE: Partial<Record<WorldEvent["type"], string>> = {
  patient_spawned: "call",
  patient_delivered: "good",
  patient_died: "bad",
  road_closed: "warn",
  ambulance_broken: "warn",
  ambulance_stranded: "warn",
  hospital_full: "warn",
  dispatch_void: "warn",
  action_rejected: "bad",
  action_applied: "order",
};

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

  const mapRef = useRef<MapHandle>(null);
  const playhead = useRef(0);
  const live = useRef({ ticks, playing, follow, speed });
  live.current = { ticks, playing, follow, speed };

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
      const { ticks, playing, follow, speed } = live.current;
      const end = Math.max(ticks.length - 1, 0);
      if (follow) playhead.current = end;
      else if (playing) playhead.current = Math.min(playhead.current + dt * speed, end);
      mapRef.current?.draw(ticks, playhead.current);
      setIndex(Math.floor(playhead.current));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const isLive = meta?.status === "running";
  const current = ticks[Math.min(index, ticks.length - 1)];
  const tickSeconds = meta?.config.tickSeconds ?? 30;

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
          detail: record.actions.map((a, i) => `${describeAction(a)}${d.reasons?.[i] ? ` — ${d.reasons[i]}` : ""}`),
        });
      }
      record.events.forEach((e, i) => {
        if (e.type === "action_applied" && d?.source === "llm") return; // already inside the decision card
        items.push({ key: `e${record.tick}-${i}`, tick: e.tick, tone: EVENT_TONE[e.type] ?? "info", text: describe(e) });
      });
    }
    return items.reverse().slice(0, 120);
  }, [ticks, index]);

  const marks = useMemo(
    () =>
      ticks.flatMap((r, i) => {
        const tone = r.events.some((e) => e.type === "patient_died")
          ? "bad"
          : r.events.some((e) => e.type === "road_closed" || e.type === "ambulance_broken")
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
  return (
    <div className="app">
      <main className="stage">
        {graph && meta ? <MapView ref={mapRef} graph={graph} meta={meta} /> : <div className="empty">{runs.length ? "Cargando…" : "No hay simulaciones. Lanza una con: pnpm run-sim"}</div>}

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
        </header>

        <section className="kpis">
          <div className="good"><b>{summary?.saved ?? 0}</b><span>salvados</span></div>
          <div className="bad"><b>{summary?.dead ?? 0}</b><span>muertos</span></div>
          <div><b>{(summary?.waiting ?? 0) + (summary?.inAmbulance ?? 0)}</b><span>abiertos</span></div>
          <div><b>{summary ? Math.round(summary.survivalRate * 100) : 100}%</b><span>supervivencia</span></div>
        </section>

        <section>
          <h2>Flota</h2>
          <ul className="fleet">
            {current?.frame.ambulances.map((a, i) => {
              const state = ambulanceState(a);
              return (
                <li key={a.id}>
                  <i style={{ background: state.color, borderColor: AMBULANCE_COLORS[i % AMBULANCE_COLORS.length] }} />
                  <b>{a.id}</b>
                  <span>{state.label}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h2>Hospitales · camas libres</h2>
          <ul className="hospitals">
            {meta?.hospitals.map((h) => {
              const occupied = current?.frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
              return (
                <li key={h.id} title={h.name}>
                  <b>{h.id}</b>
                  <span className="name">{h.name}</span>
                  <span className="beds"><i style={{ width: `${(occupied / h.capacity) * 100}%` }} /></span>
                  <span>{h.capacity - occupied}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="feed">
          <h2>Qué está pasando · {current?.frame.closedEdges.length ?? 0} calles cortadas</h2>
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
