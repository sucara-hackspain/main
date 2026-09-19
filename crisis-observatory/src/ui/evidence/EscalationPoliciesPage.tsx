import { useEffect, useRef, useState } from "react";
import { Plus, Search, Pencil, ArrowUpRight } from "lucide-react";
import { loadPolicies, POLICY_KEY, type Policy } from "./policyStore";
import PolicyEditor from "./PolicyEditor";
import "./policies.css";
import { escalationKinds } from "./escalationDefaults";
export default function EscalationPoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState("");
  const [section, setSection] = useState("");
  const [editing, setEditing] = useState<Policy | null | undefined>(undefined);
  const [query, setQuery] = useState(""), [submitted, setSubmitted] = useState("");
  const [mode, setMode] = useState("semantic"), [showDeleted, setShowDeleted] = useState(false);
  const [results, setResults] = useState<{id:string;score:number}[]>([]);
  const [status, setStatus] = useState(""), [searchError, setSearchError] = useState("");
  const [retry, setRetry] = useState(0);
  const worker = useRef<Worker | null>(null), request = useRef(0);
  useEffect(() => {
    function reload() {
      try { setPolicies(loadPolicies()); setError(""); }
      catch(e) { setError(e instanceof Error ? e.message : "No se pudieron leer las políticas."); }
    }
    function storage(e: StorageEvent) { if (!e.key || e.key === POLICY_KEY) reload(); }
    reload();
    window.addEventListener("storage", storage);
    window.addEventListener("policies-changed", reload);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener("policies-changed", reload); };
  }, []);
  useEffect(() => {
    function locate() {
      let id = "";
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { /* Invalid anchor. */ }
      setSection(id); setQuery(""); setSubmitted("");
    }
    locate(); window.addEventListener("hashchange", locate);
    return () => window.removeEventListener("hashchange", locate);
  }, []);
  useEffect(() => { if (section) requestAnimationFrame(()=>document.getElementById(section)?.scrollIntoView({block:"center"})); }, [section, policies]);
  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => {
    const id = ++request.current;
    setResults([]); setSearchError("");
    if (!submitted || mode !== "semantic") {
      setStatus(""); worker.current?.postMessage({request:id,query:"",policies:[]}); return;
    }
    setStatus("Preparando búsqueda semántica…");
    worker.current ??= new Worker(new URL("./semantic.worker.ts", import.meta.url), {type:"module"});
    worker.current.onmessage = ({data}) => {
      if(data.request !== request.current) return;
      if(data.results) { setResults(data.results); setStatus(""); }
      else if(data.error) { setSearchError(data.error); setStatus(""); }
      else setStatus(data.status);
    };
    worker.current.onerror = () => {
      setSearchError("No se pudo iniciar la búsqueda semántica. Puedes reintentar o buscar por texto."); setStatus("");
      worker.current?.terminate(); worker.current=null;
    };
    worker.current.postMessage({request:id,query:submitted,policies:policies.filter(p=>!p.deleted)});
  }, [submitted,mode,policies,retry]);
  const normalize = (s:string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  const active = policies.filter(p=>!p.deleted || showDeleted || p.id===section);
  const shown = !submitted ? active : mode==="semantic"
    ? results.flatMap(r=>policies.filter(p=>p.id===r.id && !p.deleted))
    : active.filter(p=>normalize(p.id+" "+p.title+" "+p.body).includes(normalize(submitted)));
  return <main className="control-center policies-page">
    <header><a href="/">← Centro de coordinación</a><a href="/coordination-policies">Políticas de coordinación · Solo lectura</a></header>
    <div className="policies-layout"><nav aria-label="Apartados de políticas"><strong>Políticas de escalado</strong>
      {policies.filter(p=>!p.deleted).map(rule=><a key={rule.id} href={`#${rule.id}`} aria-current={section===rule.id?"location":undefined}><code>{rule.id}</code>{rule.title}</a>)}
    </nav><article>
      <div className="policy-heading"><h1>Políticas de escalado</h1><button className="policy-primary" disabled={!!error} onClick={()=>setEditing(null)}><Plus size={14}/>Nueva política</button></div>
      <p className="policies-note">Define cuándo la IA debe pedir una decisión humana y mostrar la alerta a pantalla completa. Estas reglas se guardan como borradores locales; todavía no modifican las alertas de la simulación.</p>
      {error && <p role="alert" className="policy-error">{error}</p>}
      <form className="policy-search" onSubmit={e=>{e.preventDefault();setSubmitted(query.trim());setRetry(r=>r+1);}}>
        <label htmlFor="policy-query">Buscar políticas</label><div><Search size={16}/><input id="policy-query" value={query} onChange={e=>{setQuery(e.target.value);if(!e.target.value.trim())setSubmitted("");}} placeholder="¿Cuándo debe intervenir una persona?"/><button className="policy-primary" type="submit" disabled={!query.trim()}>Buscar</button></div>
        <div className="policy-search-options"><label>Modo<select aria-label="Modo de búsqueda" value={mode} onChange={e=>setMode(e.target.value)}><option value="semantic">Por significado</option><option value="text">Por texto o ID</option></select></label><button type="button" onClick={()=>{setQuery("");setSubmitted("");}}>Ver todas</button></div>
        <small>{mode==="semantic" ? "Búsqueda semántica en este dispositivo. La primera consulta descarga el modelo; requiere conexión." : "Coincidencias en el identificador, título y contenido."}</small>
      </form>
      <div className="policy-results-meta"><span aria-live="polite">{status || (submitted ? `${shown.length} resultados · ${submitted}` : `${active.length} políticas`)}</span><label><input type="checkbox" checked={showDeleted} onChange={e=>setShowDeleted(e.target.checked)}/>Mostrar eliminadas</label></div>
      {submitted && mode==="semantic" && !status && !searchError && <p className="policy-search-help">Ordenadas por afinidad semántica. Son sugerencias para consultar, no una confirmación de que la política sea aplicable.</p>}
      {searchError && <p role="alert" className="policy-error">{searchError} <button onClick={()=>setRetry(r=>r+1)}>Reintentar</button></p>}
      {!status && !searchError && !shown.length && <p>No hay políticas que mostrar. Prueba otra búsqueda o crea una política.</p>}
      {section && !policies.some(p=>p.id===section) && <section id={section}><h2>Política {section}</h2><p>Este identificador no está en el catálogo disponible.</p></section>}
      {shown.map(rule=><section id={rule.id} key={rule.id} className={rule.deleted?"policy-deleted":""}>
        <div className="policy-row-tools"><span className="policy-type">{rule.deleted?"Eliminada":escalationKinds[rule.kind]} · Borrador local</span><button aria-label={`Editar política ${rule.id}`} onClick={()=>setEditing(rule)}><Pencil size={13}/>{rule.deleted?"Restaurar":"Editar"}</button></div>
        <h2><a href={`#${rule.id}`} aria-label={`Enlace al apartado ${rule.id}`}>{rule.id}<ArrowUpRight size={11}/></a>{rule.title}</h2>
        {rule.deleted?<p>Esta política fue eliminada del catálogo local. Se conserva el identificador para no romper las referencias anteriores.</p>:<p>{rule.body}</p>}
        {!rule.deleted && <div className="policy-escalation-outcome"><span data-severity={rule.severity}>{rule.severity==="critical"?"Crítica":"Revisión necesaria"}</span><span>Decisión humana · Alerta a pantalla completa</span></div>}
      </section>)}
    </article></div>
    {editing!==undefined && <PolicyEditor original={editing} onClose={()=>setEditing(undefined)}/>}
  </main>;
}
