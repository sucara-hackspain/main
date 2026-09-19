import { useEffect, useRef } from "react";
import { Activity, Bot, ChevronRight, CircleDot, Waves } from "lucide-react";
import { elapsed } from "../runModel";
import {
  actionText,
  auditTitle,
  eventText,
  laneName,
  type AuditItem,
} from "./model";
import "./thoughts.css";

type ThoughtsViewProps = {
  items: AuditItem[];
  seconds: number;
  tick: number;
  autoScroll: boolean;
  expanded: string | null;
  onExpand: (id: string | null) => void;
};

export default function ThoughtsView({
  items,
  seconds,
  tick,
  autoScroll,
  expanded,
  onExpand,
}: ThoughtsViewProps) {
  const flow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll && flow.current)
      flow.current.scrollTop = flow.current.scrollHeight;
  }, [tick, autoScroll]);
  return (
    <>
      <div className="app-lanes">
        <div>
          <span className="app-agent-icon">
            <Waves size={16} />
          </span>
          <div>
            <strong>Master y entorno</strong>
            <span>Avisos y evolución del mundo</span>
          </div>
        </div>
        <div>
          <span className="app-agent-icon">
            <Bot size={16} />
          </span>
          <div>
            <strong>Coordinador</strong>
            <span>Órdenes y resultados del motor</span>
          </div>
        </div>
      </div>
      <div className="app-flow" ref={flow}>
        {items.length === 0 && (
          <div className="app-empty">
            Sin actividad en este contexto y momento.
          </div>
        )}
        {items.map((item, i) => (
          <div key={item.id}>
            {(i === 0 || items[i - 1].tick !== item.tick) && (
              <div className="app-turn-label">
                <span>+{elapsed(item.tick, seconds)}</span>
                <strong>Registro de actividad</strong>
              </div>
            )}
            <div
              className={`app-event-row ${item.lane === "coordinator" ? "coordinator" : "master"}`}
              id={`audit-${item.id}`}
            >
              <article
                className={`app-event ${expanded === item.id ? "selected" : ""}`}
              >
                <button
                  className="app-event-button"
                  aria-expanded={expanded === item.id}
                  onClick={() =>
                    onExpand(expanded === item.id ? null : item.id)
                  }
                >
                  <span className="app-event-meta">
                    <span>
                      {item.lane === "coordinator" ? (
                        <Bot size={12} />
                      ) : item.lane === "world" ? (
                        <Activity size={12} />
                      ) : (
                        <Waves size={12} />
                      )}{" "}
                      {laneName[item.lane]}
                    </span>
                    <span>
                      {item.record.decision && item.lane === "coordinator"
                        ? sourceName(item.record.decision.source)
                        : "Evento"}
                    </span>
                  </span>
                  <strong>{auditTitle(item, seconds)}</strong>
                  <span className="app-event-tags">
                    {[...item.patients, ...item.units].map((id) => (
                      <span key={id}>{id}</span>
                    ))}
                    <ChevronRight size={12} />
                  </span>
                </button>
                {expanded === item.id && (
                  <AuditDetail item={item} seconds={seconds} />
                )}
              </article>
            </div>
          </div>
        ))}
        <div className="app-history-end">
          <CircleDot size={12} />
          Hasta +{elapsed(tick, seconds)} · solo registros recibidos
        </div>
      </div>
    </>
  );
}

function sourceName(source: string) {
  return source === "llm"
    ? "IA"
    : source === "fallback"
      ? "Respaldo por reglas"
      : "Reglas";
}
function AuditDetail({ item, seconds }: { item: AuditItem; seconds: number }) {
  const d = item.record.decision;
  return (
    <div className="app-event-detail">
      {item.event ? (
        <>
          <label>EVENTO REGISTRADO</label>
          <p>{eventText(item.event, seconds)}</p>
          {item.event.type === "patient_spawned" && (
            <p>
              Nodo {item.event.node} · TTL inicial{" "}
              {elapsed(item.event.ttl, seconds)}. El registro no incluye
              una categoría clínica de gravedad.
            </p>
          )}
          <details className="run-json">
            <summary>Ver datos del evento</summary>
            <pre>{JSON.stringify(item.event, null, 2)}</pre>
          </details>
        </>
      ) : (
        <>
          <label>DECISIÓN · {sourceName(d?.source ?? "rules")}</label>
          <p>
            {d?.situation ||
              "El coordinador no ha registrado un resumen de situación."}
          </p>
          {d?.ms !== undefined && (
            <p>
              Duración: {(d.ms / 1000).toFixed(1)} s
              {d.costUsd !== undefined
                ? ` · coste: $${d.costUsd.toFixed(4)}`
                : ""}
            </p>
          )}
          {d?.error && <p className="danger">{d.error}</p>}
          <label>ÓRDENES Y RESULTADOS</label>
          {item.record.actions.length === 0 ? (
            <p>
              Sin nuevas órdenes. No implica que hayan terminado las misiones en
              curso.
            </p>
          ) : (
            item.record.actions.map((a, i) => {
              const result = item.record.events.find(
                (e) =>
                  (e.type === "action_applied" ||
                    e.type === "action_rejected") &&
                  JSON.stringify(e.action) === JSON.stringify(a),
              );
              return (
                <div className="run-order" key={i}>
                  <strong>{actionText(a)}</strong>
                  <p>
                    {d?.reasons?.[i] ||
                      "Sin justificación registrada para esta orden."}
                  </p>
                  <span
                    className={
                      result?.type === "action_rejected" ? "danger" : ""
                    }
                  >
                    {result?.type === "action_rejected"
                      ? `Rechazada: ${result.reason}`
                      : result?.type === "action_applied"
                        ? `Aceptada · ETA ${elapsed(result.etaTicks, seconds)}`
                        : "Sin confirmación del motor"}
                  </span>
                </div>
              );
            })
          )}
          <label>CONTEXTO AUDITABLE</label>
          <p>
            El registro contiene el resultado del motor. No incluye una copia
            del conocimiento del coordinador ni los informes que recibió.
          </p>
        </>
      )}
    </div>
  );
}
