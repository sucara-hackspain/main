import { Check, ChevronRight, CircleSlash, Undo2 } from "lucide-react";
import { elapsed } from "../engineTrace";
import type { InterventionView, Pending } from "./model";
import "./interventions.css";

export type InterventionQueueProps = {
  pending: Pending[];
  history: InterventionView[];
  activeId: string | null;
  tick: number;
  seconds: number;
  /** Next tick where an exception opens among the records received. */
  nextTick: number | undefined;
  onActive: (id: string) => void;
  onSeek: (tick: number) => void;
  onUndo: (interventionId: string) => void;
};

export default function InterventionQueue({
  pending,
  history,
  activeId,
  tick,
  seconds,
  nextTick,
  onActive,
  onSeek,
  onUndo,
}: InterventionQueueProps) {
  const current = activeId ?? pending[0]?.item.id;
  return (
    <section className="decision-queue">
      <div className="app-section-title">
        <h3>
          Intervenciones{" "}
          <span className={pending.length ? "decision-count" : ""}>
            {pending.length === 1 ? "1 pendiente" : `${pending.length} pendientes`}
          </span>
        </h3>
        {nextTick !== undefined && (
          <button
            onClick={() => onSeek(nextTick)}
            title={`Ir a +${elapsed(nextTick, seconds)}`}
          >
            Siguiente excepción <ChevronRight size={12} />
          </button>
        )}
      </div>
      {pending.length === 0 && history.length === 0 && (
        <p className="app-muted">
          Sin excepciones hasta ahora: el sistema opera sin pedir decisiones.
        </p>
      )}
      <div className="decision-queue-list">
        {pending.map(({ item, prescription }) => (
          <button
            key={item.id}
            className={`decision-row ${item.severity} ${current === item.id ? "selected" : ""}`}
            aria-pressed={current === item.id}
            onClick={() => onActive(item.id)}
          >
            <i />
            <strong title={`Recomendación: ${prescription.options[0].label}`}>
              {item.title}
            </strong>
            {prescription.deadlineTick !== null && (
              <span className="decision-row-time">
                {elapsed(Math.max(0, prescription.deadlineTick - tick), seconds)}
              </span>
            )}
          </button>
        ))}
      </div>
      {history.length > 0 && (
        <details className="decision-history">
          <summary>Historial de decisiones · {history.length}</summary>
          {history.map((item) => {
            // Going back to before a decision would undo it: decided entries link to the decision itself.
            const at = item.decision?.tick ?? item.openedTick;
            return (
              <div key={item.id} className={item.status}>
                {item.decision ? <Check size={13} /> : <CircleSlash size={13} />}
                <span>
                  <strong>
                    {item.decision
                      ? `${item.decision.approved ? "Aprobada" : "Operador"} · ${item.decision.label}`
                      : "Sin decisión del operador"}
                  </strong>
                  <small>
                    <button onClick={() => onSeek(at)}>
                      +{elapsed(at, seconds)}
                    </button>{" "}
                    · {item.title}
                  </small>
                  {item.outcome && (
                    <small>Desenlace en los registros: {item.outcome}</small>
                  )}
                </span>
                {item.decision && (
                  <button
                    aria-label={`Deshacer decisión: ${item.title}`}
                    title="Deshacer decisión"
                    onClick={() => onUndo(item.id)}
                  >
                    <Undo2 size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </details>
      )}
    </section>
  );
}
