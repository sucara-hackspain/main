import { useMemo, useState } from "react";
import { INJURIES, type Call, type Frame, type IncidentFrame, type RunMeta } from "../../src/engine";
import { KIND_COLORS, KIND_LABELS, PRIORITY_COLORS } from "./MapView";

// What the coordinator knows, drawn as a graph: every node is something it believes exists,
// every link is why it believes it or what it is doing about it. Left to right:
//   water  ->  evidence (calls)  ->  incidents  ->  confirmed victims  ->  units  ->  hospitals
// Dashed = unconfirmed (only callers have said so). Solid = a crew has seen it.

type Kind = "water" | "call" | "incident" | "victim" | "unit" | "hospital";
interface GNode { id: string; kind: Kind; title: string; sub: string; color: string; dashed: boolean; incidentId?: string; y: number }
interface GEdge { from: string; to: string; label: string; color: string; dashed: boolean; incidentId?: string }

const COLUMNS: { kind: Kind; title: string; x: number; w: number }[] = [
  { kind: "water", title: "Agua conocida", x: 10, w: 150 },
  { kind: "call", title: "Evidencias · llamadas 112", x: 200, w: 190 },
  { kind: "incident", title: "Incidentes", x: 440, w: 230 },
  { kind: "victim", title: "Víctimas confirmadas", x: 720, w: 170 },
  { kind: "unit", title: "Unidades", x: 940, w: 140 },
  { kind: "hospital", title: "Hospitales", x: 1110, w: 150 },
];
const ROW = 46;
const NODE_H = 36;
const TOP = 34;
const CALLER = { victim: "el propio herido", family: "un familiar", bystander: "testigo a pie", driver: "conductor que pasaba" };
const sign = (known: { value: string } | null, yes: string, no: string, ask: string) => (known ? (known.value === "yes" || known.value === "normal" ? yes : no) : ask);

export function KnowledgeGraph(props: { frame: Frame; meta: RunMeta; calls: Map<string, Call>; selected: string | null; onSelect: (id: string | null) => void }) {
  const { frame, meta, calls, selected, onSelect } = props;
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selected;

  const { nodes, edges, height } = useMemo(() => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    const rows: Record<Kind, number> = { water: 0, call: 0, incident: 0, victim: 0, unit: 0, hospital: 0 };
    const add = (n: Omit<GNode, "y">) => nodes.push({ ...n, y: TOP + rows[n.kind]++ * ROW });

    const incidents = frame.incidents
      .filter((i) => i.status === "open")
      .sort((a, b) => Number(a.unreachable) - Number(b.unreachable) || a.priority - b.priority || a.openedTick - b.openedTick);

    for (const z of frame.knownWater.zones) {
      add({ id: z.id, kind: "water", title: z.name, sub: `≈${z.radiusM} m · parte de hace ${z.ageTicks} ticks`, color: "#22d3ee", dashed: false });
    }
    const blocked = frame.knownWater.sightings.filter((s) => s.kind === "blocked").length;
    const wet = frame.knownWater.sightings.length - blocked;
    if (frame.knownWater.sightings.length > 0) {
      add({ id: "sightings", kind: "water", title: "Avistamientos", sub: `${wet} llamadas · ${blocked} dotaciones dieron la vuelta`, color: "#22d3ee", dashed: true });
    }
    add({ id: "closed", kind: "water", title: "Tramos cortados", sub: `${frame.knownClosedEdges.length} conocidos`, color: "#fb923c", dashed: false });

    // Calls and victims are listed in the order of their incident, so links cross as little as possible.
    for (const inc of incidents) {
      const color = inc.unreachable ? "#3b82f6" : PRIORITY_COLORS[inc.priority];
      const signs = inc.located
        ? `${inc.victims.filter((v) => v.status === "waiting").length} esperando · confirmado`
        : [sign(inc.conscious, "consciente", "inconsciente", "¿consciente?"), sign(inc.breathing, "respira", inc.breathing?.value === "none" ? "NO respira" : "respira mal", "¿respira?"), `±${inc.locationErrorM} m`].join(" · ");
      add({ id: inc.id, kind: "incident", title: `${inc.id} · ${inc.unreachable ? "inalcanzable" : `P${inc.priority}`} · ${inc.line.split(" · ")[2] ?? ""}`, sub: signs, color, dashed: !inc.located, incidentId: inc.id });

      for (const callId of inc.callIds) {
        const call = calls.get(callId);
        add({ id: callId, kind: "call", title: `☎ ${callId} · ${call ? CALLER[call.caller] : ""}`, sub: call?.text.replace(/^.*?«/, "«").slice(0, 46) ?? "", color: "#facc15", dashed: call?.caller === "driver" || call?.caller === "bystander", incidentId: inc.id });
        edges.push({ from: callId, to: inc.id, label: "", color: "#facc15", dashed: false, incidentId: inc.id });
        if (call && ["vehicle_trapped", "flooded_home", "swept_away"].includes(call.mechanism ?? "")) {
          edges.push({ from: "sightings", to: callId, label: "", color: "#22d3ee", dashed: true, incidentId: inc.id });
        }
      }
      if (inc.cutOffIn !== null) {
        const zone = frame.knownWater.zones[0]?.id ?? "sightings";
        edges.push({ from: zone, to: inc.id, label: inc.cutOffIn === 0 ? "aislado" : `aísla en <${inc.cutOffIn}`, color: "#3b82f6", dashed: true, incidentId: inc.id });
      }
      for (const v of inc.victims.filter((v) => v.status === "waiting" || v.status === "in_ambulance")) {
        add({ id: v.id, kind: "victim", title: `${v.id} · ${INJURIES[v.injury].label}`, sub: `${v.triage} · ${v.status === "waiting" ? (v.trapped ? "ATRAPADO" : "esperando") : "en traslado"}`, color: { red: "#ef4444", yellow: "#facc15", green: "#4ade80", black: "#475569" }[v.triage], dashed: false, incidentId: inc.id });
        edges.push({ from: inc.id, to: v.id, label: "", color: "#94a3b8", dashed: false, incidentId: inc.id });
      }
    }

    for (const a of frame.units) {
      const state = a.broken ? "averiada" : a.mission === "to_scene" ? "en camino" : a.mission === "to_hospital" ? "trasladando" : a.victimId ? "cargada, sin destino" : "libre";
      add({ id: a.id, kind: "unit", title: `${a.id} · ${KIND_LABELS[a.kind]}`, sub: state, color: a.mission === "idle" && !a.victimId ? "#64748b" : KIND_COLORS[a.kind], dashed: false, incidentId: a.incidentId ?? undefined });
      if (a.mission === "to_scene" && a.incidentId && nodes.some((n) => n.id === a.incidentId)) {
        edges.push({ from: a.incidentId, to: a.id, label: "va hacia", color: "#38bdf8", dashed: false, incidentId: a.incidentId });
      }
      if (a.victimId && nodes.some((n) => n.id === a.victimId)) edges.push({ from: a.victimId, to: a.id, label: "a bordo", color: "#22c55e", dashed: false, incidentId: a.incidentId ?? undefined });
    }
    for (const h of meta.hospitals) {
      const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
      add({ id: h.id, kind: "hospital", title: `${h.id} · ${h.capacity - occupied} camas`, sub: h.name.replace(/^Hospital (Universitari i Politècnic |Universitari |General Universitari)?/, ""), color: occupied >= h.capacity ? "#ef4444" : "#f8fafc", dashed: false });
    }
    for (const a of frame.units) {
      if (a.hospitalId) edges.push({ from: a.id, to: a.hospitalId, label: a.mission === "to_hospital" ? "lleva a" : "después a", color: "#22c55e", dashed: a.mission !== "to_hospital", incidentId: a.incidentId ?? undefined });
    }
    return { nodes, edges, height: TOP + Math.max(...Object.values(rows), 1) * ROW + 10 };
  }, [frame, meta, calls]);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const colOf = (kind: Kind) => COLUMNS.find((c) => c.kind === kind)!;
  const lit = (incidentId?: string) => !focus || incidentId === focus;

  return (
    <div className="knowledge">
      <p className="legend">
        Lo que el coordinador cree que existe y por qué. <b className="dash">Discontinuo</b> = solo lo dice una llamada · <b>continuo</b> = lo ha visto una dotación. Pasa el ratón por un incidente para aislar su subgrafo.
      </p>
      <svg width={1270} height={height} onMouseLeave={() => setHover(null)}>
        {COLUMNS.map((c) => (
          <text key={c.kind} x={c.x} y={16} className="col-title">{c.title}</text>
        ))}
        {edges.map((e, i) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const x1 = colOf(a.kind).x + colOf(a.kind).w;
          const x2 = colOf(b.kind).x;
          const y1 = a.y + NODE_H / 2;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return (
            // "This call is also a water sighting" links are many: only drawn for the incident in focus.
            <g key={i} opacity={e.from === "sightings" ? (focus && e.incidentId === focus ? 0.9 : 0) : lit(e.incidentId) ? 0.9 : 0.08}>
              <path d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none" stroke={e.color} strokeWidth={1.5} strokeDasharray={e.dashed ? "4 3" : undefined} />
              {e.label && focus && lit(e.incidentId) && <text x={mid} y={(y1 + y2) / 2 - 3} className="edge-label" fill={e.color}>{e.label}</text>}
            </g>
          );
        })}
        {nodes.map((n) => {
          const col = colOf(n.kind);
          const active = n.kind === "incident" && n.id === focus;
          return (
            <g
              key={n.id}
              transform={`translate(${col.x},${n.y})`}
              opacity={lit(n.incidentId) || n.kind === "hospital" || n.kind === "water" ? 1 : 0.15}
              onMouseEnter={() => n.incidentId && setHover(n.incidentId)}
              onClick={() => n.incidentId && onSelect(n.incidentId === selected ? null : n.incidentId)}
              style={{ cursor: n.incidentId ? "pointer" : "default" }}
            >
              <rect width={col.w} height={NODE_H} rx={6} fill={active ? "#1e293b" : "#0b1120"} stroke={n.color} strokeWidth={active ? 2.5 : 1.5} strokeDasharray={n.dashed ? "5 3" : undefined} />
              <text x={8} y={15} className="node-title" fill={n.color}>{n.title.slice(0, Math.floor(col.w / 6.2))}</text>
              <text x={8} y={29} className="node-sub">{n.sub.slice(0, Math.floor(col.w / 5.6))}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
