# Alerta · Control Center

> **Formato soportado.** Control Center lee el modelo de unidades e incidentes del motor de `../gabriel/` (`frame.units`, `scenes`, `incidents`, `knownWater`, `knownClosedEdges`; eventos `call_*`, `scene_*`, `victim_*`, `unit_*`, `flood_*`). `src/ui/engineTrace.ts` reexporta sus tipos y reúne las etiquetas y los helpers compartidos. Las grabaciones del contrato anterior (`frame.ambulances`, `patients`) se rechazan con un mensaje explícito.

Panel de gestión con React + TypeScript + Vite. La UI se sirve en `/` y muestra mapa, avisos, flota, hospitales, actividad y línea temporal.

## Qué es cada parte

| Directorio | Responsabilidad |
| --- | --- |
| `src/ui/` | Frontend: Control Center, mapa y actividad de los agentes. |
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

`npm run data:local` ejecuta el motor con el coordinador por reglas (semilla 2, 120 registros) y escribe la ejecución en `../gabriel/runs/`. Las grabaciones del formato anterior que queden en esa carpeta muestran el error de formato; el selector sigue disponible para elegir otra.

«Seguir ejecución» lleva la aplicación al último registro recibido. Play/pause controla la reproducción en el navegador; el proceso que escribe los datos continúa en la terminal. Las posiciones se actualizan con cada snapshot del motor.

El runner admite `--coordinator claude --model haiku`, con Claude CLI instalado y autenticado. La aplicación distingue IA, reglas y respaldo por reglas, y muestra las justificaciones que figuran en la ejecución.

## Trabajar en paralelo en la UI

| Área | Archivos dentro de `src/ui/` | Qué tocar |
| --- | --- | --- |
| Mapa | `map/RunMap.tsx`, `map/routes.ts`, `map/unitIcons.ts`, `map/map.css` | Cartografía, unidades por tipo, incidentes con su incertidumbre, agua conocida y real, cortes, rutas, controles y estilos del mapa, incluido móvil. |
| Panel de situación | `situation/SituationSidebar.tsx`, `situation/model.ts`, `situation/situation.css` | Resumen global y balance, incidentes, unidades, capacidad de hospitales, agua y cortes, filtros e inspector de entidades. |
| Chain of thoughts / actividad | `thoughts/ThoughtsView.tsx`, `thoughts/ActivityLog.tsx`, `thoughts/model.ts`, `thoughts/thoughts.css` | Flujo central, detalle de decisiones, transformación de eventos y estilos, incluido móvil. |
| Intervenciones del operador | `interventions/model.ts`, `interventions/routing.ts`, `interventions/useInterventions.ts`, `interventions/scene.ts`, `interventions/DecisionRoom.tsx`, `interventions/IncidentMap.tsx`, `interventions/IncidentFacts.tsx`, `interventions/DecisionBanner.tsx`, `interventions/DecisionParts.tsx`, `interventions/InterventionInbox.tsx`, `interventions/InterventionQueue.tsx`, `interventions/sound.ts`, `interventions/interventions.css`, `interventions/room.css` | Detección de excepciones, recomendación, sala de decisión con mapa del incidente, hechos con su fuente e hilo, notificación de supervisión, aviso sonoro, cola e historial en la barra superior y estilos, incluido móvil. |

`ControlCenter.tsx` conecta estas vistas mediante props y mantiene la ejecución, reproducción, filtros y selección compartida. El mapa, el panel de situación y la actividad comparten una selección `{ kind, id }` (`incident`, `unit`, `hospital` o `scene`, definida en `engineTrace.ts`); el mapa y el panel comparten además el snapshot operativo y los conjuntos de entidades relacionadas y coincidentes con el filtro. `onSelect` actualiza la selección; `focusRequest` permite volver a centrarla. La actividad conserva sus eventos filtrados, el tiempo y el detalle expandido, y filtra por las referencias de cada evento: seleccionar un incidente deja sus llamadas, las unidades que lo atienden y lo que comunican. Cada componente gestiona sus referencias al DOM y su scroll.

Los cambios de cada área se hacen en su carpeta. Si cambia la comunicación entre ambas, coordinad el cambio en `ControlCenter.tsx`. `engineTrace.ts` define los tipos y helpers comunes de las ejecuciones; `useRuns.ts` carga las ejecuciones desde la API y rechaza el formato anterior.

Los estilos se reparten por responsabilidad:

- `src/global.css`: estilos base del documento.
- `src/theme.css`: colores, tipografía y tokens compartidos.
- `src/ui/control-center.css`: layout y controles comunes del panel.
- `src/ui/session.css`: selector de ejecución, estado de conexión, avisos y flota.
- `src/ui/map/map.css`, `src/ui/situation/situation.css`, `src/ui/thoughts/thoughts.css`, `src/ui/interventions/interventions.css` y `src/ui/interventions/room.css`: estilos propios de cada área.

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

Cada petición abre una sala de decisión a pantalla completa que bloquea el resto de la aplicación hasta que el operador decide: roja si es crítica, ámbar si es de supervisión. Dentro está lo necesario para decidir: la situación, la recomendación con su justificación, el plazo con una barra que se consume (la previsión del agua cuando va a aislar el incidente; si no, el tiempo que la simulación da a la víctima), un mapa encuadrado en el incidente y el hilo de la cadena de pensamiento que llevó hasta ahí. El mapa muestra el área de incertidumbre del incidente, el agua conocida y la real, el trayecto de cada opción con su ETA (al pasar por una opción se resalta el suyo), la ruta que tenía la unidad bloqueada y el corte que la cortó. «Lo que sabe el coordinador» lista los datos del incidente con la llamada o la dotación de la que salen; «Realidad de la simulación» muestra las víctimas reales, solo para supervisar. El hilo empieza en las llamadas del incidente, sigue con lo que comunican sus dotaciones y las decisiones del coordinador (desplegables, como en la actividad), marca el corte causante y se puede abrir completo en Actividad de los agentes. Las teclas `1`–`4` responden; «Otra acción…» registra una decisión en palabras del operador. `Esc` no cierra la sala: «Salir a investigar» la sustituye por una barra con la cuenta atrás hasta volver, y una petición nueva la vuelve a abrir. Al abrirse mientras avanza el tiempo suena, y se puede silenciar; durante la reproducción, además, pausa el historial hasta decidir. En otra pestaña, el título parpadea mientras haya una petición pendiente. `?iteracion=1` muestra la primera iteración, un banner sobre el mapa, para comparar. El botón «Intervenciones» de la barra superior despliega la cola, salta a la siguiente excepción y guarda el historial, con el desenlace que figura en los registros.

El backend todavía no envía peticiones de decisión: mientras tanto, `model.ts` las detecta y recomienda a partir de los registros recibidos. Cuando la API las envíe, sustituyen a `detectInterventions()` en `useInterventions.ts`. Lo que se muestra en un registro no incluye lo que cuentan los posteriores; solo «Siguiente excepción» los recorre, para saltar hasta ella. Las recomendaciones y los ETA usan el grafo y la búsqueda de rutas de `../gabriel/src/engine/`, en modo lectura, con lo que sabe el coordinador en ese registro (cortes comunicados y agua conocida) y lo que puede hacer cada tipo de unidad: el rescate acuático cruza las calles inundadas conocidas y el helicóptero vuela en línea recta.

Las decisiones forman parte de la línea temporal y se guardan en memoria: si se vuelve a un momento anterior a una decisión, se deshace y la petición se repite al reproducir. Recargar la página empieza de cero. El motor todavía no recibe órdenes del operador y la interfaz lo indica. Cada opción que equivale a una orden lleva la `Action` que acepta `Simulation.order()`: `useInterventions.ts` es el punto donde enviarla cuando la API de ejecuciones admita escritura.

## Integración

[Contrato de datos y funcionamiento de la integración](docs/data-integration.md).

`server/runsApi.ts` expone `/api/runs`, `/api/runs/:id?from=N` y `/api/graph/:map`. La API lee archivos locales; el motor corre por separado. La aplicación valida el formato de los registros y muestra un error si los datos no son válidos.

El build estático necesita un servicio equivalente a esta API para usarse fuera de Vite. El mapa usa MapLibre y OpenFreeMap/OSM, con conexión para cargar las teselas. Geist y Geist Mono se sirven localmente.

## Verificación

```sh
npm run build          # TypeScript + build de producción
npm test               # formato de registros, actividad, geometrías de rutas, situación e intervenciones
npm run test:gabriel    # tests del motor
npm run test:ui         # Chrome instalado; integración API/UI
```

Para comprobar un worktree separado sin usar el servidor de otra rama: `PLAYWRIGHT_PORT=5180 npm run test:ui`.

Los tests de navegador simulan en memoria una noche DANA con el motor de `../gabriel/` y el coordinador por reglas (`tests/support/engineRun.ts`, semillas 2 y 12), y la sirven a través del contrato incremental de la API; no escriben en `gabriel/runs/`. Comprueban snapshots, GPS, actividad, historial, filtros, navegación móvil y las intervenciones del operador. También verifican el rechazo explícito del formato anterior. Las teselas externas se sustituyen por un fondo local. Las capturas y resultados de pruebas se ignoran en Git.
