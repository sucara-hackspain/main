// Makes the `112-triage` workflow answer fast, and publishes the change:
//
//   pnpm hr:triage          (or: node_modules/.bin/tsx --env-file=.env scripts/hr-fix-112-triage.ts)
//
// Its "Triage Decision" node is told to write the WHOLE incident board back, every incident with its seventeen fields,
// so its answer grows with the night: 2.4 s on an empty board, 10 to 19 s once there are twenty incidents. The session
// only ever needs the incident the call was attached to (the fold in `applyTriage` takes any subset). This forks the
// live version, tells the node to return only that incident, publishes the fork, and then times one run.
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { runAndReadNode } from "../src/coordinators/hr-wait";
import { readTriage } from "../src/triage/happyrobot";

const WF = process.env.HAPPYROBOT_TRIAGE_WORKFLOW_ID ?? "01a0ba99-6f31-7fc8-a336-20eea7a1f42d";
const NODE = process.env.HAPPYROBOT_TRIAGE_NODE_ID ?? "01a0baa6-1ebc-7bc8-98cf-ac659a384ce3"; // "Triage Decision"
const apiKey = process.env.HAPPYROBOT_API_KEY;
if (!apiKey) {
  console.error("Set HAPPYROBOT_API_KEY (see .env.example).");
  process.exit(1);
}
const client = new HappyRobotClient({ apiKey, cluster: (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
type Slate = { type: string; children: Record<string, unknown>[] }[];
type NodeRow = { id: string; name: string; persistent_id: string; parent_id: string | null; event_id: string };

const REWORDS: [string, string][] = [
  ["Return the complete updated incident set, not only the ones that changed. Carry unaffected incidents through unchanged, exactly as received.", "Return ONLY the incident this call was attached to, created or updated, as a one-element incidents array. Do not return the other incidents: they are kept as they were."],
  ["For each incident set changed to true when this call created it or altered it in any way, and false otherwise.", "Set changed to true on it."],
  ['"description": "The complete updated incident set, including incidents unaffected by this call."', '"description": "Only the incident this call was attached to, created or updated: a one-element array."'],
];
const reword = (slate: Slate) => slate.map((p) => ({ ...p, children: p.children.map((c) => (typeof c.text === "string" ? { ...c, text: REWORDS.reduce((t, [from, to]) => t.replace(from, to), c.text as string) } : c)) }));

const wf = await client.workflows.get(WF);
console.log(`"${wf.name}": live version is ${wf.latest_version.name} (${wf.latest_version.id})`);
const fork = (await client.versions.fork(wf.latest_version.id)) as { id?: string; version?: { id: string }; data?: { id: string } };
const versionId = fork.id ?? fork.version?.id ?? fork.data?.id ?? (await client.workflows.get(WF)).latest_version.id;
console.log(`forked into ${versionId}`);
const { data: nodes } = (await client.nodes.list(versionId)) as { data: NodeRow[] };
const node = nodes.find((n) => n.persistent_id === NODE);
if (!node) throw new Error(`no node with persistent_id ${NODE} in version ${versionId}`);
const current = (await client.nodes.get(versionId, node.id)) as { configuration?: Record<string, unknown>; data?: { configuration?: Record<string, unknown> } };
const configuration = { ...(current.configuration ?? current.data?.configuration ?? {}) };
const before = JSON.stringify([configuration.prompt, configuration.json_schema]);
configuration.prompt = reword(configuration.prompt as Slate);
configuration.json_schema = reword(configuration.json_schema as Slate);
const after = JSON.stringify([configuration.prompt, configuration.json_schema]);
console.log(`"${node.name}": ${REWORDS.filter(([from]) => before.includes(JSON.stringify(from).slice(1, -1))).length} of ${REWORDS.length} sentences found and reworded${before === after ? " (nothing changed: already done?)" : ""}`);
await client.nodes.update(versionId, node.id, { type: "action", event_id: node.event_id, configuration } as never);
await client.versions.publish(versionId, { force: true } as never);
const live = await client.workflows.get(WF);
console.log(`published ${live.latest_version.name} (${live.latest_version.id}), live=${live.latest_version.is_live}`);

// The proof: one call against a board of twelve incidents, timed.
const incident = (n: number) => ({ id: `C${n}`, callIds: [`L${n}`], priority: "medium", mechanism: "fall", node: 1000 + n, locationErrorM: 100, street: `Carrer ${n}`, conscious: "yes", breathing: "normal", bleeding: "no", trapped: "no", ageGroup: "adult", victims: 1, firstTick: n, lastTick: n, text: `C${n} · P2 · caída`, changed: false });
const call = { id: "L99", tick: 40, caller: "family", mechanism: "fall", node: 1003, locationErrorM: 60, street: "Carrer 3", conscious: "yes", breathing: "difficult", bleeding: "no", trapped: "no", ageGroup: "elderly", victims: 1, text: "Un familiar: «mi padre se ha caído en el Carrer 3 y respira mal»" };
const started = Date.now();
const result = await runAndReadNode(client, { workflowId: WF, nodePersistentId: NODE, payload: { call, incidents: Array.from({ length: 12 }, (_, n) => incident(n + 1)) }, timeoutMs: 60_000, firstPollMs: 800, pollIntervalMs: 500 });
const verdict = readTriage(result.nodeOutput, call.id);
console.log(`one verdict against 12 incidents: ${((Date.now() - started) / 1000).toFixed(1)} s · matched ${verdict.matchedIncidentId}${verdict.matchedNewIncident ? " (new)" : ""} · returned ${verdict.incidents.length} incident(s): ${JSON.stringify(verdict.incidents.map((i) => [i.id, i.priority]))} · ${verdict.reasoning}`);
