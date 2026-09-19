export type CallDraft = {
  location: string;
  people: string;
  situation: string;
  priority: string;
  notes: string;
};

export type TranscriptTurn = {
  id: string;
  speaker: "operator" | "caller";
  start: number;
  end: number;
  text: string;
};

// A scripted preview, deliberately independent of operational run data.
// A future transcription provider can supply the same speaker/turn boundaries.
export const demoTurns: TranscriptTurn[] = [
  { id: "opening", speaker: "operator", start: 0, end: 5, text: "Emergencias 112. ¿Qué está ocurriendo?" },
  { id: "location", speaker: "caller", start: 6, end: 18, text: "Está entrando mucha agua en nuestro edificio. Estamos en la calle San Vicente Mártir, número 171, en València." },
  { id: "question-people", speaker: "operator", start: 19, end: 23, text: "¿Cuántas personas hay con usted?" },
  { id: "people", speaker: "caller", start: 24, end: 35, text: "Somos tres vecinos en el portal. Una de las personas tiene movilidad reducida y no puede subir las escaleras." },
  { id: "question-water", speaker: "operator", start: 36, end: 41, text: "Entendido. ¿Hasta dónde llega el agua ahora?" },
  { id: "situation", speaker: "caller", start: 42, end: 56, text: "Nos llega por las rodillas y sigue subiendo. La puerta del portal está bloqueada, no podemos salir por ahí." },
  { id: "question-access", speaker: "operator", start: 57, end: 64, text: "Estoy anotando la información. ¿Hay algún otro acceso al edificio?" },
  { id: "access", speaker: "caller", start: 65, end: 76, text: "Sí, hay una entrada por el patio de atrás. Se accede desde la calle de al lado." },
  { id: "closing", speaker: "operator", start: 77, end: 84, text: "Recibido. Queda anotado el acceso por el patio trasero, pendiente de confirmar la calle exacta." },
];

export const DEMO_START = 49;
export const DEMO_END = 88;
export const DRAFT_STORAGE_KEY = "alerta.call-intake.demo-draft.v1";

export function callTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function visibleTurns(seconds: number) {
  return demoTurns.filter((turn) => seconds >= turn.start).map((turn) => {
    const complete = seconds >= turn.end;
    const words = turn.text.split(" ");
    const count = Math.max(1, Math.floor(words.length * (seconds - turn.start) / (turn.end - turn.start)));
    return { ...turn, complete, text: complete ? turn.text : words.slice(0, count).join(" ") };
  });
}

export function suggestedDraft(seconds: number): CallDraft {
  return {
    location: seconds >= 18 ? "C/ San Vicente Mártir, 171 · València" : "",
    people: seconds >= 35 ? "3 personas · una con movilidad reducida" : "",
    situation: seconds >= 56 ? "Agua a la altura de las rodillas y en aumento. Puerta del portal bloqueada." : "",
    priority: "Por valorar",
    notes: "",
  };
}

export function readDraft(): { draft: CallDraft; savedAt: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || "null");
    const keys: (keyof CallDraft)[] = ["location", "people", "situation", "priority", "notes"];
    if (saved?.version !== 1 || !saved.draft || !keys.every((key) => typeof saved.draft[key] === "string")) return null;
    if (!["Por valorar", "Alta", "Media", "Baja"].includes(saved.draft.priority)) return null;
    if (typeof saved.savedAt !== "string" || !Number.isFinite(Date.parse(saved.savedAt))) return null;
    return { draft: saved.draft, savedAt: saved.savedAt };
  } catch {
    return null;
  }
}
