import { DEFAULT_CONFIG } from "../../../../gabriel/src/engine/engine";
import type { Call, GraphData, IncidentFrame, RunMeta, TickRecord, UnitFrame } from "../engineTrace";

export const SCALE_ID = "demo-escala";
export const scaleMeta: RunMeta = {
  id: SCALE_ID, map: "valencia", seed: 42, ticks: 7, coordinator: "demo", model: null,
  config: DEFAULT_CONFIG, hospitals: [], startedAt: "2026-09-19T18:00:00Z", status: "finished", summary: null,
};

/** Deterministic, explicitly simulated UI workload. Never written into operational runs. */
export function createScaleRun(graph: GraphData, count = 2400) {
  const [south, west, north, east] = graph.bbox;
  const nodes = graph.nodes.flatMap(([lon, lat], i) => lon >= west && lon <= east && lat >= south && lat <= north ? [i] : []);
  if (!nodes.length || count < 1) throw new Error("El escenario necesita calles dentro del territorio y al menos una incidencia.");
  const streets = new Map<number, string>();
  for (const edge of graph.edges) if (edge.name) { streets.set(edge.a, edge.name); streets.set(edge.b, edge.name); }
  const kinds = ["flooded_home", "vehicle_trapped", "traffic", "collapse", "fall", "building_collapse"] as const;
  const descriptions = [
    "Está entrando agua en la vivienda. Hay personas esperando en la planta superior.",
    "Un vehículo se ha quedado inmovilizado. Necesitan ayuda para salir.",
    "Hay un accidente en la calzada. La circulación está interrumpida.",
    "Una persona necesita asistencia. La ubicación está pendiente de confirmar.",
    "Una persona se ha caído y no puede desplazarse por sus propios medios.",
    "Se ha producido un desprendimiento. Hay personas solicitando ayuda.",
  ];
  const allCalls: Call[] = [];
  const base: IncidentFrame[] = Array.from({ length: count }, (_, i) => {
    const node = nodes[(i * 7919 + 31) % nodes.length];
    const tick = (Math.floor(i / Math.ceil(count / 6)) + 1) * 10;
    const callIds = Array.from({ length: 5 }, (_, j) => `DEMO-L${i * 5 + j + 1}`);
    const mechanism = kinds[i % kinds.length];
    callIds.forEach((id, j) => allCalls.push({
      id, tick, caller: "bystander", mechanism, node, locationErrorM: 60 + i % 180,
      street: streets.get(node) ?? "Ubicación comunicada al 112", conscious: "unknown", breathing: "unknown",
      bleeding: "unknown", trapped: "unknown", ageGroup: "unknown", victims: 1 + i % 3,
      text: `${descriptions[i % descriptions.length]}${j ? " Un nuevo aviso aporta información del mismo lugar." : ""}`,
    }));
    return {
      id: `DEMO-C${i + 1}`, status: "open", closedReason: null, mergedInto: null, splitFrom: null, emergencyId: null,
      openedTick: tick, updatedTick: tick, node, locationErrorM: 60 + i % 180, located: false, sceneId: null,
      callIds, mechanism: { value: mechanism, from: callIds[0], tick }, conscious: null, breathing: null,
      bleeding: null, trapped: null, ageGroup: null, victimsReported: { value: 1 + i % 3, from: callIds[0], tick },
      victims: [], seenTick: null, seenBy: null, priority: i % 19 === 0 ? 0 : i % 7 === 0 ? 1 : i % 4 === 0 ? 3 : 2,
      unreachable: i % 17 === 0, cutOffIn: i % 29 === 0 ? 0 : null, history: [], foci: [],
      timeline: callIds.map((id) => ({ tick, kind: "call", from: id, callId: id, text: descriptions[i % descriptions.length] })),
      // Nobody triaged these by phone: the scale demo is made up, not read off the 112 desk.
      triaged: null,
      line: `Incidencia simulada ${i + 1}`,
    };
  });
  const records: TickRecord[] = Array.from({ length: 7 }, (_, index) => {
    const tick = index * 10;
    const incidents = base.filter((i) => i.openedTick <= tick).map((incident, n): IncidentFrame => {
      const resolved = tick - incident.openedTick >= 20 && n % 3 === 0;
      const located = tick > incident.openedTick && n % 2 === 0;
      return { ...incident, located: located || resolved, locationErrorM: located || resolved ? 0 : incident.locationErrorM,
        status: resolved ? "closed" : "open", closedReason: resolved ? "resolved" : null,
        updatedTick: resolved ? incident.openedTick + 20 : located ? incident.openedTick + 10 : incident.openedTick,
        timeline: [...incident.timeline,
          ...(located ? [{ tick: incident.openedTick + 10, kind: "radio" as const, from: "radio DEMO-U1", text: "Ubicación confirmada por la dotación. Se actualiza el seguimiento del caso." }] : []),
          ...(resolved ? [{ tick: incident.openedTick + 20, kind: "closed" as const, from: "sistema", text: "Atención en el lugar finalizada." }] : [])],
      };
    });
    const open = incidents.filter((i) => i.status === "open");
    const units: UnitFrame[] = Array.from({ length: 96 }, (_, n) => {
      const assigned = open.length && n % 4 !== 0 ? open[(n * 13) % open.length] : null;
      return { id: `DEMO-U${n + 1}`, kind: n < 55 ? "ambulance" : n < 72 ? "fire" : n < 86 ? "rescue" : n < 90 ? "helicopter" : "drone",
        pos: graph.nodes[assigned?.node ?? nodes[(n * 1297) % nodes.length]], mission: assigned ? n >= 90 ? "to_observe" : "to_scene" : "idle",
        incidentId: assigned?.id ?? null, victimId: null, hospitalId: null, broken: n === 18, stranded: !!assigned && n === 39, route: [] };
    });
    return { tick, calls: allCalls.filter((c) => c.tick === tick), actions: [], events: [], frame: {
      incidents, units, scenes: [], floods: [], knownClosedEdges: [], closedEdges: [], hospitals: [],
      knownWater: { zones: index ? [
        { id: "DEMO-W1", name: "Observación de agua · sector oeste", node: base[0].node, radiusM: 350 + index * 40, ageTicks: Math.max(0, tick - 20) },
        { id: "DEMO-W2", name: "Observación de agua · zona urbana", node: base[Math.min(190, base.length - 1)].node, radiusM: 220 + index * 20, ageTicks: 2 },
      ] : [], sightings: [] },
      recon: { scouts: [], gaps: index ? [{ id: "DEMO-G1", node: base[0].node, kind: "silence", why: "Falta una observación reciente de esta zona." }] : [] },
      summary: { ticks: tick, victims: 0, saved: 0, dead: 0, waiting: 0, inAmbulance: 0, survivalRate: 0, inWater: 0, reachableSurvivalRate: 0, meanResponseTicks: 0 },
    } };
  });
  return { meta: scaleMeta, records };
}
