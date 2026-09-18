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
```

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
  simulation.ts             step(): coordinador → mover → master → fin de turno
  master/schema.ts          plan del Master (zod) y límites por turno
  master/briefing.ts        resumen + candidatos que ve el Master
  master/llm-master.ts      Master IA (OpenRouter, salida estructurada por JSON Schema)
  render.ts                 tablas de estado por consola
  cli.ts                    comandos
  fetch-map.ts              Overpass → data/valencia.json
```

`npm test` · `npm run typecheck`
