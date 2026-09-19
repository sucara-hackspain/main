# Alerta · Control Center

> **Formato soportado.** Esta aplicación reproduce grabaciones del contrato anterior (`frame.ambulances`, `patients`, eventos `patient_*`). Sus tipos están aislados en `src/ui/legacyRun.ts` para que siga compilando al cambiar el motor. Las ejecuciones nuevas de `../gabriel/` (`frame.units`, `scenes`, `incidents`, `knownWater`) se rechazan con un mensaje explícito hasta portar la UI. El visor del modelo nuevo está en `../gabriel/ui` (`cd ../gabriel && pnpm ui`).

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

Las grabaciones compatibles existentes en `../gabriel/runs/` se pueden revisar sin ejecutar el motor. `npm run data:local` genera ahora el formato nuevo; esas ejecuciones se consultan en el visor de Gabriel hasta completar la migración.

«Seguir ejecución» lleva la aplicación al último registro recibido. Play/pause controla la reproducción en el navegador; el proceso que escribe los datos continúa en la terminal. Las posiciones se actualizan con cada snapshot del motor.

El runner admite `--coordinator claude --model haiku`, con Claude CLI instalado y autenticado. La aplicación distingue IA, reglas y respaldo por reglas, y muestra las justificaciones que figuran en la ejecución.

## Trabajar en paralelo en la UI

| Área | Archivos dentro de `src/ui/` | Qué tocar |
| --- | --- | --- |
| Mapa | `map/RunMap.tsx`, `map/routes.ts`, `map/map.css` | Cartografía, marcadores, rutas, controles y estilos del mapa, incluido móvil. |
| Panel de situación | `situation/SituationSidebar.tsx`, `situation/model.ts`, `situation/situation.css` | Resumen global, recursos, capacidad, casos, cortes, filtros e inspector de entidades. |
| Chain of thoughts / actividad | `thoughts/ThoughtsView.tsx`, `thoughts/ActivityLog.tsx`, `thoughts/model.ts`, `thoughts/thoughts.css` | Flujo central, detalle de decisiones, transformación de eventos y estilos, incluido móvil. |

`ControlCenter.tsx` conecta estas vistas mediante props y mantiene la ejecución, reproducción, filtros y selección compartida. El mapa y el panel de situación comparten una selección `{ kind, id }` (`patient`, `ambulance`, `hospital` o `road`), el snapshot operativo y los conjuntos de entidades relacionadas y coincidentes con el filtro. `onSelect` actualiza la selección; `focusRequest` permite volver a centrarla. La actividad conserva sus eventos filtrados, el tiempo y el detalle expandido. Seleccionar un paciente o su ambulancia mantiene el filtro por paciente de la actividad. Cada componente gestiona sus referencias al DOM y su scroll.

Los cambios de cada área se hacen en su carpeta. Si cambia la comunicación entre ambas, coordinad el cambio en `ControlCenter.tsx`. `runModel.ts` define los tipos y helpers comunes de las ejecuciones; `useRuns.ts` carga las ejecuciones desde la API.

Los estilos se reparten por responsabilidad:

- `src/global.css`: estilos base del documento.
- `src/theme.css`: colores, tipografía y tokens compartidos.
- `src/ui/control-center.css`: layout y controles comunes del panel.
- `src/ui/session.css`: selector de ejecución, estado de conexión, avisos y flota.
- `src/ui/map/map.css`, `src/ui/situation/situation.css` y `src/ui/thoughts/thoughts.css`: estilos propios de cada área.

Los cambios del Control Center viven en este paquete. El visor de `../gabriel/ui/` es una aplicación independiente.

## Integración

[Contrato de datos y funcionamiento de la integración](docs/data-integration.md).

`server/runsApi.ts` expone `/api/runs`, `/api/runs/:id?from=N` y `/api/graph/:map`. La API lee archivos locales; el motor corre por separado. La aplicación valida el formato de los registros y muestra un error si los datos no son válidos.

El build estático necesita un servicio equivalente a esta API para usarse fuera de Vite. El mapa usa MapLibre y OpenFreeMap/OSM, con conexión para cargar las teselas. Geist y Geist Mono se sirven localmente.

## Verificación

```sh
npm run build          # TypeScript + build de producción
npm test               # formato de registros, actividad y geometrías de rutas
npm run test:gabriel    # tests del motor
npm run test:ui         # Chrome instalado; integración API/UI
```

Para comprobar un worktree separado sin usar el servidor de otra rama: `PLAYWRIGHT_PORT=5180 npm run test:ui`.

Los tests de navegador sirven una grabación archivada en `tests/fixtures/legacy-run.json` a través del contrato incremental de la API. Comprueban snapshots, GPS, actividad, historial, filtros y navegación móvil. También verifican el rechazo explícito del nuevo formato. No ejecutan ni modifican el motor. Las teselas externas se sustituyen por un fondo local; los marcadores conservan los datos de la grabación. Las capturas y resultados de pruebas se ignoran en Git.
