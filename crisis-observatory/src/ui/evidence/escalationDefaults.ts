export const escalationKinds = {
  stranded: "Unidad bloqueada", unassigned: "Incidencia sin atender",
  loaded: "Traslado sin destino", unreachable: "Zona inaccesible",
  cutoff: "Riesgo de aislamiento", surge: "Saturación de recursos",
  water: "Zonas aisladas sin rescate", not_found: "Aviso sin confirmar",
  fallback: "Agente no disponible", rejected: "Orden rechazada", custom: "Otra condición",
} as const;
export type Policy = {
  id: string; title: string; body: string; kind: keyof typeof escalationKinds;
  severity: "critical" | "warning"; deleted?: boolean; updatedAt?: string;
};
// Drafts based on current intervention triggers, not inferred coordination doctrine.
export const ESCALATION_DEFAULTS: Policy[] = [
  { id: "ESC-01", kind: "stranded", severity: "critical", title: "Unidad bloqueada durante una intervención",
    body: "Solicitar una decisión humana cuando una unidad quede sin ruta conocida y tenga una víctima a bordo o se dirija a una incidencia abierta." },
  { id: "ESC-02", kind: "unassigned", severity: "critical", title: "Incidencia urgente sin unidad asignada",
    body: "Escalar si una incidencia P0 o P1 permanece sin una dotación trabajando en ella durante tres registros consecutivos, pese a existir unidades libres." },
  { id: "ESC-03", kind: "loaded", severity: "critical", title: "Víctima a bordo sin hospital de destino",
    body: "Escalar cuando una unidad con una víctima a bordo esté sin misión de traslado durante dos registros consecutivos, sin estar averiada ni bloqueada." },
  { id: "ESC-04", kind: "surge", severity: "critical", title: "Demanda urgente superior a los recursos disponibles",
    body: "Pedir una decisión humana cuando dos o más incidencias P0 o P1 estén sin atender y no haya unidades libres durante tres registros consecutivos." },
  { id: "ESC-05", kind: "fallback", severity: "warning", title: "El agente deja de estar disponible",
    body: "Escalar cuando el coordinador recurra al sistema de reglas de respaldo por un fallo de la IA. Mostrar el error registrado para que el operador revise la continuidad de la respuesta." },
  { id: "ESC-06", kind: "rejected", severity: "warning", title: "Una orden no puede ejecutarse",
    body: "Solicitar revisión humana cuando el motor rechace una orden. Presentar la acción propuesta, la unidad afectada y el motivo del rechazo." },
];
