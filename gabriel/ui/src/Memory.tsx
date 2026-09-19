import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EdgeKind, HistoryEntry, MemoryEdge, MemoryNode, NodeKind } from "../../src/memory/store";

// The agent's long-term memory as the graph it is stored as. Rules hang from the concepts they are
// about; sessions and the evidence they left hang from the rules they backed or undermined.
// Click anything to see what it says, where it came from and what it is connected to.

interface MemoryData { nodes: MemoryNode[]; edges: MemoryEdge[]; history: HistoryEntry[] }
type Placed = MemoryNode & SimulationNodeDatum & { x: number; y: number };

const KINDS: { kind: NodeKind; label: string; color: string; r: number; on: boolean }[] = [
  { kind: "driver", label: "Principios", color: "#facc15", r: 13, on: true },
  { kind: "heuristic", label: "Heurísticas", color: "#38bdf8", r: 11, on: true },
  { kind: "antipattern", label: "Errores a evitar", color: "#f87171", r: 11, on: true },
  { kind: "concept", label: "Conceptos", color: "#94a3b8", r: 8, on: true },
  { kind: "episode", label: "Sesiones", color: "#a78bfa", r: 12, on: true },
  { kind: "evidence", label: "Evidencias", color: "#4ade80", r: 5, on: false },
];
const EDGES: Record<EdgeKind, { label: string; color: string }> = {
  about: { label: "trata de", color: "#334155" },
  supports: { label: "la respalda", color: "#22c55e" },
  contradicts: { label: "la contradice", color: "#ef4444" },
  derived_from: { label: "aprendida en", color: "#a78bfa" },
  replaces: { label: "sustituye a", color: "#fb923c" },
  applied_in: { label: "citada en", color: "#6366f1" },
  happened_in: { label: "ocurrió en", color: "#1e293b" },
};
const OPS: Record<string, string> = { add: "nueva, en prueba", merge: "fusión", rewrite: "reescrita", reinforce: "reforzada", weaken: "debilitada", retire: "retirada", promote: "pasa a activa" };
const kindOf = (kind: NodeKind) => KINDS.find((k) => k.kind === kind)!;
const isRule = (n: MemoryNode) => n.kind === "driver" || n.kind === "heuristic" || n.kind === "antipattern";

export function MemoryGraph() {
  const [data, setData] = useState<MemoryData | null>(null);
  const [shown, setShown] = useState(() => new Set(KINDS.filter((k) => k.on).map((k) => k.kind)));
  const [retired, setRetired] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/memory").then((r) => r.json()).then(setData).catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  // Evidence is only drawn for whatever is selected: there is a lot of it.
  const visible = useMemo(() => {
    if (!data) return new Set<string>();
    const around = new Set(data.edges.filter((e) => e.src === selected || e.dst === selected).flatMap((e) => [e.src, e.dst]));
    return new Set(
      data.nodes
        .filter((n) => n.id === selected || around.has(n.id) || (shown.has(n.kind) && (retired || n.status !== "retired")))
        .map((n) => n.id),
    );
  }, [data, shown, retired, selected]);

  // Layout is computed once for the whole graph so nodes do not jump when filters change.
  const placed = useMemo(() => {
    if (!data) return new Map<string, Placed>();
    const nodes = data.nodes.map((n) => ({ ...n })) as Placed[];
    const column: Partial<Record<NodeKind, number>> = { episode: -420, evidence: -260, concept: 360 };
    forceSimulation(nodes)
      .force("link", forceLink(data.edges.map((e) => ({ source: e.src, target: e.dst }))).id((n) => (n as Placed).id).distance(70).strength(0.25))
      .force("charge", forceManyBody().strength(-220))
      .force("collide", forceCollide(26))
      .force("x", forceX<Placed>((n) => column[n.kind] ?? 0).strength((n) => (n.kind in column ? 0.25 : 0.04)))
      .force("y", forceY(0).strength(0.05))
      .stop()
      .tick(320);
    return new Map(nodes.map((n) => [n.id, n]));
  }, [data]);

  // Fit whatever the layout produced into the canvas, whatever its size.
  const box = useMemo(() => {
    const pts = [...placed.values()];
    if (pts.length === 0) return "0 0 100 100";
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 70;
    return `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + pad * 2} ${Math.max(...ys) - Math.min(...ys) + pad * 2}`;
  }, [placed]);

  if (!data) return <div className="memory empty">Cargando memoria…</div>;

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const node = selected ? byId.get(selected) : undefined;
  const neighbours = new Set(data.edges.filter((e) => e.src === selected || e.dst === selected).flatMap((e) => [e.src, e.dst]));
  const episodes = data.nodes.filter((n) => n.kind === "episode").sort((a, b) => String(a.data.at).localeCompare(String(b.data.at)));
  const live = data.nodes.filter((n) => isRule(n) && n.status !== "retired");

  return (
    <div className="memory">
      <div className="memory-bar">
        <span className="count">
          <b>{live.filter((n) => n.status === "active").length}</b> reglas activas · <b>{live.filter((n) => n.status === "candidate").length}</b> en prueba · <b>{episodes.length}</b> sesiones
        </span>
        {KINDS.map((k) => (
          <button key={k.kind} className={shown.has(k.kind) ? "chip on" : "chip"} onClick={() => setShown((s) => { const next = new Set(s); next.has(k.kind) ? next.delete(k.kind) : next.add(k.kind); return next; })}>
            <i style={{ background: k.color }} /> {k.label}
          </button>
        ))}
        <button className={retired ? "chip on" : "chip"} onClick={() => setRetired(!retired)}>Retiradas</button>
      </div>

      <svg
        className="memory-canvas"
        viewBox={box}
        preserveAspectRatio="xMidYMid meet"
        onWheel={(e) => setView((v) => ({ ...v, k: Math.min(3, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }))}
        onMouseDown={(e) => (drag.current = { x: e.clientX - view.x, y: e.clientY - view.y })}
        onMouseMove={(e) => drag.current && setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }))}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onClick={(e) => e.target === e.currentTarget && setSelected(null)}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <g>
            {data.edges.map((e, i) => {
              const a = placed.get(e.src);
              const b = placed.get(e.dst);
              if (!a || !b || !visible.has(e.src) || !visible.has(e.dst)) return null;
              const focus = selected !== null && (e.src === selected || e.dst === selected);
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={EDGES[e.kind].color} strokeWidth={focus ? 2 : 1} opacity={selected === null ? 0.7 : focus ? 1 : 0.12} strokeDasharray={e.kind === "applied_in" ? "3 3" : undefined} />;
            })}
            {data.nodes.map((n) => {
              const p = placed.get(n.id);
              if (!p || !visible.has(n.id)) return null;
              const k = kindOf(n.kind);
              const dim = selected !== null && n.id !== selected && !neighbours.has(n.id);
              const color = n.kind === "evidence" ? (n.data.good ? "#4ade80" : "#f87171") : k.color;
              const label = isRule(n) ? n.id : n.kind === "concept" ? n.title : n.kind === "episode" ? n.title.split(" · ").pop() : "";
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.15 : n.status === "retired" ? 0.4 : 1} onClick={(ev) => (ev.stopPropagation(), setSelected(n.id === selected ? null : n.id))} style={{ cursor: "pointer" }}>
                  <circle r={k.r + (isRule(n) ? ((n.confidence ?? 0.5) - 0.5) * 10 : 0)} fill={n.id === selected ? color : "#0b1120"} stroke={color} strokeWidth={2.5} strokeDasharray={n.status === "candidate" ? "4 3" : undefined} />
                  <text y={isRule(n) ? 4 : k.r + 12} className={isRule(n) ? "in" : "out"} fill={isRule(n) ? (n.id === selected ? "#0b1120" : color) : "#cbd5e1"}>{label}</text>
                  {isRule(n) && <text y={k.r + 16} className="out">{n.title.slice(0, 30)}</text>}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      <aside className="memory-detail">
        {node ? (
          <NodeDetail node={node} data={data} byId={byId} onSelect={setSelected} />
        ) : (
          <>
            <h3>Sesiones</h3>
            {episodes.length === 0 && <p className="muted">Todavía no hay ninguna. La memoria es la doctrina inicial.</p>}
            {[...episodes].reverse().map((ep) => {
              const ops = data.history.filter((h) => `episode:${h.session}` === ep.id);
              return (
                <button key={ep.id} className="episode" onClick={() => setSelected(ep.id)}>
                  <b>{ep.title}</b>
                  <span>{ops.length ? `${ops.length} cambios en la doctrina` : "sin cambios en la doctrina"}</span>
                </button>
              );
            })}
            <p className="muted">Pincha cualquier nodo. Rueda para acercar, arrastra para mover. Trazo discontinuo = regla en prueba; tamaño = confianza.</p>
          </>
        )}
      </aside>
    </div>
  );
}

function NodeDetail({ node, data, byId, onSelect }: { node: MemoryNode; data: MemoryData; byId: Map<string, MemoryNode>; onSelect: (id: string | null) => void }) {
  const links = data.edges.filter((e) => e.src === node.id || e.dst === node.id);
  const groups = new Map<string, { other: MemoryNode; note: string }[]>();
  for (const e of links) {
    const outgoing = e.src === node.id;
    const other = byId.get(outgoing ? e.dst : e.src);
    if (!other) continue;
    // Read every link from the point of view of the node on screen.
    const label = outgoing ? EDGES[e.kind].label : { about: "reglas sobre esto", supports: "respalda a", contradicts: "contradice a", derived_from: "reglas aprendidas aquí", replaces: "sustituida por", applied_in: "reglas citadas", happened_in: "qué ocurrió" }[e.kind];
    groups.set(label, [...(groups.get(label) ?? []), { other, note: e.note }]);
  }
  const history = data.history.filter((h) => h.nodeId === node.id || `episode:${h.session}` === node.id);
  const summary = node.data.summary as { saved: number; dead: number; inWater: number } | undefined;

  return (
    <>
      <button className="back" onClick={() => onSelect(null)}>← sesiones</button>
      <h3 style={{ color: node.kind === "evidence" ? (node.data.good ? "#4ade80" : "#f87171") : kindOf(node.kind).color }}>
        {isRule(node) ? `${node.id} · ` : ""}
        {node.title}
      </h3>
      {isRule(node) && (
        <p className="meta">
          {node.status === "candidate" ? "En prueba" : node.status === "retired" ? "Retirada" : "Activa"} · confianza {(node.confidence ?? 0).toFixed(2)}
          <span className="bar"><i style={{ width: `${(node.confidence ?? 0) * 100}%` }} /></span>
          origen: {node.origin}
        </p>
      )}
      {summary && <p className="meta">{summary.saved} atendidos · {summary.dead} muertos · {summary.inWater} dentro del agua{node.data.dreamer ? ` · soñado con ${node.data.dreamer}` : ""}</p>}
      {node.body && <p className="body">{node.body}</p>}

      {history.length > 0 && (
        <>
          <h4>{node.kind === "episode" ? "Qué cambió en la doctrina esa noche" : "Historia"}</h4>
          {history.map((h, i) => (
            <p key={i} className="history">
              <b onClick={() => onSelect(h.nodeId)}>{h.nodeId}</b> {OPS[h.op] ?? h.op} <i>— {h.reason}</i>
            </p>
          ))}
        </>
      )}
      {[...groups].map(([label, items]) => (
        <div key={label}>
          <h4>{label} · {items.length}</h4>
          {items.slice(0, 14).map(({ other, note }, i) => (
            <p key={i} className="link" onClick={() => onSelect(other.id)}>
              <i style={{ background: other.kind === "evidence" ? (other.data.good ? "#4ade80" : "#f87171") : kindOf(other.kind).color }} />
              <span>
                {isRule(other) ? <b>{other.id} </b> : null}
                {other.kind === "evidence" ? other.body.slice(0, 150) : other.title}
                {note && other.kind !== "evidence" ? <em> — {note}</em> : null}
              </span>
            </p>
          ))}
        </div>
      ))}
    </>
  );
}
