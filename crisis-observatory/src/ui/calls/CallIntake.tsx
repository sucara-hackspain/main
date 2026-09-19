import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown, ArrowUpRight, Check, CheckCheck, ChevronRight, Download,
  FileText, Headphones, MapPin, MessageSquare, Minimize2, Pause, Phone,
  PhoneIncoming, Play, RotateCcw, Save, ShieldCheck, Sparkles, Users, Waves,
} from "lucide-react";
import { callTime, DEMO_END, DEMO_START, DRAFT_STORAGE_KEY, readDraft, suggestedDraft, visibleTurns, type CallDraft } from "./demoCall";
import "./calls.css";

export default function CallIntake({ open, onOpen, onClose }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [started, setStarted] = useState(open);
  const [seconds, setSeconds] = useState(DEMO_START);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState<"transcript" | "draft">("transcript");
  const [following, setFollowing] = useState(true);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [stored] = useState(readDraft);
  const [edits, setEdits] = useState<Partial<CallDraft>>(stored?.draft ?? {});
  const [saved, setSaved] = useState(stored ? JSON.stringify(stored.draft) : "");
  const [savedAt, setSavedAt] = useState(stored?.savedAt ?? "");
  const [saveError, setSaveError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const locationInput = useRef<HTMLInputElement>(null);
  const sourceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = seconds >= DEMO_END;
  const running = started && !paused && !finished;
  const turns = visibleTurns(seconds);
  const draft = { ...suggestedDraft(seconds), ...edits };
  const isSaved = saved === JSON.stringify(draft);
  const extracted = seconds >= 56 ? 3 : 2;
  const status = finished ? "Demo finalizada" : paused ? "Demo pausada" : "En curso";

  useEffect(() => {
    if (open) {
      setStarted(true);
      dialog.current?.showModal();
      const overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = overflow; dialog.current?.close(); };
    }
    dialog.current?.close();
  }, [open]);

  useEffect(() => {
    if (!running) return;
    // Measure elapsed time so a background tab does not slow the simulated call.
    let previous = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - previous) / 1000);
      if (elapsed > 0) {
        previous += elapsed * 1000;
        setSeconds((current) => Math.min(DEMO_END, current + elapsed));
      }
    }, 250);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (open && following && tab === "transcript" && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [seconds, open, following, tab]);

  useEffect(() => () => { if (sourceTimer.current) clearTimeout(sourceTimer.current); }, []);

  function update(key: keyof CallDraft, value: string) {
    setEdits((previous) => ({ ...previous, [key]: value }));
    setSaveError("");
  }

  function showSource(id: string) {
    setTab("transcript");
    setFollowing(false);
    setHighlight(id);
    requestAnimationFrame(() => {
      const source = dialog.current?.querySelector<HTMLElement>(`[data-turn="${id}"]`);
      source?.focus({ preventScroll: true });
      source?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    });
    if (sourceTimer.current) clearTimeout(sourceTimer.current);
    sourceTimer.current = setTimeout(() => setHighlight(null), 3500);
  }

  function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!draft.location.trim()) {
      setSaveError("Añade una ubicación para guardar el borrador.");
      setTab("draft");
      requestAnimationFrame(() => locationInput.current?.focus());
      return;
    }
    try {
      const timestamp = new Date().toISOString();
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
        version: 1, source: "demo-call-0142", simulated: true,
        savedAt: timestamp, draft, transcript: turns,
      }));
      setSaved(JSON.stringify(draft));
      setSavedAt(timestamp);
      setSaveError("");
    } catch {
      setSaveError("No se ha podido guardar en este navegador. Tu borrador sigue disponible en esta ventana.");
    }
  }

  function downloadTranscript() {
    const content = ["ALERTA · Llamada de ejemplo 0142", "SIMULACIÓN — no corresponde a una llamada real.", "",
      ...turns.map((turn) => `[${callTime(turn.start)}] ${turn.speaker === "operator" ? "Operadora 112" : "Llamante"}: ${turn.text}${turn.complete ? "" : " [transcripción parcial]"}`),
    ].join("\n\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "llamada-demo-0142.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    {started && !open && <button className="call-dock" onClick={onOpen} aria-label="Abrir transcripción de la llamada de ejemplo">
      <span className="call-dock-icon"><PhoneIncoming size={18} /></span>
      <span><strong>{finished ? "Transcripción disponible" : paused ? "Demo en pausa" : "Llamada de ejemplo"}</strong><small>{finished ? "Ver conversación y borrador" : `${callTime(seconds)} · ${paused ? "Simulación pausada" : "Simulación en curso"}`}</small></span>
      {running && <span className="call-mini-wave" aria-hidden="true"><i /><i /><i /><i /></span>}
      <ChevronRight size={16} />
    </button>}

    <dialog ref={dialog} className="call-dialog" aria-labelledby="call-title" aria-describedby="call-description"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter((element) => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}>
      <div className="call-window">
        <header className="call-header">
          <div className="call-heading">
            <span className="call-header-icon"><PhoneIncoming size={21} /></span>
            <div><div className="call-eyebrow">CENTRO DE COORDINACIÓN <span>/</span> ENTRADA DE INFORMACIÓN</div>
              <h1 id="call-title">Atención de llamada</h1>
            </div>
          </div>
          <div className="call-header-actions"><span className="call-demo-label">Demo</span>
            <button className="call-icon-button" aria-label="Minimizar llamada" title="Minimizar llamada · Esc" onClick={onClose}><Minimize2 size={18} /></button>
          </div>
        </header>

        <div className="call-identity">
          <div className="call-caller"><span className="call-avatar"><Phone size={17} /></span>
            <div><strong>Llamada entrante <span>#0142</span></strong><p id="call-description">Canal 112 <span>·</span> Llamante sin identificar <span>·</span> Español</p></div>
          </div>
          <div className="call-connection"><span className={`call-live-state ${running ? "is-live" : ""}`}><i />{finished ? "Demo finalizada" : status}</span><span className="call-duration">{callTime(seconds)}</span>
            <span className={`call-signal ${running ? "is-live" : ""}`} aria-hidden="true">{[7, 15, 10, 23, 17, 29, 13, 22, 9, 17, 6].map((height, i) => <i key={i} style={{ height, animationDelay: `${i * -0.13}s` }} />)}</span>
          </div>
        </div>

        <div className="call-mobile-tabs" role="tablist" aria-label="Vista de la llamada">
          <button id="call-transcript-tab" role="tab" aria-selected={tab === "transcript"} aria-controls="call-transcript-panel" tabIndex={tab === "transcript" ? 0 : -1} onClick={() => setTab("transcript")} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { setTab("draft"); document.getElementById("call-draft-tab")?.focus(); } }}><MessageSquare size={15} /> Conversación</button>
          <button id="call-draft-tab" role="tab" aria-selected={tab === "draft"} aria-controls="call-draft-panel" tabIndex={tab === "draft" ? 0 : -1} onClick={() => setTab("draft")} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { setTab("transcript"); document.getElementById("call-transcript-tab")?.focus(); } }}><FileText size={15} /> Borrador <span>{extracted}</span></button>
        </div>

        <div className="call-body" data-tab={tab}>
          <section id="call-transcript-panel" className="call-transcript-panel" aria-label="Conversación transcrita">
            <div className="call-panel-heading"><div><MessageSquare size={16} /><h2>Transcripción</h2><span className="call-subtle-label">{finished ? "COMPLETA" : paused ? "EN PAUSA" : "EN DIRECTO"}</span></div>
              <button className="call-icon-button" aria-label="Descargar transcripción" title="Descargar transcripción" onClick={downloadTranscript}><Download size={16} /></button>
            </div>
            <div className="call-transcript-scroll" ref={transcript} tabIndex={0} aria-label="Historial de la conversación" onScroll={() => {
              const element = transcript.current;
              if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
            }}>
              <div className="call-start-marker"><span />Inicio de la llamada<span /></div>
              <div className="call-turns">
                {turns.map((turn) => <article key={turn.id} data-turn={turn.id} tabIndex={-1} className={`call-turn ${turn.speaker} ${highlight === turn.id ? "is-highlighted" : ""}`}>
                  <span className="call-speaker-icon">{turn.speaker === "operator" ? <Headphones size={15} /> : <Phone size={14} />}</span>
                  <div className="call-turn-content"><div className="call-turn-meta"><strong>{turn.speaker === "operator" ? "Operadora 112" : "Llamante"}</strong>{turn.speaker === "operator" && <span>112</span>}<time>{callTime(turn.start)}</time></div>
                    <p>{turn.text}{!turn.complete && <span className={`call-cursor ${running ? "is-live" : ""}`} aria-label="Transcripción parcial" />}</p>
                    {["location", "people", "situation"].includes(turn.id) && turn.complete && <span className="call-extracted-tag"><CheckCheck size={12} /> Dato recogido en el borrador</span>}
                  </div>
                </article>)}
              </div>
              <div className="call-listening">{running ? <><span className="call-mini-wave" aria-hidden="true"><i /><i /><i /><i /></span> Transcribiendo la llamada de ejemplo…</> : <><Check size={13} />{finished ? "Fin de la llamada de ejemplo" : "Simulación en pausa"}</>}</div>
            </div>
            <div className="call-transcript-bottom">
              <span><ShieldCheck size={13} /> Transcripción de ejemplo</span>
              <button className={following ? "is-following" : ""} onClick={() => { setFollowing(true); if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }}><ArrowDown size={13} />{following ? "Siguiendo conversación" : "Ir a lo más reciente"}</button>
            </div>
          </section>

          <aside id="call-draft-panel" className="call-draft-panel" aria-label="Borrador del aviso">
            <div className="call-panel-heading"><div><Sparkles size={16} /><h2>De la llamada al aviso</h2></div><span className="call-count">{extracted}</span></div>
            <div className="call-draft-scroll">
              <p className="call-draft-intro">La información toma forma mientras escuchas. Revisa y completa el borrador.</p>
              <form id="call-draft-form" onSubmit={saveDraft} noValidate>
                <div className="call-field-card"><div className="call-field-heading"><label htmlFor="call-location"><MapPin size={14} />Ubicación</label><button type="button" className="call-source" aria-label="Ver origen de la ubicación, segundo 6" onClick={() => showSource("location")}>00:06 <ArrowUpRight size={12} /></button></div>
                  <input ref={locationInput} id="call-location" value={draft.location} onChange={(event) => update("location", event.target.value)} placeholder="Añadir ubicación" aria-required="true" aria-invalid={!draft.location.trim() && !!saveError} />
                  <span className="call-field-note">Ubicación declarada por el llamante</span>
                </div>
                <div className="call-field-card"><div className="call-field-heading"><label htmlFor="call-people"><Users size={14} />Personas afectadas</label><button type="button" className="call-source" aria-label="Ver origen de las personas afectadas, segundo 24" onClick={() => showSource("people")}>00:24 <ArrowUpRight size={12} /></button></div>
                  <textarea id="call-people" rows={2} value={draft.people} onChange={(event) => update("people", event.target.value)} placeholder="Pendiente de información" />
                </div>
                <div className={`call-field-card ${seconds < 56 ? "is-pending" : ""}`}><div className="call-field-heading"><label htmlFor="call-situation"><Waves size={14} />Situación reportada</label>{seconds >= 56 ? <button type="button" className="call-source" aria-label="Ver origen de la situación, segundo 42" onClick={() => showSource("situation")}>00:42 <ArrowUpRight size={12} /></button> : <span className="call-pending-label">{running ? "Escuchando" : "Pendiente"}</span>}</div>
                  <textarea id="call-situation" rows={3} value={draft.situation} onChange={(event) => update("situation", event.target.value)} placeholder="La información aparecerá aquí al completar la intervención…" />
                </div>
                <div className="call-priority"><label htmlFor="call-priority">Prioridad del aviso</label><select id="call-priority" value={draft.priority} onChange={(event) => update("priority", event.target.value)}>{["Por valorar", "Alta", "Media", "Baja"].map((value) => <option key={value}>{value}</option>)}</select></div>
                <div className="call-notes"><label htmlFor="call-notes">Notas del operador <span>Opcional</span></label><textarea id="call-notes" rows={2} placeholder="Añade contexto relevante…" value={draft.notes} onChange={(event) => update("notes", event.target.value)} /></div>
              </form>
              <div className="call-review-note"><ShieldCheck size={15} /><p>Información declarada, pendiente de validar. El borrador queda separado de los casos operativos.</p></div>
            </div>
          </aside>
        </div>

        <footer className="call-footer">
          <div className="call-preview-controls"><button className="call-demo-control" onClick={() => { if (finished) { setSeconds(DEMO_START); setPaused(false); setFollowing(true); } else setPaused(!paused); }} aria-label={finished ? "Repetir demo" : paused ? "Reanudar demo" : "Pausar demo"}>{finished ? <RotateCcw size={14} /> : paused ? <Play size={14} /> : <Pause size={14} />}</button><div><strong>Vista previa interactiva</strong><span>Llamada simulada · guardado local</span></div></div>
          <div className="call-save-actions"><span className={`call-save-status ${saveError ? "has-error" : ""}`} role="status">{saveError || (isSaved ? <><Check size={13} />Guardado en este navegador{savedAt && <small>{new Date(savedAt).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</small>}</> : saved ? "Hay cambios sin guardar" : "Listo para revisar")}</span>
            <button className="call-save-button" type="submit" form="call-draft-form" disabled={isSaved}>{isSaved ? <Check size={15} /> : <Save size={15} />}{isSaved ? "Borrador guardado" : "Guardar borrador"}</button>
          </div>
        </footer>
        <div className="call-announcer" role="log" aria-live="polite" aria-relevant="additions" aria-label="Nuevas intervenciones">
          {turns.filter((turn) => turn.complete).map((turn) => <p key={turn.id}>{turn.speaker === "operator" ? "Operadora 112" : "Llamante"}: {turn.text}</p>)}
        </div>
      </div>
    </dialog>
  </>;
}
