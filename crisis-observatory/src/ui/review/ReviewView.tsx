import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, ScrollText } from "lucide-react";
import type { Evaluation, Finding, FindingKind } from "../../../../gabriel/src/memory/evaluate";
import { elapsed, type RunMeta } from "../engineTrace";
import "./review.css";

// The night's post-mortem: what the engine's hindsight evaluator wrote when the run ended (runs/<id>/evaluation.json).
// It reads the ground truth the coordinator never had and gives every death and wasted trip a cause.

const KIND: Record<FindingKind, string> = {
  death_never_dispatched: "Murió sin que se mandara a nadie",
  death_late: "Murió antes de que llegara la ayuda",
  death_trapped_waiting: "Murió atrapado, sin nadie que lo liberara",
  death_left_waiting: "Murió esperando una segunda unidad",
  death_in_transport: "Murió en el traslado",
  death_in_water: "Murió dentro del agua",
  wasted_nobody_there: "Salida en vano: no había nadie",
  wasted_trapped_no_fire: "Salida en vano: atrapado sin bomberos",
  wasted_turned_back: "Salida en vano: el agua la hizo volver",
  hospital_rejected: "Hospital sin camas",
  saved_critical: "Crítico salvado a tiempo",
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function ReviewView({ runId, meta, seconds, onIncident }: { runId: string; meta: RunMeta | null; seconds: number; onIncident: (id: string) => void }) {
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [missing, setMissing] = useState(false);
  const running = meta?.status === "running";

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setEvaluation(null);
    setMissing(false);
    async function poll() {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/evaluation`, { signal: abort.signal, cache: "no-store" });
        if (response.ok) return setEvaluation((await response.json()) as Evaluation);
        setMissing(true);
      } catch {
        if (abort.signal.aborted) return;
      }
      // Not there yet: the night is still on, or the file is being written. Look again in a while.
      timer = setTimeout(poll, 10_000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [runId, running]);

  if (!evaluation) {
    return <section className="review-view" aria-label="Balance de la noche">
      <ReviewHeading runId={runId} />
      <div className="review-empty"><ScrollText size={28} />
        <h2>{running ? "La noche sigue en marcha" : missing ? "Esta ejecución no dejó balance" : "Leyendo el balance…"}</h2>
        <p>{running ? "El balance se escribe cuando termina: cada fallecido y cada salida en vano, con su causa." : missing ? "El motor lo escribe al acabar la sesión; una noche interrumpida no lo tiene." : ""}</p>
      </div>
    </section>;
  }

  const { summary: s, counts, findings } = evaluation;
  const bad = findings.filter((f) => !f.good).sort((a, b) => a.tick - b.tick);
  const good = findings.filter((f) => f.good).sort((a, b) => a.tick - b.tick);
  const kinds = (Object.keys(counts) as FindingKind[]).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  const tiles: [string, string][] = [
    ["Víctimas", String(s.victims)],
    ["Salvadas", String(s.saved)],
    ["Fallecidas", String(s.dead)],
    ["Supervivencia", `${pct(s.survivalRate)} · ${pct(s.reachableSurvivalRate)} de las alcanzables`],
    ["Perdidas en el agua", String(s.inWater)],
    ["Respuesta a críticos", evaluation.criticalResponseTicks === null ? "—" : `+${elapsed(evaluation.criticalResponseTicks, seconds)} de media`],
    ["Decisiones del agente", `${evaluation.decisions.llm} · ${evaluation.decisions.fallback} por reglas${evaluation.decisions.meanMs ? ` · ${(evaluation.decisions.meanMs / 1000).toFixed(0)} s cada una` : ""}`],
  ];

  return <section className="review-view" aria-label="Balance de la noche">
    <ReviewHeading runId={runId} ticks={evaluation.ticks} seconds={seconds} />
    <div className="review-tiles">{tiles.map(([label, value]) => <div className="review-tile" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="review-columns">
      <div>
        <h2>Causas <span>{findings.length}</span></h2>
        <ul className="review-counts">{kinds.map((k) => <li key={k} className={k === "saved_critical" ? "is-good" : "is-bad"}><strong>{counts[k]}</strong>{KIND[k]}</li>)}</ul>
        {evaluation.hospitalLoad.length > 0 && <>
          <h2>Hospitales</h2>
          <ul className="review-counts">{evaluation.hospitalLoad.map((h) => <li key={h.id}><strong>{h.delivered}/{h.capacity}</strong>{h.name}</li>)}</ul>
        </>}
        {evaluation.ruleUse.length > 0 && <>
          <h2>Doctrina citada</h2>
          <p className="review-rules">{evaluation.ruleUse.map((r) => <code key={r.ruleId}>{r.ruleId} ×{r.times}</code>)}</p>
        </>}
      </div>
      <div>
        <h2>Lo que salió mal <span>{bad.length}</span></h2>
        <ol className="review-findings">{bad.map((f) => <FindingRow key={f.id} finding={f} seconds={seconds} onIncident={onIncident} />)}</ol>
        {good.length > 0 && <>
          <h2>Lo que salió bien <span>{good.length}</span></h2>
          <ol className="review-findings">{good.map((f) => <FindingRow key={f.id} finding={f} seconds={seconds} onIncident={onIncident} />)}</ol>
        </>}
      </div>
    </div>
  </section>;
}

function ReviewHeading({ runId, ticks, seconds }: { runId: string; ticks?: number; seconds?: number }) {
  return <header className="review-heading">
    <div><span className="app-eyebrow">BALANCE DE LA NOCHE</span><h1>Evaluación</h1><p>Con la verdad que el coordinador nunca tuvo: la causa de cada fallecido y de cada salida en vano.</p></div>
    <span className="review-run"><Clock3 size={13} />{ticks && seconds ? `${elapsed(ticks, seconds)} de noche · ` : ""}<code>{runId}</code></span>
  </header>;
}

function FindingRow({ finding: f, seconds, onIncident }: { finding: Finding; seconds: number; onIncident: (id: string) => void }) {
  return <li className={f.good ? "is-good" : "is-bad"}>
    <span className="review-when">{f.good ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}+{elapsed(f.tick, seconds)}</span>
    <div>
      <strong>{f.title}</strong>
      <p>{f.detail}</p>
      <span className="review-links">
        {f.incidentIds.map((id) => <button key={id} onClick={() => onIncident(id)}>{id}</button>)}
        {f.victimId && <code>{f.victimId}</code>}
        {f.ruleIds.map((r) => <code key={r} title="regla de la doctrina citada en este incidente">{r}</code>)}
      </span>
    </div>
  </li>;
}
