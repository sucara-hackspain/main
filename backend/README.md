# dana-sim

Simulador de emergencias por turnos sobre el callejero real de València + l'Horta Sud (OSM).
Un **Coordinador** asigna ambulancias a heridos (urgencia + cercanía, Dijkstra sobre 50k nodos);
un **Master** (agente Claude) corta calles, genera heridos y pincha ruedas para ponerlo a prueba.

```sh
cd backend
npm install
npm run map                      # descarga el mapa de Overpass → data/valencia.json (ya incluido)
cp .env.example .env             # OPENROUTER_API_KEY para el Master IA (sin clave, el turno va sin Master)

npm run sim -- init -n 4         # base en La Fe, 4 ambulancias
npm run sim -- spawn --ttl 8     # herido aleatorio (o --at 39.43,-0.41)
npm run sim -- step 5            # Coordinador → mover → Master → t++
npm run sim -- cut "Avinguda del Cid" --at 39.47,-0.40
npm run sim -- puncture A2
npm run sim -- status
npm run sim -- step 5 --agents off  # sin los agentes 112 de HappyRobot
npm run phone                        # POST /phone y /followup: llamadas reales (112-inbound) y partes de seguimiento (112-outbound)
```

## Agentes 112 (HappyRobot)

Con `HAPPYROBOT_API_KEY` en `.env`, cada `step` pasa por los agentes antes y después de asignar ambulancias:

- **112-triage**: toda llamada (real por `/phone`, simulada por el coordinador 112, o un herido del Master/CLI) lanza una ejecución
  con `{call, incidents}` y devuelve el tablón de incidentes con prioridad (`critical > high > medium > low`). El Coordinador de
  ambulancias ordena a los heridos por esa prioridad y, a igualdad, por ttl. El tablón vive en `state.json` (`incidents`).
- **112-coordinator**: cada `COORDINATOR_EVERY_TURNS` turnos (5) se lanza con `{ticks, scenario}`; cada iteración de su bucle
  produce una llamada simulada que entra al mundo como herido (en la calle que dice si está en el mapa, si no al azar) y se triaja.
- **112-outbound** (seguimiento real): al rescatar a un herido de prioridad `FOLLOWUP_PRIORITIES` (`low`) que entró por una llamada
  **con teléfono**, `FOLLOWUP_AFTER_TURNS` turnos después (10) se lanza una llamada de voz de seguimiento. El parte (`reached`,
  `evolution`, `escalate`, `nextAction`…) vuelve por `POST /followup`: si no contestan se reintenta una vez; si hay que escalar, el
  caso vuelve a entrar como llamada nueva y pasa por triaje. El parte cambia la prioridad del caso (mejor → `low`, peor o con
  banderas rojas → `high`). Sin teléfono (llamadas del coordinador 112 o del Master), **sim-112-outbound** inventa el parte en el
  acto (`FOLLOWUP_SIMULATED=on`). `npm run sim -- followup H3 [--phone +34...]` fuerza uno a mano.

## Control Center (`../crisis-observatory`)

`init` abre `runs/<partida>/` y exporta el callejero a `data/valencia-ui.json`; cada `step` añade un registro (`ticks.jsonl`) en el
formato del Control Center: ambulancias como unidades con su ruta, heridos como escenas, el tablón del triaje como incidentes con
prioridad y expediente (llamadas, triaje, órdenes, rescates, seguimientos), cortes, pinchazos. `cd ../crisis-observatory && npm run dev`
lee `backend/runs/` y sigue la partida en vivo.

`npm run phone` escucha `POST /phone` y `POST /followup` (puerto `PHONE_PORT`) tras un túnel ngrok (`PUBLIC_URL`) y apunta lo que
llega en `inbox.jsonl`; el siguiente `step` lo mete en la partida (así la CLI nunca pisa lo que entró durante un turno).
`npm run webhooks` apunta los nodos POST de `112-inbound` (a `/phone`, con el teléfono del que llama) y `112-outbound` (a `/followup`)
a esa URL y publica; repítelo cada vez que cambie el túnel.

Estado en `state.json`. Un turno ≈ 1 min; `SPEED` y `STUCK_TURNS` en `src/sim.ts`.

```
src/
  config.ts                 parámetros (velocidad, reparación, base, ficheros, modelo) + carga de .env
  map/graph.ts              tipos del grafo, haversine, edgeKey
  map/road-map.ts           RoadMap: consultas de calles + Dijkstra (inmutable, los cortes se pasan por consulta)
  map/heap.ts               montículo para Dijkstra
  entities/base.ts          Base
  entities/ambulance.ts     Ambulancia: estado, pinchazo, avance por ruta
  entities/injured.ts       Herido: ttl
  entities/street-cut.ts    Calle cortada: tramos bloqueados, planificar un corte
  world.ts                  World: todo el estado (persistido en state.json), log
  actions.ts                acciones del Master: spawnInjured, cutStreet, punctureAmbulance
  coordinator.ts            Coordinator (greedy por urgencia + cercanía), etaTurns
  simulation.ts             step(): agentes 112 → coordinador → mover → seguimientos → master → fin de turno
  happyrobot.ts             cliente mínimo: lanza un workflow y lee la salida de un nodo
  triage.ts                 agente 112-triage: llamada → tablón de incidentes con prioridad; llamadas entrantes → heridos
  coordinator-112.ts        agente 112-coordinator: cada N turnos, tanda de llamadas simuladas
  followup.ts               agente 112-outbound: llamada real de seguimiento a los rescatados; parte por webhook
  server.ts                 POST /phone y /followup: webhooks de los workflows de voz
  inbox.ts                  bandeja de los webhooks (inbox.jsonl), que cada step vacía
  hr-webhooks.ts            apunta los nodos POST de 112-inbound/112-outbound a PUBLIC_URL y publica
  recorder.ts               graba cada turno en runs/<partida>/ en el formato del Control Center
  map/ui-graph.ts           el callejero en el formato del Control Center (data/valencia-ui.json)
  master/schema.ts          plan del Master (zod) y límites por turno
  master/briefing.ts        resumen + candidatos que ve el Master
  master/llm-master.ts      Master IA (OpenRouter, salida estructurada por JSON Schema)
  render.ts                 tablas de estado por consola
  cli.ts                    comandos
  fetch-map.ts              Overpass → data/valencia.json
```

`npm test` · `npm run typecheck`
