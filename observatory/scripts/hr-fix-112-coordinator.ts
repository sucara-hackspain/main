// Repairs the `112-coordinator` workflow (the call generator behind `--desk happyrobot`) and publishes the repair:
//
//   pnpm hr:generator          (or: node_modules/.bin/tsx --env-file=.env scripts/hr-fix-112-coordinator.ts)
//
// Its trigger is a "Receive external data" webhook, which keeps the API payload under `data`, while its "Generate Tick
// Seed" and "Simulation Summary" nodes read a top-level `{{scenario}}` that this trigger never sets: the seed generator
// saw an empty theme every run and invented the same cyclist on Calle de Alcalá. This forks the live version, rebinds
// both inputs to `data.scenario`, tells the seed generator to name València streets (the session hands it a sample of
// real ones), publishes the fork, and then runs the generator once through the session's own code to show the result.
import { readFileSync } from "node:fs";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { Graph } from "../src/engine/graph";
import { happyRobotCallGenerator } from "../src/triage/happyrobot";

const WF = process.env.HAPPYROBOT_GENERATOR_WORKFLOW_ID ?? "01a0bac2-283b-7174-8857-5ea031bf4cf5";
const apiKey = process.env.HAPPYROBOT_API_KEY;
if (!apiKey) {
  console.error("Set HAPPYROBOT_API_KEY (see .env.example).");
  process.exit(1);
}
const client = new HappyRobotClient({ apiKey, cluster: (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
type Slate = { type: string; children: Record<string, unknown>[] }[];
type NodeRow = { id: string; name: string; persistent_id: string; parent_id: string | null; event_id: string };

const wf = await client.workflows.get(WF);
console.log(`"${wf.name}": live version is ${wf.latest_version.name} (${wf.latest_version.id})`);
const fork = (await client.versions.fork(wf.latest_version.id)) as { id?: string; version?: { id: string }; data?: { id: string } };
const versionId = fork.id ?? fork.version?.id ?? fork.data?.id ?? (await client.workflows.get(WF)).latest_version.id;
console.log(`forked into ${versionId}`);

const { data: nodes } = (await client.nodes.list(versionId)) as { data: NodeRow[] };
const trigger = nodes.find((n) => n.parent_id === null)!;
const rebind = (slate: Slate) => slate.map((p) => ({ ...p, children: p.children.map((c) => (c.type === "variable" && c.group_id === trigger.persistent_id && c.variable_id === "scenario" ? { ...c, variable_id: "data.scenario" } : c)) }));
const reword = (slate: Slate) => slate.map((p) => ({ ...p, children: p.children.map((c) => (typeof c.text === "string" ? { ...c, text: (c.text as string).replace("Name a specific Spanish street.", "Name a specific street of València (Spain) or its Horta Sud. If the scenario lists streets, use only those, with their exact names.") } : c)) }));

for (const name of ["Generate Tick Seed", "Simulation Summary"]) {
  const node = nodes.find((n) => n.name === name);
  if (!node) throw new Error(`no node called "${name}" in version ${versionId}`);
  const current = (await client.nodes.get(versionId, node.id)) as { configuration?: Record<string, unknown>; data?: { configuration?: Record<string, unknown> } };
  const configuration = { ...(current.configuration ?? current.data?.configuration ?? {}) };
  configuration.input = rebind(configuration.input as Slate);
  if (name === "Generate Tick Seed") configuration.prompt = reword(configuration.prompt as Slate);
  await client.nodes.update(versionId, node.id, { type: "action", event_id: node.event_id, configuration } as never);
  console.log(`${name}: scenario rebound to data.scenario = ${JSON.stringify(configuration.input).includes('"data.scenario"')}`);
}
await client.versions.publish(versionId, { force: true } as never);
const after = await client.workflows.get(WF);
console.log(`published ${after.latest_version.name} (${after.latest_version.id}), live=${after.latest_version.is_live}`);

// The proof: one run through the session's own generator, with a handful of real streets handed over.
const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")));
const offered = [...new Set(Array.from({ length: 40 }, () => graph.streetAt(Math.floor(Math.random() * graph.nodeCount))).filter((s): s is string => !!s))].slice(0, 12);
const generate = happyRobotCallGenerator({ streets: () => offered, onTrace: (t) => console.log(`generator: ${t.calls.length} calls in ${(t.ms / 1000).toFixed(1)} s${t.error ? ` [${t.error}]` : ""}`) });
console.log(`offered: ${offered.join(" | ")}`);
for (const c of await generate(0)) console.log(`-> ${c.street} · offered=${offered.includes(c.street ?? "")} · on map=${graph.findStreet(c.street ?? "") !== null} · ${c.mechanism} · ${c.text.slice(0, 80)}`);
