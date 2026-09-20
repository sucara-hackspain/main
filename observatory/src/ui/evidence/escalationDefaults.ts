import { DEFAULT_ESCALATION, ESCALATION_KINDS, type EscalationKind, type EscalationPolicy } from "../engineTrace";

// The catalogue lives with the engine (policies/escalation.json): what is written here is what
// the escalation desk applies, run after run. This module only puts the engine's vocabulary in words.

export const escalationKinds: Record<EscalationKind, string> = {
  stranded: "Unidad bloqueada", unassigned: "Incidencia sin atender", loaded: "Traslado sin destino",
  unreachable: "Zona inaccesible", cutoff: "Riesgo de aislamiento", surge: "Saturación de recursos",
  water: "Zonas aisladas sin rescate", not_found: "Aviso sin confirmar", fallback: "Agente no disponible",
  rejected: "Orden rechazada",
};
/** The numbers the desk applies for each kind, in the words of the form that edits them. */
export const thresholdLabels = {
  afterTicks: "Registros que debe durar antes de escalar",
  withinTicks: "Escalar cuando el agua deje menos de estos registros de acceso",
  minIncidents: "Incidencias urgentes sin atender para considerarlo saturación",
} as const;
export const thresholdsFor: Record<EscalationKind, (keyof typeof thresholdLabels)[]> = {
  stranded: [], unassigned: ["afterTicks"], loaded: ["afterTicks"], surge: ["afterTicks", "minIncidents"],
  unreachable: ["afterTicks"], cutoff: ["afterTicks", "withinTicks"], water: ["afterTicks"],
  not_found: [], fallback: [], rejected: [],
};

export type Policy = EscalationPolicy;
export { ESCALATION_KINDS, DEFAULT_ESCALATION };
export const isKind = (value: string): value is EscalationKind => (ESCALATION_KINDS as readonly string[]).includes(value);
