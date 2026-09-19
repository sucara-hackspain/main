# Integración de datos de Control Center

## Responsabilidades

- `src/ui/`: aplicación React. `ControlCenter.tsx` coordina la selección de ejecución, el historial, los filtros, el mapa, los tickets y las intervenciones.
- `server/runsApi.ts`: middleware de Vite que lee registros y mapas. No ejecuta el motor ni modifica sus datos.
- `gabriel/src/`: motor, coordinadores y runner. Los registros se escriben en `gabriel/runs/` y los mapas se leen de `gabriel/data/`.
- `backend/`: módulo independiente con CLI y persistencia en `state.json`; no forma parte de esta conexión.

La aplicación tiene una sola UI, servida en `/`. `src/ui/map/` contiene el mapa, `src/ui/tickets/` los tickets de incidencias y `src/ui/situation/` el panel operativo lateral. `src/ui/audit/` reúne la transformación de eventos compartida y el detalle de los registros que se despliegan en las intervenciones.

## API de lectura

`vite.config.ts` registra el plugin exportado por `server/runsApi.ts`.

| Endpoint | Datos | Uso en la UI |
| --- | --- | --- |
| `GET /api/runs` | Metadatos de las ejecuciones, de más reciente a más antigua | Selector; consulta cada 5 s |
| `GET /api/runs/:id?from=N` | Metadatos y registros desde el índice `N` | Lectura incremental cada 1,5 s |
| `GET /api/graph/:map` | Callejero, geometrías, nodos y hospitales | Representación del mapa |

El contrato de ejecuciones es el del motor: `src/ui/engineTrace.ts` reexporta los tipos de `../gabriel/src/engine/types.ts` y `trace.ts` (registros, unidades, escenas, incidentes, agua conocida) y reúne las etiquetas y los helpers de la UI. `src/ui/useRuns.ts` mantiene el polling, conserva el último snapshot válido ante un error y rechaza explícitamente las grabaciones del contrato anterior (`frame.ambulances`, `patients`).

Cambiar de ejecución reinicia mapa, reloj, selección y filtros. Pausar el historial afecta a la reproducción del navegador. Tras una ejecución finalizada o fallida se continúa leyendo hasta recibir una respuesta sin registros nuevos: el middleware lee los registros antes de los metadatos y puede observar el cierre entre ambas lecturas.

La API funciona dentro del servidor de desarrollo. Para servir el build estático hay que proporcionar estos endpoints desde un servicio HTTP. `npm run data:local` genera una ejecución del motor que esta UI lee directamente.

## Representación de los registros

- Incidentes: lo que sabe el coordinador. Abiertos por prioridad, sin unidad, aislados por el agua o a punto de quedarlo según la previsión, con sus unidades, la precisión de la ubicación y las llamadas. Un incidente aislado sigue señalado hasta que va una unidad que cruza el agua o vuela. Los cerrados recientes se muestran a petición.
- Tiempo: el campo `tickSeconds` permite convertir los índices y TTL del registro en duraciones.
- Unidades: tipo, disponibilidad, misión y próxima etapa del snapshot seleccionado. El frame no trae plazos: la excarcelación, la recogida, la atención en el lugar y la descarga se reconstruyen con los eventos conocidos hasta ese instante y la configuración de la ejecución, igual que la reparación de una avería (`unit_broken.untilTick`). Una unidad sin misión puede seguir descargando. No se modifica el motor para generarlos.
- Hospitales: ocupación confirmada y demanda de víctimas a bordo con ese destino, incluidos los traslados detenidos. El margen previsto descuenta esa demanda de la capacidad libre, puede ser negativo y no representa reservas. Un hospital asignado antes de la recogida no se cuenta como traslado. Se indica si tiene helipuerto.
- Agua y cortes: las zonas de los mapas oficiales con su radio y antigüedad, los avisos de agua y los tramos cortados que conoce el coordinador, frente a los cortes reales que nadie ha comunicado (supervisión).
- Mapa: coordenadas registradas de cada unidad con su tipo (ambulancia, bomberos, rescate acuático, helicóptero), incidentes con su prioridad y el área de incertidumbre de su ubicación, agua conocida (zonas y avistamientos), cortes comunicados y geometrías del grafo. «Realidad» añade lo que el coordinador no ve: el agua real, las escenas y los cortes sin comunicar. Las rutas se recortan desde el GPS sin saltarse las curvas de la primera arista.
- Registros de incidencias e intervenciones: distinguen entorno, llamadas al 112, evolución de las dotaciones y coordinador. Las referencias de cada evento (llamada, incidente, unidad, escena, víctima, hospital) permiten reconstruir el hilo de una intervención. Su detalle desplegable muestra situación, razones, órdenes, aceptación/rechazo y ETA, además de duración, coste o error cuando existen. Los tickets presentan la cronología de cada incidencia en su lateral.

El resumen global y el balance acumulado, bajo los indicadores, usan exclusivamente el snapshot seleccionado. La interfaz señala cuándo se revisa el pasado. La espera de un incidente se cuenta desde que se abrió. Una selección que todavía no existe al retroceder se elimina.

`src/ui/situation/model.ts` calcula disponibilidad, demanda y relaciones sin escribir en el servicio de datos. La selección compartida `{ kind, id }` permite abrir incidentes, unidades, hospitales y escenas reales desde el mapa o el sidebar. Los filtros resaltan coincidencias en el mapa y conservan los indicadores globales. El detalle de la selección se abre en un modal sobre el mapa, junto a lo seleccionado: muestra los recursos vinculados y permite saltar a ellos. Al seleccionar una incidencia, el mapa la pone en primer plano con esas mismas relaciones: encuadra la incidencia, sus unidades y su hospital, y atenúa el resto.

Las justificaciones se muestran tal como aparecen en los registros. La UI no recibe tokens en streaming ni información sobre razonamiento en curso. Los registros se validan como un único contrato; si este cambia, se actualizan la aplicación y sus pruebas conjuntamente.

## Verificación

`npm test` comprueba la validación de registros, la clasificación de eventos, los estados y plazos de las unidades, la demanda de hospitales, las relaciones y filtros del panel de situación, las geometrías de rutas y la detección y recomendación de intervenciones. `npm run test:ui` combina ejecuciones del motor en memoria (`tests/support/engineRun.ts`) con escenarios fijos de tickets e intervenciones, servidos a través del contrato incremental de la API; comprueba posiciones, capacidad, historial, expansión del detalle, polling, recuperación tras errores, layout móvil e intervenciones del operador. También comprueba el rechazo explícito del formato anterior.

Estas pruebas no hacen llamadas a modelos reales. Las pruebas de navegador sustituyen el estilo externo por un fondo local para comprobar interacciones sin conexión a las teselas. La aplicación normal carga la cartografía de OpenFreeMap.
