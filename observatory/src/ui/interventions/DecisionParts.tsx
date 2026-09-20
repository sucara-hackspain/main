import { useEffect, useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import type { Option, Prescription } from "./model";

// Pieces shared by both ways of asking for a decision: the decision room and the first iteration's banner.

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.matches("input:not([type=range]), textarea, select, [contenteditable]");

export function Recommendation({
  prescription,
}: {
  prescription: Prescription;
}) {
  const [prescribed] = prescription.options;
  return (
    <div className="decision-prescription">
      <label>RECOMENDACIÓN DEL SISTEMA · REGLAS</label>
      <strong>{prescribed.label}</strong>
      {prescribed.detail && <span>{prescribed.detail}</span>}
      <p>{prescription.rationale}</p>
    </div>
  );
}

/** Numbered options (options[0] is the prescribed one) plus a decision in the operator's words.
 * Key it by request so a half-written decision does not carry over to the next one. */
export function DecisionActions({
  options,
  shortcuts,
  onAnswer,
  onPreview,
}: {
  options: Option[];
  /** Number keys answer while true, as long as the operator is not typing. */
  shortcuts: boolean;
  onAnswer: (option: Option) => void;
  /** Option under the pointer or the keyboard focus, to show what it would do. */
  onPreview?: (optionId: string | null) => void;
}) {
  const [other, setOther] = useState<string | null>(null);
  useEffect(() => {
    if (!shortcuts || other !== null) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const option = options[Number(e.key) - 1];
      if (!option) return;
      e.preventDefault();
      onAnswer(option);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const previews = (id: string) =>
    onPreview && {
      onMouseEnter: () => onPreview(id),
      onMouseLeave: () => onPreview(null),
      onFocus: () => onPreview(id),
      onBlur: () => onPreview(null),
    };

  if (other !== null)
    return (
      <form
        className="decision-actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (other.trim()) onAnswer({ id: "custom", label: other.trim() });
        }}
      >
        <input
          autoFocus
          aria-label="Decisión del operador"
          placeholder="Describe la decisión que tomas en lugar de la recomendada"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Escape closes the note, not whatever holds it.
            e.stopPropagation();
            setOther(null);
          }}
        />
        <button className="decision-approve" disabled={!other.trim()}>
          Registrar decisión
        </button>
        <button type="button" onClick={() => setOther(null)}>
          Cancelar
        </button>
      </form>
    );
  const [prescribed, ...alternatives] = options;
  return (
    <div className="decision-actions">
      <button
        className="decision-approve"
        onClick={() => onAnswer(prescribed)}
        {...previews(prescribed.id)}
      >
        <kbd>1</kbd>
        Aprobar: {prescribed.label}
      </button>
      {alternatives.map((option, i) => (
        <button
          key={option.id}
          onClick={() => onAnswer(option)}
          {...previews(option.id)}
        >
          <kbd>{i + 2}</kbd>
          {option.label}
          {option.detail && <small>{option.detail}</small>}
        </button>
      ))}
      <button className="decision-other" onClick={() => setOther("")}>
        Otra acción…
      </button>
    </div>
  );
}

/** Confirmation with a short undo window. Key it by decision: each one gets its full window. */
export function DecisionReceipt({
  label,
  className = "",
  onUndo,
  onClose,
}: {
  label: string;
  className?: string;
  onUndo: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, 10000);
    return () => clearTimeout(timer);
    // Keyed by decision: the window starts once, whatever the parent re-renders.
  }, []);
  return (
    <div className={`decision-receipt ${className}`} role="status">
      <Check size={14} />
      <span>
        <strong>Decisión registrada · {label}</strong>
        <small>
          La sesión en vivo estaba esperando: la orden se da en el motor y la
          noche continúa.
        </small>
      </span>
      <button
        onClick={() => {
          onUndo();
          onClose();
        }}
      >
        <Undo2 size={12} />
        Deshacer
      </button>
      <button aria-label="Cerrar aviso" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
