import { useEffect, useMemo, useRef, useState } from "react";
import { clock, describe, describeAction, type GraphData, type RunMeta, type TickRecord, type WorldEvent } from "../../src/engine";
import { INCIDENT_LABEL, KIND_COLOR, MapView, unitState, type MapHandle, type View } from "./MapView";

const POLL_MS = 1500;
const SPEEDS = [1, 2, 5, 10, 20];

const EVENT_TONE: Partial<Record<WorldEvent["type"], string>> = {
  patient_spawned: "call",
  patient_delivered: "good",
  patient_extricated: "good",
  incident_resolved: "good",
  patient_died: "bad",
  incident_started: "alert",
  zone_started: "alert",
  hospital_down: "alert",
  road_closed: "warn",
  road_discovered: "warn",
  unit_broken: "warn",
  unit_stranded: "warn",
  hospital_rejected: "warn",
  dispatch_void: "warn",
  false_alarm: "warn",
  action_rejected: "bad",
  action_applied: "order",
  backup_arrived: "good",
};
// Chatter that would bury what matters.
const FEED_HIDDEN = new Set<WorldEvent["type"]>(["unit_rerouted", "patient_assessed", "zone_grew", "unit_free", "unit_repaired"]);

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
  const [view, setView] = useState<View>("truth");

  const mapRef = useRef<MapHandle>(null);
  const playhead = useRef(0);
  const live = useRef({ ticks, playing, follow, speed, view });
  live.current = { ticks, playing, follow, speed, view };

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
      const { ticks, playing, follow, speed, view } = live.current;
      const end = Math.max(ticks.length - 1, 0);
      if (follow) playhead.current = end;
      else if (playing) playhead.current = Math.min(playhead.current + dt * speed, end);
      mapRef.current?.draw(ticks, playhead.current, view);
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
      (view === "belief" ? record.heard : record.events).forEach((e, i) => {
        if (FEED_HIDDEN.has(e.type)) return;
        if (e.type === "action_applied" && d?.source === "llm") return; // already inside the decision card
        items.push({ key: `e${record.tick}-${i}`, tick: e.tick, tone: EVENT_TONE[e.type] ?? "info", text: describe(e) });
      });
    }
    return items.reverse().slice(0, 120);
  }, [ticks, index, view]);

  const marks = useMemo(
    () =>
      ticks.flatMap((r, i) => {
        const tone = r.events.some((e) => e.type === "patient_died")
          ? "bad"
          : r.events.some((e) => e.type === "incident_started" || e.type === "zone_started" || e.type === "hospital_down")
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
                {r.scenario} · {r.coordinator}
                {r.model ? ` (${r.model})` : ""} · seed {r.seed} · {r.startedAt.slice(11, 16)}
              </option>
            ))}
          </select>
          <div className="toggle">
            <button className={view === "truth" ? "on" : ""} onClick={() => setView("truth")}>Realidad</button>
            <button className={view === "belief" ? "on" : ""} onClick={() => setView("belief")}>Lo que sabe el coordinador</button>
          </div>
        </header>

        <section className="kpis">
          <div className="good"><b>{summary?.saved ?? 0}</b><span>salvados</span></div>
          <div className="bad"><b>{summary?.dead ?? 0}</b><span>muertos</span></div>
          <div><b>{(summary?.waiting ?? 0) + (summary?.inAmbulance ?? 0)}</b><span>abiertos</span></div>
          <div><b>{summary ? `${summary.points}` : 0}<small>/{summary?.maxPoints ?? 0}</small></b><span>puntos</span></div>
        </section>

        <section>
          <h2>Unidades</h2>
          <ul className="fleet">
            {current?.frame.units.map((u) => {
              const state = unitState(u);
              return (
                <li key={u.id}>
                  <i style={{ background: KIND_COLOR[u.kind], borderColor: state.color }} />
                  <b>{u.id}</b>
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
              const state = current?.frame.hospitals.find((x) => x.id === h.id);
              const occupied = state?.occupied ?? 0;
              const tags = [...h.specialties.filter((x) => x !== "general"), ...(h.helipad ? ["heli"] : [])];
              return (
                <li key={h.id} title={h.name} className={state?.offline ? "offline" : ""}>
                  <b>{h.id}</b>
                  <span className="name">{h.name.replace(/^Hospital (Universitari i Politècnic |Universitari )?/, "")}{tags.map((t) => <em key={t}>{t}</em>)}</span>
                  <span className="beds"><i style={{ width: `${(occupied / h.capacity) * 100}%` }} /></span>
                  <span>{state?.offline ? "✕" : h.capacity - occupied}</span>
                </li>
              );
            })}
          </ul>
        </section>

        {current && current.frame.incidents.length + current.frame.zones.length > 0 && (
          <section>
            <h2>Frentes abiertos</h2>
            <ul className="fronts">
              {current.frame.zones.map((z) => (
                <li key={z.id}>
                  <b>{z.id}</b> {z.label} · {z.radiusM} m{z.kind === "flood" && z.knownRadiusM !== null && z.knownRadiusM < z.radiusM - 60 ? ` (el coordinador cree ${Math.round(z.knownRadiusM)} m)` : ""}
                </li>
              ))}
              {current.frame.incidents.filter((x) => x.kind !== "obstacle").map((x) => (
                <li key={x.id} className={x.known ? "" : "unknown"}>
                  <b>{x.id}</b> {INCIDENT_LABEL[x.kind]} · {x.label}{x.known ? "" : " · aún sin avisar"}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="feed">
          <h2>{view === "belief" ? "Lo que le llega al coordinador" : "Qué está pasando"} · {current?.frame.closedEdges.length ?? 0} calles cortadas ({current?.frame.knownClosedEdges.length ?? 0} conocidas)</h2>
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
