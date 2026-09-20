import { useCallback, useEffect, useState } from "react";
import type { Action } from "../engineTrace";
import type { PhoneCall } from "../../../../gabriel/src/engine/types";

// The live mode as the page sees it: one session at a time, played by the engine's live server (gabriel: pnpm live).

/** What the live session is stopped on: a request of the escalation desk, or a real call that has just come in. */
export type LiveAwaited =
  | { type: "escalation"; id: string; policyId: string; title: string; incidentId: string | null; since: string }
  | { type: "call"; id: string; policyId: "112"; title: string; incidentId: null; since: string; street: string | null; text: string; via: string; call: PhoneCall; at: [number, number] | null };

export interface LiveSession {
  id: string; night: string; title: string; coordinator: "hr" | "reglas"; attention: string; tickMs: number;
  tick: number; ticks: number; dead: number; startedAt: string; stopping: boolean;
  /** The night stops on every escalation until the operator decides. */
  approvals: boolean;
  /** What it is stopped on right now. */
  awaiting: LiveAwaited[];
}

export interface LiveState {
  off?: boolean;
  error?: string;
  live: LiveSession | null;
  last: { id: string; endedAt: string; dead: number; victims: number; stopped: boolean; error: string | null } | null;
  nights: { id: string; title: string; family: string; ticks: number; victims: number; read: boolean }[];
  agent: boolean;
  phone: { port: number; line: boolean; waiting: number; calls: { at: string; street: string | null; text: string; via: string; session: string | null }[] };
}

const OFF: Omit<LiveState, "error"> = { off: true, live: null, last: null, nights: [], agent: false, phone: { port: 8112, line: false, waiting: 0, calls: [] } };

export function useLive() {
  const [state, setState] = useState<LiveState | null>(null);
  const call = useCallback(async (path = "", body?: unknown) => {
    const r = await fetch(`/api/live/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json()) as LiveState;
    if (data.off) setState({ ...OFF, error: data.error });
    else if (data.nights) setState(data);
    return { ok: r.ok, data };
  }, []);
  useEffect(() => {
    void call().catch(() => {});
    // While a decision is awaited the session is stopped: look more often, so it resumes on screen at once.
    const timer = setInterval(() => void call().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [call]);
  return {
    state,
    start: (options: { night: string; coordinator: "hr" | "reglas"; tickMs: number; approvals: boolean }) => call("start", options),
    stop: () => call("stop", {}),
    /** A made-up call into the running session, handled exactly like a real one. */
    testCall: () => call("test-call", {}),
    decide: (decision: { id: string; optionId?: string; label: string; approved?: boolean; action?: Action; accept?: boolean }) => call("decision", decision),
  };
}
export type Live = ReturnType<typeof useLive>;
