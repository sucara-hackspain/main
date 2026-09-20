import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  ShieldAlert,
} from "lucide-react";
import { elapsed } from "../engineTrace";
import type { InterventionView, Option, Pending } from "./model";
import { DecisionActions, DecisionReceipt, Recommendation } from "./DecisionParts";
import "./interventions.css";

type DecisionBannerProps = {
  pending: Pending[];
  activeId: string | null;
  tick: number;
  seconds: number;
  /** Playback stopped by itself because a decision opened. */
  held: boolean;
  /** Number keys answer this request: off while something else holds the operator. */
  shortcuts: boolean;
  onActive: (id: string) => void;
  onDecide: (item: InterventionView, option: Option, prescribed: Option) => void;
  onUndo: (interventionId: string) => void;
  onLocate: (incidentId: string) => void;
};

/** First iteration (?iteracion=1): a banner above the map with its own receipt. */
export default function DecisionBanner({
  pending,
  activeId,
  tick,
  seconds,
  held,
  shortcuts,
  onActive,
  onDecide,
  onUndo,
  onLocate,
}: DecisionBannerProps) {
  const [confirmed, setConfirmed] = useState<{ id: string; label: string } | null>(
    null,
  );
  const position = Math.max(
    0,
    pending.findIndex((x) => x.item.id === activeId),
  );
  const active = pending[position];
  const item = active?.item,
    prescription = active?.prescription;

  function decide(option: Option) {
    if (!item || !prescription) return;
    onDecide(item, option, prescription.options[0]);
    setConfirmed({ id: item.id, label: option.label });
  }
  const receipt = confirmed && (
    <DecisionReceipt
      key={confirmed.id}
      label={confirmed.label}
      onUndo={() => onUndo(confirmed.id)}
      onClose={() => setConfirmed(null)}
    />
  );
  if (!item || !prescription) return receipt || null;

  const left =
    prescription.deadlineTick === null
      ? null
      : prescription.deadlineTick - tick;
  return (
    <>
      {receipt}
      <section
        className={`decision-banner ${item.severity}`}
        aria-label="Decisión requerida"
      >
        <span className="decision-live" aria-live="assertive">
          Decisión requerida: {item.title}
        </span>
        <header>
          <span className="decision-badge">
            <ShieldAlert size={13} />
            {item.severity === "critical" ? "Decisión requerida" : "Supervisión requerida"}
          </span>
          {pending.length > 1 && (
            <span className="decision-pager">
              <button
                aria-label="Decisión anterior"
                disabled={position === 0}
                onClick={() => onActive(pending[position - 1].item.id)}
              >
                <ChevronLeft size={13} />
              </button>
              {position + 1} de {pending.length}
              <button
                aria-label="Decisión siguiente"
                disabled={position === pending.length - 1}
                onClick={() => onActive(pending[position + 1].item.id)}
              >
                <ChevronRight size={13} />
              </button>
            </span>
          )}
          {held && (
            <span className="decision-held">
              Historial en pausa hasta decidir
            </span>
          )}
          {left !== null && (
            <span className={`decision-deadline ${left <= 10 ? "urgent" : ""}`}>
              Decidir antes de +{elapsed(prescription.deadlineTick!, seconds)} ·
              quedan <b>{elapsed(Math.max(0, left), seconds)}</b>
            </span>
          )}
        </header>
        <div className="decision-body">
          <div>
            <h2>{item.title}</h2>
            <p>{prescription.summary}</p>
            <div className="decision-links">
              {item.incidentId && (
                <button onClick={() => onLocate(item.incidentId!)}>
                  <LocateFixed size={12} />
                  Ver {item.incidentId} en el mapa
                </button>
              )}
            </div>
          </div>
          <Recommendation prescription={prescription} />
        </div>
        <DecisionActions
          key={item.id}
          options={prescription.options}
          shortcuts={shortcuts}
          onAnswer={decide}
        />
      </section>
    </>
  );
}
