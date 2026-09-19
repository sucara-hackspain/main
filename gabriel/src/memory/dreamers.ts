import { spawn } from "node:child_process";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { triggerAndWaitForNodeOutput } from "@happyrobot-ai/sdk/helpers";
import { DREAM_PROMPT, DREAM_SCHEMA, readDreamOutput, type DreamOutput } from "./dream-protocol";

export interface Dreamer {
  readonly name: string;
  dream(input: string): Promise<DreamOutput>;
}

/** The dream runs as its own HappyRobot workflow: one run per session, no hurry. */
export class HappyRobotDreamer implements Dreamer {
  readonly name = "happyrobot";
  constructor(
    private readonly workflowId: string,
    private readonly nodeId: string,
    private readonly timeoutMs = 300_000,
  ) {}

  async dream(input: string): Promise<DreamOutput> {
    const apiKey = process.env.HAPPYROBOT_API_KEY;
    if (!apiKey) throw new Error("HAPPYROBOT_API_KEY is not set");
    const client = new HappyRobotClient({ apiKey, cluster: (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
    const result = await triggerAndWaitForNodeOutput(client, {
      workflowId: this.workflowId,
      nodePersistentId: this.nodeId,
      payload: { data: input },
      timeoutMs: this.timeoutMs,
      pollIntervalMs: 1000,
    });
    if (!result.ok) throw new Error(`dream run ${result.runId} ended as "${result.status}" without node output`);
    return readDreamOutput(result.nodeOutput);
  }
}

/** Stand-in while the dream workflow does not exist yet, or when the platform is down. */
export class ClaudeDreamer implements Dreamer {
  readonly name: string;
  constructor(
    private readonly model = "sonnet",
    private readonly timeoutMs = 300_000,
  ) {
    this.name = `claude-cli:${model}`;
  }

  dream(input: string): Promise<DreamOutput> {
    const args = ["-p", "--model", this.model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands", "--system-prompt", DREAM_PROMPT, "--output-format", "json", "--json-schema", JSON.stringify(DREAM_SCHEMA)];
    const { CLAUDECODE: _nested, ...env } = process.env;
    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => (clearTimeout(timer), reject(err)));
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout);
          if (code !== 0 || parsed.is_error || !parsed.structured_output) throw new Error(String(parsed.result ?? stderr).slice(0, 300));
          resolve(readDreamOutput(parsed.structured_output));
        } catch (err) {
          reject(new Error(`claude exit ${code}: ${err instanceof Error ? err.message : err}`));
        }
      });
      child.stdin.end(input);
    });
  }
}

/** HappyRobot if its dream workflow is configured, otherwise Claude. */
export function pickDreamers(): Dreamer[] {
  const { HAPPYROBOT_DREAM_WORKFLOW_ID: workflowId, HAPPYROBOT_DREAM_NODE_ID: nodeId } = process.env;
  const dreamers: Dreamer[] = [];
  if (workflowId && nodeId) dreamers.push(new HappyRobotDreamer(workflowId, nodeId));
  dreamers.push(new ClaudeDreamer());
  return dreamers;
}
