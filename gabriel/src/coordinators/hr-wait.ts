import type { HappyRobotClient } from "@happyrobot-ai/sdk";

// The SDK's own helper polls twice per round, every round, per run. One session never notices; a dozen games at once
// hit the organization's API rate limit and every decision falls back to rules. This waits the same way, but all the
// runs of the process share one paced queue of requests, and a "rate limit exceeded" is waited out instead of
// failing the decision.

const NODE_READY = new Set(["completed", "succeeded"]);
const NODE_FAILED = new Set(["failed", "canceled", "skipped"]);
const RUN_TERMINAL = new Set(["completed", "succeeded", "failed", "canceled", "skipped"]);

// Measured: the organization gets about 10 requests per second; above that the rest are refused.
const SPACING_MS = 125;
const spacingMs = SPACING_MS;
let nextAt = 0;

/** How the shared queue is doing: for whoever wants to show why a batch of games is slow. */
export const pace = { requests: 0, rateLimited: 0, spacingMs: () => Math.round(spacingMs) };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRateLimit = (err: unknown) => /rate limit|429|too many/i.test(err instanceof Error ? err.message : String(err));

/** One request at a time through the shared pace; backs off and tries again when the platform says slow down. */
async function paced<T>(request: () => Promise<T>, deadline: number): Promise<T> {
  for (;;) {
    const at = Math.max(Date.now(), nextAt);
    nextAt = at + spacingMs;
    await sleep(at - Date.now());
    try {
      pace.requests++;
      const result = await request();
      return result;
    } catch (err) {
      if (!isRateLimit(err) || Date.now() > deadline) throw err;
      pace.rateLimited++;
      // Somebody else is using the quota too (a live session, a teammate): everyone holds for a moment.
      nextAt = Math.max(nextAt, Date.now() + 1000);
      await sleep(500 + Math.random() * 1000);
    }
  }
}

export interface WaitOptions {
  workflowId: string;
  nodePersistentId: string;
  payload: Record<string, unknown>;
  environment?: string;
  timeoutMs?: number;
  /** Nothing answers faster than this: no point asking before. */
  firstPollMs?: number;
  pollIntervalMs?: number;
}

export async function runAndReadNode(client: HappyRobotClient, options: WaitOptions): Promise<{ runId: string; nodeOutput: unknown }> {
  const { workflowId, nodePersistentId, payload, environment = "production", timeoutMs = 120_000, firstPollMs = 9000, pollIntervalMs = 4000 } = options;
  const deadline = Date.now() + timeoutMs;
  const triggered = (await paced(() => client.workflows.triggerRun(workflowId, { payload, environment } as never), deadline)) as { run_id?: string; queued_run_ids?: string[] };
  const runId = triggered.run_id ?? triggered.queued_run_ids?.[0];
  if (!runId) throw new Error("No run_id returned from trigger");

  await sleep(firstPollMs);
  let runEnded: string | null = null;
  for (let round = 0; Date.now() < deadline; round++) {
    const nodes = await paced(() => client.runs.listNodes(runId, { node_persistent_id: nodePersistentId, sort: "asc" } as never), deadline);
    const node = (nodes.data as { node_persistent_id: string; output_id?: string; status?: string }[]).filter((n) => n.node_persistent_id === nodePersistentId).at(-1);
    if (node?.output_id && node.status && NODE_READY.has(node.status)) {
      const output = await paced(() => client.runs.getOutput(runId, node.output_id!), deadline);
      return { runId, nodeOutput: output.data };
    }
    if (node?.status && NODE_FAILED.has(node.status)) throw new Error(`run ${runId}: node ended as "${node.status}"`);
    // The nodes were read after the run was seen finished, and the answer still is not there: it never will be.
    if (runEnded) throw new Error(`run ${runId} ended as "${runEnded}" without node output`);
    // The run's own status costs a request: only worth asking now and then, in case it died before reaching the node.
    if (round % 5 === 4) {
      const run = await paced(() => client.runs.get(runId), deadline);
      if (RUN_TERMINAL.has(run.status)) {
        runEnded = run.status;
        continue;
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`run ${runId} timed out after ${timeoutMs} ms`);
}
