# Alerta · interfaz de coordinación

React + TypeScript + Vite. La V2 mantiene la UI de HappyRobot y muestra las ejecuciones del backend `gabriel/` de este mismo repo. Todo se ejecuta localmente.

## Arranque

```sh
npm install
npm run sim:local   # ejecución real del motor, greedy, seed 2, 120 registros; sin llamadas a IA
npm run dev         # http://localhost:5173/v2
```

- `/v2`: V2 conectada al backend. Selector de ejecución, mapa, avisos, flota, hospitales, actividad y línea temporal.
- `/`: acceso a la misma V2 conectada.

La V2 lee las ejecuciones existentes de `gabriel/runs/`. Si todavía no hay ninguna, muestra cómo generarlas. Una ejecución nueva aparece automáticamente en el selector. No sustituye una ejecución seleccionada por otra mientras se está revisando.

Para seguir una ejecución mientras el motor escribe nuevos registros:

```sh
cd gabriel
../node_modules/.bin/tsx src/run.ts --coordinator greedy --seed 7 --ticks 120 --tick-ms 500
```

El botón «Seguir ejecución» lleva el visor al último registro recibido. Play/pause controla el historial del navegador, **no** la simulación que corre en la terminal. Las posiciones se actualizan al registro real de 30 segundos; no se extrapolan trayectorias entre snapshots.

Para usar el coordinador Claude, el runner original admite `--coordinator claude --model haiku`, con Claude CLI instalado y autenticado. No se ha ejecutado una llamada real al modelo durante esta integración. El visor distingue IA, reglas y respaldo por reglas, y muestra solo las justificaciones registradas.

## Integración y restricciones

[Análisis de main, PR #1, contratos y decisiones de UI](docs/backend-integration.md).

`vite.config.ts` reutiliza el middleware de lectura de `gabriel/ui/vite.config.ts`: `/api/runs`, `/api/runs/:id?from=N`, `/api/graph/:map`. El motor de Gabriel no está modificado. El frontend no tiene endpoints de escritura ni puede crear pacientes o asignar recursos. Los hospitales y las posiciones vienen de la ejecución.

La PR rich-world cambia el contrato a unidades de varios tipos, incidentes y conocimiento imperfecto. Está analizada, pero no mergeada. El adaptador rechaza ese formato explícitamente hasta su migración, sin mostrar datos ficticios.

El build estático necesita un servicio equivalente a esta API para usarse fuera del servidor local de Vite. No se ha realizado ningún despliegue.

## UI

`src/happyrobot-theme.css` aplica los tokens de la skill `happyrobot-interface` v2.0.0. Geist y Geist Mono se sirven localmente. Inspector derecho, controles compactos, bordes neutros, rojo para avisos/bloqueos y detalle expandido solo en el flujo central. La interfaz se presenta en tema claro; no hay selector de tema.

El mapa usa MapLibre y OpenFreeMap/OSM, con conexión para cargar las teselas. La V2 conectada dibuja las geometrías del grafo del backend.

## Verificación

```sh
npm run build          # TypeScript + build de producción
npm test               # adaptador y geometrías de rutas
npm run test:gabriel    # tests del motor commiteado, sin modificarlo
npm run test:ui         # Chrome instalado; integración API/UI
```

Los tests de integración generan una ejecución greedy local en `gabriel/runs/` y verifican snapshots y GPS contra la API real. Los casos de polling/error usan respuestas controladas. Las trazas, capturas y copias temporales de revisión no se versionan.
