// The doctrine the agent starts with. From here on the memory only changes through what sessions teach:
// every later edit is made by the dream, with evidence attached.

export type RuleKind = "driver" | "heuristic" | "antipattern";

export interface SeedRule {
  id: string;
  kind: RuleKind;
  title: string;
  body: string;
  /** Concept ids this rule is about: what lets the memory be browsed as a graph. */
  about: string[];
}

export const CONCEPTS: Record<string, string> = {
  priority: "Prioridad y triaje",
  calls: "Llamadas al 112",
  uncertainty: "Información dudosa",
  crew_report: "Dotación en el lugar",
  ambulance: "Ambulancias",
  fire: "Bomberos",
  rescue: "Rescate acuático",
  helicopter: "Helicóptero",
  drone: "Drones y reconocimiento",
  silence: "Zonas en silencio",
  trapped: "Víctimas atrapadas",
  minor: "Heridos leves",
  water: "Agua e inundación",
  cut_off: "Aislamiento por carretera",
  fleet: "Protección de la flota",
  hospitals: "Hospitales y camas",
  la_fe: "Hospital La Fe",
  diversion: "Desvíos y reasignaciones",
  waiting: "Esperas",
};

export const SEED_RULES: SeedRule[] = [
  // Drivers: what weighs more when not everything fits.
  { id: "D1", kind: "driver", title: "Vida en riesgo inmediato primero", body: "\"No respira\" o \"no responde\" es P0 aunque lo diga un solo testigo. Mejor sobretriaje que perder una parada o un ahogamiento.", about: ["priority", "uncertainty"] },
  { id: "D2", kind: "driver", title: "Lo que el agua va a aislar va antes", body: "A igual prioridad, atiende primero el incidente que el agua va a dejar sin acceso: después ya no se podrá.", about: ["water", "cut_off", "priority"] },
  { id: "D3", kind: "driver", title: "Decide por tiempo real, no por cercanía", body: "Elige la unidad por su ETA del parte, no por lo cerca que parezca.", about: ["priority"] },
  { id: "D4", kind: "driver", title: "Lo escaso, solo donde nadie más llega", body: "Helicóptero y rescate acuático se reservan para lo que una ambulancia no puede resolver.", about: ["helicopter", "rescue"] },
  { id: "D6", kind: "driver", title: "Si te falta información, ve a buscarla", body: "Decidir a ciegas es una elección, no una fatalidad: un dron es barato y no le quita una unidad a nadie. Pero mirar no salva a nadie por sí solo: sirve para que la siguiente orden sea la buena, no para retrasarla.", about: ["drone", "uncertainty"] },
  { id: "D5", kind: "driver", title: "Proteger la flota y no olvidar a nadie", body: "Una unidad perdida son muchas víctimas futuras. Y nadie espera para siempre: un P3 con más de 40 minutos abierto sube de prioridad.", about: ["fleet", "waiting"] },

  // Doubtful information.
  { id: "H1", kind: "heuristic", title: "Llamada vaga: una unidad a confirmar", body: "Con una sola llamada imprecisa (conductor que pasaba, ±400 m, sin señales) manda una unidad a confirmar; los refuerzos, tras el triaje en el lugar.", about: ["calls", "uncertainty"] },
  { id: "H2", kind: "heuristic", title: "Varias llamadas con varios heridos: dos unidades de entrada", body: "Si varias llamadas coinciden y hablan de 2 o más heridos, manda dos unidades que trasladen desde el principio.", about: ["calls"] },
  { id: "H3", kind: "heuristic", title: "Una rellamada sin unidad asignada sube la prioridad", body: "Si vuelven a llamar por un incidente al que nadie va, trátalo un nivel por encima de lo que marca el parte.", about: ["calls", "waiting", "priority"] },
  { id: "H4", kind: "heuristic", title: "La dotación en el lugar manda sobre las llamadas", body: "Cuando una dotación confirma víctimas y triaje, replanifica el incidente entero con ese dato: unidades, hospital y prioridad.", about: ["crew_report", "uncertainty"] },

  // Units.
  { id: "H5", kind: "heuristic", title: "Atrapado: bomberos a la vez que la ambulancia", body: "Si se reporta alguien atrapado, manda bomberos (o rescate) al mismo tiempo que la ambulancia, no después.", about: ["trapped", "fire", "ambulance"] },
  { id: "H6", kind: "heuristic", title: "Sin ruta por carretera: solo rescate o helicóptero", body: "A un incidente marcado sin ruta por carretera no se le vuelve a mandar ambulancia ni bomberos.", about: ["cut_off", "rescue", "helicopter"] },
  { id: "H7", kind: "heuristic", title: "Helicóptero: solo lo grave y lejano, y a helipuerto", body: "Úsalo para P0/P1 con ETA terrestre de más de 12 ticks o en sitios aislados, y siempre con un hospital con helipuerto como destino.", about: ["helicopter", "hospitals"] },
  { id: "H8", kind: "heuristic", title: "Leves confirmados: una sola dotación", body: "Para heridos leves confirmados basta una dotación, y los bomberos valen. No gastes ambulancias.", about: ["minor", "fire", "ambulance"] },
  { id: "H9", kind: "heuristic", title: "No desvíes a quien está a punto de llegar", body: "No desvíes una unidad a menos de 3 ticks de su destino salvo para un P0.", about: ["diversion"] },

  // Going to look, and reading silence.
  { id: "H14", kind: "heuristic", title: "Antes de gastar media flota a ciegas, manda el dron", body: "Con ubicación de ±300 m o más y número de heridos desconocido, manda primero un dron y ajusta con lo que traiga: evita mandar dos ambulancias a un cruce vacío.", about: ["drone", "uncertainty", "calls"] },
  { id: "H15", kind: "heuristic", title: "El silencio de un barrio es un aviso, no una buena noticia", body: "Una zona que llamaba y ha dejado de llamar, o a la que llega el agua sin que nadie llame, es el sitio más probable donde hay gente que nadie ha contado: sin cobertura, sin batería o sin nadie consciente. Mándale un dron.", about: ["silence", "drone", "water"] },
  { id: "H16", kind: "heuristic", title: "Un dron informa, no confirma", body: "Lo que ve es aproximado y lo de dentro de las casas casi no lo ve. Que no vea a nadie NO cierra un incidente: solo una dotación en el lugar confirma. Lo que sí puedes creerle es el agua y las calles cortadas.", about: ["drone", "uncertainty", "crew_report"] },

  // Water and hospitals.
  { id: "H10", kind: "heuristic", title: "No entres donde el agua cierra la salida", body: "No mandes unidades de carretera a un sitio que el agua aísla en menos de su ETA + 8 ticks, y saca con reposition las que estén paradas en zonas en riesgo.", about: ["water", "cut_off", "fleet"] },
  { id: "H11", kind: "heuristic", title: "El agua real va por delante de lo que sabes", body: "Un parte oficial viejo significa un frente más avanzado (edad del parte por velocidad). Los ETA hacia zonas con avistamientos recientes son optimistas.", about: ["water", "uncertainty"] },
  { id: "H12", kind: "heuristic", title: "Reparte entre hospitales", body: "No mandes a un hospital al que le quedan 2 camas o menos si hay otro a 3 ticks más como mucho.", about: ["hospitals"] },
  { id: "H13", kind: "heuristic", title: "Espera a la mejor unidad si compensa", body: "Si la unidad que antes llegaría está a punto de quedar libre, espérala cuando ahorra más de 4 ticks y el incidente no es P0.", about: ["waiting", "diversion"] },

  // Anti-patterns: mistakes already seen.
  { id: "A1", kind: "antipattern", title: "Ambulancia sola a un atrapado", body: "Llega, no puede cargarlo y se pierde el viaje.", about: ["trapped", "ambulance"] },
  { id: "A2", kind: "antipattern", title: "Dos unidades al mismo leve", body: "La segunda llega y no tiene nada que hacer.", about: ["minor"] },
  { id: "A3", kind: "antipattern", title: "Saturar La Fe por ser la más cercana al agua", body: "Se queda sin camas y empieza a rechazar ambulancias con el herido dentro.", about: ["la_fe", "hospitals"] },
  { id: "A4", kind: "antipattern", title: "Unidades aparcadas al sur del nuevo cauce", body: "Cuando el agua cubre los puentes quedan fuera de juego.", about: ["fleet", "water", "cut_off"] },
  { id: "A5", kind: "antipattern", title: "Dar por vacía una zona porque el dron no vio nada", body: "Una pasada de calidad baja no ve a la gente dentro de las casas; se descarta el barrio y se muere ahí.", about: ["drone", "silence", "uncertainty"] },
  { id: "A6", kind: "antipattern", title: "Drones parados mientras hay huecos en el parte", body: "No pueden rescatar a nadie: si no están mirando, no sirven para nada.", about: ["drone"] },
];
