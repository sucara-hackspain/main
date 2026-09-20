import { useEffect, useRef } from "react";
import { PhoneIncoming } from "lucide-react";
import type { Live, LiveAwaited } from "./useLive";

// A real person has just phoned 112 and the live session is stopped on it. It takes the screen like any request that
// needs the operator: the night only goes on once the call is taken in, or set aside.
export default function LiveCallAlert({ live, calls, onRing }: { live: Live; calls: Extract<LiveAwaited, { type: "call" }>[]; onRing: () => void }) {
  const rung = useRef(new Set<string>());
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const fresh = calls.filter((c) => !rung.current.has(c.id));
    for (const c of fresh) rung.current.add(c.id);
    if (fresh.length) { onRing(); first.current?.focus(); }
  }, [calls, onRing]);
  if (!calls.length) return null;
  const call = calls[0];
  return (
    <div className="live-call-backdrop">
      <section className="live-call" role="alertdialog" aria-modal="true" aria-labelledby="live-call-title">
        <header><span><PhoneIncoming size={15} />LLAMADA REAL AL 112</span><em>La sesión en vivo está parada</em></header>
        <h2 id="live-call-title">{call.street ?? "Sin calle identificada"}</h2>
        <blockquote>{call.text}</blockquote>
        <p className="live-muted">Entró a las {new Date(call.since).toLocaleTimeString("es-ES")} por {call.via}. Si le das entrada, el coordinador la recibe en el siguiente registro como cualquier otro aviso, y lo que describe pasa a ser verdad en la noche.</p>
        <div className="live-actions">
          <button ref={first} className="is-primary" onClick={() => void live.decide({ id: call.id, label: "Dar entrada a la llamada", accept: true })}>Dar entrada y continuar</button>
          <button onClick={() => void live.decide({ id: call.id, label: "Descartar la llamada", accept: false })}>Descartar</button>
        </div>
        {calls.length > 1 && <p className="live-muted">Hay {calls.length - 1} llamada(s) más esperando detrás de esta.</p>}
      </section>
    </div>
  );
}
