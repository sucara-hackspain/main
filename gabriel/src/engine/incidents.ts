import type { Graph } from "./graph";
import type { AssessedVictim, Unit, UnitKind, Belief, Breathing, Call, Incident, Priority, Report, Sourced, World } from "./types";
import { INJURIES, SCENES } from "./victims";
import { addSighting, applyBulletin, impliesWater } from "./water";

// The coordinator's side of the fence: calls come in, incidents come out.
// Everything here works from reports only; none of it may look at the world's scenes or victims.

/** Calls this close in space and time, about the same kind of thing, are taken to be the same incident. */
const ATTACH_SLACK_M = 100;
const ATTACH_WINDOW_TICKS = 24;

export function createBelief(world: Readonly<World>): Belief {
  return {
    tick: world.tick,
    units: structuredClone(world.units),
    hospitals: structuredClone(world.hospitals),
    incidents: [],
    calls: [],
    waterSightings: [],
    floods: [],
    closedEdges: [],
    floodedEdges: [],
    nextIncidentNum: 1,
  };
}

/** Folds new reports into the coordinator's picture of the world. */
export function updateBelief(belief: Belief, reports: Report[], world: Readonly<World>, graph: Graph): void {
  belief.tick = world.tick;
  // Fleet GPS/status and hospital bed counts come from our own systems, not from reports.
  belief.units = structuredClone(world.units);
  belief.hospitals = structuredClone(world.hospitals);

  for (const { event, tick } of reports) {
    switch (event.type) {
      case "call_received":
        belief.calls.push(event.call);
        attachCall(belief, event.call, graph);
        if (impliesWater(event.call.mechanism)) addSighting(belief, tick, event.call.node, event.call.id, "wet");
        break;
      case "flood_bulletin":
        applyBulletin(belief, event, graph);
        break;
      case "road_blocked_found":
        belief.closedEdges.push(...event.edges.filter((e) => !belief.closedEdges.includes(e)));
        if (event.flooded) belief.floodedEdges.push(...event.edges.filter((e) => !belief.floodedEdges.includes(e)));
        if (event.flooded) addSighting(belief, tick, event.node, `radio ${event.unitId}`, "blocked");
        break;
      case "unit_stranded": {
        const incident = resolve(belief, event.incidentId);
        if (incident && incident.status === "open" && !incident.unreachable) {
          incident.unreachable = true;
          note(incident, tick, "acceso", "sin ruta por carretera: necesita rescate acuático o aéreo", `radio ${event.unitId}`);
        }
        break;
      }
      case "action_rejected":
        if (event.action.type === "dispatch" && event.reason.startsWith("no open route")) {
          const incident = resolve(belief, event.action.incidentId);
          if (incident && !incident.unreachable) {
            incident.unreachable = true;
            note(incident, tick, "acceso", "sin ruta conocida por carretera", "sistema");
          }
        }
        break;
      case "scene_assessed": {
        const incident = incidentFor(belief, event.incidentId, event.sceneId, tick, event.node, event.unitId);
        const from = `radio ${event.unitId}`;
        if (!incident.located || incident.node !== event.node) note(incident, tick, "ubicación", `confirmada en nodo ${event.node}`, from);
        incident.node = event.node;
        incident.locationErrorM = 0;
        incident.located = true;
        incident.sceneId = event.sceneId;
        incident.victims = structuredClone(event.victims);
        note(incident, tick, "víctimas", event.victims.map((v) => `${v.id} ${INJURIES[v.injury].label} (${v.triage})`).join(", "), from);
        if (impliesWater(incident.mechanism?.value)) addSighting(belief, tick, event.node, from, "wet");
        refresh(incident, tick);
        break;
      }
      case "scene_not_found": {
        const incident = resolve(belief, event.incidentId);
        if (incident && incident.status === "open" && !incident.located) {
          note(incident, tick, "estado", "nadie en el lugar", `radio ${event.unitId}`);
          close(incident, "not_found", tick);
        }
        break;
      }
      case "victim_freed":
        for (const incident of belief.incidents) {
          const victim = incident.victims.find((v) => v.id === event.victimId);
          if (victim) victim.trapped = false;
        }
        break;
      case "victim_picked_up":
        setVictim(belief, event.victimId, "in_ambulance", tick);
        break;
      case "victim_treated":
        setVictim(belief, event.victimId, "treated", tick);
        break;
      case "victim_delivered":
        setVictim(belief, event.victimId, "delivered", tick);
        break;
      case "road_closed":
        if (!belief.closedEdges.includes(event.edge)) belief.closedEdges.push(event.edge);
        break;
      case "road_opened":
        belief.closedEdges = belief.closedEdges.filter((e) => e !== event.edge);
        break;
    }
  }
}

function note(incident: Incident, tick: number, field: string, value: string, from: string): void {
  incident.history.push({ tick, field, value, from });
  incident.updatedTick = tick;
}

function newIncident(belief: Belief, tick: number, node: number, errorM: number): Incident {
  const incident: Incident = {
    id: `C${belief.nextIncidentNum++}`,
    status: "open",
    closedReason: null,
    mergedInto: null,
    emergencyId: null,
    openedTick: tick,
    updatedTick: tick,
    node,
    locationErrorM: errorM,
    located: false,
    sceneId: null,
    callIds: [],
    mechanism: null,
    conscious: null,
    breathing: null,
    bleeding: null,
    trapped: null,
    ageGroup: null,
    victimsReported: null,
    victims: [],
    priority: 2,
    unreachable: false,
    history: [],
  };
  belief.incidents.push(incident);
  return incident;
}

/** Follows merges to the incident that is still alive. */
export function resolve(belief: Belief, id: string | null): Incident | undefined {
  let incident = belief.incidents.find((i) => i.id === id);
  while (incident?.mergedInto) incident = belief.incidents.find((i) => i.id === incident!.mergedInto);
  return incident;
}

/** New call: same incident as one we already have, or a new one? */
function attachCall(belief: Belief, call: Call, graph: Graph): void {
  let best: Incident | null = null;
  let bestM = Infinity;
  for (const incident of belief.incidents) {
    if (incident.status !== "open" || call.tick - incident.openedTick > ATTACH_WINDOW_TICKS) continue;
    if (call.mechanism && incident.mechanism && call.mechanism !== incident.mechanism.value) continue;
    const d = graph.distanceM(call.node, incident.node);
    if (d <= call.locationErrorM + incident.locationErrorM + ATTACH_SLACK_M && d < bestM) {
      best = incident;
      bestM = d;
    }
  }
  const incident = best ?? newIncident(belief, call.tick, call.node, call.locationErrorM);
  incident.callIds.push(call.id);
  note(incident, call.tick, "llamada", best ? `${call.id} adjuntada (a ${Math.round(bestM)} m)` : `${call.id} abre el incidente`, call.id);

  // The most precise caller wins the location; a crew's confirmation beats them all.
  if (!incident.located && call.locationErrorM < incident.locationErrorM) {
    incident.node = call.node;
    incident.locationErrorM = call.locationErrorM;
    note(incident, call.tick, "ubicación", `nodo ${call.node} ±${call.locationErrorM} m`, call.id);
  }

  const src = <T>(value: T): Sourced<T> => ({ value, from: call.id, tick: call.tick });
  if (call.mechanism && !incident.mechanism) incident.mechanism = src(call.mechanism);
  // "Unknown" never overwrites an answer, and the worse answer wins: better to over-triage than to miss an arrest.
  if (call.conscious !== "unknown" && incident.conscious?.value !== "no" && incident.conscious?.value !== call.conscious) {
    incident.conscious = src(call.conscious);
    note(incident, call.tick, "consciente", call.conscious === "yes" ? "sí" : "no", call.id);
  }
  if (call.breathing !== "unknown" && breathingRank(call.breathing) > breathingRank(incident.breathing?.value)) {
    incident.breathing = src(call.breathing);
    note(incident, call.tick, "respira", call.breathing, call.id);
  }
  if (call.bleeding !== "unknown" && incident.bleeding?.value !== "yes" && incident.bleeding?.value !== call.bleeding) {
    incident.bleeding = src(call.bleeding);
    note(incident, call.tick, "sangra", call.bleeding === "yes" ? "sí" : "no", call.id);
  }
  if (call.trapped !== "unknown" && incident.trapped?.value !== "yes" && incident.trapped?.value !== call.trapped) {
    incident.trapped = src(call.trapped);
    note(incident, call.tick, "atrapado", call.trapped === "yes" ? "sí" : "no", call.id);
  }
  if (call.ageGroup !== "unknown" && !incident.ageGroup) incident.ageGroup = src(call.ageGroup);
  if (call.victims !== null && call.victims > (incident.victimsReported?.value ?? 0)) {
    incident.victimsReported = src(call.victims);
    note(incident, call.tick, "nº heridos", String(call.victims), call.id);
  }
  refresh(incident, call.tick);
}

function breathingRank(b: Breathing | undefined): number {
  return b === "none" ? 3 : b === "difficult" ? 2 : b === "normal" ? 1 : 0;
}

/** The incident a crew's radio message is about. Two incidents turning out to be one scene get merged. */
function incidentFor(belief: Belief, incidentId: string | null, sceneId: string, tick: number, node: number, unitId: string): Incident {
  const tagged = resolve(belief, incidentId);
  const sameScene = belief.incidents.find((i) => i.sceneId === sceneId && !i.mergedInto);
  if (sameScene && tagged && sameScene !== tagged) {
    sameScene.callIds.push(...tagged.callIds);
    note(sameScene, tick, "fusión", `${tagged.id} era este mismo incidente`, `radio ${unitId}`);
    note(tagged, tick, "fusión", `fusionado en ${sameScene.id}`, `radio ${unitId}`);
    close(tagged, "merged", tick);
    tagged.mergedInto = sameScene.id;
    if (sameScene.status === "closed") {
      sameScene.status = "open";
      sameScene.closedReason = null;
    }
    return sameScene;
  }
  return sameScene ?? tagged ?? newIncident(belief, tick, node, 0);
}

function setVictim(belief: Belief, victimId: string, status: AssessedVictim["status"], tick: number): void {
  for (const incident of belief.incidents) {
    const victim = incident.victims.find((v) => v.id === victimId);
    if (!victim) continue;
    victim.status = status;
    refresh(incident, tick);
  }
}

function close(incident: Incident, reason: NonNullable<Incident["closedReason"]>, tick: number): void {
  incident.status = "closed";
  incident.closedReason = reason;
  incident.updatedTick = tick;
}

function refresh(incident: Incident, tick: number): void {
  const before = incident.priority;
  incident.priority = deducePriority(incident);
  if (incident.priority !== before) note(incident, tick, "prioridad", `P${before} → P${incident.priority}`, "reglas");
  if (incident.located && !incident.victims.some((v) => v.status === "waiting") && incident.status === "open") {
    close(incident, "resolved", tick);
  }
}

/** Priority from what is known, the way a 112 protocol does it. Nobody ever tells the coordinator how long someone has. */
export function deducePriority(incident: Incident): Priority {
  if (incident.located) {
    const waiting = incident.victims.filter((v) => v.status === "waiting");
    if (waiting.some((v) => v.injury === "cardiac_arrest")) return 0;
    if (waiting.some((v) => v.triage === "red")) return 1;
    if (waiting.some((v) => v.triage === "yellow")) return 2;
    return 3;
  }
  const conscious = incident.conscious?.value;
  const breathing = incident.breathing?.value;
  if (breathing === "none" || (conscious === "no" && !breathing)) return 0;
  if (conscious === "no" || breathing === "difficult" || incident.bleeding?.value === "yes") return 1;
  const violent = incident.mechanism && incident.mechanism.value !== "fall" && incident.mechanism.value !== "collapse";
  if (conscious === "yes" && breathing === "normal") return violent ? 2 : 3;
  return 2;
}

export interface Needs {
  /** Crews that can carry someone to hospital (ambulance, rescue, helicopter). */
  carriers: number;
  /** Firefighters to free whoever is trapped. */
  fire: number;
}

/** What the incident still needs, beyond the units already heading there. */
export function unitsNeeded(incident: Incident, units: Unit[]): Needs {
  let carriers: number;
  let fire: number;
  if (incident.located) {
    const waiting = incident.victims.filter((v) => v.status === "waiting");
    const toCarry = waiting.filter((v) => INJURIES[v.injury].transport);
    // One crew can patch up all the minor ones. Trapped victims need firefighters before anyone can take them.
    carriers = toCarry.filter((v) => !v.trapped).length + (waiting.length > toCarry.length && toCarry.length === 0 ? 1 : 0);
    fire = waiting.some((v) => v.trapped) ? 1 : 0;
  } else {
    // Before anyone has been there, a second carrier only if callers speak of several hurt.
    carriers = (incident.victimsReported?.value ?? 1) >= 2 ? 2 : 1;
    fire = incident.trapped?.value === "yes" ? 1 : 0;
  }
  const heading = units.filter((u) => u.incidentId === incident.id && u.mission === "to_scene" && u.brokenUntil === null);
  const isFire = (k: UnitKind) => k === "fire";
  return {
    carriers: Math.max(0, carriers - heading.filter((u) => !isFire(u.kind)).length),
    // A rescue crew frees people too.
    fire: Math.max(0, fire - heading.filter((u) => isFire(u.kind) || u.kind === "rescue").length),
  };
}

/** One line per incident: what always goes in the coordinator's briefing. */
export function incidentLine(incident: Incident): string {
  const parts: string[] = [`${incident.id} · P${incident.priority}`];
  if (incident.mechanism) parts.push(SCENES[incident.mechanism.value].label);
  if (incident.located) {
    const waiting = incident.victims.filter((v) => v.status === "waiting");
    parts.push(`confirmado por dotación: ${waiting.length} esperando (${waiting.map((v) => `${INJURIES[v.injury].label}/${v.triage}${v.trapped ? "/ATRAPADO" : ""}`).join(", ") || "nadie"})`);
  } else {
    const signs = [
      incident.conscious ? (incident.conscious.value === "yes" ? "consciente" : "inconsciente") : "¿consciente?",
      incident.breathing ? { normal: "respira", difficult: "respira mal", none: "NO respira" }[incident.breathing.value] : "¿respira?",
    ];
    if (incident.bleeding?.value === "yes") signs.push("sangra mucho");
    if (incident.trapped?.value === "yes") signs.push("ATRAPADO");
    if (incident.ageGroup && incident.ageGroup.value !== "adult") signs.push(incident.ageGroup.value === "child" ? "niño" : "mayor");
    parts.push(signs.join(", "));
    parts.push(incident.victimsReported ? `${incident.victimsReported.value} herido(s) según llamadas` : "nº heridos desconocido");
    parts.push(`ubicación ±${incident.locationErrorM} m`);
  }
  parts.push(`${incident.callIds.length} llamada(s)`);
  return parts.join(" · ");
}
