// Labels of what can happen to people, as the UI shows them.
import type { InjuryKind, SceneKind } from "./types";

export const SCENES: Record<SceneKind, { label: string }> = {
  vehicle_trapped: { label: "vehículo atrapado por el agua" },
  flooded_home: { label: "planta baja inundada" },
  swept_away: { label: "persona arrastrada por el agua" },
  building_collapse: { label: "derrumbe" },
  collapse: { label: "persona desplomada" },
  fall: { label: "caída" },
  traffic: { label: "accidente de tráfico" },
};

export const INJURIES: Record<InjuryKind, { label: string }> = {
  cardiac_arrest: { label: "parada cardiaca" },
  drowning: { label: "ahogamiento" },
  hemorrhage: { label: "hemorragia grave" },
  respiratory: { label: "insuficiencia respiratoria" },
  polytrauma: { label: "politraumatismo" },
  hypothermia: { label: "hipotermia" },
  fracture: { label: "fractura" },
  minor: { label: "herida leve" },
};
