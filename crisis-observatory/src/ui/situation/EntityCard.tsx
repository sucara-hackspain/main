import type { ReactNode } from "react";
import { ClipboardList, X } from "lucide-react";
import { priority, sceneLabel, UNIT_KINDS, type GraphData, type Selection } from "../engineTrace";
import { attentionText, capitalize, hospitalName, incidentIcon, incidentWhat } from "./entityParts";
import { hospitalIcon, unitIcon } from "../map/unitIcons";
import { ticketNextStep, ticketStates, type Ticket } from "../tickets/model";
import { duration, type Situation } from "./model";
import "./situation.css";

const can = { carries: "Traslada víctimas", extricates: "Excarcela", wades: "Cruza el agua", flies: "Vuela", observes: "Reconoce desde el aire" };
const samePlace = (a: [number, number], b: [number, number]) =>
  a[0].toFixed(6) === b[0].toFixed(6) && a[1].toFixed(6) === b[1].toFixed(6);

type Props = {
  s: Situation;
  selection: Selection;
  graph: GraphData;
  /** The incident's ticket, when the selection is one. */
  ticket: Ticket | null;
  onSelect: (ref: Selection | null) => void;
  onOpenTicket: (incidentId: string) => void;
};

/** The selection's detail, in a popover on the map: what it is, how it is now, what it is tied to, what to do next. */
export default function EntityCard({ s, selection, graph, ticket, onSelect, onOpenTicket }: Props) {
  const link = (ref: Selection, label: string) => (
    <button key={`${ref.kind}:${ref.id}`} className="entity-link" onClick={() => onSelect(ref)}>{label}</button>
  );
  const shell = (icon: ReactNode, kind: string, title: string, body: ReactNode, actions?: ReactNode) => (
    <section className="entity-card" role="dialog" aria-label="Detalle de la selección">
      <header className="entity-card-head">
        {icon}
        <div><span className="entity-card-kind">{kind}</span><h3>{title}</h3></div>
        <button className="entity-card-close" aria-label="Cerrar detalle" onClick={() => onSelect(null)}><X size={14} /></button>
      </header>
      {body}
      {actions && <footer className="entity-card-actions">{actions}</footer>}
    </section>
  );
  if (selection.kind === "incident") {
    const i = s.incidents.find((x) => x.id === selection.id);
    if (!i) return null;
    const next = ticket && ticketNextStep(ticket);
    const street = ticket?.location && ticket.calls.some((c) => c.street) ? ticket.location : null;
    return shell(
      <span className="entity-card-icon incident" data-state={i.attention} dangerouslySetInnerHTML={{ __html: incidentIcon[i.mechanism?.value ?? "unknown"] }} />,
      "Incidencia",
      `${i.id} · ${capitalize(incidentWhat(i))}`,
      <>
        <div className="entity-card-badges">
          <span className="entity-badge" data-tone={i.attention === "waiting" ? "danger" : undefined}>{capitalize(attentionText[i.attention])}</span>
          <span className="entity-badge" data-critical={i.priority === 0 || undefined}>P{i.priority} · {priority[i.priority].label}</span>
        </div>
        <dl className="entity-card-facts">
          <dt>Situación</dt><dd>{i.label}</dd>
          <dt>Ubicación</dt><dd>{i.located ? "Confirmada por una dotación" : `Aproximada · ±${i.locationErrorM} m`}{street && <small>{street}</small>}</dd>
          <dt>Llamadas</dt><dd>{i.callIds.length}</dd>
          <dt>Heridos</dt><dd>{i.located ? `${i.victims.length} confirmados en el lugar` : i.victimsReported ? `${i.victimsReported.value} según las llamadas` : "Por confirmar"}</dd>
          {i.open && (i.unreachable || i.cutOffIn !== null) && <><dt>Agua</dt><dd className="danger">
            {i.unreachable ? "Ninguna calle conocida llega" : i.cutOffIn === 0 ? "La previsión la da por aislada" : `La previsión la aísla en ${duration(i.cutOffIn!, s.seconds)}`}
          </dd></>}
          {i.open && <><dt>Unidades</dt><dd>{i.crews.length ? i.crews.map((u) => link(u.ref, `${u.id} · ${u.label}`)) : "Ninguna"}</dd></>}
          {i.wait !== null && <><dt>{i.crews.length ? "Abierta hace" : "Esperando"}</dt><dd>{duration(i.wait, s.seconds)}</dd></>}
        </dl>
        {next && <p className="entity-card-note"><strong>{next.title}</strong>{next.detail}</p>}
      </>,
      <button className="entity-action primary" onClick={() => onOpenTicket(i.id)}><ClipboardList size={13} />Abrir ticket{ticket && <small>{ticketStates[ticket.state]}</small>}</button>,
    );
  }

  if (selection.kind === "unit") {
    const u = s.units.find((x) => x.id === selection.id);
    if (!u) return null;
    return shell(
      <span className="entity-card-icon" dangerouslySetInnerHTML={{ __html: unitIcon[u.kind] }} />,
      `Unidad propia · ${u.kindLabel}`,
      u.id,
      <>
        <div className="entity-card-badges"><span className="entity-badge" data-tone={u.tone === "danger" ? "danger" : undefined}>{u.label}</span></div>
        <dl className="entity-card-facts">
          <dt>Ahora</dt><dd>{u.detail}</dd>
          {u.incidentId && <><dt>Incidencia</dt><dd>{link({ kind: "incident", id: u.incidentId }, u.incidentId)}</dd></>}
          {u.victimId && <><dt>A bordo</dt><dd>{u.victimId}</dd></>}
          {u.hospitalId && <><dt>Destino</dt><dd>{link({ kind: "hospital", id: u.hospitalId }, u.hospitalId)}</dd></>}
          <dt>Puede</dt><dd>{(Object.keys(can) as (keyof typeof can)[]).filter((k) => UNIT_KINDS[u.kind][k]).map((k) => can[k]).join(" · ")}</dd>
        </dl>
      </>,
    );
  }

  if (selection.kind === "hospital") {
    const h = s.hospitals.find((x) => x.id === selection.id);
    if (!h) return null;
    const here = s.units.filter((u) => samePlace(u.pos, graph.nodes[h.node]));
    return shell(
      <span className="entity-card-icon" dangerouslySetInnerHTML={{ __html: hospitalIcon }} />,
      "Hospital",
      `${h.id} · ${hospitalName(h.name)}`,
      <>
        <dl className="entity-card-facts">
          <dt>Camas libres</dt><dd>{h.free} de {h.capacity}
            <span className="situation-capacity" role="img" aria-label={`${h.occupied} camas ocupadas de ${h.capacity}`}>
              <span className="situation-capacity-used" style={{ width: `${Math.min(100, h.capacity ? h.occupied / h.capacity * 100 : 0)}%` }} />
              <span className="situation-capacity-incoming" style={{ width: `${Math.min(h.free, h.incoming.length) / Math.max(1, h.capacity) * 100}%` }} />
            </span>
          </dd>
          <dt>En camino</dt><dd>{h.incoming.length ? h.incoming.map((u) => link(u.ref, `${u.id} · ${u.victimId}`)) : "Ningún traslado"}</dd>
          <dt>Margen previsto</dt><dd className={h.margin < 0 ? "danger" : ""}>{h.margin} camas</dd>
          <dt>Helipuerto</dt><dd>{h.helipad ? "Sí" : "No"}</dd>
          <dt>Unidades aquí</dt><dd>{here.length ? here.map((u) => link(u.ref, `${u.id} · ${u.label}`)) : "Ninguna"}</dd>
        </dl>
        <p className="entity-card-note">El margen descuenta las víctimas a bordo con este destino, incluidos los traslados detenidos. No son reservas.</p>
      </>,
    );
  }

  const scene = s.scenes.find((x) => x.id === selection.id);
  if (!scene) return null;
  const known = s.incidents.find((i) => i.sceneId === scene.id);
  return shell(
    <span className="entity-card-icon scene" />,
    "Escena real · solo supervisión",
    `${scene.id} · ${capitalize(sceneLabel(scene.kind))}`,
    <>
      <dl className="entity-card-facts">
        <dt>Víctimas</dt><dd>{scene.victims.length}</dd>
        <dt>Sin atender</dt><dd>{scene.victims.filter((v) => v.status === "waiting").length}</dd>
        <dt>En el agua</dt><dd>{scene.victims.filter((v) => v.inWater).length}</dd>
        <dt>Incidencia</dt><dd>{known ? link(known.ref, known.id) : "El coordinador todavía no la ha localizado"}</dd>
      </dl>
      <p className="entity-card-note">El coordinador no ve la escena real: la sitúa donde dicen las llamadas hasta que una dotación la encuentra.</p>
    </>,
  );
}
