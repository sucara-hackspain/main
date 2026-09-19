import { useEffect, useRef, useState } from "react";
import { BellRing, ChevronDown } from "lucide-react";
import InterventionQueue, { type InterventionQueueProps } from "./InterventionQueue";
import "./interventions.css";

/** Pending requests and the decisions taken, one click away from the workspace toolbar. */
export default function InterventionInbox(props: InterventionQueueProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  const count = props.pending.length;
  return (
    <div className="decision-inbox" ref={box}>
      <button
        className={count ? "has-pending" : ""}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <BellRing size={13} />
        Intervenciones
        {count > 0 && <b>{count}</b>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="decision-inbox-panel" role="dialog" aria-label="Intervenciones">
          <InterventionQueue
            {...props}
            onActive={(id) => {
              setOpen(false);
              props.onActive(id);
            }}
          />
        </div>
      )}
    </div>
  );
}
