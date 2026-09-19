# Alerta · Control Center

> **Pendiente de portar.** Esta aplicación lee el formato de ejecuciones anterior del motor (`frame.ambulances`, `patients`, eventos `patient_*`). El motor de `../gabriel/` escribe ahora `frame.units`, `scenes`, `incidents`, `knownWater` y eventos `unit_*` / `victim_*`, así que ni compila contra sus tipos ni puede leer ejecuciones nuevas hasta adaptarla. Mientras tanto, el visor del modelo nuevo está en `../gabriel/ui` (`cd ../gabriel && pnpm ui`).

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
npm run data:local  # genera registros de desarrollo locales; sin llamadas a IA
npm run dev         # http://localhost:5173/
```

La aplicación lee las ejecuciones de `gabriel/runs/`. Si todavía no hay ninguna, muestra el estado de espera. Las nuevas ejecuciones aparecen automáticamente en el selector; la selección se conserva mientras se revisa una ejecución.

Para generar registros de desarrollo de forma progresiva:

```sh
cd ../gabriel
../crisis-observatory/node_modules/.bin/tsx src/run.ts --coordinator greedy --seed 7 --ticks 120 --tick-ms 500
```

«Seguir ejecución» lleva la aplicación al último registro recibido. Play/pause controla la reproducción en el navegador; el proceso que escribe los datos continúa en la terminal. Las posiciones se actualizan con cada snapshot del motor.

El runner admite `--coordinator claude --model haiku`, con Claude CLI instalado y autenticado. La aplicación distingue IA, reglas y respaldo por reglas, y muestra las justificaciones que figuran en la ejecución.

## Trabajar en paralelo en la UI

| Área | Archivos dentro de `src/ui/` | Qué tocar |
| --- | --- | --- |
| Mapa | `map/RunMap.tsx`, `map/routes.ts`, `map/map.css` | Cartografía, marcadores, rutas, controles y estilos del mapa, incluido móvil. |
| Chain of thoughts / actividad | `thoughts/ThoughtsView.tsx`, `thoughts/ActivityLog.tsx`, `thoughts/model.ts`, `thoughts/thoughts.css` | Flujo central, detalle de decisiones, registro lateral, transformación de eventos y estilos, incluido móvil. |

`ControlCenter.tsx` conecta ambas partes mediante props y mantiene la ejecución, reproducción, filtros y selección compartida. El mapa recibe `graph`, `meta`, `record`, `selected` y `onSelect`; la actividad recibe los eventos filtrados, el tiempo y callbacks para seleccionar o abrir un registro. Cada componente gestiona sus referencias al DOM y su scroll.

Los cambios de cada área se hacen en su carpeta. Si cambia la comunicación entre ambas, coordinad el cambio en `ControlCenter.tsx`. `runModel.ts` define los tipos y helpers comunes de las ejecuciones; `useRuns.ts` carga las ejecuciones desde la API.

Los estilos se reparten por responsabilidad:

- `src/global.css`: estilos base del documento.
- `src/theme.css`: colores, tipografía y tokens compartidos.
- `src/ui/control-center.css`: layout y controles comunes del panel.
- `src/ui/session.css`: selector de ejecución, estado de conexión, avisos y flota.
- `src/ui/map/map.css` y `src/ui/thoughts/thoughts.css`: estilos propios de cada área.

Integrad esta separación antes de abrir las dos ramas.

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

Los tests de integración generan una ejecución greedy local en `gabriel/runs/` y verifican snapshots y GPS contra la API real. Los casos de polling/error usan respuestas controladas. Las trazas, capturas y resultados de pruebas se ignoran en Git.
