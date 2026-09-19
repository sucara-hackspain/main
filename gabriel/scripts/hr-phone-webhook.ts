// Points the 112 voice workflow at this machine, so that a call phoned in lands in the running session
// the moment it ends:
//
//   ngrok http 8112                                  (or any tunnel to the session's --phone-port)
//   pnpm hr:phone https://xxxx.ngrok-free.app        sets the URL of the workflow's POST node and publishes
//
// The tunnel's address changes every time it restarts: run this again when it does.
import { HappyRobotClient } from "@happyrobot-ai/sdk";

const base = process.argv[2];
const apiKey = process.env.HAPPYROBOT_API_KEY;
const workflowId = process.env.HAPPYROBOT_PHONE_WORKFLOW_ID;
if (!base?.startsWith("http") || !apiKey || !workflowId) {
  console.error("Usage: pnpm hr:phone <public url of the tunnel>   (needs HAPPYROBOT_API_KEY and HAPPYROBOT_PHONE_WORKFLOW_ID)");
  process.exit(1);
}
const url = `${base.replace(/\/+$/, "")}/phone`;
const client = new HappyRobotClient({ apiKey, cluster: (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });

/** What the node posts when nothing else is configured: the call record filed by `Build Call Object`. */
const DEFAULTS = {
  body: { raw: `{{$var:${process.env.HAPPYROBOT_PHONE_NODE_ID}.response}}`, contentType: "application/json", schemaVersion: 2 },
  params: [], headers: [], authType: "none", ignore5XX: false, contentType: "application/json", xssProtection: true, responseHeaders: [], webhookSchemaVersion: 2,
};

type NodeRow = { id: string; name: string; event_id: string; configuration?: Record<string, unknown> };
const workflow = await client.workflows.get(workflowId);
let versionId = workflow.latest_version.id;
const postNode = async () => {
  const { data: nodes } = (await client.nodes.list(versionId)) as { data: NodeRow[] };
  const node = nodes.find((n) => n.name === "POST");
  if (!node) throw new Error(`workflow ${workflowId} has no node called "POST"`);
  return node;
};
const push = async () => {
  const node = await postNode();
  // The API answers under `data`, and wants the whole configuration back: sending only the URL wipes the body.
  const current = (await client.nodes.get(versionId, node.id)) as unknown as { data?: NodeRow } & NodeRow;
  const kept = current.data?.configuration ?? current.configuration;
  if (!kept) throw new Error("could not read the POST node's configuration: refusing to overwrite it");
  await client.nodes.update(versionId, node.id, {
    type: "action",
    event_id: node.event_id,
    configuration: { ...DEFAULTS, ...kept, body: kept.body ?? DEFAULTS.body, url: [{ type: "paragraph", children: [{ text: url }] }] },
  } as never);
};
try {
  await push();
} catch (error) {
  if (!String((error as Error).message).includes("locked version")) throw error;
  await client.versions.fork(versionId);
  versionId = (await client.workflows.get(workflowId)).latest_version.id;
  console.log(`"${workflow.latest_version.name}" is locked: forked it.`);
  await push();
}
await client.versions.publish(versionId, { force: true } as never);
console.log(`The 112 workflow "${workflow.name}" now posts every finished call to ${url} and is published.`);
