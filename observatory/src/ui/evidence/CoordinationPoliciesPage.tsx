import "./policies.css";

/** Trained coordination doctrine has not been published yet. Never expose the authoring UI. */
export default function CoordinationPoliciesPage() {
  let rule = "";
  try { rule = decodeURIComponent(window.location.hash.slice(1)); } catch { /* Invalid anchor. */ }
  return <main className="control-center policies-page">
    <header><a href="/">← Centro de coordinación</a><a href="/escalation-policies">Editar políticas de escalado</a></header>
    <article className="coordination-policies-empty">
      <span className="policy-type">SOLO LECTURA · PENDIENTE DE ENTRENAMIENTO</span>
      <h1>Políticas de coordinación</h1>
      <p>Estas políticas serán inferidas por la IA durante el entrenamiento. Cuando estén disponibles, podrás consultarlas y abrir los apartados citados en las decisiones.</p>
      {rule && <section id={rule}><h2>Referencia {rule}</h2><p>El registro cita este identificador, pero el documento y su versión todavía no se han publicado aquí.</p></section>}
    </article>
  </main>;
}
