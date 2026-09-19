import type { Decision } from "./coordinator";
import { describe } from "./describe";
import { SAME_PLACE_M } from "./engine";
import type { Graph } from "./graph";
import type { Action, AerialSighting, AssessedVictim, Unit, UnitKind, Belief, Breathing, Call, CaseEntry, Focus, Incident, Priority, Report, SceneKind, Signs, Sourced, World, WorldEvent } from "./types";
import { INJURIES, SCENES } from "./victims";
import { addSighting, applyBulletin, impliesWater } from "./water";

// The coordinator's side of the fence: calls come in, incidents come out.
// Everything here works from reports only; none of it may look at the world's scenes or victims.
//
// One incident = one place, one response. A call about anything going on where an open incident already is
// joins it, whatever it is about: the same crews on the same trip deal with it. What differs inside
// (a collapse AND a trapped car) is kept apart as foci. It only becomes another incident when it turns
// out to be somewhere else.

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
    scouts: [],
    nextIncidentNum: 1,
  };
}

/** Dispatch relabels a unit when what it is working on turns out to belong to another incident. */
export interface Retag {
  unitId: string;
  incidentId: string;
}

/** Folds new reports into the coordinator's picture of the world. */
export function updateBelief(belief: Belief, reports: Report[], world: Readonly<World>, graph: Graph): Retag[] {
  // Which incident each unit was on when it radioed: fleet status as of the previous tick, before it moved on.
  const missionOf = new Map(belief.units.map((u) => [u.id, u.incidentId]));
  belief.tick = world.tick;
  // Fleet GPS/status and hospital bed counts come from our own systems, not from reports.
  belief.units = structuredClone(world.units);
  belief.hospitals = structuredClone(world.hospitals);

  const retags: Retag[] = [];
  /** Places a crew has looked over this tick: whatever was reported there and it did not see, is not there. */
  const lookedOver: { incident: Incident; node: number; unitId: string; tick: number }[] = [];
  const onMission = (unitId: string) => {
    const incident = resolve(belief, missionOf.get(unitId) ?? belief.units.find((u) => u.id === unitId)?.incidentId ?? null);
    return incident?.status === "open" ? incident : undefined;
  };

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
      case "drone_report": {
        belief.scouts.push({ tick, node: event.node, radiusM: event.radiusM, quality: event.quality, from: event.unitId, found: event.sightings.length });
        belief.closedEdges.push(...[...event.closedEdges, ...event.floodedEdges].filter((e) => !belief.closedEdges.includes(e)));
        belief.floodedEdges.push(...event.floodedEdges.filter((e) => !belief.floodedEdges.includes(e)));
        if (event.water) addSighting(belief, tick, event.node, `dron ${event.unitId}`, event.floodedEdges.length ? "blocked" : "wet");
        for (const sighting of event.sightings) attachSighting(belief, sighting, event.unitId, tick, graph);
        break;
      }
      case "road_blocked_found": {
        belief.closedEdges.push(...event.edges.filter((e) => !belief.closedEdges.includes(e)));
        if (event.flooded) belief.floodedEdges.push(...event.edges.filter((e) => !belief.floodedEdges.includes(e)));
        if (event.flooded) addSighting(belief, tick, event.node, `radio ${event.unitId}`, "blocked");
        const incident = onMission(event.unitId);
        if (incident) radio(incident, event);
        break;
      }
      case "unit_broken": {
        const incident = onMission(event.unitId);
        if (incident) radio(incident, event);
        break;
      }
      case "unit_stranded": {
        const incident = resolve(belief, event.incidentId);
        if (incident?.status !== "open") break;
        radio(incident, event);
        if (!incident.unreachable) {
          incident.unreachable = true;
          note(incident, tick, "acceso", "sin ruta por carretera: necesita rescate acuático o aéreo", `radio ${event.unitId}`, undefined, "alert");
        }
        break;
      }
      case "action_rejected":
        if (event.action.type === "dispatch" && event.reason.startsWith("no open route")) {
          const incident = resolve(belief, event.action.incidentId);
          if (incident && !incident.unreachable) {
            incident.unreachable = true;
            note(incident, tick, "acceso", "sin ruta conocida por carretera", "sistema", undefined, "alert");
          }
        }
        break;
      case "scene_assessed": {
        const incident = assess(belief, event, graph, retags);
        if (!event.inSight) lookedOver.push({ incident, node: event.node, unitId: event.unitId, tick });
        if (impliesWater(event.kind)) addSighting(belief, tick, event.node, `radio ${event.unitId}`, "wet");
        break;
      }
      case "scene_not_found": {
        const incident = resolve(belief, event.incidentId);
        // A wasted trip belongs in the file even when the incident was already closed by then.
        if (incident) radio(incident, event);
        if (incident?.status !== "open") break;
        const reported = incident.foci.filter((f) => f.status === "reported");
        const searched = reported.filter((f) => graph.distanceM(event.node, f.node) <= world.config.searchRadiusM);
        for (const focus of searched.length > 0 ? searched : reported) focus.status = "not_found";
        refresh(incident, tick);
        break;
      }
      case "victim_freed":
      case "victim_picked_up":
      case "victim_treated":
      case "victim_delivered":
        for (const incident of belief.incidents) {
          const focus = incident.foci.find((f) => f.victims.some((v) => v.id === event.victimId));
          if (!focus || incident.mergedInto) continue;
          const victim = focus.victims.find((v) => v.id === event.victimId)!;
          if (event.type === "victim_freed") victim.trapped = false;
          else victim.status = event.type === "victim_picked_up" ? "in_ambulance" : event.type === "victim_treated" ? "treated" : "delivered";
          radio(incident, event, focus.id);
          refresh(incident, tick);
        }
        break;
      case "road_closed":
        if (!belief.closedEdges.includes(event.edge)) belief.closedEdges.push(event.edge);
        break;
      case "road_opened":
        belief.closedEdges = belief.closedEdges.filter((e) => e !== event.edge);
        break;
    }
  }

  // The crew is standing there: a reported focus it must have seen, and did not, was a mistaken or duplicate call.
  for (const { incident, node, unitId, tick } of lookedOver) {
    const live = resolve(belief, incident.id);
    if (live?.status !== "open") continue;
    for (const focus of live.foci) {
      if (focus.status !== "reported" || graph.distanceM(node, focus.node) + focus.locationErrorM > SAME_PLACE_M) continue;
      focus.status = "not_found";
      log(live, { tick, kind: "radio", from: `radio ${unitId}`, unitId, focusId: focus.id, text: `${unitId} no ve ${focusName(focus)} en el lugar: aviso descartado` });
    }
    refresh(live, tick);
  }
  return retags;
}

/** The coordinator's orders (and the supervisor's), filed under the incident they are about, with what became of them. */
export function recordOrders(belief: Belief, tick: number, decision: Decision | undefined, actions: Action[], outcomes: WorldEvent[]): void {
  const agentOrders = decision?.actions.length ?? 0;
  actions.forEach((action, n) => {
    const byOperator = n >= agentOrders;
    const unit = belief.units.find((u) => u.id === action.unitId);
    const incident = resolve(belief, action.type === "dispatch" ? action.incidentId : (unit?.incidentId ?? null));
    if (!incident) return;
    const outcome = outcomes.find((e) => (e.type === "action_applied" || e.type === "action_rejected") && e.action === action);
    const accepted = outcome?.type === "action_applied";
    const what =
      action.type === "dispatch"
        ? `${action.unitId} enviada${action.hospitalId ? `, después a ${action.hospitalId}` : ""}`
        : action.type === "transport"
          ? `${action.unitId} traslada al paciente a ${action.hospitalId}`
          : `${action.unitId} retirada de la incidencia y reubicada`;
    log(incident, {
      tick,
      kind: byOperator ? "operator" : "order",
      from: byOperator ? "operador" : decision?.source === "llm" ? "agente" : decision?.source === "fallback" ? "reglas (respaldo)" : "reglas",
      unitId: action.unitId,
      action,
      accepted,
      flag: accepted ? undefined : "alert",
      etaTicks: outcome?.type === "action_applied" ? outcome.etaTicks : undefined,
      text: accepted ? what : `Orden rechazada (${outcome?.type === "action_rejected" ? outcome.reason : "sin respuesta"}): ${what}`,
      reason: byOperator ? undefined : decision?.reasons?.[n] || undefined,
      applies: byOperator ? undefined : decision?.applies?.[n]?.length ? decision.applies[n] : undefined,
      decidedBy: byOperator ? "operator" : decision?.source,
    });
  });
}

function log(incident: Incident, entry: CaseEntry): void {
  incident.timeline.push(entry);
  incident.updatedTick = entry.tick;
}

/** A crew's or hospital's report, in the incident's file as it was said. */
function radio(incident: Incident, event: WorldEvent & { unitId: string }, focusId?: string): void {
  const from = event.type === "victim_delivered" ? `hospital ${event.hospitalId}` : `radio ${event.unitId}`;
  const alert = event.type === "road_blocked_found" || event.type === "unit_broken" || event.type === "unit_stranded" || event.type === "scene_not_found";
  log(incident, { tick: event.tick, kind: "radio", flag: alert ? "alert" : undefined, from, unitId: event.unitId, focusId, text: describe(event) });
}

function note(incident: Incident, tick: number, field: string, value: string, from: string, focusId?: string, flag?: CaseEntry["flag"]): void {
  incident.history.push({ tick, field, value, from });
  log(incident, { tick, kind: "update", flag, from, focusId, text: `${field}: ${value}` });
}

const STATUS: Record<AssessedVictim["status"], string> = { waiting: "esperando", in_ambulance: "recogido", delivered: "en hospital", treated: "atendido", dead: "fallecido" };

const NO_SIGNS: Signs = { mechanism: null, conscious: null, breathing: null, bleeding: null, trapped: null, ageGroup: null, victimsReported: null };

function newIncident(belief: Belief, tick: number, node: number, errorM: number): Incident {
  const incident: Incident = {
    id: `C${belief.nextIncidentNum++}`,
    status: "open",
    closedReason: null,
    mergedInto: null,
    splitFrom: null,
    emergencyId: null,
    openedTick: tick,
    updatedTick: tick,
    node,
    locationErrorM: errorM,
    located: false,
    seenTick: null,
    seenBy: null,
    sceneId: null,
    callIds: [],
    foci: [],
    ...NO_SIGNS,
    victims: [],
    priority: 2,
    unreachable: false,
    history: [],
    timeline: [],
  };
  belief.incidents.push(incident);
  return incident;
}

function newFocus(incident: Incident, tick: number, node: number, errorM: number): Focus {
  // Numbered by the incident that opened it: a focus keeps its name if its incident is merged into another.
  const taken = incident.foci.filter((f) => f.id.startsWith(`${incident.id}.`)).length;
  const focus: Focus = { id: `${incident.id}.${taken + 1}`, status: "reported", openedTick: tick, node, locationErrorM: errorM, sceneId: null, callIds: [], ...NO_SIGNS, victims: [], lastReport: null, seenTick: null, seenBy: null, peopleSeen: null };
  incident.foci.push(focus);
  return focus;
}

function focusName(focus: Focus): string {
  return focus.mechanism ? SCENES[focus.mechanism.value].label.toLowerCase() : "lo que decía el aviso";
}

/** Follows merges to the incident that is still alive. */
export function resolve(belief: Belief, id: string | null): Incident | undefined {
  let incident = belief.incidents.find((i) => i.id === id);
  while (incident?.mergedInto) incident = belief.incidents.find((i) => i.id === incident!.mergedInto);
  return incident;
}

/** How far apart two reports of the same place can be: what each could be off by, plus the place itself. */
function near(node: number, errorM: number, focus: Focus, graph: Graph): number | null {
  const d = graph.distanceM(node, focus.node);
  return d <= errorM + focus.locationErrorM + SAME_PLACE_M ? d : null;
}

/**
 * Is `node` part of the place this incident is about? Once a crew has confirmed where that is, only that counts:
 * otherwise an incident would creep down the street, one vague call after another.
 */
function samePlace(incident: Incident, node: number, errorM: number, graph: Graph): number | null {
  const confirmed = incident.foci.filter((f) => f.status === "located" || f.status === "cleared");
  const anchors = confirmed.length > 0 ? confirmed : incident.foci.filter((f) => f.status === "reported").slice(0, 1);
  const found = anchors.map((f) => near(node, errorM, f, graph)).filter((d) => d !== null);
  return found.length > 0 ? Math.min(...found) : null;
}

/** The focus that a call, or what a crew found, is about: something reported of the same kind (or of no known kind) close enough. */
function matchingFocus(incident: Incident, kind: SceneKind | null, node: number, errorM: number, graph: Graph, statuses: Focus["status"][]): Focus | undefined {
  return incident.foci
    .filter((f) => statuses.includes(f.status) && (!kind || !f.mechanism || f.mechanism.value === kind))
    .map((f) => ({ f, d: near(node, errorM, f, graph) }))
    .filter((m): m is { f: Focus; d: number } => m.d !== null)
    // Knowing it is the same kind of thing beats being a little nearer.
    .sort((a, b) => Number(b.f.mechanism?.value === kind) - Number(a.f.mechanism?.value === kind) || a.d - b.d)[0]?.f;
}

/** New call: about a place we already have an open incident for, or a new one? */
function attachCall(belief: Belief, call: Call, graph: Graph): void {
  let best: Incident | null = null;
  let bestM = Infinity;
  for (const incident of belief.incidents) {
    if (incident.status !== "open") continue;
    const d = samePlace(incident, call.node, call.locationErrorM, graph);
    if (d !== null && d < bestM) {
      best = incident;
      bestM = d;
    }
  }
  const incident = best ?? newIncident(belief, call.tick, call.node, call.locationErrorM);
  const known = matchingFocus(incident, call.mechanism, call.node, call.locationErrorM, graph, ["reported", "located"]);
  const focus = known ?? newFocus(incident, call.tick, call.node, call.locationErrorM);
  incident.callIds.push(call.id);
  focus.callIds.push(call.id);
  log(incident, { tick: call.tick, kind: "call", from: call.id, callId: call.id, focusId: focus.id, text: call.text });
  incident.history.push({
    tick: call.tick,
    field: "llamada",
    value: !best ? `${call.id} abre el incidente` : `${call.id} adjuntada (a ${Math.round(bestM)} m)${known ? "" : `: otra cosa en el mismo sitio, foco ${focus.id}`}`,
    from: call.id,
  });
  if (best && !known) log(incident, { tick: call.tick, kind: "update", from: call.id, focusId: focus.id, text: `Otra cosa en el mismo sitio: se abre el foco ${focus.id}, la misma salida lo cubre` });

  // The most precise caller wins the location; a crew's confirmation beats them all.
  if (focus.status === "reported" && call.locationErrorM < focus.locationErrorM) {
    focus.node = call.node;
    focus.locationErrorM = call.locationErrorM;
    note(incident, call.tick, "ubicación", `nodo ${call.node} ±${call.locationErrorM} m`, call.id, focus.id);
  }

  foldSigns(focus, call);
  foldSigns(incident, call, (field, value) => note(incident, call.tick, field, value, call.id, focus.id));
  refresh(incident, call.tick);
}

/** "Unknown" never overwrites an answer, and the worse answer wins: better to over-triage than to miss an arrest. */
function foldSigns(target: Signs, call: Call, changed?: (field: string, value: string) => void): void {
  const src = <T>(value: T): Sourced<T> => ({ value, from: call.id, tick: call.tick });
  if (call.mechanism && !target.mechanism) target.mechanism = src(call.mechanism);
  if (call.conscious !== "unknown" && target.conscious?.value !== "no" && target.conscious?.value !== call.conscious) {
    target.conscious = src(call.conscious);
    changed?.("consciente", call.conscious === "yes" ? "sí" : "no");
  }
  if (call.breathing !== "unknown" && breathingRank(call.breathing) > breathingRank(target.breathing?.value)) {
    target.breathing = src(call.breathing);
    changed?.("respira", call.breathing);
  }
  if (call.bleeding !== "unknown" && target.bleeding?.value !== "yes" && target.bleeding?.value !== call.bleeding) {
    target.bleeding = src(call.bleeding);
    changed?.("sangra", call.bleeding === "yes" ? "sí" : "no");
  }
  if (call.trapped !== "unknown" && target.trapped?.value !== "yes" && target.trapped?.value !== call.trapped) {
    target.trapped = src(call.trapped);
    changed?.("atrapado", call.trapped === "yes" ? "sí" : "no");
  }
  if (call.ageGroup !== "unknown" && !target.ageGroup) target.ageGroup = src(call.ageGroup);
  if (call.victims !== null && call.victims > (target.victimsReported?.value ?? 0)) {
    target.victimsReported = src(call.victims);
    changed?.("nº heridos", String(call.victims));
  }
}

/**
 * What an observer radioes in about one spot, folded in the same way a call is. It is worth much more
 * than a call (the location is good, a count is a count) and much less than a crew: it never confirms
 * anything, so the focus stays "reported". A sighting matching nothing open opens a new incident,
 * which is the whole point of flying over a neighbourhood nobody has called from.
 */
function attachSighting(belief: Belief, sighting: AerialSighting, unitId: string, tick: number, graph: Graph): void {
  const from = `dron ${unitId}`;
  let best: Incident | null = null;
  let bestM = Infinity;
  for (const incident of belief.incidents) {
    if (incident.status !== "open") continue;
    const d = samePlace(incident, sighting.node, sighting.locationErrorM, graph);
    if (d !== null && d < bestM) {
      best = incident;
      bestM = d;
    }
  }
  const incident = best ?? newIncident(belief, tick, sighting.node, sighting.locationErrorM);
  const known = matchingFocus(incident, sighting.kind, sighting.node, sighting.locationErrorM, graph, ["reported", "located"]);
  const focus = known ?? newFocus(incident, tick, sighting.node, sighting.locationErrorM);

  const what = describeSighting(sighting);
  log(incident, { tick, kind: "radio", flag: "assessment", from, unitId, focusId: focus.id, text: what });
  if (!best) {
    incident.history.push({ tick, field: "origen", value: "abierto por avistamiento aéreo, sin ninguna llamada", from });
  }

  focus.seenTick = tick;
  focus.seenBy = unitId;
  incident.seenTick = tick;
  incident.seenBy = unitId;
  if (focus.status === "reported" && sighting.locationErrorM < focus.locationErrorM) {
    focus.node = sighting.node;
    focus.locationErrorM = sighting.locationErrorM;
    note(incident, tick, "ubicación", `nodo ${sighting.node} ±${sighting.locationErrorM} m (desde el aire)`, from, focus.id);
  }

  const src = <T>(value: T): Sourced<T> => ({ value, from, tick });
  for (const target of [focus, incident] as Signs[]) {
    if (sighting.kind && !target.mechanism) target.mechanism = src(sighting.kind);
    // "Not moving" from the air is not a diagnosis: it is the reason to treat it as the worst case.
    if (sighting.still !== null && sighting.still > 0 && target.conscious?.value !== "no") target.conscious = src("no");
    if (sighting.trapped !== "unknown" && target.trapped?.value !== "yes") target.trapped = src(sighting.trapped === "yes" ? "yes" : "no");
    if (sighting.people !== null && sighting.people > (target.victimsReported?.value ?? 0)) target.victimsReported = src(sighting.people);
  }
  if (sighting.people !== null) {
    focus.peopleSeen = src(sighting.people);
    note(incident, tick, "gente vista", `${sighting.people}${sighting.still !== null ? `, ${sighting.still} sin moverse` : ""}`, from, focus.id);
  }
  if (sighting.inWater === "yes" && !incident.unreachable) {
    incident.unreachable = true;
    note(incident, tick, "acceso", "rodeado de agua según el dron: rescate acuático o aéreo", from, focus.id, "alert");
  }
  refresh(incident, tick);
}

/** The sighting as the observer would say it over the radio. */
function describeSighting(s: AerialSighting): string {
  const kind = s.kind ? SCENES[s.kind].label : "no distingue qué ha pasado";
  const people = s.people === null ? "no puede contarlos" : `${s.people} persona(s)`;
  const still = s.still === null ? "" : `, ${s.still} sin moverse`;
  const trapped = s.trapped === "yes" ? ", parecen atrapados" : "";
  const water = s.inWater === "yes" ? ", rodeados de agua" : "";
  return `Visto desde el aire (sin confirmar): ${kind}, ${people}${still}${trapped}${water} · ±${s.locationErrorM} m`;
}

function breathingRank(b: Breathing | undefined): number {
  return b === "none" ? 3 : b === "difficult" ? 2 : b === "normal" ? 1 : 0;
}

/**
 * A crew radioes what is at the scene it is working, or at another it can see from there.
 * Same place as the incident it was sent to: one more focus of it. Somewhere else: another incident.
 */
function assess(belief: Belief, event: WorldEvent & { type: "scene_assessed" }, graph: Graph, retags: Retag[]): Incident {
  const { tick, unitId, node } = event;
  const own = !event.inSight;
  const from = `radio ${unitId}`;
  const tagged = resolve(belief, event.incidentId);
  const owner = belief.incidents.find((i) => !i.mergedInto && i.foci.some((f) => f.sceneId === event.sceneId));
  let incident: Incident;
  let focus: Focus;

  if (owner) {
    incident = owner;
    focus = owner.foci.find((f) => f.sceneId === event.sceneId)!;
    if (tagged && tagged !== owner && tagged.status === "open" && samePlace(tagged, node, 0, graph) !== null) merge(tagged, owner, event, graph);
  } else {
    // Nobody had confirmed this yet. It belongs to whichever incident is about this place: first of all, the one the crew was sent to.
    const meant = (i: Incident) => matchingFocus(i, event.kind, node, 0, graph, ["reported"]);
    const here = [tagged, ...belief.incidents.filter((i) => i.status === "open")].find((i) => i && (meant(i) || samePlace(i, node, 0, graph) !== null));
    if (here) {
      incident = here;
      focus = meant(here) ?? newFocus(here, tick, node, 0);
      if (focus.callIds.length === 0) log(incident, { tick, kind: "radio", from, unitId, focusId: focus.id, text: `${unitId} encuentra algo más en el mismo sitio: ${SCENES[event.kind].label.toLowerCase()} (foco ${focus.id})` });
    } else {
      // Not where any incident is: the crew went looking around and came across something else.
      incident = newIncident(belief, tick, node, 0);
      focus = newFocus(incident, tick, node, 0);
      if (tagged) {
        incident.splitFrom = tagged.id;
        const far = Math.round(graph.distanceM(tagged.node, node));
        log(incident, { tick, kind: "link", from, unitId, text: `Separada de ${tagged.id}: ${unitId} iba allí y encontró esto a ${far} m, otro sitio` });
        log(tagged, { tick, kind: "link", from, unitId, text: `${unitId} encontró otra cosa a ${far} m: se abre ${incident.id}. Esta sigue pendiente` });
      }
    }
  }
  if (own && event.incidentId !== incident.id) retags.push({ unitId, incidentId: incident.id });

  if (focus.status === "reported" || focus.node !== node) note(incident, tick, "ubicación", `confirmada en nodo ${node}`, from, focus.id);
  focus.node = node;
  focus.locationErrorM = 0;
  focus.sceneId = event.sceneId;
  focus.status = "located";
  focus.mechanism = { value: event.kind, from, tick };
  const victims = event.victims.map((v) => `${v.id} ${INJURIES[v.injury].label} (${v.triage}${v.trapped ? ", atrapado" : ""}${v.status === "waiting" ? "" : `, ${STATUS[v.status]}`})`).join(", ") || "nadie";
  // Every crew that turns up says what it sees: only what is news goes in the file.
  if (victims !== focus.lastReport) {
    incident.history.push({ tick, field: "víctimas", value: victims, from });
    log(incident, { tick, kind: "radio", flag: "assessment", from, unitId, focusId: focus.id, text: `${unitId} ${own ? "en el lugar" : "ve desde allí"} · ${SCENES[event.kind].label}: ${victims}` });
  }
  focus.lastReport = victims;
  focus.victims = structuredClone(event.victims);
  incident.mechanism ??= focus.mechanism;
  if (incident.status === "closed" && event.victims.some((v) => v.status === "waiting")) {
    incident.status = "open";
    incident.closedReason = null;
    log(incident, { tick, kind: "update", from, text: "Se reabre: sigue habiendo alguien esperando" });
  }
  refresh(incident, tick);
  return incident;
}

/** Two incidents turn out to be the same place: `from` is folded into `into`, focus by focus. */
function merge(from: Incident, into: Incident, event: WorldEvent & { unitId: string }, graph: Graph): void {
  const { tick, unitId } = event;
  for (const focus of from.foci) {
    const twin = focus.status === "reported" ? matchingFocus(into, focus.mechanism?.value ?? null, focus.node, focus.locationErrorM, graph, ["reported", "located", "cleared"]) : undefined;
    if (twin) twin.callIds.push(...focus.callIds);
    else into.foci.push(focus);
  }
  into.callIds.push(...from.callIds);
  into.timeline.push(...from.timeline.map((entry) => ({ ...entry, text: `[${from.id}] ${entry.text}` })));
  into.timeline.sort((a, b) => a.tick - b.tick);
  into.history.push({ tick, field: "fusión", value: `${from.id} era este mismo incidente`, from: `radio ${unitId}` });
  from.history.push({ tick, field: "fusión", value: `fusionado en ${into.id}`, from: `radio ${unitId}` });
  log(into, { tick, kind: "link", from: `radio ${unitId}`, unitId, text: `${from.id} era este mismo sitio: sus llamadas y su historial pasan aquí` });
  log(from, { tick, kind: "link", from: `radio ${unitId}`, unitId, text: `Es el mismo sitio que ${into.id}: se sigue allí` });
  from.foci = [];
  close(from, "merged", tick);
  from.mergedInto = into.id;
}

function close(incident: Incident, reason: NonNullable<Incident["closedReason"]>, tick: number): void {
  incident.status = "closed";
  incident.closedReason = reason;
  const text = reason === "merged" ? "Cerrada: fusionada" : reason === "not_found" ? "Cerrada: nadie en el lugar" : "Cerrada: nadie queda esperando";
  log(incident, { tick, kind: "closed", from: "reglas", text });
}

/** What is left to do at a focus, as a priority; null when nothing is. */
function focusPriority(focus: Focus): Priority | null {
  if (focus.status === "not_found") return null;
  if (focus.status !== "reported") {
    const waiting = focus.victims.filter((v) => v.status === "waiting");
    if (waiting.length === 0) return null;
    if (waiting.some((v) => v.injury === "cardiac_arrest")) return 0;
    if (waiting.some((v) => v.triage === "red")) return 1;
    return waiting.some((v) => v.triage === "yellow") ? 2 : 3;
  }
  const conscious = focus.conscious?.value;
  const breathing = focus.breathing?.value;
  if (breathing === "none" || (conscious === "no" && !breathing)) return 0;
  if (conscious === "no" || breathing === "difficult" || focus.bleeding?.value === "yes") return 1;
  const violent = focus.mechanism && focus.mechanism.value !== "fall" && focus.mechanism.value !== "collapse";
  if (conscious === "yes" && breathing === "normal") return violent ? 2 : 3;
  return 2;
}

/** Foci that still need a crew, most pressing first. */
function pending(incident: Incident): Focus[] {
  return incident.foci
    .filter((f) => focusPriority(f) !== null)
    .sort((a, b) => focusPriority(a)! - focusPriority(b)! || a.openedTick - b.openedTick);
}

/** Priority from what is known, the way a 112 protocol does it. Nobody ever tells the coordinator how long someone has. */
export function deducePriority(incident: Incident): Priority {
  const first = pending(incident)[0];
  return first ? focusPriority(first)! : 3;
}

/** Brings the incident's headline up to date with its foci, and closes it when none of them needs anyone. */
function refresh(incident: Incident, tick: number): void {
  for (const focus of incident.foci) {
    if (focus.status === "located" || focus.status === "cleared") focus.status = focus.victims.some((v) => v.status === "waiting") ? "located" : "cleared";
  }
  const confirmed = incident.foci.filter((f) => f.status === "located" || f.status === "cleared");
  incident.victims = incident.foci.flatMap((f) => f.victims);
  incident.located = confirmed.length > 0;
  incident.sceneId = confirmed[0]?.sceneId ?? null;

  const todo = pending(incident);
  if (todo.length > 0) {
    incident.node = todo[0].node;
    incident.locationErrorM = todo[0].locationErrorM;
  }
  const before = incident.priority;
  incident.priority = deducePriority(incident);
  if (incident.priority !== before) note(incident, tick, "prioridad", `P${before} → P${incident.priority}`, "reglas", undefined, incident.priority < before ? "alert" : undefined);
  if (incident.status === "open" && todo.length === 0 && incident.foci.length > 0) close(incident, confirmed.length > 0 ? "resolved" : "not_found", tick);
}

export interface Needs {
  /** Crews that can carry someone to hospital (ambulance, rescue, helicopter). */
  carriers: number;
  /** Firefighters to free whoever is trapped. */
  fire: number;
}

/** What the incident still needs, beyond the units already heading there: the sum of what each focus needs. */
export function unitsNeeded(incident: Incident, units: Unit[]): Needs {
  let carriers = 0;
  let fire = 0;
  for (const focus of pending(incident)) {
    if (focus.status === "reported") {
      // Before anyone has been there, a second carrier only if callers speak of several hurt.
      carriers += (focus.victimsReported?.value ?? 1) >= 2 ? 2 : 1;
      if (focus.trapped?.value === "yes") fire = 1;
      continue;
    }
    const waiting = focus.victims.filter((v) => v.status === "waiting");
    const toCarry = waiting.filter((v) => INJURIES[v.injury].transport);
    // One crew can patch up all the minor ones. Trapped victims need firefighters before anyone can take them.
    carriers += toCarry.filter((v) => !v.trapped).length + (waiting.length > toCarry.length && toCarry.length === 0 ? 1 : 0);
    // One fire crew frees everybody at the place.
    if (waiting.some((v) => v.trapped)) fire = 1;
  }
  const heading = units.filter((u) => u.incidentId === incident.id && u.mission === "to_scene" && u.brokenUntil === null);
  const isFire = (k: UnitKind) => k === "fire";
  return {
    carriers: Math.max(0, carriers - heading.filter((u) => !isFire(u.kind)).length),
    // A rescue crew frees people too.
    fire: Math.max(0, fire - heading.filter((u) => isFire(u.kind) || u.kind === "rescue").length),
  };
}

function focusLine(focus: Focus): string {
  const parts: string[] = [];
  if (focus.mechanism) parts.push(SCENES[focus.mechanism.value].label);
  if (focus.status !== "reported") {
    const waiting = focus.victims.filter((v) => v.status === "waiting");
    parts.push(`confirmado por dotación: ${waiting.length} esperando (${waiting.map((v) => `${INJURIES[v.injury].label}/${v.triage}${v.trapped ? "/ATRAPADO" : ""}`).join(", ") || "nadie"})`);
  } else {
    const signs = [
      focus.conscious ? (focus.conscious.value === "yes" ? "consciente" : "inconsciente") : "¿consciente?",
      focus.breathing ? { normal: "respira", difficult: "respira mal", none: "NO respira" }[focus.breathing.value] : "¿respira?",
    ];
    if (focus.bleeding?.value === "yes") signs.push("sangra mucho");
    if (focus.trapped?.value === "yes") signs.push("ATRAPADO");
    if (focus.ageGroup && focus.ageGroup.value !== "adult") signs.push(focus.ageGroup.value === "child" ? "niño" : "mayor");
    parts.push(signs.join(", "));
    parts.push(
      focus.victimsReported
        ? `${focus.victimsReported.value} herido(s) ${focus.victimsReported.from.startsWith("dron") ? "contados desde el aire" : "según llamadas"}`
        : "nº heridos desconocido",
    );
    parts.push(`ubicación ±${focus.locationErrorM} m`);
  }
  return parts.join(" · ");
}

/** One line per incident: what always goes in the coordinator's briefing. */
export function incidentLine(incident: Incident): string {
  const todo = pending(incident);
  const foci = todo.length > 0 ? todo : incident.foci.filter((f) => f.status !== "not_found").slice(0, 1);
  const what = foci.length > 1 ? `${foci.length} focos en el mismo sitio, una salida los cubre: ${foci.map((f) => `[${focusLine(f)}]`).join(" + ")}` : foci.map(focusLine).join("");
  // An incident nobody ever called about is the whole point of having sent someone to look.
  const heard =
    incident.callIds.length === 0 && incident.seenTick !== null
      ? `SIN NINGUNA LLAMADA · lo abrió ${incident.seenBy} desde el aire`
      : `${incident.callIds.length} llamada(s)`;
  return [`${incident.id} · P${incident.priority}`, what, heard].filter(Boolean).join(" · ");
}
