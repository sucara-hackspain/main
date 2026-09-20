// Pushes the coordinator's prompt and output schema from git into its HappyRobot workflow, so the
// platform never drifts from the repo:
//
//   pnpm hr:sync              sync and publish the coordinator
//   pnpm hr:sync --dream      same for the dream workflow (HAPPYROBOT_DREAM_WORKFLOW_ID / _NODE_ID)
//   pnpm hr:sync --master     same for the master workflow (HAPPYROBOT_MASTER_WORKFLOW_ID / _NODE_ID); its input,
//                             built from the trigger's own fields, is left as it is, and the nodes that hung
//                             from the turn (the loop that invented 112 calls) are removed: calls are the engine's
//   pnpm hr:sync --dry-run    show what would be sent
//
// The workflow itself (trigger + decision node) is created once in the HappyRobot UI; this only
// rewrites the decision node's prompt, input and json_schema.
import { parseArgs } from "node:util";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { HR_SCHEMA as COORDINATOR_SCHEMA, SYSTEM_PROMPT as COORDINATOR_PROMPT } from "../src/coordinators/protocol";
import { DREAM_HR_SCHEMA, DREAM_PROMPT } from "../src/memory/dream-protocol";
import { MASTER_PROMPT, MASTER_SCHEMA } from "../src/masters/protocol";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, dream: { type: "boolean", default: false }, master: { type: "boolean", default: false } } });
const SYSTEM_PROMPT = values.master ? MASTER_PROMPT : values.dream ? DREAM_PROMPT : COORDINATOR_PROMPT;
const HR_SCHEMA = values.master ? MASTER_SCHEMA : values.dream ? DREAM_HR_SCHEMA : COORDINATOR_SCHEMA;
const which = values.master ? "MASTER_" : values.dream ? "DREAM_" : "";

const apiKey = process.env.HAPPYROBOT_API_KEY;
const workflowId = process.env[`HAPPYROBOT_${which}WORKFLOW_ID`];
const nodeId = process.env[`HAPPYROBOT_${which}NODE_ID`];
if (!apiKey || !workflowId || !nodeId) {
  console.error(`Set HAPPYROBOT_API_KEY, HAPPYROBOT_${which}WORKFLOW_ID and HAPPYROBOT_${which}NODE_ID (see .env.example).`);
  process.exit(1);
}

/** The platform stores prose as Slate paragraphs, one per line. */
const paragraphs = (text: string) => text.split("\n").map((line) => ({ type: "paragraph", children: [{ text: line }] }));

const client = new HappyRobotClient({ apiKey, cluster: (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });

const workflow = await client.workflows.get(workflowId);
// The SDK ships its node types as unresolved zod inferences, so pin down the fields we use.
type NodeRow = { id: string; name: string; persistent_id: string; parent_id: string | null; event_id: string };
let all: NodeRow[] = [];
async function nodesOf(version: string) {
  const { data: nodes } = (await client.nodes.list(version)) as { data: NodeRow[] };
  all = nodes;
  const trigger = nodes.find((n) => n.parent_id === null);
  const node = nodes.find((n) => n.persistent_id === nodeId);
  if (!trigger || !node) throw new Error(`workflow ${workflowId} has no trigger, or no node with persistent_id ${nodeId}`);
  return { trigger, node };
}
let versionId = workflow.latest_version.id;
let { trigger, node } = await nodesOf(versionId);

// The briefing arrives as the trigger's `data` field; the node reads it as a variable reference.
const input = [
  {
    type: "paragraph",
    children: [
      { text: "" },
      { type: "variable", children: [{ text: "" }], group_id: trigger.persistent_id, variable_id: "data" },
      { text: "" },
    ],
  },
];

const configuration = {
  // The master's input spells out the trigger's fields one by one: it is the workflow's own, not ours to rewrite.
  ...(values.master ? {} : { input }),
  prompt: paragraphs(SYSTEM_PROMPT),
  json_schema: paragraphs(JSON.stringify(HR_SCHEMA, null, 2)),
};

if (values["dry-run"]) {
  console.log(`workflow "${workflow.name}" version ${workflow.latest_version.name}, node "${node.name}"`);
  console.log(`prompt: ${SYSTEM_PROMPT.split("\n").length} lines, schema: ${JSON.stringify(HR_SCHEMA).length} chars`);
  if (values.master) console.log(`would remove: ${below(node).map((n) => n.name).join(", ") || "nothing"}`);
  process.exit(0);
}

/** Everything that hangs from the decision node, deepest first. */
function below(parent: NodeRow): NodeRow[] {
  return all.filter((n) => n.parent_id === parent.id).flatMap((child) => [...below(child), child]);
}

// `type` is the body's discriminator and `event_id` pins which action this node runs; both are required.
const push = async () => {
  if (values.master) for (const orphan of below(node)) await client.nodes.delete(versionId, orphan.id);
  // The API wants the whole configuration back: keep what the node already has (its input, its model) under ours.
  const current = (await client.nodes.get(versionId, node.id)) as { configuration?: Record<string, unknown>; data?: { configuration?: Record<string, unknown> } };
  const kept = values.master ? (current.configuration ?? current.data?.configuration ?? {}) : {};
  await client.nodes.update(versionId, node.id, { type: "action", event_id: node.event_id, configuration: { ...kept, ...configuration } });
};
try {
  await push();
} catch (error) {
  // A published version is locked: the change goes into a fork of it, which then becomes the published one.
  if (!String((error as Error).message).includes("locked version")) throw error;
  const fork = (await client.versions.fork(versionId)) as { id?: string; version?: { id: string }; data?: { id: string } };
  versionId = fork.id ?? fork.version?.id ?? fork.data?.id ?? (await client.workflows.get(workflowId)).latest_version.id;
  ({ trigger, node } = await nodesOf(versionId));
  console.log(`"${workflow.latest_version.name}" is locked: forked it into version ${versionId}.`);
  await push();
}
// `force` takes the live slot from whichever version holds it (the locked one we forked from).
await client.versions.publish(versionId, { force: true } as Parameters<typeof client.versions.publish>[1]);
console.log(`Synced prompt + schema into "${workflow.name}" / "${node.name}" and published.`);
