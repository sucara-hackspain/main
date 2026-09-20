import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Pause,
  ShieldAlert,
  Square,
} from "lucide-react";
import {
  elapsed,
  type GraphData,
  type RunMeta,
  type TickRecord,
} from "../engineTrace";
import { auditTitle, laneName, type AuditItem } from "../audit/model";
import { AuditDetail, LaneIcon } from "../audit/AuditDetail";
import type { InterventionView, Option, Pending } from "./model";
import type { Router } from "./routing";
import { incidentScene, incidentThread } from "./scene";
import { DecisionActions, Recommendation } from "./DecisionParts";
import IncidentFacts from "./IncidentFacts";
import "./interventions.css";
import "./room.css";

const IncidentMap = lazy(() => import("./IncidentMap"));

type DecisionRoomProps = {
  /** Every pending request, most urgent first. */
  pending: Pending[];
  activeId: string | null;
  record: TickRecord;
  /** Every record received: the room looks back at the one where the request opened. */
  records: TickRecord[];
  /** Chain of thoughts up to the selected record. */
  items: AuditItem[];
  meta: RunMeta;
  graph: GraphData;
  router: Router;
  seconds: number;
  held: boolean;
  sound: { muted: boolean; toggle: () => void };
  onActive: (id: string) => void;
  onDecide: (item: InterventionView, option: Option, prescribed: Option) => void;
  /** Leave without deciding: the request stays pending in a bar above the page. */
  onLeave: () => void;
  /** Open the policy that asked for this request. */
  onPolicy: (policyId: string) => void;
  /** The request belongs to the live session, which is stopped on it: the room can also end that session. */
  onStopLive?: () => void;
};

/** A request takes over the page: critical ones in red, supervision in amber. Everything needed to
 * decide is inside: the map framed on the incident, what each option would do, and the chain of
 * thoughts that led here. */
export default function DecisionRoom({
  pending,
  activeId,
  record,
  records,
  items,
  meta,
  graph,
  router,
  seconds,
  held,
  sound,
  onActive,
  onDecide,
  onLeave,
  onPolicy,
  onStopLive,
}: DecisionRoomProps) {
  const position = Math.max(
    0,
    pending.findIndex((x) => x.item.id === activeId),
  );
  const { item, prescription } = pending[position];
  const [preview, setPreview] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    setPreview(null);
    setExpanded(null);
    // The dialog, not an option, takes the focus: Enter must not approve by accident.
    dialog.current?.focus();
  }, [item.id]);

  const scene = useMemo(
    () =>
      incidentScene(item, prescription, record, records, meta, graph, router),
    [item, prescription, record, records, meta, graph, router],
  );
  const thread = useMemo(
    () => incidentThread(item, items, record),
    [item, items, record],
  );
  const left =
    prescription.deadlineTick === null
      ? null
      : prescription.deadlineTick - record.tick;
  const span =
    prescription.deadlineTick === null
      ? 0
      : prescription.deadlineTick - item.openedTick;
  const share =
    left === null || span <= 0 ? null : Math.min(1, Math.max(0, left / span));

  return (
    <div className="decision-room-scrim">
      <section
        ref={dialog}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="decision-room-title"
        aria-describedby="decision-room-summary"
        className={`decision-room ${item.severity}`}
      >
        <header>
          <span className="decision-badge">
            <ShieldAlert size={15} />
            {item.severity === "critical" ? "Decisión requerida" : "Supervisión requerida"}
          </span>
          {/* Which policy asked for this: the operator can open it and change when it happens again. */}
          {item.policyId && (
            <button type="button" className="decision-policy" title="Ver la política que ha pedido esta decisión" onClick={() => onPolicy(item.policyId!)}>
              Política {item.policyId}
            </button>
          )}
          {pending.length > 1 && (
            <span className="decision-pager">
              <button
                aria-label="Decisión anterior"
                disabled={position === 0}
                onClick={() => onActive(pending[position - 1].item.id)}
              >
                <ChevronLeft size={14} />
              </button>
              {position + 1} de {pending.length}
              <button
                aria-label="Decisión siguiente"
                disabled={position === pending.length - 1}
                onClick={() => onActive(pending[position + 1].item.id)}
              >
                <ChevronRight size={14} />
              </button>
            </span>
          )}
          <h2 id="decision-room-title">{item.title}</h2>
          <span className="decision-tools">
            {held && (
              <span className="decision-room-held">
                <Pause size={12} />
                Historial en pausa
              </span>
            )}
            {left !== null && (
              <span
                className={`decision-deadline ${left <= 10 ? "urgent" : ""}`}
                title={`Decidir antes de +${elapsed(prescription.deadlineTick!, seconds)}`}
              >
                Quedan <b>{elapsed(Math.max(0, left), seconds)}</b>
              </span>
            )}
            <button
              aria-label={
                sound.muted
                  ? "Activar el sonido de los avisos"
                  : "Silenciar los avisos"
              }
              title={sound.muted ? "Activar sonido" : "Silenciar"}
              onClick={sound.toggle}
            >
              {sound.muted ? <BellOff size={14} /> : <Bell size={14} />}
            </button>
            {onStopLive && (
              <button className="decision-leave" title="Terminar la sesión en vivo sin decidir" onClick={onStopLive}>
                <Square size={12} />
                Parar la sesión
              </button>
            )}
            <button className="decision-leave" onClick={onLeave}>
              <LogOut size={13} />
              Salir a investigar
            </button>
          </span>
        </header>
        {share !== null && (
          <div className="decision-timer" aria-hidden="true">
            <i style={{ width: `${share * 100}%` }} />
          </div>
        )}
        <div className="decision-room-body">
          <div className="decision-room-map">
            <Suspense
              fallback={<div className="app-empty">Cargando mapa…</div>}
            >
              <IncidentMap
                graph={graph}
                meta={meta}
                record={record}
                scene={scene}
                focusKey={item.id}
                preview={preview}
                seconds={seconds}
              />
            </Suspense>
          </div>
          <div className="decision-room-panel">
            <section>
              <label>SITUACIÓN</label>
              <p id="decision-room-summary">{prescription.summary}</p>
            </section>
            <Recommendation prescription={prescription} />
            <DecisionActions
              key={item.id}
              options={prescription.options}
              shortcuts
              onAnswer={(option) =>
                onDecide(item, option, prescription.options[0])
              }
              onPreview={setPreview}
            />
            <IncidentFacts item={item} record={record} seconds={seconds} />
            <section className="decision-thread">
              <div className="decision-thread-title">
                <label>
                  {item.incidentId ? "HILO DEL INCIDENTE" : "HILO DE LA PETICIÓN"} · {thread.length}{" "}
                  {thread.length === 1 ? "registro" : "registros"}
                </label>
              </div>
              <ol>
                {thread.map((x) => (
                  <li key={x.id} className={`${x.lane} ${x.mark ?? ""}`}>
                    <button
                      aria-expanded={expanded === x.id}
                      onClick={() =>
                        setExpanded(expanded === x.id ? null : x.id)
                      }
                    >
                      <time>+{elapsed(x.tick, seconds)}</time>
                      <span className="decision-thread-lane">
                        <LaneIcon lane={x.lane} size={12} />
                        {laneName[x.lane]}
                      </span>
                      <strong>
                        {auditTitle(x, seconds)}
                        {x.mark && (
                          <em>
                            {x.mark === "cause" ? "Causa" : "Se abre la petición"}
                          </em>
                        )}
                      </strong>
                    </button>
                    {expanded === x.id && (
                      <AuditDetail item={x} seconds={seconds} />
                    )}
                  </li>
                ))}
                <li className="now">
                  <span>
                    <time>+{elapsed(record.tick, seconds)}</time>
                    <strong>Ahora · se requiere tu decisión</strong>
                  </span>
                </li>
              </ol>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

/** What stays on screen when the operator leaves the room to investigate. */
export function PendingDecisionBar({
  pending,
  tick,
  seconds,
  held,
  onReturn,
}: {
  pending: Pending[];
  tick: number;
  seconds: number;
  held: boolean;
  onReturn: () => void;
}) {
  const { item, prescription } = pending[0];
  const left =
    prescription.deadlineTick === null
      ? null
      : prescription.deadlineTick - tick;
  return (
    <div
      className={`decision-pending-bar ${pending.some((x) => x.item.severity === "critical") ? "" : "warning"} ${left !== null && left <= 10 ? "urgent" : ""}`}
    >
      <ShieldAlert size={15} />
      <strong>
        {pending.length === 1
          ? "Decisión pendiente"
          : `${pending.length} decisiones pendientes`}
      </strong>
      <span>{item.title}</span>
      {left !== null && (
        <span>
          Quedan <b>{elapsed(Math.max(0, left), seconds)}</b>
        </span>
      )}
      {held && <span>Historial en pausa</span>}
      <button onClick={onReturn}>Volver a la decisión</button>
    </div>
  );
}
