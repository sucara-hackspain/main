import type { Decision } from "./coordinator";
import { unitLonLat, summarize, type Summary } from "./engine";
import type { Graph } from "./graph";
import { FLOOD_FRINGE_M } from "./engine";
import { incidentLine } from "./incidents";
import { PRESS_EVERY_TICKS, pressNote, type PressNote } from "./press";
import type { LeadDesk, ReadMessage } from "./reading";
import { infoGaps } from "./recon";
import { waterArrivalTicks } from "./sites";
import { believedWater, cutOffForecast, projectedRadius } from "./water";
import type { TickResult } from "./sim";
import type { Action, Belief, Call, Incident, InjuryKind, LonLat, Mission, ObservedEvent, SceneKind, SimConfig, SiteKind, Triage, UnitKind, VictimStatus, World } from "./types";
import { triage } from "./victims";

// On-disk format of a run (runs/<id>/): meta.json + ticks.jsonl (one TickRecord per line) + llm.jsonl.

export interface RunMeta {
  id: string;
  map: string;
  seed: number;
  ticks: number;
  coordinator: string;
  model: string | null;
  config: SimConfig;
  hospitals: { id: string; name: string; node: number; capacity: number; helipad: boolean }[];
  startedAt: string;
  status: "running" | "finished" | "failed";
  summary: Summary | null;
}

export interface UnitFrame {
  id: string;
  kind: UnitKind;
  pos: LonLat;
  mission: Mission;
  incidentId: string | null;
  victimId: string | null;
  hospitalId: string | null;
  broken: boolean;
  stranded: boolean;
  /** Remaining route as [edge, forward] pairs. */
  route: [number, 0 | 1][];
}

/** Ground truth, for the human supervisor only. */
export interface SceneFrame {
  id: string;
  kind: SceneKind;
  node: number;
  resolved: boolean;
  victims: { id: string; injury: InjuryKind; age: number; trapped: boolean; inWater: boolean; status: VictimStatus; ttl: number | null; triage: Triage; endTick: number | null }[];
}

export interface IncidentFrame extends Incident {
  line: string;
  /** Ticks until the water cuts this place off, if it is in its way. */
  cutOffIn: number | null;
}

/** Everything the UI needs to draw one tick: what is true, and what the coordinator believes. */
export interface SiteFrame {
  id: string;
  kind: SiteKind;
  name: string;
  node: number;
  people: number;
  safe: number;
  warnedTick: number | null;
  floodedTick: number | null;
  /** Ticks until the water is expected there, as dispatch reckons it. null = nothing points that way yet. */
  arrivalTicks: number | null;
  /** How many the water caught inside, once it has arrived. */
  caught: number | null;
}

export interface Frame {
  units: UnitFrame[];
  /** Places with people inside who are fine until the water arrives. Absent in runs older than the sites. */
  sites?: SiteFrame[];
  gauges?: { name: string; node: number; level: number; overflowTick: number }[];
  outages?: { id: string; node: number; radiusM: number; untilTick: number }[];
  /** Rounds of outbound calls: in progress (found = null) and answered. */
  outbound?: { zone: string; node: number; tick: number; found: number | null }[];
  /** The citizen channel as its reader left it: running totals, this tick's messages, and every lead so far. */
  channel?: {
    reader: string;
    received: number;
    read: number;
    relevant: number;
    fresh: ReadMessage[];
    leads: { id: string; tick: number; node: number; street: string | null; summary: string; credibility: number; urgency: string; messages: string[]; registry: string | null; real: boolean }[];
  };
  scenes: SceneFrame[];
  incidents: IncidentFrame[];
  /** Truth: where the water really is. */
  floods: { id: string; name: string; node: number; radiusM: number; fringeM: number }[];
  /** Belief: what the coordinator has pieced together about it. */
  knownWater: {
    zones: { id: string; name: string; node: number; radiusM: number; ageTicks: number }[];
    sightings: { node: number; kind: "wet" | "blocked"; ageTicks: number }[];
  };
  knownClosedEdges: number[];
  /** Where the coordinator has already looked from the air, and what it is still blind about. */
  recon: {
    scouts: { node: number; radiusM: number; ageTicks: number; quality: number; found: number }[];
    gaps: { id: string; node: number; kind: "incident" | "silence"; why: string }[];
  };
  hospitals: { id: string; occupied: number }[];
  closedEdges: number[];
  summary: Summary;
}

export interface TickRecord {
  tick: number;
  frame: Frame;
  /** Truth log plus the calls that came in this tick. */
  events: ObservedEvent[];
  calls: Call[];
  actions: Action[];
  decision?: Omit<Decision, "actions">;
  /** The public statement put out this tick, if it was time for one. */
  press?: PressNote;
}

const RECENT_TICKS = 20;

export function makeFrame(world: World, belief: Belief, graph: Graph): Frame {
  const cutOffIn = cutOffForecast(believedWater(belief), belief.hospitals, graph);
  const recent = (tick: number | null) => tick !== null && world.tick - tick <= RECENT_TICKS;
  return {
    units: world.units.map((a) => ({
      id: a.id,
      kind: a.kind,
      pos: unitLonLat(a, graph),
      mission: a.mission,
      incidentId: a.incidentId,
      victimId: a.victimId,
      hospitalId: a.hospitalId,
      broken: a.brokenUntil !== null,
      stranded: a.stranded,
      route: a.route.map((s) => [s.edge, s.forward ? 1 : 0]),
    })),
    scenes: world.scenes
      .map((scene) => ({ scene, victims: world.victims.filter((v) => v.sceneId === scene.id) }))
      .filter(({ victims }) => victims.some((v) => v.status === "waiting" || v.status === "in_ambulance" || recent(v.endTick)))
      .map(({ scene, victims }) => ({
        id: scene.id,
        kind: scene.kind,
        node: scene.node,
        resolved: scene.resolved,
        victims: victims.map((v) => ({
          id: v.id,
          injury: v.injury,
          age: v.age,
          trapped: v.trapped,
          inWater: v.inWater,
          status: v.status,
          ttl: v.ttl === null ? null : Math.ceil(v.ttl),
          triage: triage(v),
          endTick: v.endTick,
        })),
      })),
    incidents: belief.incidents
      .filter((i) => i.status === "open" || recent(i.updatedTick))
      .map((i) => ({ ...structuredClone(i), line: incidentLine(i), cutOffIn: i.status === "open" ? cutOffIn(i.node) : null })),
    sites: world.sites.map(({ people, ...site }) => ({
      ...site,
      people: people.length,
      arrivalTicks: site.floodedTick === null ? waterArrivalTicks(belief, graph, site.node) : null,
      caught: site.floodedTick === null ? null : people.length - site.safe,
    })),
    gauges: world.gauges.map(({ name, node, level, overflowTick }) => ({ name, node, level, overflowTick })),
    outages: world.outages.filter((o) => world.tick < o.untilTick).map(({ id, node, radiusM, untilTick }) => ({ id, node, radiusM, untilTick })),
    outbound: belief.outboundRounds.filter((r) => world.tick - r.tick <= 12),
    floods: world.floods.map((f) => ({ id: f.id, name: f.name, node: f.node, radiusM: Math.round(f.radiusM), fringeM: Math.round(f.radiusM + FLOOD_FRINGE_M) })),
    knownWater: {
      zones: belief.floods.map((z) => ({ id: z.id, name: z.name, node: z.node, radiusM: projectedRadius(z, world.tick), ageTicks: world.tick - z.asOfTick })),
      sightings: belief.waterSightings.map((w) => ({ node: w.node, kind: w.kind, ageTicks: world.tick - w.tick })),
    },
    knownClosedEdges: [...belief.closedEdges],
    recon: {
      scouts: belief.scouts.map((s) => ({ node: s.node, radiusM: s.radiusM, ageTicks: world.tick - s.tick, quality: s.quality, found: s.found })),
      gaps: infoGaps(belief, graph, world.tick).map(({ id, node, kind, why }) => ({ id, node, kind, why })),
    },
    hospitals: world.hospitals.map((h) => ({ id: h.id, occupied: h.occupied })),
    closedEdges: [...world.closedEdges],
    summary: summarize(world),
  };
}

export function makeTickRecord(result: TickResult, world: World, belief: Belief, graph: Graph, desk: LeadDesk | null = null): TickRecord {
  const calls = result.reports.flatMap((r) => (r.event.type === "call_received" ? [r.event.call] : []));
  const record: TickRecord = {
    tick: result.tick,
    frame: {
      ...makeFrame(world, belief, graph),
      channel: desk
        ? {
            reader: desk.reader.name,
            ...desk.stats,
            fresh: desk.lastTick,
            leads: desk.leads.map((l) => ({ id: l.id, tick: l.tick, node: l.node, street: l.street, summary: l.summary, credibility: l.credibility, urgency: l.urgency, messages: l.messages, registry: l.registry?.who ?? null, real: l.about !== null })),
          }
        : undefined,
    },
    events: [...calls.map((call) => ({ type: "call_received" as const, tick: result.tick, call })), ...result.events],
    calls,
    actions: result.actions,
  };
  if (result.tick > 0 && result.tick % PRESS_EVERY_TICKS === 0) record.press = pressNote(belief, graph, world.config, desk ? { received: desk.stats.received, leads: desk.leads.length } : null);
  if (result.decision) {
    const { actions: _actions, ...why } = result.decision;
    record.decision = why;
  }
  return record;
}
