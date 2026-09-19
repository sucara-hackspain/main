# Integración de datos de Control Center

## Responsabilidades

- `src/ui/`: aplicación React. `ControlCenter.tsx` coordina la selección de ejecución, el historial, los filtros, el mapa y la actividad.
- `server/runsApi.ts`: middleware de Vite que lee registros y mapas. No ejecuta el motor ni modifica sus datos.
- `gabriel/src/`: motor, coordinadores y runner. Los registros se escriben en `gabriel/runs/` y los mapas se leen de `gabriel/data/`.
- `backend/`: módulo independiente con CLI y persistencia en `state.json`; no forma parte de esta conexión.

La aplicación tiene una sola UI, servida en `/`. `src/ui/map/` contiene el mapa y `src/ui/thoughts/` el flujo de actividad y `src/ui/situation/` el panel operativo lateral.

## API de lectura

`vite.config.ts` registra el plugin exportado por `server/runsApi.ts`.

| Endpoint | Datos | Uso en la UI |
| --- | --- | --- |
| `GET /api/runs` | Metadatos de las ejecuciones, de más reciente a más antigua | Selector; consulta cada 5 s |
| `GET /api/runs/:id?from=N` | Metadatos y registros desde el índice `N` | Lectura incremental cada 1,5 s |
| `GET /api/graph/:map` | Callejero, geometrías, nodos y hospitales | Representación del mapa |

El contrato de ejecuciones anterior se declara en `src/ui/legacyRun.ts`, separado de los tipos nuevos del motor. El tipo del callejero se importa de `../gabriel/src/engine/types.ts`. `src/ui/runModel.ts` exporta los tipos usados por la UI y valida los registros recibidos; rechaza explícitamente el formato nuevo de unidades, escenas e incidentes, cuya integración está pendiente. `src/ui/useRuns.ts` mantiene el polling y conserva el último snapshot válido ante un error.

Cambiar de ejecución reinicia mapa, reloj, selección y filtros. Pausar el historial afecta a la reproducción del navegador. Tras una ejecución finalizada o fallida se continúa leyendo hasta recibir una respuesta sin registros nuevos: el middleware lee los registros antes de los metadatos y puede observar el cierre entre ambas lecturas.

La API funciona dentro del servidor de desarrollo. Para servir el build estático hay que proporcionar estos endpoints desde un servicio HTTP. `npm run data:local` genera ahora el nuevo formato del motor, que se consulta en el visor de Gabriel. Esta UI sigue leyendo las grabaciones anteriores compatibles.

## Representación de los registros

- Casos: pacientes sin asignar, en recogida, en traslado, pendientes de destino o bloqueados por una incidencia conocida en su unidad. Las filas mantienen el orden por identificador. Los casos cerrados se muestran a petición.
- Tiempo: el campo `tickSeconds` permite convertir los índices y TTL del registro en duraciones.
- Flota: disponibilidad, misión y próxima etapa del snapshot seleccionado. El frontend consume `busyUntil`, `brokenUntil` y `etaTicks` cuando llegan en las trazas. Una unidad sin misión puede seguir descargando. Las grabaciones sin estos datos muestran disponibilidad sin confirmar; no se modifica el motor para generarlos.
- Hospitales: ocupación confirmada y demanda de pacientes a bordo con ese destino, incluidos los traslados detenidos. El margen previsto descuenta esa demanda de la capacidad libre, puede ser negativo y no representa reservas. Una preasignación de hospital antes de la recogida no se cuenta como traslado.
- Mapa: coordenadas registradas, cortes y geometrías del grafo. Las rutas se recortan desde el GPS sin saltarse las curvas de la primera arista.
- Actividad: distingue entorno, evolución del motor y coordinador. El detalle central muestra situación, razones, órdenes, aceptación/rechazo y ETA, además de duración, coste o error cuando existen. Los filtros de Master y Coordinador se muestran únicamente en la vista de actividad. El sidebar contiene el estado operativo, sin tarjetas ni registros de agentes.

El resumen global y el balance acumulado usan exclusivamente el snapshot seleccionado. La interfaz señala cuándo se revisa el pasado. `spawnTick` y `pickupTick` permiten mostrar la espera; para grabaciones anteriores se consultan solo eventos conocidos hasta ese instante. Una selección que todavía no existe al retroceder se elimina.

`src/ui/runModel.ts` declara las extensiones del contrato de entrada para el frontend; `src/ui/situation/model.ts` calcula disponibilidad, demanda y relaciones sin escribir en el servicio de datos. La selección compartida `{ kind, id }` permite abrir casos, ambulancias, hospitales y cortes desde el mapa o el sidebar. Los filtros resaltan coincidencias en el mapa y conservan los indicadores globales. El inspector muestra los recursos vinculados y permite localizarlos.

Las justificaciones se muestran tal como aparecen en los registros. La UI no recibe tokens en streaming ni información sobre razonamiento en curso. Los registros se validan como un único contrato; si este cambia, se actualizan la aplicación y sus pruebas conjuntamente.

## Verificación

`npm test` comprueba la validación de registros, la clasificación de actividad, los estados de unidades y las geometrías de rutas. `npm run test:ui` sirve una grabación archivada del formato soportado y comprueba posiciones, capacidad, historial, expansión del detalle, polling, recuperación tras errores y layout móvil a través del contrato incremental de la API. También comprueba el rechazo explícito del formato nuevo.

Estas pruebas no hacen llamadas a modelos reales. Las pruebas de navegador sustituyen el estilo externo por un fondo local para comprobar interacciones sin conexión a las teselas. La aplicación normal carga la cartografía de OpenFreeMap.
