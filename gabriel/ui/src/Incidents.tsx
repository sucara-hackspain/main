import { clock, INJURIES, type Call, type Frame, type IncidentFrame } from "../../src/engine";
import { PRIORITY_COLORS, type ViewMode } from "./MapView";

type Stage = "unassigned" | "on_the_way" | "confirmed" | "unreachable" | "closed";

const STAGES: { id: Stage; title: string; hint: string }[] = [
  { id: "unassigned", title: "Sin unidad", hint: "Nadie va de camino" },
  { id: "on_the_way", title: "Unidad en camino", hint: "Solo se sabe lo que dicen las llamadas" },
  { id: "confirmed", title: "Confirmado en el lugar", hint: "Una dotación ha visto qué hay; quedan víctimas" },
  { id: "unreachable", title: "Inalcanzables", hint: "Sin ruta por carretera: necesitan rescate acuático o aéreo" },
  { id: "closed", title: "Cerrados (últimos 10 min)", hint: "" },
];

const CLOSED_LABEL = { resolved: "resuelto", not_found: "no había nadie", merged: "duplicado" };

function unitsOf(incident: IncidentFrame, frame: Frame) {
  return {
    heading: frame.units.filter((a) => a.incidentId === incident.id && a.mission === "to_scene" && !a.broken),
    carrying: frame.units.filter((a) => a.incidentId === incident.id && a.victimId),
  };
}

function stageOf(incident: IncidentFrame, frame: Frame): Stage {
  if (incident.status === "closed") return "closed";
  if (incident.unreachable) return "unreachable";
  if (incident.located) return "confirmed";
  return unitsOf(incident, frame).heading.length > 0 ? "on_the_way" : "unassigned";
}

/** Every incident as a card, in the column of how far its response has got. Worst first. */
export function IncidentBoard(props: { frame: Frame; tick: number; tickSeconds: number; selected: string | null; onSelect: (id: string | null) => void }) {
  const { frame, tick, tickSeconds, selected, onSelect } = props;
  const minutes = (ticks: number) => Math.round((ticks * tickSeconds) / 60);
  return (
    <div className="board">
      {STAGES.map((stage) => {
        const cards = frame.incidents
          .filter((i) => i.closedReason !== "merged" && stageOf(i, frame) === stage.id)
          .sort((a, b) => (stage.id === "closed" ? b.updatedTick - a.updatedTick : a.priority - b.priority || a.openedTick - b.openedTick));
        return (
          <section key={stage.id} className={`column ${stage.id}`}>
            <header>
              <h2>
                {stage.title} <b>{cards.length}</b>
              </h2>
              <p>{stage.hint}</p>
            </header>
            <ul>
              {cards.map((inc) => {
                const { heading, carrying } = unitsOf(inc, frame);
                const waiting = inc.victims.filter((v) => v.status === "waiting");
                return (
                  <li key={inc.id} className={inc.id === selected ? "card on" : "card"} onClick={() => onSelect(inc.id === selected ? null : inc.id)}>
                    <div className="top">
                      <b style={{ background: inc.status === "open" ? PRIORITY_COLORS[inc.priority] : "#475569" }}>{inc.status === "open" ? `P${inc.priority}` : "—"}</b>
                      <strong>{inc.id}</strong>
                      <span>{inc.line.split(" · ")[2]?.startsWith("confirmado") || !inc.mechanism ? "" : inc.line.split(" · ")[2]}</span>
                      <time>{inc.status === "open" ? `${minutes(tick - inc.openedTick)} min` : CLOSED_LABEL[inc.closedReason ?? "resolved"]}</time>
                    </div>
                    {inc.status === "open" && (
                      <p>
                        {inc.located
                          ? waiting.map((v) => `${INJURIES[v.injury].label} (${v.triage}${v.trapped ? ", atrapado" : ""})`).join(", ")
                          : inc.line.split(" · ").slice(3, 5).join(" · ")}
                      </p>
                    )}
                    <footer>
                      <span>☎ {inc.callIds.length}</span>
                      {!inc.located && inc.status === "open" && <span>⌖ ±{inc.locationErrorM} m</span>}
                      {(inc.located ? waiting.some((v) => v.trapped) : inc.trapped?.value === "yes") && <span className="trapped">⛓ atrapado</span>}
                      {heading.length > 0 && <span className="unit">→ {heading.map((a) => a.id).join(", ")}</span>}
                      {carrying.length > 0 && <span className="unit carrying">⛑ {carrying.map((a) => a.id).join(", ")}</span>}
                      {inc.cutOffIn !== null && <span className="water">{inc.cutOffIn === 0 ? "≈ aislado por el agua" : `≈ agua en <${minutes(inc.cutOffIn)} min`}</span>}
                    </footer>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** One incident in full: the calls word for word, how the picture was built, and (for the supervisor) the truth. */
export function IncidentDetail(props: { incident: IncidentFrame; frame: Frame; calls: Map<string, Call>; mode: ViewMode; tickSeconds: number; onClose: () => void }) {
  const { incident, frame, calls, mode, tickSeconds, onClose } = props;
  const scene = incident.sceneId ? frame.scenes.find((s) => s.id === incident.sceneId) : undefined;
  return (
    <div className="ficha">
      <button className="close" onClick={onClose}>✕</button>
      <h3>
        {incident.id} · {incident.status === "open" ? `P${incident.priority}` : `cerrado (${CLOSED_LABEL[incident.closedReason ?? "resolved"]})`} · ubicación{" "}
        {incident.located ? "confirmada" : `±${incident.locationErrorM} m`}
      </h3>
      <h4>Llamadas al 112</h4>
      {incident.callIds.map((id) => {
        const call = calls.get(id);
        return (
          <p key={id}>
            <b>{id}</b> {call?.text.replace(/^.*?: /, "")} <i>— {call?.text.split(":")[0].toLowerCase()}</i>
          </p>
        );
      })}
      <h4>Cómo lo ha ido sabiendo</h4>
      {incident.history.map((h, i) => (
        <p key={i} className="history">
          <time>{clock(h.tick, tickSeconds).slice(0, 5)}</time> {h.field}: {h.value} <i>← {h.from}</i>
        </p>
      ))}
      {mode === "truth" && (
        <>
          <h4 className="truth">Realidad (el coordinador no lo ve)</h4>
          {scene ? (
            scene.victims.map((v) => (
              <p key={v.id} className="truth">
                <b>{v.id}</b> {INJURIES[v.injury].label}, {v.age} años · {v.status}
                {v.trapped ? " · atrapado" : ""}
                {v.inWater ? " · dentro del agua" : ""}
                {v.ttl !== null && v.status !== "dead" ? ` · le quedan ${v.ttl} ticks` : ""}
              </p>
            ))
          ) : (
            <p className="truth">Ninguna dotación ha confirmado todavía qué hay allí.</p>
          )}
        </>
      )}
    </div>
  );
}
