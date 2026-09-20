import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bot, MapPin, Pause, PhoneIncoming, PhoneOff, Radio, Square, UserRound, Webhook } from "lucide-react";
import { sceneLabel, unitKind, type GraphData, type TickRecord } from "../engineTrace";
import type { Live, LiveAwaited } from "./useLive";

// A real person has just phoned 112, HappyRobot's voice agent took the call, and the live session is stopped on it.
// It takes the screen like a request for approval: who called, from where, what the voice agent made of it, and what
// happens next. The night only goes on once the operator takes the call in, or sets it aside.

type Ringing = Extract<LiveAwaited, { type: "call" }>;

/** What the alert looks like, with no session and no call: to look at it, or to rehearse the demo. */
export const SAMPLE_CALL: Ringing = {
  type: "call", id: "preview", policyId: "112", title: "Llamada real al 112 · Carrer de Sant Vicent Màrtir", incidentId: null, since: "", street: "Carrer de Sant Vicent Màrtir", via: "vista previa", at: [-0.38658, 39.446567],
  text: "Llamada real al 112: «Mi madre tiene 82 años, vive en un bajo y el agua le llega por la cintura. No puede subir las escaleras y casi no me contesta»",
  call: { caller: "family", mechanism: "flooded_home", street: "Carrer de Sant Vicent Màrtir", locationErrorM: 120, conscious: "yes", breathing: "difficult", bleeding: "no", trapped: "yes", ageGroup: "elderly", victims: 1,
    text: "Llamada real al 112: «Mi madre tiene 82 años, vive en un bajo y el agua le llega por la cintura. No puede subir las escaleras y casi no me contesta»" },
};

const CALLER = { victim: "La propia víctima", family: "Un familiar", bystander: "Alguien que lo está viendo", driver: "Un conductor" } as const;
const ANSWER = { yes: "Sí", no: "No", unknown: "No se sabe", normal: "Con normalidad", difficult: "Con dificultad", none: "No respira" } as const;
const AGE = { child: "Menor", adult: "Adulto", elderly: "Persona mayor", unknown: "No se sabe" } as const;
const VIEW_M = 650;

/** The streets around the caller, drawn from the graph itself: no tiles to wait for in the middle of an alert. */
function Locator({ at, graph, record }: { at: [number, number]; graph: GraphData; record: TickRecord | null }) {
  const drawn = useMemo(() => {
    const kLat = 111320, kLon = 111320 * Math.cos((at[1] * Math.PI) / 180);
    const xy = (p: [number, number]) => [((p[0] - at[0]) * kLon) as number, (-(p[1] - at[1]) * kLat) as number];
    const near = (p: [number, number]) => Math.abs((p[0] - at[0]) * kLon) < VIEW_M * 1.4 && Math.abs((p[1] - at[1]) * kLat) < VIEW_M * 1.4;
    const streets = graph.edges.filter((e) => e.geom.some(near)).map((e) => e.geom.map((p) => xy(p).map((n) => n.toFixed(0)).join(",")).join(" "));
    const water = (record?.frame.knownWater.zones ?? []).flatMap((z) => (graph.nodes[z.node] ? [{ c: xy(graph.nodes[z.node]), r: z.radiusM }] : []));
    const units = (record?.frame.units ?? []).filter((u) => near(u.pos)).map((u) => ({ id: u.id, kind: u.kind, c: xy(u.pos), free: u.mission === "idle" && !u.victimId && !u.broken && !u.stranded }));
    return { streets, water, units };
  }, [at, graph, record]);
  return (
    <svg className="call-room-map" viewBox={`${-VIEW_M} ${-VIEW_M * 0.8} ${VIEW_M * 2} ${VIEW_M * 1.6}`} preserveAspectRatio="xMidYMid slice" role="img" aria-label="Calles alrededor de la llamada">
      {drawn.water.map((w, n) => <circle key={n} cx={w.c[0]} cy={w.c[1]} r={w.r} className="call-map-water" />)}
      {drawn.streets.map((points, n) => <polyline key={n} points={points} className="call-map-street" />)}
      {drawn.units.map((u) => <g key={u.id} transform={`translate(${u.c[0]} ${u.c[1]})`} className={`call-map-unit${u.free ? " is-free" : ""}`}><circle r="17" /><text y="5" textAnchor="middle">{u.id}</text><title>{unitKind[u.kind].label} {u.id}{u.free ? " · libre" : ""}</title></g>)}
      <circle r="150" className="call-map-doubt" />
      <circle r="46" className="call-map-ring" />
      <circle r="13" className="call-map-point" />
    </svg>
  );
}

export default function LiveCallAlert({ live, calls, graph, record, onRing, onClosePreview }: { live: Live; calls: Ringing[]; graph: GraphData | null; record: TickRecord | null; onRing: () => void; onClosePreview: () => void }) {
  const rung = useRef(new Set<string>());
  const first = useRef<HTMLButtonElement>(null);
  const [, beat] = useState(0);
  useEffect(() => {
    const fresh = calls.filter((c) => !rung.current.has(c.id));
    for (const c of fresh) rung.current.add(c.id);
    if (fresh.length) { onRing(); first.current?.focus(); }
  }, [calls, onRing]);
  useEffect(() => {
    if (!calls.length) return;
    const timer = setInterval(() => beat((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [calls.length]);
  if (!calls.length) return null;
  const ringing = calls[0], call = ringing.call;
  const preview = ringing.id === "preview", rehearsal = ringing.via === "simulacro";
  const answer = (accept: boolean) => (preview ? onClosePreview() : void live.decide({ id: ringing.id, label: accept ? "Dar entrada a la llamada" : "Descartar la llamada", accept }));
  const waited = ringing.since ? Math.max(0, Math.round((Date.now() - Date.parse(ringing.since)) / 1000)) : 18;
  const said = call.text.replace(/^Llamada real al 112:\s*/, "").replace(/^«|»$/g, "");
  const free = (record?.frame.units ?? []).filter((u) => u.mission === "idle" && !u.victimId && !u.broken && !u.stranded).length;
  const steps = [
    { icon: UserRound, label: "Una persona llama al 112", done: true },
    { icon: Bot, label: "La atiende el agente de voz de HappyRobot", done: true },
    { icon: Webhook, label: "Al colgar, la ficha llega por webhook", done: true },
    { icon: Pause, label: "La sesión se para y te avisa", now: true },
    { icon: Radio, label: "El coordinador la recibe y decide", done: false },
  ];
  return (
    <div className="call-room-backdrop">
      <section className="call-room" role="alertdialog" aria-modal="true" aria-labelledby="call-room-title">
        <header className="call-room-bar">
          <span className="call-room-badge"><PhoneIncoming size={15} />LLAMADA REAL AL 112</span>
          {(preview || rehearsal) && <span className="call-room-mock">{preview ? "VISTA PREVIA · no hay ninguna sesión parada" : "SIMULACRO · la sesión sí está parada"}</span>}
          <strong id="call-room-title">{call.street ?? "Calle sin identificar"}</strong>
          <span className="call-room-paused"><Pause size={13} />Sesión en pausa · {Math.floor(waited / 60)}:{String(waited % 60).padStart(2, "0")} esperando</span>
        </header>
        <ol className="call-room-steps" aria-label="Recorrido de la llamada">
          {steps.map((s, n) => <li key={n} className={s.now ? "is-now" : s.done ? "is-done" : ""}><s.icon size={14} /><span>{s.label}</span>{n < steps.length - 1 && <ArrowRight size={12} className="call-room-arrow" />}</li>)}
        </ol>
        <div className="call-room-body">
          <div className="call-room-where">
            {ringing.at && graph ? <Locator at={ringing.at} graph={graph} record={record} />
              : <div className="call-room-nowhere"><MapPin size={20} /><p>La calle que dijo no está en el mapa.<br />Si le das entrada, el motor la sitúa con un margen de error grande.</p></div>}
            <p className="call-room-caption"><MapPin size={12} />{call.street ?? "Sin calle"} · margen de ±{Math.round(call.locationErrorM)} m{record ? ` · ${free} ${free === 1 ? "unidad libre" : "unidades libres"} ahora mismo` : ""}</p>
          </div>
          <div className="call-room-what">
            <h3>Lo que ha dicho</h3>
            <blockquote>{said || "Sin transcripción"}</blockquote>
            <h3>Lo que el agente de voz ha sacado de la llamada</h3>
            <dl className="call-room-facts">
              <div><dt>Quién llama</dt><dd>{CALLER[call.caller]}</dd></div>
              <div><dt>Qué ocurre</dt><dd>{call.mechanism ? sceneLabel(call.mechanism) : "No queda claro"}</dd></div>
              <div><dt>Personas afectadas</dt><dd>{call.victims ?? "No lo dijo"}</dd></div>
              <div><dt>Edad</dt><dd>{AGE[call.ageGroup]}</dd></div>
              <div data-alert={call.conscious === "no"}><dt>Consciente</dt><dd>{ANSWER[call.conscious]}</dd></div>
              <div data-alert={call.breathing === "none" || call.breathing === "difficult"}><dt>Respira</dt><dd>{ANSWER[call.breathing]}</dd></div>
              <div data-alert={call.bleeding === "yes"}><dt>Sangra</dt><dd>{ANSWER[call.bleeding]}</dd></div>
              <div data-alert={call.trapped === "yes"}><dt>Atrapada</dt><dd>{ANSWER[call.trapped]}</dd></div>
            </dl>
            <h3>Qué pasa si le das entrada</h3>
            <p className="call-room-next">La llamada entra en la noche como un aviso más: en el siguiente registro el coordinador la recibe, abre una incidencia en ese punto y decide qué unidad manda. Si la descartas, la noche sigue como si no hubiera sonado.</p>
            <div className="call-room-actions">
              <button ref={first} className="is-primary" onClick={() => answer(true)}><PhoneIncoming size={15} />{preview ? "Cerrar la vista previa" : "Dar entrada y reanudar"}</button>
              {!preview && <button onClick={() => answer(false)}><PhoneOff size={14} />Descartar</button>}
              {!preview && <button className="is-quiet" title="Terminar la sesión en vivo" onClick={() => void live.stop()}><Square size={12} />Parar la sesión</button>}
            </div>
            {calls.length > 1 && <p className="call-room-more">Hay {calls.length - 1} {calls.length === 2 ? "llamada más" : "llamadas más"} esperando detrás de esta.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
