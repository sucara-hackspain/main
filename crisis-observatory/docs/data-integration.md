# Integración de datos de Control Center

## Responsabilidades

- `src/ui/`: aplicación React. `ControlCenter.tsx` coordina la selección de ejecución, el historial, los filtros, el mapa y la actividad.
- `server/runsApi.ts`: middleware de Vite que lee registros y mapas. No ejecuta el motor ni modifica sus datos.
- `gabriel/src/`: motor, coordinadores y runner. Los registros se escriben en `gabriel/runs/` y los mapas se leen de `gabriel/data/`.
- `backend/`: módulo independiente con CLI y persistencia en `state.json`; no forma parte de esta conexión.

La aplicación tiene una sola UI, servida en `/`. `src/ui/map/` contiene el mapa y `src/ui/thoughts/` el flujo de actividad y el registro lateral.

## API de lectura

`vite.config.ts` registra el plugin exportado por `server/runsApi.ts`.

| Endpoint | Datos | Uso en la UI |
| --- | --- | --- |
| `GET /api/runs` | Metadatos de las ejecuciones, de más reciente a más antigua | Selector; consulta cada 5 s |
| `GET /api/runs/:id?from=N` | Metadatos y registros desde el índice `N` | Lectura incremental cada 1,5 s |
| `GET /api/graph/:map` | Callejero, geometrías, nodos y hospitales | Representación del mapa |

Los tipos proceden de `gabriel/src/engine/types.ts` y `trace.ts`, mediante imports de tipos. `src/ui/runModel.ts` exporta los tipos usados por la UI y valida los registros recibidos. `src/ui/useRuns.ts` mantiene el polling y conserva el último snapshot válido ante un error.

Cambiar de ejecución reinicia mapa, reloj, selección y filtros. Pausar el historial afecta a la reproducción del navegador. Tras una ejecución finalizada o fallida se continúa leyendo hasta recibir una respuesta sin registros nuevos: el middleware lee los registros antes de los metadatos y puede observar el cierre entre ambas lecturas.

La API funciona dentro del servidor de desarrollo. Para servir el build estático hay que proporcionar estos endpoints desde un servicio HTTP. `npm run data:local` genera datos de desarrollo con el runner local; la UI los consume mediante el mismo contrato.

## Representación de los registros

- Avisos: pacientes con estados de espera, traslado, ingreso y fallecimiento. Se ordenan con los nuevos avisos primero y permiten filtrar por paciente.
- Tiempo: el campo `tickSeconds` permite convertir los índices y TTL del registro en duraciones.
- Flota y hospitales: estado, ocupación y capacidad del snapshot seleccionado. `idle` se muestra como «Sin misión», porque el snapshot no incluye `busyUntil`.
- Mapa: coordenadas registradas, cortes y geometrías del grafo. Las rutas se recortan desde el GPS sin saltarse las curvas de la primera arista.
- Actividad: distingue entorno, evolución del motor y coordinador. El detalle central muestra situación, razones, órdenes, aceptación/rechazo y ETA, además de duración, coste o error cuando existen. El registro lateral permanece compacto.

Las justificaciones se muestran tal como aparecen en los registros. La UI no recibe tokens en streaming ni información sobre razonamiento en curso. Los registros se validan como un único contrato; si este cambia, se actualizan la aplicación y sus pruebas conjuntamente.

## Verificación

`npm test` comprueba la validación de registros, la clasificación de actividad, los estados de unidades y las geometrías de rutas. `npm run test:ui` genera datos locales y comprueba posiciones, capacidad, historial, expansión del detalle, polling, recuperación tras errores y layout móvil contra la API.

Estas pruebas no hacen llamadas a modelos reales. Las teselas del mapa necesitan conexión a OpenFreeMap.
