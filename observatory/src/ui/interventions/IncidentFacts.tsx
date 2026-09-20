import {
  elapsed,
  injuryLabel,
  priority,
  sceneLabel,
  triageLabel,
  unitKind,
  unitStatus,
  victimStatus,
  type IncidentFrame,
  type TickRecord,
} from "../engineTrace";
import { isolatedWaiting, unattended, type Intervention } from "./model";

const yesNo = { yes: "Sí", no: "No" };
const breathing = { normal: "Normal", difficult: "Con dificultad", none: "No respira" };
const age = { child: "Menor", adult: "Adulto", elderly: "Mayor" };

/** What the coordinator knows about the request, where each piece came from, and what is really there. */
export default function IncidentFacts({
  item,
  record,
  seconds,
}: {
  item: Intervention;
  record: TickRecord;
  seconds: number;
}) {
  const { frame } = record;
  const time = (ticks: number) => elapsed(Math.max(0, ticks), seconds);
  // Technical requests are about the coordinator, not a place: no scene to show.
  if (item.kind === "fallback" || item.kind === "rejected")
    return item.units.length ? (
      <section className="decision-facts">
        <label>UNIDADES AFECTADAS</label>
        <ul className="decision-queue-facts">
          {item.units.map((id) => {
            const u = frame.units.find((x) => x.id === id);
            return (
              <li key={id}>
                {id}
                {u && ` · ${unitKind[u.kind].label.toLowerCase()} · ${unitStatus(u).toLowerCase()}`}
              </li>
            );
          })}
        </ul>
      </section>
    ) : null;
  if (item.kind === "surge" || item.kind === "water")
    return (
      <section className="decision-facts">
        <label>
          {item.kind === "surge"
            ? "INCIDENTES URGENTES SIN UNIDAD"
            : "INCIDENTES AISLADOS SIN UNIDAD ACUÁTICA"}
        </label>
        <ul className="decision-queue-facts">
          {(item.kind === "surge" ? unattended(frame) : isolatedWaiting(frame)).map((i) => (
            <li key={i.id}>{i.line}</li>
          ))}
        </ul>
      </section>
    );
  const incident = frame.incidents.find((i) => i.id === item.incidentId);
  const unit = frame.units.find((u) => u.id === item.units[0]);
  const victims = frame.scenes.flatMap((s) => s.victims);
  const onBoard = victims.find((v) => v.id === item.victimId);
  const scene = frame.scenes.find((s) => s.id === incident?.sceneId);
  const crews = incident
    ? frame.units.filter((u) => u.incidentId === incident.id)
    : [];
  return (
    <section className="decision-facts">
      {incident && (
        <>
          <label>LO QUE SABE EL COORDINADOR · {incident.id}</label>
          <dl>
            <dt>Prioridad</dt>
            <dd>
              P{incident.priority} · {priority[incident.priority].label}
            </dd>
            <Fact
              name="Qué ha pasado"
              value={incident.mechanism && sceneLabel(incident.mechanism.value)}
              from={incident.mechanism?.from}
            />
            <dt>Ubicación</dt>
            <dd>
              {incident.located
                ? "Confirmada por una dotación"
                : `Aproximada, ±${incident.locationErrorM} m`}
            </dd>
            <dt>Llamadas</dt>
            <dd>
              {incident.callIds.length} · <code>{incident.callIds.join(", ")}</code>
            </dd>
            <Fact
              name="Heridos según las llamadas"
              value={incident.victimsReported && String(incident.victimsReported.value)}
              from={incident.victimsReported?.from}
            />
            <Fact
              name="Atrapados"
              value={incident.trapped && yesNo[incident.trapped.value]}
              from={incident.trapped?.from}
            />
            <Fact
              name="Consciente"
              value={incident.conscious && yesNo[incident.conscious.value]}
              from={incident.conscious?.from}
            />
            <Fact
              name="Respira"
              value={incident.breathing && breathing[incident.breathing.value]}
              from={incident.breathing?.from}
            />
            <Fact
              name="Sangrado"
              value={incident.bleeding && yesNo[incident.bleeding.value]}
              from={incident.bleeding?.from}
            />
            <Fact
              name="Edad"
              value={incident.ageGroup && age[incident.ageGroup.value]}
              from={incident.ageGroup?.from}
            />
            {incident.unreachable && (
              <>
                <dt>Acceso</dt>
                <dd className="danger">Ninguna calle conocida llega</dd>
              </>
            )}
            {incident.cutOffIn !== null && (
              <>
                <dt>Agua</dt>
                <dd className="danger">
                  {incident.cutOffIn === 0
                    ? "La previsión lo da por aislado"
                    : `Previsión: lo aísla en ${time(incident.cutOffIn)}`}
                </dd>
              </>
            )}
            <dt>Unidades</dt>
            <dd>
              {crews.length
                ? crews
                    .map((u) => `${u.id} (${unitKind[u.kind].label.toLowerCase()}) · ${unitStatus(u).toLowerCase()}`)
                    .join(" · ")
                : "Ninguna"}
            </dd>
          </dl>
          {incident.victims.length > 0 && (
            <p className="decision-facts-note">
              Valorado en el lugar: {assessed(incident)}
            </p>
          )}
        </>
      )}
      <label>REALIDAD DE LA SIMULACIÓN · SOLO SUPERVISIÓN</label>
      {onBoard ? (
        <ul className="decision-truth">
          <Victim v={onBoard} time={time} where={unit ? `a bordo de ${unit.id}` : undefined} />
        </ul>
      ) : scene ? (
        <>
          <p className="decision-facts-note">
            {scene.id} · {sceneLabel(scene.kind)}
          </p>
          <ul className="decision-truth">
            {scene.victims.map((v) => (
              <Victim key={v.id} v={v} time={time} />
            ))}
          </ul>
        </>
      ) : (
        <p className="decision-facts-note">
          Ninguna dotación ha llegado todavía: la escena real no está
          confirmada.
        </p>
      )}
    </section>
  );
}

function Fact({ name, value, from }: { name: string; value: string | null | undefined; from?: string }) {
  if (!value) return null;
  return (
    <>
      <dt>{name}</dt>
      <dd>
        {value}
        {from && <code title="Fuente del dato">{from}</code>}
      </dd>
    </>
  );
}

function Victim({
  v,
  time,
  where,
}: {
  v: TickRecord["frame"]["scenes"][number]["victims"][number];
  time: (ticks: number) => string;
  where?: string;
}) {
  return (
    <li data-triage={v.triage}>
      <strong>{v.id}</strong> · {injuryLabel(v.injury)} · {v.age} años · triaje{" "}
      {triageLabel[v.triage].toLowerCase()}
      {v.trapped ? " · atrapada" : ""}
      {v.inWater ? " · en el agua" : ""} · {where ?? victimStatus[v.status].toLowerCase()}
      {v.ttl !== null && (v.status === "waiting" || v.status === "in_ambulance")
        ? ` · le quedan ${time(v.ttl)}`
        : ""}
    </li>
  );
}

const assessed = (incident: IncidentFrame) =>
  incident.victims
    .map(
      (v) =>
        `${v.id} ${injuryLabel(v.injury)} (${triageLabel[v.triage].toLowerCase()}${v.trapped ? ", atrapada" : ""})`,
    )
    .join(" · ");
