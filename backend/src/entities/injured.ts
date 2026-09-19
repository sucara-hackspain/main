import type { NodeId } from "../map/graph.js";
import type { Call } from "../triage.js";

export type InjuredId = string;

export type Injured = {
  id: InjuredId;
  position: NodeId;
  ttl: number; // turnos de vida restantes
  call?: Call; // la llamada al 112 por la que entró (real o simulada); sin ella, lo puso el Master o la CLI
};

export const createInjured = (id: InjuredId, position: NodeId, ttl: number): Injured => ({ id, position, ttl });
export const tick = (h: Injured) => void h.ttl--;
export const isDead = (h: Injured) => h.ttl <= 0;
