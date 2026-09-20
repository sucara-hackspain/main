// pnpm lab:report — lab/report.html, rebuilt from what is on disk. The loop calls it after every game, and the page
// reloads itself while a run is alive, so it doubles as the live view of the training.
import { writeFileSync } from "node:fs";
import { EMPTY, type Doctrine } from "./doctrine";
import { loadPlayables, type Scenario } from "./scenario";
import { deathsOn, LAB_DIR, policyKey, readGames, readLedger, readPolicies, readStatus, repNoise, type GameRow, type LedgerEntry, type Trial, type Verdict } from "./store";

type Generation = Extract<LedgerEntry, { type: "generation" }>;

const esc = (text: unknown) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? "–" : n.toFixed(digits));
const signed = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "–" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`);

/** Mean over the nights that have been played so far, and how many of them that is. */
function partial(games: GameRow[], policy: string, scenarios: Scenario[]): { mean: number; have: number; of: number } {
  const values = scenarios.map((s) => deathsOn(games, policy, s.id)).filter((v) => !Number.isNaN(v));
  return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN, have: values.length, of: scenarios.length };
}

interface Series {
  name: string;
  color: string;
  points: { x: number; y: number; partial?: boolean }[];
}
interface Reference {
  name: string;
  y: number;
  color: string;
}

function lineChart(id: string, title: string, series: Series[], refs: Reference[], xMax: number): string {
  const W = 560, H = 300, L = 46, R = 150, T = 34, B = 36;
  const ys = [...series.flatMap((s) => s.points.map((p) => p.y)), ...refs.map((r) => r.y)].filter((v) => !Number.isNaN(v));
  if (ys.length === 0) return `<div class="chart empty"><h3>${esc(title)}</h3><p class="muted">Aún no hay partidas.</p></div>`;
  const lo = Math.max(0, Math.floor(Math.min(...ys) - 1));
  const hi = Math.ceil(Math.max(...ys) + 1);
  const span = Math.max(1, xMax);
  const px = (x: number) => L + (x / span) * (W - L - R);
  const py = (y: number) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  const step = hi - lo > 12 ? 4 : hi - lo > 6 ? 2 : 1;
  const out: string[] = [`<svg id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><rect width="${W}" height="${H}" fill="var(--card)"/>`];
  out.push(`<text x="${L}" y="18" class="ct">${esc(title)}</text>`);
  for (let y = lo; y <= hi; y += step) out.push(`<line x1="${L}" x2="${W - R}" y1="${py(y)}" y2="${py(y)}" class="grid"/><text x="${L - 6}" y="${py(y) + 4}" text-anchor="end" class="tick">${y}</text>`);
  for (let x = 0; x <= span; x++) out.push(`<text x="${px(x)}" y="${H - B + 16}" text-anchor="middle" class="tick">G${x}</text>`);
  out.push(`<text x="${L}" y="${H - 6}" class="tick">generación · muertos por noche (menos es mejor)</text>`);

  // Labels on the right, nudged apart so they never overlap.
  const labels = [...refs.map((r) => ({ y: py(r.y), text: `${r.name} ${num(r.y)}`, color: r.color })), ...series.filter((s) => s.points.length).map((s) => ({ y: py(s.points.at(-1)!.y), text: `${s.name} ${num(s.points.at(-1)!.y)}`, color: s.color }))].sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;

  for (const r of refs) out.push(`<line x1="${L}" x2="${W - R}" y1="${py(r.y)}" y2="${py(r.y)}" stroke="${r.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  for (const s of series) {
    if (s.points.length > 1) out.push(`<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${s.points.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")}"/>`);
    for (const p of s.points) out.push(`<circle cx="${px(p.x)}" cy="${py(p.y)}" r="4.5" fill="${p.partial ? "var(--card)" : s.color}" stroke="${s.color}" stroke-width="2"/>`);
  }
  for (const l of labels) out.push(`<text x="${W - R + 8}" y="${l.y + 4}" fill="${l.color}" class="lab">${esc(l.text)}</text>`);
  out.push("</svg>");
  return `<div class="chart">${out.join("")}<button class="png" data-svg="${id}">PNG</button></div>`;
}

const VERDICT: Record<Verdict, { label: string; color: string }> = {
  accepted: { label: "aceptada", color: "var(--good)" },
  no_gain: { label: "no mejora", color: "var(--muted)" },
  overfit: { label: "sobreajuste", color: "var(--bad)" },
  outdone: { label: "mejoraba, otra fue antes", color: "var(--warn)" },
  invalid: { label: "no jugable", color: "var(--muted)" },
};

function trialChart(generations: Generation[]): string {
  const trials = generations.flatMap((g) => g.trials.filter((t) => t.train).map((t) => ({ g: g.n, t })));
  if (trials.length === 0) return "";
  const W = 560, L = 46, T = 34, row = 22;
  const H = T + trials.length * row + 30;
  const max = Math.max(1, ...trials.map(({ t }) => Math.abs(t.train!.delta)), ...trials.map(({ t }) => Math.abs(t.validation?.delta ?? 0)));
  const mid = L + 190 + (W - L - 200) / 2;
  const scale = (W - L - 200) / 2 / max;
  const out = [`<svg id="trials" viewBox="0 0 ${W} ${H}" role="img"><rect width="${W}" height="${H}" fill="var(--card)"/><text x="${L}" y="18" class="ct">Cada hipótesis contra la campeona (Δ muertos por noche)</text>`];
  out.push(`<line x1="${mid}" x2="${mid}" y1="${T - 6}" y2="${H - 26}" class="axis"/><text x="${mid - 6}" y="${H - 8}" text-anchor="end" class="tick">← salva vidas</text><text x="${mid + 6}" y="${H - 8}" class="tick">mueren más →</text>`);
  trials.forEach(({ g, t }, i) => {
    const y = T + i * row;
    const bar = (delta: number, dy: number, h: number, opacity: number) => `<rect x="${Math.min(mid, mid + delta * scale)}" y="${y + dy}" width="${Math.max(1, Math.abs(delta * scale))}" height="${h}" fill="${VERDICT[t.verdict].color}" opacity="${opacity}"/>`;
    out.push(`<text x="${L - 38}" y="${y + 14}" class="tick">G${g}</text><text x="${L - 14}" y="${y + 14}" class="lab" fill="var(--ink)">${esc(t.name.length > 30 ? t.name.slice(0, 29) + "…" : t.name)}</text>`);
    out.push(bar(t.train!.delta, 3, t.validation ? 8 : 14, 1));
    if (t.validation) out.push(bar(t.validation.delta, 12, 6, 0.55));
  });
  out.push("</svg>");
  return `<div class="chart">${out.join("")}<button class="png" data-svg="trials">PNG</button><p class="muted small">Barra gruesa: noches de entrenamiento. Barra fina: noches de validación (solo para las que llegaron al examen).</p></div>`;
}

function heat(value: number, reference: number): string {
  if (Number.isNaN(value) || Number.isNaN(reference) || reference === 0) return "";
  const ratio = Math.max(-1, Math.min(1, (value - reference) / Math.max(4, reference)));
  const color = ratio <= 0 ? "var(--good)" : "var(--bad)";
  return `background: color-mix(in srgb, ${color} ${Math.round(Math.abs(ratio) * 70)}%, transparent)`;
}

export function renderReport(): string {
  const scenarios = loadPlayables();
  const games = readGames();
  const ledger = readLedger();
  const policies = readPolicies();
  const status = readStatus();
  const generations = ledger.filter((e): e is Generation => e.type === "generation");
  const tested = ledger.some((e) => e.type === "test");
  const train = scenarios.filter((s) => s.split === "train");
  const validation = scenarios.filter((s) => s.split === "validation");
  const test = scenarios.filter((s) => s.split === "test");

  const emptyKey = policyKey({ kind: "agent", doctrine: EMPTY });
  const champions = [generations[0]?.championBefore ?? emptyKey, ...generations.map((g) => g.championAfter)];
  const championKey = champions.at(-1)!;
  const champion: Doctrine = policies[championKey]?.doctrine ?? EMPTY;
  const baselines = ledger.flatMap((e) => (e.type === "baseline" ? [e] : []));
  const find = (kind: string) => Object.entries(policies).find(([key, p]) => (kind === "hand" ? p.label.includes("escrita a mano") : key === kind))?.[0];
  const refs = [
    { key: find("greedy"), name: "greedy", color: "var(--ref1)" },
    { key: find("hand"), name: "a mano", color: "var(--ref2)" },
    { key: find("informed"), name: "info perfecta", color: "var(--ref3)" },
  ].filter((r): r is { key: string; name: string; color: string } => Boolean(r.key));

  const curve = (split: Scenario[], name: string, color: string): Series => ({
    name,
    color,
    points: champions.flatMap((key, x) => {
      const p = partial(games, key, split);
      return Number.isNaN(p.mean) ? [] : [{ x, y: p.mean, partial: p.have < p.of }];
    }),
  });
  const refLines = (split: Scenario[]): Reference[] => refs.flatMap((r) => {
    const p = partial(games, r.key, split);
    return Number.isNaN(p.mean) ? [] : [{ name: r.name, y: p.mean, color: r.color }];
  });
  const xMax = Math.max(1, champions.length - 1);

  const first = partial(games, champions[0], validation);
  const now = partial(games, championKey, validation);
  const greedyVal = refs[0] ? partial(games, refs[0].key, validation) : null;
  const noise = repNoise(games, championKey, [...train, ...validation].map((s) => s.id)) ?? repNoise(games, champions[0], [...train, ...validation].map((s) => s.id));
  const trialsTotal = generations.reduce((sum, g) => sum + g.trials.length, 0);
  const accepted = generations.reduce((sum, g) => sum + g.trials.filter((t) => t.verdict === "accepted").length, 0);
  const agentGames = games.filter((g) => g.policy.startsWith("agent:"));
  const decisions = agentGames.reduce((sum, g) => sum + g.game.llm.calls, 0);

  const remaining = status ? status.total - status.done : 0;
  const eta = status?.running && status.meanGameSeconds ? Math.ceil((remaining / status.parallel) * status.meanGameSeconds / 60) : null;

  const columns = [...refs.map((r) => ({ key: r.key, name: r.name })), ...[...new Set(champions)].map((key) => ({ key, name: `G${champions.indexOf(key)}${champions.lastIndexOf(key) !== champions.indexOf(key) ? `–${champions.lastIndexOf(key)}` : ""}` }))];
  const rows = [...train, ...validation, ...(tested ? test : [])];
  const greedyKey = refs[0]?.key;

  const trialRow = (g: Generation, t: Trial) => `<tr>
    <td>G${g.n}</td>
    <td><strong>${esc(t.name)}</strong><div class="edit">${esc(t.editText)}</div><div class="muted small">${esc(t.rationale)}</div></td>
    <td class="n">${signed(t.train?.delta)}</td><td class="n">${signed(t.validation?.delta)}</td>
    <td><span class="pill" style="--c:${VERDICT[t.verdict].color}">${VERDICT[t.verdict].label}</span></td></tr>`;

  const ruleUse = new Map<string, number>();
  for (const g of games.filter((g) => g.policy === championKey)) for (const u of g.game.ruleUse) ruleUse.set(u.ruleId, (ruleUse.get(u.ruleId) ?? 0) + u.times);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${status?.running ? '<meta http-equiv="refresh" content="4">' : ""}
<title>Laboratorio de doctrina</title>
<style>
:root { --bg:#f6f5f1; --card:#ffffff; --ink:#1c1b19; --muted:#77736a; --line:#e4e1d8; --good:#1f9d6b; --bad:#d64545; --warn:#c98a1b; --train:#2f6fde; --val:#8a3ffc; --ref1:#77736a; --ref2:#c98a1b; --ref3:#1f9d6b; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#151412; --card:#1f1e1b; --ink:#f0ede6; --muted:#9a958a; --line:#33312c; --good:#3ecf8e; --bad:#ff6b6b; --warn:#f0b341; --train:#6ea1ff; --val:#b58cff; --ref1:#9a958a; --ref2:#f0b341; --ref3:#3ecf8e; } }
:root[data-theme="dark"] { --bg:#151412; --card:#1f1e1b; --ink:#f0ede6; --muted:#9a958a; --line:#33312c; --good:#3ecf8e; --bad:#ff6b6b; --warn:#f0b341; --train:#6ea1ff; --val:#b58cff; --ref1:#9a958a; --ref2:#f0b341; --ref3:#3ecf8e; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1180px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:26px; margin:0 0 4px; letter-spacing:-0.02em; } h2 { font-size:17px; margin:34px 0 10px; } h3 { font-size:14px; margin:0 0 6px; }
.muted { color:var(--muted); } .small { font-size:12.5px; } .n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.card, .chart { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-top:16px; }
.kpi b { display:block; font-size:26px; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; } .kpi span { font-size:12.5px; color:var(--muted); }
.live { border-color:var(--train); } .bar { height:6px; border-radius:3px; background:var(--line); overflow:hidden; } .bar i { display:block; height:100%; background:var(--train); }
.games { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:8px; margin-top:10px; }
.game { border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:12.5px; } .game .bar { margin-top:6px; height:4px; }
.charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:12px; }
.chart { position:relative; } .chart svg { width:100%; height:auto; display:block; }
.png { position:absolute; top:10px; right:10px; font:11px ui-sans-serif,system-ui; padding:2px 8px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--muted); cursor:pointer; }
svg .ct { font:600 13px ui-sans-serif,system-ui; fill:var(--ink); } svg .tick { font:11px ui-sans-serif,system-ui; fill:var(--muted); } svg .lab { font:600 11.5px ui-sans-serif,system-ui; }
svg .grid { stroke:var(--line); } svg .axis { stroke:var(--muted); }
.scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-size:13.5px; } th, td { padding:7px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; } th { font-size:12px; color:var(--muted); font-weight:600; }
.heat td.n { min-width:54px; } .split { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:12px; font-weight:600; color:var(--c); border:1px solid var(--c); white-space:nowrap; }
.edit { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; margin:3px 0; }
.rule { padding:9px 0; border-bottom:1px solid var(--line); } .rule:last-child { border:0; } .rule code { font-weight:700; margin-right:6px; }
pre { margin:0; font:12px/1.5 ui-monospace,Menlo,monospace; white-space:pre-wrap; color:var(--muted); max-height:320px; overflow:auto; }
blockquote { margin:6px 0 12px; padding:8px 12px; border-left:3px solid var(--val); background:var(--card); border-radius:0 8px 8px 0; font-size:13.5px; }
</style></head><body><main>
<h1>Laboratorio de doctrina</h1>
<div class="muted">El coordinador aprende a decidir jugando las mismas noches una y otra vez. Nadie escribe las reglas: se proponen, se juegan y solo se quedan las que salvan vidas también en noches que nunca se estudiaron.</div>

${status ? `<h2>${status.running ? "En marcha" : "Parado"} · ${esc(status.phase)}</h2>
<div class="card ${status.running ? "live" : ""}">
  <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><span>Partidas de esta ejecución: <strong>${status.done}</strong> de ${status.total}</span><span class="muted">${status.meanGameSeconds ? `${Math.round(status.meanGameSeconds)} s por partida con agente · ` : ""}${status.parallel} a la vez${status.platform ? ` · plataforma: ${status.platform.requests} peticiones, ${status.platform.rateLimited} frenazos, una cada ${status.platform.spacingMs} ms` : ""}${eta !== null ? ` · quedan ~${eta} min` : ""} · ${new Date(status.updatedAt).toLocaleTimeString("es-ES")}</span></div>
  <div class="bar" style="margin-top:8px"><i style="width:${status.total ? (100 * status.done) / status.total : 0}%"></i></div>
  ${status.games.length ? `<div class="games">${status.games.map((g) => `<div class="game"><strong>${esc(g.scenario)}</strong> r${g.rep} · ${esc(g.label)}<div class="muted">tick ${g.tick}/${g.ticks} · ${g.dead} muertos</div><div class="bar"><i style="width:${(100 * g.tick) / g.ticks}%"></i></div></div>`).join("")}</div>` : ""}
</div>` : ""}

<div class="kpis">
  <div class="card kpi"><b>${num(first.mean)} → ${num(now.mean)}</b><span>muertos por noche en validación: sin doctrina → campeona${now.have < now.of ? ` (parcial, ${now.have}/${now.of} noches)` : ""}</span></div>
  <div class="card kpi"><b>${num(greedyVal?.mean)}</b><span>greedy en esas mismas noches</span></div>
  <div class="card kpi"><b>${generations.length}</b><span>generaciones · ${trialsTotal} hipótesis probadas · ${accepted} aceptadas</span></div>
  <div class="card kpi"><b>${champion.rules.length}</b><span>reglas en la doctrina campeona</span></div>
  <div class="card kpi"><b>±${num(noise)}</b><span>ruido: cuánto cambia la misma noche con la misma doctrina de una partida a otra</span></div>
  <div class="card kpi"><b>${agentGames.length}</b><span>partidas con agente · ${decisions} decisiones del LLM</span></div>
</div>

<h2>Curva de aprendizaje</h2>
<div class="charts">
  ${lineChart("curve-train", `Entrenamiento (${train.length} noches que el investigador estudia)`, [curve(train, "campeona", "var(--train)")], refLines(train), xMax)}
  ${lineChart("curve-val", `Validación (${validation.length} noches que nunca ve)`, [curve(validation, "campeona", "var(--val)")], refLines(validation), xMax)}
</div>
<p class="muted small">Punto hueco: faltan noches por jugar. Si la curva de entrenamiento baja y la de validación no, la doctrina está memorizando las noches en vez de aprender a decidir.</p>

${generations.length ? `<h2>Hipótesis</h2><div class="charts">${trialChart(generations)}</div>
${generations.map((g) => `<h3 style="margin-top:18px">Generación ${g.n} <span class="muted small">· ${esc(g.researcher)} · noches: ${g.minibatch.join(", ")} · ${Math.round((Date.parse(g.endedAt) - Date.parse(g.startedAt)) / 60000)} min</span></h3>
<blockquote>${esc(g.analysis)}</blockquote>
<div class="card scroll"><table><tr><th></th><th>Hipótesis</th><th class="n">Δ entren.</th><th class="n">Δ valid.</th><th>Veredicto</th></tr>${g.trials.map((t) => trialRow(g, t)).join("")}</table></div>`).join("")}` : ""}

<h2>Doctrina campeona</h2>
<div class="card">${champion.rules.length ? champion.rules.map((r) => `<div class="rule"><code>${esc(r.id)}</code><strong>${esc(r.title)}</strong> <span class="muted small">· entró en G${r.since} · citada ${ruleUse.get(r.id) ?? 0} veces</span><div>${esc(r.body)}</div></div>`).join("") : '<span class="muted">Vacía: el agente decide sin ninguna regla aprendida. Es el punto de partida.</span>'}</div>

<h2>Noche a noche</h2>
<div class="card scroll"><table class="heat"><tr><th>Noche</th><th>Víctimas</th>${columns.map((c) => `<th class="n">${esc(c.name)}</th>`).join("")}</tr>
${rows.map((s) => `<tr><td><span class="split">${s.split === "train" ? "entren." : s.split === "validation" ? "valid." : "test"}</span> <strong>${s.id}</strong> ${esc(s.title)}<div class="muted small">${esc(s.family)}</div></td><td class="n">${s.stats.victims}</td>${columns.map((c) => { const v = deathsOn(games, c.key, s.id); return `<td class="n" style="${heat(v, greedyKey ? deathsOn(games, greedyKey, s.id) : NaN)}">${num(v)}</td>`; }).join("")}</tr>`).join("")}
</table></div>
<p class="muted small">Muertos por noche (media de las repeticiones). Verde: menos que greedy en esa noche. Rojo: más. ${tested ? "" : `Las ${test.length} noches de test siguen guardadas: se juegan una sola vez, al final.`}</p>

${baselines.length ? `<p class="muted small">Referencias: ${baselines.map((b) => esc(b.name)).join(" · ")}.</p>` : ""}

${status?.log.length ? `<h2>Registro</h2><div class="card"><pre>${esc(status.log.join("\n"))}</pre></div>` : ""}
</main>
<script>
try { const y = sessionStorage.getItem("labScroll"); if (y) scrollTo(0, Number(y)); addEventListener("scroll", () => sessionStorage.setItem("labScroll", String(scrollY))); } catch {}
for (const button of document.querySelectorAll(".png")) button.addEventListener("click", () => {
  const svg = document.getElementById(button.dataset.svg);
  const css = getComputedStyle(document.documentElement);
  let text = new XMLSerializer().serializeToString(svg).replace(/var\\((--[a-z0-9]+)\\)/g, (_, name) => css.getPropertyValue(name).trim());
  const rules = { ".ct": "font:600 13px sans-serif;fill:" + css.getPropertyValue("--ink"), ".tick": "font:11px sans-serif;fill:" + css.getPropertyValue("--muted"), ".lab": "font:600 11.5px sans-serif", ".grid": "stroke:" + css.getPropertyValue("--line"), ".axis": "stroke:" + css.getPropertyValue("--muted") };
  text = text.replace(/<svg([^>]*)>/, (m, attrs) => "<svg" + attrs + "><style>" + Object.entries(rules).map(([k, v]) => k + "{" + v + "}").join("") + "</style>");
  const image = new Image();
  image.onload = () => { const box = svg.viewBox.baseVal, canvas = document.createElement("canvas"); canvas.width = box.width * 3; canvas.height = box.height * 3; canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height); const a = document.createElement("a"); a.download = button.dataset.svg + ".png"; a.href = canvas.toDataURL("image/png"); a.click(); };
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
});
</script></body></html>`;
}

export function writeReport(): void {
  try {
    writeFileSync(`${LAB_DIR}/report.html`, renderReport());
  } catch (err) {
    console.error(`report: ${err instanceof Error ? err.message : err}`);
  }
}

if (process.argv[1]?.endsWith("report.ts")) {
  writeReport();
  console.log(`${LAB_DIR}/report.html`);
}
