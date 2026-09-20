DOCTRINA Y MEMORIA (lo aprendido en sesiones anteriores; en cada orden cita en `applies` los ids que has seguido):

Qué pesa más cuando no cabe todo:
- D4 · Lo escaso, para donde la ambulancia no llega: Helicóptero y rescate acuático son para lo que una ambulancia no puede resolver: atrapados por agua, vehículos anegados, plantas bajas inundadas. Ahí no se reservan: si hay uno libre y una víctima grave sin acceso, mándalo ya.
- D1 · Vida en riesgo inmediato primero: "No respira" o "no responde" es P0 aunque lo diga un solo testigo. Mejor sobretriaje que perder una parada o un ahogamiento.
- D2 · Lo que el agua va a aislar va antes: A igual prioridad, atiende primero el incidente que el agua va a dejar sin acceso: después ya no se podrá.
- D3 · Decide por tiempo real, no por cercanía: Elige la unidad por su ETA del parte, no por lo cerca que parezca.
- D5 · Proteger la flota y no olvidar a nadie: Una unidad perdida son muchas víctimas futuras. Y nadie espera para siempre: un P3 con más de 40 minutos abierto sube de prioridad.
- D6 · Si te falta información, ve a buscarla: Decidir a ciegas es una elección, no una fatalidad: un dron es barato y no le quita una unidad a nadie. Pero mirar no salva a nadie por sí solo: sirve para que la siguiente orden sea la buena, no para retrasarla.

Heurísticas:
- H15 · El silencio de un barrio es un aviso, no una buena noticia: Una zona que llamaba y ha dejado de llamar, o a la que llega el agua sin que nadie llame, es el sitio más probable donde hay gente que nadie ha contado: sin cobertura, sin batería o sin nadie consciente. Mándale un dron.
- H17 · Víctima en agua: orden en 2 ticks: Si llama alguien atrapado en vehículo o planta baja inundada con signos vitales graves, da orden de rescate o bomberos más ambulancia en los 2 primeros ticks, aunque falte información. Esperar cuesta la vida y el agua sube.
- H10 · No entres donde el agua cierra la salida: No mandes unidades de carretera a un sitio que el agua aísla en menos de ETA + 12 ticks (el parte suele ir por detrás), y saca con reposition las paradas en zonas en riesgo.
- H11 · El agua real va por delante de lo que sabes: Un parte oficial viejo significa un frente más avanzado (edad del parte por velocidad). Los ETA hacia zonas con avistamientos recientes son optimistas.
- H19 · Al cargar a uno, reasigna a los que quedan: Si una unidad se lleva a un herido y en el sitio quedan otros esperando, manda otra unidad en ese mismo turno. Si no, quien queda espera hasta morir.
- H5 · Atrapado: bomberos o rescate antes que ambulancia sola: Un atrapado necesita bomberos o rescate que lo liberen: mándalos en la misma orden que la ambulancia. Ambulancia o helicóptero solos llegan y no cargan. Sin bomberos libres, no envíes la ambulancia sola.
- H1 · Llamada vaga: una unidad a confirmar: Con una sola llamada imprecisa (conductor que pasaba, ±400 m, sin señales) manda una unidad a confirmar; los refuerzos, tras el triaje en el lugar.
- H12 · Reparte entre hospitales: No mandes a un hospital al que le quedan 2 camas o menos si hay otro a 3 ticks más como mucho.
- H13 · Espera a la mejor unidad si compensa: Si la unidad que antes llegaría está a punto de quedar libre, espérala cuando ahorra más de 4 ticks y el incidente no es P0.
- H14 · Antes de gastar media flota a ciegas, manda el dron: Con ubicación de ±300 m o más y número de heridos desconocido, manda primero un dron y ajusta con lo que traiga: evita mandar dos ambulancias a un cruce vacío.
- H16 · Un dron informa, no confirma: Lo que ve es aproximado y lo de dentro de las casas casi no lo ve. Que no vea a nadie NO cierra un incidente: solo una dotación en el lugar confirma. Lo que sí puedes creerle es el agua y las calles cortadas.
- H2 · Varios heridos: dos unidades, salvo agua que aísla: Si varias llamadas coinciden y hablan de 2 o más heridos, manda dos unidades que trasladen. Si el agua puede aislar el sitio, manda solo una, con rescate: dos viajes perdidos cuestan el doble.
- H20 · Ambulancia y rescate deben llegar a la vez: Al mandar ambulancia a un atrapado, compara ETAs: si llega más de 3 ticks antes que rescate o bomberos, retrasa su salida. Una ambulancia esperando en el lugar es un viaje perdido.
- H3 · Una rellamada sin unidad asignada sube la prioridad: Si vuelven a llamar por un incidente al que nadie va, trátalo un nivel por encima de lo que marca el parte.
- H4 · La dotación en el lugar manda sobre las llamadas: Cuando una dotación confirma víctimas y triaje, replanifica el incidente entero con ese dato: unidades, hospital y prioridad.
- H6 · Sin ruta por carretera: solo rescate o helicóptero: A un incidente marcado sin ruta por carretera no se le vuelve a mandar ambulancia ni bomberos.
- H7 · Helicóptero: grave y lejano o aislado, a helipuerto: Úsalo para P0/P1 no atrapados con ETA terrestre mayor de 12 ticks o aislados por el agua, con destino a hospital con helipuerto. Si el herido está atrapado, no llega solo: exige antes bomberos o rescate en el lugar.
- H8 · Leves confirmados: una sola dotación: Para heridos leves confirmados basta una dotación, y los bomberos valen. No gastes ambulancias.
- H9 · No desvíes a quien está a punto de llegar: No desvíes una unidad a menos de 3 ticks de su destino salvo para un P0.
- H18 (EN PRUEBA) · Cada respuesta cubre todos los incidentes abiertos: Las respuestas son escasas y sin orden nadie sale: en cada una despacha todos los incidentes abiertos sin unidad, agua y atrapados primero, aunque falte información. Con unidades libres, ninguno espera más de 2 ticks. Repasa la lista.

Errores ya cometidos que no debes repetir:
- A1 · Ambulancia sola a un atrapado: Llega, no puede cargarlo y se pierde el viaje.
- A2 · Dos unidades al mismo leve: La segunda llega y no tiene nada que hacer.

---
31 reglas activas, 2 en prueba, tras 6 sesiones. Generado desde memory/memory.db: no editar a mano.
