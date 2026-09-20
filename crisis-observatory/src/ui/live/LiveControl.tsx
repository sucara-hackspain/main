import { useEffect, useRef, useState } from "react";
import { PhoneIncoming, Radio, Square, X } from "lucide-react";
import { elapsed } from "../engineTrace";
import "./live.css";

// The live mode: one session at a time, started from here, played by the engine's live server (gabriel: pnpm live).
// Real 112 calls always go to it: into the running session, or kept for the next one.

interface LiveState {
  off?: boolean;
  error?: string;
  live: { id: string; night: string; title: string; coordinator: "hr" | "reglas"; attention: string; tickMs: number; tick: number; ticks: number; dead: number; startedAt: string; stopping: boolean } | null;
  last: { id: string; endedAt: string; dead: number; victims: number; stopped: boolean; error: string | null } | null;
  nights: { id: string; title: string; family: string; ticks: number; victims: number; read: boolean }[];
  agent: boolean;
  phone: { port: number; line: boolean; waiting: number; calls: { at: string; street: string | null; text: string; via: string; session: string | null }[] };
}

const PACES = [
  { ms: 30000, label: "Tiempo real · 30 s por registro" },
  { ms: 10000, label: "Rápido · 10 s por registro" },
  { ms: 4000, label: "Muy rápido · 4 s por registro" },
];

export default function LiveControl({ runId, seconds, onWatch }: { runId: string; seconds: number; onWatch: (id: string) => void }) {
  const [state, setState] = useState<LiveState | null>(null);
  const [open, setOpen] = useState(false);
  const [night, setNight] = useState("H1"), [coordinator, setCoordinator] = useState<"hr" | "reglas">("hr"), [tickMs, setTickMs] = useState(30000);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  async function call(path = "", body?: unknown) {
    const r = await fetch(`/api/live/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json()) as LiveState;
    if (r.ok || data.off) setState(data.off ? { ...data, live: null, last: null, nights: [], agent: false, phone: { port: 8112, line: false, waiting: 0, calls: [] } } : data);
    return { ok: r.ok, data };
  }
  useEffect(() => {
    void call().catch(() => {});
    const timer = setInterval(() => void call().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function start() {
    setBusy(true); setError(null);
    try {
      const { ok, data } = await call("start", { night, coordinator, tickMs });
      if (!ok) return setError(data.error ?? "No se pudo empezar la sesión");
      if (data.live) { onWatch(data.live.id); setOpen(false); }
    } catch { setError("Sin conexión con el modo en vivo"); } finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { await call("stop", {}); } finally { setBusy(false); }
  }

  const live = state?.live ?? null;
  const chosen = state?.nights.find((n) => n.id === night);
  const minutes = chosen ? Math.round((chosen.ticks * tickMs) / 60000) : null;
  return (
    <div className="live-control" ref={box}>
      <button className={`live-button${live ? " is-live" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="live-dot" />
        {live ? <>EN VIVO · {live.night} · +{elapsed(live.tick, seconds)}</> : "Modo en vivo"}
        {state && state.phone.waiting > 0 && <em title="Llamadas reales esperando a la próxima sesión">{state.phone.waiting}</em>}
      </button>
      {open && (
        <div className="live-popover" role="dialog" aria-label="Modo en vivo">
          <header><strong><Radio size={14} />Modo en vivo</strong><button aria-label="Cerrar" onClick={() => setOpen(false)}><X size={14} /></button></header>
          {!state ? <p className="live-muted">Conectando…</p>
            : state.off ? <p className="live-error">{state.error}</p>
            : live ? <>
              <p className="live-now"><b>{live.title}</b><span>{live.coordinator === "hr" ? "Coordina el agente de HappyRobot" : "Coordinan las reglas"} · {live.tickMs / 1000} s por registro</span></p>
              <div className="live-progress"><i style={{ width: `${(100 * live.tick) / Math.max(1, live.ticks)}%` }} /></div>
              <p className="live-muted">Registro {live.tick} de {live.ticks} · {live.dead} fallecidos hasta ahora{live.stopping ? " · parando…" : ""}</p>
              <div className="live-actions">
                {runId !== live.id && <button className="is-primary" onClick={() => { onWatch(live.id); setOpen(false); }}>Ver la sesión</button>}
                <button disabled={busy || live.stopping} onClick={stop}><Square size={12} />Parar la sesión</button>
              </div>
              <p className="live-muted">Solo puede haber una sesión en vivo a la vez: para empezar otra, para esta.</p>
            </> : <>
              <label>Noche<select value={night} onChange={(e) => setNight(e.target.value)}>
                {state.nights.map((n) => <option key={n.id} value={n.id}>{n.id} · {n.title} · {n.victims} víctimas</option>)}
              </select></label>
              <label>Quién coordina<select value={coordinator} onChange={(e) => setCoordinator(e.target.value as "hr" | "reglas")}>
                <option value="hr" disabled={!state.agent}>Agente de HappyRobot{state.agent ? "" : " (sin credenciales)"}</option>
                <option value="reglas">Reglas (sin peticiones a HappyRobot)</option>
              </select></label>
              <label>Ritmo<select value={tickMs} onChange={(e) => setTickMs(Number(e.target.value))}>
                {PACES.map((p) => <option key={p.ms} value={p.ms}>{p.label}</option>)}
              </select></label>
              {minutes !== null && <p className="live-muted">Durará unos {minutes} min{coordinator === "hr" ? ` y hará unas ${Math.round((chosen!.ticks / 3) * 1.2)} peticiones a HappyRobot` : ""}.{chosen && !chosen.read ? " Esta noche no tiene lectura del agente: el canal ciudadano lo leerá una sala." : ""}</p>}
              {error && <p className="live-error">{error}</p>}
              <div className="live-actions"><button className="is-primary" disabled={busy} onClick={start}><span className="live-dot" />Empezar sesión en vivo</button></div>
              {state.last && <p className="live-muted">Última: {state.last.id} · {state.last.error ? `falló (${state.last.error})` : `${state.last.dead} fallecidos de ${state.last.victims}${state.last.stopped ? " · parada a mano" : ""}`}</p>}
            </>}
          {state && !state.off && (
            <section className="live-phone">
              <h4><PhoneIncoming size={12} />Línea 112 real · puerto {state.phone.port}</h4>
              <p className="live-muted">{live ? "Las llamadas que entren van a esta sesión." : state.phone.waiting ? `${state.phone.waiting} llamada(s) esperando: entrarán en la próxima sesión.` : "Las llamadas que entren esperarán a la próxima sesión (15 min)."}</p>
              <ul>{state.phone.calls.slice(0, 4).map((c, n) => <li key={n}><time>{new Date(c.at).toLocaleTimeString("es-ES")}</time><span>{c.street ?? "sin calle"} · {c.text}</span><em>{c.session ? "entró" : "esperó"}</em></li>)}</ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
