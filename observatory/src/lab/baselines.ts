// What the learned doctrine has to beat: everything we wrote by hand before the lab existed.
import { SEED_RULES } from "../memory/seed";
import type { Doctrine } from "./doctrine";

/** The advice that used to sit in the coordinator's prompt under "CÓMO DECIDIR", before the lab took that job over. */
const FROM_THE_OLD_PROMPT = [
  { title: "Una unidad que confirme antes de mandar más", body: "Con pocos datos (una llamada vaga) puede bastar una unidad que confirme antes de mandar más." },
  { title: "Cuando todo no cabe, P0 y P1 antes", body: "P0 y P1 van antes aunque lleven menos tiempo abiertos. No dejes un P3 esperando para siempre." },
  { title: "No reasignes por reasignar", body: "Desvía una ambulancia solo si con ello se salva alguien más." },
  { title: "Esperar a la que está a punto de quedar libre", body: "Si la ambulancia que antes llegaría está a punto de quedar libre, puede compensar esperarla." },
  { title: "Reparte entre hospitales", body: "No satures un hospital si otro está casi igual de cerca." },
];

export const HAND_WRITTEN: Doctrine = {
  rules: [
    ...SEED_RULES.map(({ id, kind, title, body }) => ({ id, kind, title, body, since: 0 })),
    ...FROM_THE_OLD_PROMPT.map((rule, n) => ({ id: `P${n + 1}`, kind: "heuristic" as const, ...rule, since: 0 })),
  ],
};
