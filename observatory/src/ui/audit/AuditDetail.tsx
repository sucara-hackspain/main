import { Activity, Bot, Phone, Waves } from "lucide-react";
import { elapsed, injuryLabel, triageLabel, victimStatus } from "../engineTrace";
import { actionText, eventText, type AuditItem, type Lane } from "./model";
import "./audit.css";

export function LaneIcon({ lane, size }: { lane: Lane; size: number }) {
  if (lane === "coordinator") return <Bot size={size} />;
  if (lane === "call") return <Phone size={size} />;
  if (lane === "world") return <Activity size={size} />;
  return <Waves size={size} />;
}

function sourceName(source: string) {
  return source === "llm"
    ? "IA"
    : source === "fallback"
      ? "Respaldo por reglas"
      : "Reglas";
}
export function AuditDetail({ item, seconds }: { item: AuditItem; seconds: number }) {
  const d = item.record.decision;
  return (
    <div className="app-event-detail">
      {item.event ? (
        <>
          <label>EVENTO REGISTRADO</label>
          <p>{eventText(item.event, seconds)}</p>
          {item.event.type === "call_received" && (
            <blockquote className="run-call">{item.event.call.text}</blockquote>
          )}
          {item.event.type === "scene_assessed" && (
            <ul className="run-assessed">
              {item.event.victims.map((v) => (
                <li key={v.id} data-triage={v.triage}>
                  <strong>{v.id}</strong> · {injuryLabel(v.injury)} · triaje{" "}
                  {triageLabel[v.triage].toLowerCase()}
                  {v.trapped ? " · atrapada" : ""} · {victimStatus[v.status].toLowerCase()}
                </li>
              ))}
            </ul>
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
