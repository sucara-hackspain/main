import { useEffect, useRef } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { elapsed } from "../engineTrace";
import { auditTitle, laneName, type AuditItem } from "./model";
import { LaneIcon } from "./ThoughtsView";
import "./thoughts.css";

type ActivityLogProps = {
  items: AuditItem[];
  seconds: number;
  tick: number;
  patient: string | null;
  expanded: string | null;
  onSelectPatient: (id: string | null) => void;
  onReveal: (item: AuditItem) => void;
};

export default function ActivityLog({
  items,
  seconds,
  tick,
  patient,
  expanded,
  onSelectPatient,
  onReveal,
}: ActivityLogProps) {
  const activity = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activity.current)
      activity.current.scrollTop = activity.current.scrollHeight;
  }, [tick]);
  function reveal(item: AuditItem) {
    onReveal(item);
    requestAnimationFrame(() =>
      document
        .getElementById(`audit-${item.id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }
  return (
    <section className="app-observation">
      <div className="app-section-title">
        <h3>
          {patient ? `${patient} · seguimiento` : "Registro compartido"}
        </h3>
        {patient && (
          <button onClick={() => onSelectPatient(null)}>
            Ver todo <X size={12} />
          </button>
        )}
      </div>
      <div className="app-activity" ref={activity}>
        {items.slice(-150).map((item) => (
          <button
            key={item.id}
            className={`app-log ${expanded === item.id ? "selected" : ""}`}
            onClick={() => reveal(item)}
          >
            <span className="app-log-icon">
              <LaneIcon lane={item.lane} size={13} />
            </span>
            <span>
              <small>
                +{elapsed(item.tick, seconds)} · {laneName[item.lane]}
              </small>
              <strong>{auditTitle(item, seconds)}</strong>
              <span>{item.refs.join(" · ")}</span>
            </span>
            <ArrowUpRight size={12} />
          </button>
        ))}
        {items.length === 0 && (
          <p className="app-muted">Sin actividad en este contexto.</p>
        )}
      </div>
    </section>
  );
}
