import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { savePolicy, type Policy } from "./policyStore";
import { escalationKinds, thresholdLabels, thresholdsFor } from "./escalationDefaults";
export default function PolicyEditor({ original, onClose }: { original: Policy | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Policy>(original ?? { id: "", title: "", body: "", kind: "unassigned", severity: "warning" });
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const [saving, setSaving] = useState(false);
  function save(deleted = false) {
    setSaving(true);
    savePolicy({ ...draft, deleted }, original ?? undefined).then(onClose, (e: unknown) => {
      setError(e instanceof Error ? e.message : "No se pudo guardar el catálogo.");
      setSaving(false);
    });
  }
  return <dialog ref={dialog} className="policy-editor" onCancel={onClose} aria-labelledby="policy-editor-title">
    <form onSubmit={e => { e.preventDefault(); save(); }}>
      <header><h2 id="policy-editor-title">{original ? "Editar política de escalado" : "Nueva política de escalado"}</h2><button type="button" aria-label="Cerrar editor" onClick={onClose}><X size={16}/></button></header>
      <label>Identificador<input required maxLength={40} pattern="[A-Za-z0-9_-]+" value={draft.id} disabled={!!original} onChange={e=>setDraft({...draft,id:e.target.value})} placeholder="ESC-07" /></label>
      <label>Título<input required maxLength={180} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} autoFocus /></label>
      <label>Situación que requiere escalado<small>De las que el motor sabe reconocer</small><select value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value as Policy["kind"]})}>{Object.entries(escalationKinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      {thresholdsFor[draft.kind].map(key=><label key={key}>{thresholdLabels[key]}<input type="number" min={0} step={1} value={draft[key] ?? ""} placeholder="Por defecto del motor"
        onChange={e=>setDraft({...draft,[key]: e.target.value === "" ? undefined : Number(e.target.value)})} /></label>)}
      <label className="policy-switch"><input type="checkbox" checked={draft.enabled !== false} onChange={e=>setDraft({...draft,enabled:e.target.checked})} />En vigor: el motor escala esta situación</label>
      <label>Prioridad de la alerta<select value={draft.severity} onChange={e=>setDraft({...draft,severity:e.target.value as Policy["severity"]})}><option value="critical">Crítica</option><option value="warning">Revisión necesaria</option></select></label>
      <label>Cuándo debe escalar la IA<textarea required maxLength={12000} rows={7} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})} placeholder="Describe la condición, sus límites y la información que debe revisar el operador."/></label>
      <p className="policy-search-help">Respuesta prevista: solicitar una decisión humana mediante la alerta a pantalla completa. Se guarda en el catálogo del motor y rige desde la siguiente ejecución.</p>
      {error && <p role="alert" className="policy-error">{error}</p>}
      {removing && <div className="policy-delete-confirm"><p>¿Eliminar {draft.id}? Sus enlaces seguirán indicando que fue eliminada y podrás restaurarla.</p><button type="button" onClick={()=>save(true)}>Confirmar eliminación</button><button type="button" onClick={()=>setRemoving(false)}>Cancelar</button></div>}
      <footer>{original && !original.deleted && <button type="button" className="policy-danger" onClick={()=>setRemoving(true)}>Eliminar política</button>}<button type="button" onClick={onClose}>Cancelar</button><button className="policy-primary" type="submit" disabled={saving}>{saving ? "Guardando…" : original?.deleted ? "Restaurar política" : "Guardar política"}</button></footer>
    </form>
  </dialog>;
}
