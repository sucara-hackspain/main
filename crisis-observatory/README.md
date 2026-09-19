# Alerta · Control Center

> **Formato soportado.** Control Center lee el modelo de unidades e incidentes del motor de `../gabriel/` (`frame.units`, `scenes`, `incidents`, `knownWater`, `knownClosedEdges`; eventos `call_*`, `scene_*`, `victim_*`, `unit_*`, `flood_*`). `src/ui/engineTrace.ts` reexporta sus tipos y reúne las etiquetas y los helpers compartidos. Las grabaciones del contrato anterior (`frame.ambulances`, `patients`) se rechazan con un mensaje explícito.

Panel de gestión con React + TypeScript + Vite. La UI se sirve en `/`. Operaciones e Incidencias comparten la línea temporal con Decisiones, Plan, Prensa y Señales.

## Qué es cada parte

| Directorio | Responsabilidad |
| --- | --- |
| `src/ui/` | Frontend: Control Center, mapa, tickets de incidencias e intervenciones. |
| `server/` | API de lectura que sirve las ejecuciones y el callejero mediante Vite. |
| `../gabriel/` | Motor, coordinadores y su propio visor. Escribe las ejecuciones en `gabriel/runs/`. |
| `../backend/` | Módulo independiente con CLI y estado en `state.json`. Esta UI lee las ejecuciones de `gabriel/`. |

## Arranque

Desde este directorio (`crisis-observatory/`):

```sh
npm install
npm run dev         # http://localhost:5173/
```

La aplicación lee las ejecuciones de `gabriel/runs/`. Si todavía no hay ninguna, muestra el estado de espera. Las nuevas ejecuciones aparecen automáticamente en el selector; la selección se conserva mientras se revisa una ejecución.

`npm run data:local` ejecuta el motor con el coordinador por reglas (semilla 2, 120 registros) y escribe la ejecución en `../gabriel/runs/`. El generador de pruebas local usa únicamente el motor, sin requerir el SDK de HappyRobot ni inicializar la memoria persistente del agente. Las grabaciones del formato anterior que queden en esa carpeta muestran el error de formato; el selector sigue disponible para elegir otra.

«Seguir ejecución» lleva la aplicación al último registro recibido. Play/pause controla la reproducción en el navegador; el proceso que escribe los datos continúa en la terminal. Las posiciones se actualizan con cada snapshot del motor.

El runner admite `--coordinator claude --model haiku`, con Claude CLI instalado y autenticado. La aplicación distingue IA, reglas y respaldo por reglas, y muestra las justificaciones que figuran en la ejecución.

La pestaña **Incidencias** muestra una tabla paginada de 50 filas, independiente del mapa, con búsqueda por identificador, calle, llamada o unidad y filtros **Triage**, **Progreso** y **Resuelto**. Triage reúne los avisos sin intervención iniciada; Progreso indica una asignación, una orden de envío aceptada o una valoración en el lugar; Resuelto corresponde al cierre del motor, con su motivo (atención finalizada, aviso agrupado o nadie en el lugar). Un cierre de atención en el lugar puede preceder al ingreso en hospital.

Al seleccionar un ticket, el lateral muestra sus datos, unidades, información pendiente y cronología: llamadas, órdenes aceptadas o rechazadas, motivos registrados por el coordinador, valoraciones, cambios de prioridad y cierre. Los siguientes pasos deducidos del estado se identifican como tales; si falta una justificación se indica expresamente. Los tickets cerrados se conservan en el historial, sin usar información posterior al instante seleccionado. **Ver en el mapa** centra la incidencia concreta con zoom de calle en Operaciones y abre su detalle contextual. Mantiene el instante seleccionado, también para los tickets archivados; volver a Incidencias conserva el ticket, la búsqueda y los filtros.

## Panorama operativo

**Operaciones** e **Incidencias** cubren la gestión diaria. Las vistas **Decisiones**, **Plan**, **Prensa** y **Señales** conservan el análisis de órdenes, el plan del coordinador, los comunicados y el canal ciudadano incorporados en `main`. La vista de Territorio permanece retirada. **Operaciones** es la portada y sigue el último registro recibido. `?inicio=1` permite empezar en el primer registro para revisar el historial. El recorrido va del territorio al sector, de ahí a sus incidencias y después a la evidencia de cada ticket. Al volver a Operaciones se conserva el sector seleccionado.

La primera agrupación es territorial: seis sectores estables calculados sobre los límites del mapa. Son ámbitos de navegación, no fusiones de casos ni situaciones inferidas por IA. Los casos fuera de esos límites y los que carecen de coordenadas tienen grupos explícitos. Las colas distinguen urgentes P0/P1 sin atención efectiva, accesos comprometidos y ubicaciones pendientes de confirmar; un dron de reconocimiento o una unidad bloqueada no se cuentan como atención efectiva. La disponibilidad de unidades respeta las actividades y plazos de ocupación registrados.

El mapa de Operaciones muestra un marcador por sector y, al abrirlo, agrupa sus incidencias mediante una capa GeoJSON. El callejero local permanece disponible si falla la cartografía de fondo. La carga de cada sector se compara con una instantánea de hace 15 minutos, o con la primera disponible si hay menos historial. Las observaciones de agua de 10 minutos o más se señalan para revisión. Radar aparece como fuente sin conectar; el canal ciudadano muestra los mensajes registrados cuando la ejecución lo incluye, y redes sociales figura sin conectar en las grabaciones que no lo incluyen.

Al pulsar una incidencia en el mapa, su detalle se abre en un panel lateral, o en un panel inferior ampliable en móvil, conservando el zoom y la posición. El punto seleccionado se resalta; otro clic cambia el caso del mismo panel. Las llamadas, las unidades y la actividad con sus evidencias se consultan allí. Cerrar o pulsar `Esc` devuelve el foco al mapa; solo «Abrir en Incidencias» cambia de vista. Cambiar de sector o retroceder a un instante anterior a la incidencia cierra el detalle. Desde la ficha, «Ver en el mapa» centra su punto con zoom de calle, muestra su identificador y abre el detalle dejando el punto visible junto al panel. Las incidencias archivadas usan su última ubicación registrada sin cambiar el instante del historial; el enlace se desactiva cuando no hay coordenadas disponibles.

**Escenario de escala**, en el selector o mediante `?escala=1`, genera 2.400 incidencias, 12.000 llamadas y 96 unidades sobre el callejero de València. Está marcado como simulado, no escribe ejecuciones y nunca sustituye automáticamente a datos vacíos o incompatibles. Permite probar búsqueda, paginación, sectores, evidencia e historial. Las decisiones se revisan con las ejecuciones del motor; la demo no ejecuta el coordinador ni calcula miles de recomendaciones de rutas.

Esta iteración valida la navegación a escala. Los resúmenes se calculan todavía en el navegador a partir del contrato de ejecuciones existente. El canal ciudadano del motor se consulta en Señales. Los resúmenes incrementales en servidor y la asignación de colas a operadores requieren ampliar el backend.

## Trabajar en paralelo en la UI

| Área | Archivos dentro de `src/ui/` | Qué tocar |
| --- | --- | --- |
| Operaciones | `operations/OperationsView.tsx`, `operations/OperationsMap.tsx`, `operations/model.ts`, `operations/demo.ts`, `operations/operations.css` | Panorama, sectores territoriales, colas, capacidad, fuentes, mapa agregado y escenario de escala. |
| Modelo de situación | `situation/model.ts` | Estado y disponibilidad de unidades, ocupación y resumen operativo para Operaciones. |
| Tickets de incidencias | `tickets/TicketsView.tsx`, `tickets/model.ts`, `tickets/tickets.css` | Tabla, filtros, detalle, cronología y navegación al mapa. |
| Registros compartidos | `audit/model.ts`, `audit/AuditDetail.tsx`, `audit/audit.css` | Transformación de eventos para tickets e intervenciones; detalle desplegable del hilo de una intervención. |
| Intervenciones del operador | `interventions/model.ts`, `interventions/routing.ts`, `interventions/useInterventions.ts`, `interventions/scene.ts`, `interventions/DecisionRoom.tsx`, `interventions/IncidentMap.tsx`, `interventions/IncidentFacts.tsx`, `interventions/DecisionBanner.tsx`, `interventions/DecisionParts.tsx`, `interventions/InterventionInbox.tsx`, `interventions/InterventionQueue.tsx`, `interventions/sound.ts`, `interventions/interventions.css`, `interventions/room.css` | Detección de excepciones, recomendación, sala de decisión con mapa del incidente, hechos con su fuente e hilo, notificación de supervisión, aviso sonoro, cola e historial en la barra superior y estilos, incluido móvil. |

`ControlCenter.tsx` mantiene la ejecución, reproducción, sector, ámbito de incidencias y ticket seleccionado. Operaciones abre colas territoriales y tickets; Incidencias localiza el punto concreto mediante «Ver en el mapa», con una petición de enfoque que se consume una sola vez. El mapa general se carga de forma diferida solo al abrir Decisiones para explicar sus órdenes; no existe una pestaña de Territorio. El resumen territorial se calcula únicamente en Operaciones o Decisiones. Los mapas de las salas de aprobación siguen limitados al caso correspondiente.

Los cambios de cada área se hacen en su carpeta. Si cambia la comunicación entre ambas, coordinad el cambio en `ControlCenter.tsx`. `engineTrace.ts` define los tipos y helpers comunes de las ejecuciones; `useRuns.ts` carga las ejecuciones desde la API y rechaza el formato anterior.

Los estilos se reparten por responsabilidad:

- `src/global.css`: estilos base del documento.
- `src/theme.css`: colores, tipografía y tokens compartidos.
- `src/ui/control-center.css`: layout y controles comunes del panel.
- `src/ui/session.css`: selector de ejecución, estado de conexión, avisos y flota.
- `src/ui/map/map.css`, `src/ui/situation/situation.css`, `src/ui/tickets/tickets.css`, `src/ui/audit/audit.css`, `src/ui/interventions/interventions.css` y `src/ui/interventions/room.css`: estilos propios de cada área.

Los cambios del Control Center viven en este paquete. El visor de `../gabriel/ui/` es una aplicación independiente.

## Intervenciones del operador

La aplicación pide una decisión cuando los registros muestran una excepción que el sistema deja abierta. Un incidente aislado, a punto de aislarse o sin unidad solo llega al operador si sigue así tres registros seguidos: el coordinador suele resolverlo en uno o dos. Cada incidente tiene como mucho una petición a la vez, aparte de las de una víctima a bordo. Las peticiones de un incidente son críticas si es P0–P1 y de supervisión si es P2–P3; una unidad bloqueada o con una víctima sin destino siempre es crítica. Todas se deciden igual, a pantalla completa.

| Excepción | Cuándo se abre | Recomendación |
| --- | --- | --- |
| Unidad bloqueada | Una unidad se queda sin ruta conocida camino de un incidente abierto o con una víctima a bordo | Reasignar la unidad libre que llega antes, llevar a la víctima a otro hospital o pedir un medio alternativo |
| Víctima a bordo sin destino | Una unidad lleva dos registros con una víctima y sin misión | Llevarla al hospital adecuado (con helipuerto si va en helicóptero) o escalar |
| Incidente aislado | Ninguna calle conocida llega a un P0–P1, o la previsión del agua ya lo aísla, y no va ninguna unidad acuática ni el helicóptero | Enviar el rescate acuático o el helicóptero libre, o pedir embarcaciones externas |
| Aislamiento previsto | La previsión del agua aísla un incidente sin unidades en 20 registros o menos (10 min con registros de 30 s) | Enviar antes del corte la unidad que llega a tiempo u ordenar una evacuación preventiva |
| Urgente sin unidad | Un P0–P1 espera sin unidades y hay unidades libres | Enviar la más adecuada: una que pueda excarcelar si hay atrapados |
| Escena no encontrada | La dotación llega al punto del aviso y no encuentra a nadie | Esperar más llamadas o cerrar el incidente |
| Zonas aisladas (supervisión) | Uno o más P2–P3 aislados por el agua esperan una unidad acuática o el helicóptero | Pedir embarcaciones externas o mantener las prioridades |
| Saturación | Dos o más P0–P1 sin unidad y ninguna libre durante tres registros | Solicitar refuerzos externos |
| IA no disponible / orden rechazada (supervisión) | El coordinador decide por reglas de respaldo o el motor rechaza una orden | Continuar o escalar |

Las aprobaciones están desactivadas por defecto: el coordinador actúa de forma autónoma. `?aprobaciones=1` activa la cola para revisar el flujo de supervisión; `?iteracion=1` y `?iteracion=2` activan sus variantes anteriores. En estos modos, las peticiones permanecen en una cola y el operador abre expresamente la sala de decisión desde Operaciones o Intervenciones. Mientras la sala está abierta, el resto de la aplicación queda fuera de alcance: roja si es crítica, ámbar si es de supervisión. Dentro está lo necesario para decidir: la situación, la recomendación con su justificación, el plazo con una barra que se consume (la previsión del agua cuando va a aislar el incidente; si no, el tiempo que la simulación da a la víctima), un mapa encuadrado en el incidente y las justificaciones registradas que llevaron hasta ahí. El mapa muestra el área de incertidumbre del incidente, el agua conocida y la real, el trayecto de cada opción con su ETA (al pasar por una opción se resalta el suyo), la ruta que tenía la unidad bloqueada y el corte que la cortó. «Lo que sabe el coordinador» lista los datos del incidente con la llamada o la dotación de la que salen; «Realidad de la simulación» muestra las víctimas reales, solo para supervisar. El hilo empieza en las llamadas del incidente, sigue con lo que comunican sus dotaciones y las decisiones del coordinador, permite desplegar sus detalles dentro de la sala y marca el corte causante. Las teclas `1`–`4` responden; «Otra acción…» registra una decisión en palabras del operador. `Esc` no cierra la sala; «Salir a investigar» devuelve al panorama y mantiene la petición en la cola. Las peticiones nuevas no toman el control de la pantalla ni pausan el historial. `?iteracion=2` conserva el comportamiento anterior de interrupción, barra de retorno y pausa automática para compararlo; `?iteracion=1` conserva el banner. En otra pestaña, el título parpadea mientras haya una petición pendiente. `?iteracion=1` muestra la primera iteración, un banner sobre el mapa, para comparar. El botón «Intervenciones» de la barra superior despliega la cola, salta a la siguiente excepción y guarda el historial, con el desenlace que figura en los registros.

El backend todavía no envía peticiones de decisión: mientras tanto, `model.ts` las detecta y recomienda a partir de los registros recibidos. Cuando la API las envíe, sustituyen a `detectInterventions()` en `useInterventions.ts`. Lo que se muestra en un registro no incluye lo que cuentan los posteriores; solo «Siguiente excepción» los recorre, para saltar hasta ella. Las recomendaciones y los ETA usan el grafo y la búsqueda de rutas de `../gabriel/src/engine/`, en modo lectura, con lo que sabe el coordinador en ese registro (cortes comunicados y agua conocida) y lo que puede hacer cada tipo de unidad: el rescate acuático cruza las calles inundadas conocidas y el helicóptero vuela en línea recta.

Las decisiones forman parte de la línea temporal y se guardan en memoria: si se vuelve a un momento anterior a una decisión, se deshace y la petición se repite al reproducir. Recargar la página empieza de cero. El motor todavía no recibe órdenes del operador y la interfaz lo indica. Cada opción que equivale a una orden lleva la `Action` que acepta `Simulation.order()`: `useInterventions.ts` es el punto donde enviarla cuando la API de ejecuciones admita escritura.

## Integración

[Contrato de datos y funcionamiento de la integración](docs/data-integration.md).

`server/runsApi.ts` expone `/api/runs`, `/api/runs/:id?from=N` y `/api/graph/:map`. La API lee archivos locales; el motor corre por separado. La aplicación valida el formato de los registros y muestra un error si los datos no son válidos.

El build estático necesita un servicio equivalente a esta API para usarse fuera de Vite. El mapa usa MapLibre y OpenFreeMap/OSM, con conexión para cargar las teselas. Geist y Geist Mono se sirven localmente.

## Verificación

```sh
npm run build          # TypeScript + build de producción
npm test               # formato de registros, eventos, geometrías de rutas, situación e intervenciones
npm run test:gabriel    # tests del motor
npm run test:ui         # Chrome instalado; integración API/UI
```

Para comprobar un worktree separado sin usar el servidor de otra rama: `PLAYWRIGHT_PORT=5180 npm run test:ui`.

Los tests de navegador combinan una noche DANA simulada en memoria con el motor de `../gabriel/` y el coordinador por reglas (`tests/support/engineRun.ts`, semilla 2) con escenarios fijos para tickets e intervenciones (`tests/support/ticketRun.ts` y `tests/support/interventionRun.ts`). Todos se sirven a través del contrato incremental de la API, sin escribir en `gabriel/runs/`. Comprueban snapshots, GPS, historial, filtros, navegación móvil e intervenciones del operador. Los escenarios fijos mantienen las pruebas de UI independientes de la estrategia del simulador. También verifican el rechazo explícito del formato anterior. Las teselas externas se sustituyen por un fondo local. Las capturas y resultados de pruebas se ignoran en Git.
