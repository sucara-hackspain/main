// pnpm lab:attention [night ids] — same nights, same dispatcher, same citizen channel; the only thing that changes is
// how much of the channel gets read, and how well. No LLM is called here: the agent's reading is taken from
// lab/readings (pnpm lab:read), so nights without one simply skip that column.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Graph, type GraphData } from "../engine";
import { play, READINGS_DIR, type Attention, type Game } from "./play";
import { loadScenarios } from "./scenario";

const OUT = "lab/attention";
const PROFILES: { key: string; label: string; attention: Attention | null; outbound: boolean; note: string }[] = [
  { key: "none", label: "Sala de hoy", attention: null, outbound: false, note: "solo 112, radio y drones" },
  { key: "sala", label: "Sala + redes", attention: "sala", outbound: false, note: "operadores leyendo: 6 mensajes por tick" },
  { key: "palabras", label: "Reglas", attention: "palabras", outbound: false, note: "lo leen todo por palabras clave" },
  { key: "agente", label: "Agente lector", attention: "agente", outbound: true, note: "lo lee todo y lo entiende; llama casa por casa" },
  { key: "perfecto", label: "Lector perfecto", attention: "perfecto", outbound: true, note: "techo: sabe qué mensaje es verdad" },
];

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const wanted = process.argv.slice(2);
const nights = loadScenarios().filter((s) => (wanted.length ? wanted.includes(s.id) : s.split !== "test"));
mkdirSync(OUT, { recursive: true });

interface Row {
  night: string;
  family: string;
  title: string;
  victims: number;
  results: Record<string, { dead: number; wasted: number; channel: Game["channel"] } | null>;
}
const rows: Row[] = [];
for (const night of nights) {
  const row: Row = { night: night.id, family: night.family, title: night.title, victims: night.stats.victims, results: {} };
  for (const p of PROFILES) {
    if (p.attention === "agente" && !existsSync(`${READINGS_DIR}/${night.id}.json`)) {
      row.results[p.key] = null;
      continue;
    }
    const game = await play(night, { kind: "greedy" }, graph, p.attention ? { channel: { attention: p.attention, outbound: p.outbound } } : {});
    row.results[p.key] = { dead: game.dead, wasted: game.counts.wasted_nobody_there ?? 0, channel: game.channel };
  }
  rows.push(row);
  console.log(`${night.id.padEnd(4)} ${PROFILES.map((p) => `${p.key} ${row.results[p.key]?.dead ?? "–"}`).join(" · ")}`);
}
writeFileSync(`${OUT}/results.json`, JSON.stringify({ profiles: PROFILES, rows }, null, 2));

// ---------- report ----------
const esc = (t: unknown) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const complete = rows.filter((r) => PROFILES.every((p) => r.results[p.key]));
const basis = complete.length ? complete : rows;
const stat = (key: string) => {
  const got = basis.flatMap((r) => (r.results[key] ? [r.results[key]!] : []));
  const ch = got.flatMap((g) => (g.channel ? [g.channel] : []));
  return {
    dead: mean(got.map((g) => g.dead)),
    wasted: mean(got.map((g) => g.wasted)),
    readShare: ch.length ? mean(ch.map((c) => c.read / Math.max(1, c.received))) : 0,
    leads: mean(ch.map((c) => c.leads)),
    realShare: ch.length ? mean(ch.map((c) => (c.leads ? c.realLeads / c.leads : 1))) : NaN,
    silentFound: ch.length ? mean(ch.map((c) => c.silentFound / Math.max(1, c.silentScenes))) : NaN,
    received: mean(ch.map((c) => c.received)),
  };
};
const stats = PROFILES.map((p) => ({ ...p, ...stat(p.key) }));
const top = Math.max(...stats.map((s) => s.dead).filter((d) => !Number.isNaN(d)));
const W = 760, H = 300, L = 150, R = 190, T = 30, rowH = 46;
const bars = stats
  .map((s, i) => {
    if (Number.isNaN(s.dead)) return "";
    const w = ((W - L - R) * s.dead) / top;
    const y = T + i * rowH;
    const color = s.key === "agente" ? "var(--agent)" : s.key === "perfecto" ? "var(--ceiling)" : "var(--bar)";
    return `<text x="${L - 10}" y="${y + 17}" text-anchor="end" class="name">${esc(s.label)}</text><text x="${L - 10}" y="${y + 31}" text-anchor="end" class="note">${esc(s.note)}</text>
      <rect x="${L}" y="${y + 4}" width="${w}" height="26" rx="4" fill="${color}"/><text x="${L + w + 8}" y="${y + 22}" class="value">${s.dead.toFixed(1)} muertos por noche</text>`;
  })
  .join("");
const pct = (x: number) => (Number.isNaN(x) ? "–" : `${Math.round(x * 100)} %`);
const num = (x: number, d = 1) => (Number.isNaN(x) ? "–" : x.toFixed(d));

writeFileSync(
  `${OUT}/report.html`,
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Presupuesto de atención</title>
<style>
:root { --bg:#f6f5f1; --card:#fff; --ink:#1c1b19; --muted:#77736a; --line:#e4e1d8; --bar:#b9b4a8; --agent:#2f6fde; --ceiling:#1f9d6b; --good:#1f9d6b; --bad:#d64545; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#151412; --card:#1f1e1b; --ink:#f0ede6; --muted:#9a958a; --line:#33312c; --bar:#5a564d; --agent:#6ea1ff; --ceiling:#3ecf8e; --good:#3ecf8e; --bad:#ff6b6b; } }
:root[data-theme="dark"] { --bg:#151412; --card:#1f1e1b; --ink:#f0ede6; --muted:#9a958a; --line:#33312c; --bar:#5a564d; --agent:#6ea1ff; --ceiling:#3ecf8e; --good:#3ecf8e; --bad:#ff6b6b; }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
main { max-width:1080px; margin:0 auto; padding:28px 16px 64px; } h1 { font-size:26px; letter-spacing:-0.02em; margin:0 0 6px; } h2 { font-size:17px; margin:32px 0 10px; }
.muted { color:var(--muted); } .small { font-size:12.5px; } .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; overflow-x:auto; }
svg { width:100%; height:auto; display:block; } svg .name { font:600 13px ui-sans-serif,system-ui; fill:var(--ink); } svg .note { font:10.5px ui-sans-serif,system-ui; fill:var(--muted); } svg .value { font:600 12.5px ui-sans-serif,system-ui; fill:var(--ink); }
table { border-collapse:collapse; width:100%; font-size:13.5px; } th,td { padding:7px 10px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; } th:first-child,td:first-child { text-align:left; white-space:normal; } th { font-size:12px; color:var(--muted); font-weight:600; }
td.best { color:var(--good); font-weight:600; } .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; margin:18px 0; } .kpi b { display:block; font-size:26px; letter-spacing:-0.02em; } .kpi span { font-size:12.5px; color:var(--muted); }
</style></head><body><main>
<h1>Presupuesto de atención</h1>
<p class="muted">Las mismas ${basis.length} noches, el mismo despachador por reglas, el mismo canal ciudadano. Lo único que cambia es cuánto de ese canal se alcanza a leer, y cómo de bien. Ninguna llamada a un LLM durante las partidas: la lectura del agente se hizo una vez por noche y está guardada.</p>
<div class="kpis">
  <div class="card kpi"><b>${num(stats[0].received || stats[1].received, 0)}</b><span>mensajes por noche en el canal ciudadano</span></div>
  <div class="card kpi"><b>${pct(stats[1].readShare)}</b><span>es lo que alcanza a leer una sala con operadores</span></div>
  <div class="card kpi"><b>${num(stats[0].dead)} → ${num(stats.find((s) => s.key === "agente")!.dead)}</b><span>muertos por noche: sala de hoy → agente lector</span></div>
  <div class="card kpi"><b>${pct(stats.find((s) => s.key === "palabras")!.realShare)} · ${pct(stats.find((s) => s.key === "agente")!.realShare)}</b><span>pistas que eran verdad: reglas por palabras clave · agente</span></div>
</div>
<div class="card"><svg viewBox="0 0 ${W} ${T + stats.length * rowH + 10}" role="img" aria-label="Muertos por noche según quién lee el canal">${bars}</svg></div>
<h2>Qué hace cada uno con el mismo canal</h2>
<div class="card"><table><tr><th>Quién lee</th><th>Lee</th><th>Pistas por noche</th><th>Eran verdad</th><th>Escenas mudas encontradas</th><th>Viajes a sitios vacíos</th><th>Muertos por noche</th></tr>
${stats.map((s) => `<tr><td><strong>${esc(s.label)}</strong><div class="muted small">${esc(s.note)}</div></td><td>${s.attention ? pct(s.readShare) : "0 %"}</td><td>${s.attention ? num(s.leads) : "0"}</td><td>${s.attention ? pct(s.realShare) : "–"}</td><td>${pct(s.silentFound)}</td><td>${num(s.wasted)}</td><td><strong>${num(s.dead)}</strong></td></tr>`).join("")}
</table></div>
<p class="muted small">"Escenas mudas": emergencias de las que nadie llamó al 112. Una sala lee bien pero poco; unas reglas leen todo y se creen las bromas, así que mandan unidades a sitios donde no hay nadie; el agente lee todo y entiende qué es verdad.</p>
<h2>Noche a noche</h2>
<div class="card"><table><tr><th>Noche</th><th>Víctimas</th>${PROFILES.map((p) => `<th>${esc(p.label)}</th>`).join("")}</tr>
${rows.map((r) => { const best = Math.min(...PROFILES.filter((p) => p.key !== "perfecto").flatMap((p) => (r.results[p.key] ? [r.results[p.key]!.dead] : []))); return `<tr><td><strong>${r.night}</strong> ${esc(r.title)}<div class="muted small">${esc(r.family)}</div></td><td>${r.victims}</td>${PROFILES.map((p) => { const x = r.results[p.key]; return `<td class="${x && x.dead === best && p.key !== "perfecto" ? "best" : ""}">${x ? x.dead : "–"}</td>`; }).join("")}</tr>`; }).join("")}
</table></div>
${complete.length < rows.length ? `<p class="muted small">Las medias de arriba usan solo las ${complete.length} noches que el agente ya ha leído.</p>` : ""}
</main></body></html>`,
);
console.log(`${OUT}/report.html`);
