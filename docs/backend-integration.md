# V2 · integración local con Gabriel

Revisión del 19/09/2026. Base: `main` en `77f24217b455a2f06e4f1fe7ae3dd1f4e614f163`.
PR analizada: [#1, gabriel/rich-world](https://github.com/sucara-hackspain/main/pull/1), head `e6e3bc410ae6ac307dc3cb121e941ab998dd2216`. No se ha mergeado ni copiado su implementación a la aplicación.

## Estado del repo

El checkout local no tenía commits y la UI era código sin seguimiento. Se hizo fetch y pull de `origin/main`, preservando la UI y combinando las reglas locales de `.gitignore`. Los dos commits remotos contienen dos implementaciones distintas:

- `backend/`: CLI que persiste `state.json`, coordinador greedy y Master por OpenRouter. Su ciclo es coordinador → movimiento → Master. No es la implementación conectada.
- `gabriel/`: motor TypeScript, coordinador intercambiable, Master aleatorio, informes y conocimiento separados del estado del mundo, trazas por ejecución y visor con API de lectura. Es el backend solicitado y conectado.

No se han modificado `backend/` ni `gabriel/`. La PR rich-world se ha revisado sin mergearla. El backend genera archivos locales ignorados en `gabriel/runs/`.

## Cómo funciona Gabriel en main

`Simulation.step()` aplica las acciones del Master, avanza el mundo, convierte eventos en informes mediante el Observer, actualiza Belief, consulta al coordinador si hay informes nuevos y aplica sus órdenes. El resultado se guarda con un snapshot posterior a las acciones. Los registros tienen índice cero; se mantiene su reloj relativo, sin inventar una hora de comienzo de la emergencia.

`RandomMaster` introduce pacientes, cortes/reaperturas y averías de manera reproducible por semilla. No es un LLM en esta implementación. `GreedyCoordinator` prioriza TTL y proximidad, reserva destinos hospitalarios y no reconsidera una ambulancia que ya está en camino. `ClaudeCliCoordinator` usa `claude -p` con salida estructurada; devuelve situación y una razón breve por orden. Cuando falla o agota el tiempo, usa greedy con `source: fallback`. Puede devolver cero órdenes si no hay decisiones pendientes. La traza se publica al acabar cada paso; no existe streaming de tokens ni un evento que permita afirmar que un agente está razonando en ese momento.

Las ambulancias recorren aristas dirigidas de un grafo OSM. Un corte provoca cálculo de ruta o bloqueo. Una unidad a mitad de arista termina ese tramo antes de desviarse. Hay tiempos de carga y descarga, pacientes a bordo, capacidad hospitalaria, fallecimientos y órdenes rechazadas. La asistencia no termina con la recogida: el paciente se salva cuando ingresa en un hospital.

Las ambulancias salen repartidas entre los hospitales seleccionados del mapa. No existe una base única de Campanar en el contrato de main. No se modifica el motor para mantener esa hipótesis visual de la maqueta.

## API y conexión

La API existente vive en el middleware Vite de `gabriel/ui/vite.config.ts`, no en un servicio HTTP independiente:

| Lectura | Uso en la V2 |
| --- | --- |
| `GET /api/runs` | Listado y selector de ejecuciones, cada 5 s |
| `GET /api/runs/:id?from=N` | Lectura incremental de registros, cada 1,5 s mientras la ejecución está activa |
| `GET /api/graph/:map` | Callejero, geometrías y nodos de esa ejecución |

El `vite.config.ts` de la raíz reutiliza el plugin `runs-api` del backend. No duplica las reglas de simulación ni crea endpoints de escritura. La V2 carga tipos de `gabriel/src/engine/types.ts` y `trace.ts` mediante imports solo de tipos. La ejecución del motor continúa fuera del navegador, con el runner original.

La UI permite reproducir historial, navegar a un registro concreto o seguir el último recibido. Pausar el historial no pausa el motor. Un error conserva el último snapshot válido e informa de la desconexión; no cambia a datos ficticios. Cambiar de ejecución reinicia selección, mapa, reloj y filtros. Tras una ejecución finalizada o fallida se sigue leyendo hasta recibir una respuesta sin registros nuevos: el middleware lee el archivo de ticks antes de la metadata y podría observar el cierre durante esa lectura.

La integración actual es local de desarrollo. El build estático no incluye una API: para desplegar habrá que servir este contrato en un proceso HTTP o detrás de un proxy. No se ha desplegado nada.

## Cambios funcionales en la V2

- Los avisos corresponden a pacientes reales de la ejecución, sin inventar agrupaciones de incidentes que main no exporta.
- Nuevos avisos primero, estados de espera, traslado, ingreso y fallecimiento; selección por paciente.
- TTL mostrado en unidades de tiempo del simulador. Es un presupuesto nominal, no una predicción clínica; a bordo disminuye según `ttlDecayInAmbulance`.
- Flota, ocupación hospitalaria, rutas, cortes y posiciones proceden del snapshot seleccionado.
- `idle` se muestra como «Sin misión»: el snapshot omite `busyUntil`, así que no se puede garantizar disponibilidad durante descarga.
- En el flujo se distingue Master/entorno, evolución automática del motor y coordinador. Recogidas, ingresos o recálculos automáticos no se atribuyen a razonamientos del Master.
- Órdenes registradas junto a aceptación/rechazo y ETA del motor. `source` distingue IA, reglas y fallback. Se muestran `situation`, `reasons`, duración, coste y error cuando existen; no se inventan justificaciones.
- El detalle se despliega solo en el flujo central, mientras el registro lateral conserva filas compactas.
- Los marcadores usan las coordenadas registradas cada 30 segundos. Las rutas se recortan en el GPS inicial sin saltarse las curvas de la primera arista. No se interpolan líneas rectas entre snapshots ni se extrapola el futuro.
- `/v2` y `/` sirven la versión conectada con los componentes y tokens de HappyRobot. Las maquetas anteriores no forman parte de esta entrega.

## PR #1: hacia dónde va el sistema

La PR cambia el dominio, no solo añade campos opcionales:

| Main | Rich-world | Implicación para UI |
| --- | --- | --- |
| `frame.ambulances` | `frame.units`, cinco tipos | Recursos por capacidad y tipo; ambulancias básicas/medicalizadas, helicópteros, bomberos y policía |
| Paciente y TTL | Gravedad, especialidad, atrapados, falsas alarmas | Separar urgencia declarada de valoración confirmada |
| Avisos individuales | Accidentes, incendios, derrumbes, rescates y obstáculos | Incidente como agrupación persistente, con pacientes y trabajo pendiente |
| Cortes conocidos inmediatamente | Descubrimiento en ruta y zonas de agua/sin cobertura | Visualizar restricciones conocidas y eventos recibidos con retraso |
| `dispatch`, `transport`, `reposition` | También `assist`, `request_backup` | Mostrar trabajo sobre incidentes y límites de refuerzos |
| `RandomMaster` | `DanaMaster` por defecto, random para benchmark | Escenario DANA explícito y reproducible |
| Mundo exportado | Mundo más `heard`, `known`, radios conocidos | Auditoría separada de realidad y conocimiento |
| Hospitales con capacidad | Especialidades, helipuerto, cierres | Destinos válidos según tipo de recurso y paciente |

Se revisaron tipos, motor, observador, briefing, runner, traza, coordinador y representación del mapa. Sus 16 tests pasan ejecutados en una copia temporal aislada, sin checkout de la rama sobre el trabajo local.

### Huecos concretos que condicionan la siguiente integración

1. **La vista de conocimiento no es una copia fiel de Belief.** `makeFrame` exporta TTL, gravedad y estado reales del paciente junto a un booleano `known`. El visor de la PR filtra por ese booleano, pero sigue mostrando los valores del mundo. Un paciente conocido puede tener una gravedad estimada distinta o un fallecimiento aún no comunicado. Hace falta exportar un snapshot de Belief o datos equivalentes para no revelar información desconocida.
2. **Los informes pierden metadatos.** `heard` conserva `r.event`, no la fuente, confianza ni ID del informe. La recepción se puede situar en el TickRecord que contiene `heard`, pero no se conserva como metadato explícito de cada informe. Estos campos importan para explicar por qué una decisión se tomó después de que ocurriera un evento.
3. **La relación paciente–incidente no está en PatientFrame.** Existe en World y en ciertos eventos, pero no en el snapshot de pacientes. Para agrupar y reconstruir el inspector sin depender de un replay completo conviene incluir `incidentId`.
4. **No hay API HTTP de intervención.** `inject()` y `order()` son métodos internos del motor. Tampoco hay endpoints para iniciar/parar/reanudar el runner. No se añaden botones de intervención que simulen esas capacidades.
5. **No hay versión del esquema en las trazas.** Se propone `schemaVersion` y un adaptador por versión. La V2 rechaza explícitamente una traza rich-world en lugar de mostrar una flota vacía o mezclar contratos.
6. **Trazabilidad de decisiones.** Main no persiste los informes ni el Belief de entrada en `TickRecord`; PR mejora esto con `heard`, pero falta un `decisionId` y relación explícita informe → decisión → orden → resultado. Hoy las razones se relacionan por posición en el array y los resultados por contenido de la acción. Órdenes idénticas repetidas y overrides humanos requerirían IDs para distinguirlas sin ambigüedad.
7. **Disponibilidad y trayectorias.** Ambas trazas omiten `busyUntil` y parte del progreso de misión. Un booleano `available` calculado por el motor y telemetría temporal más fina permitirían mostrar disponibilidad exacta y animación continua sin inventar datos.

La V2 conectada se ciñe a main. Cuando se apruebe la PR, hay que migrar el adaptador y la vista de recursos/incidentes; no basta con cambiar una URL. El rechazo explícito del contrato evita aparentar compatibilidad que todavía no existe.

## Validación y límites

- Ejecución original de Gabriel: greedy, semilla 2, 120 registros, 5 ambulancias; 22 pacientes ingresados, 2 fallecidos y 3 abiertos. Sin llamadas a modelos ni credenciales.
- Pruebas de main: 9 tests del motor.
- PR aislada: 16 tests de motor/capas. Ejecución DANA greedy, seed 2, 200 registros: 34 ingresados, 15 fallecidos, 22 abiertos; 69 % de supervivencia entre casos finalizados y 54/94 puntos, coincidente con la PR.
- Adaptador: recorte de geometría, clasificación de eventos, disponibilidad no inferida y rechazo del contrato incompatible.
- Browser: API real → estado/GPS/capacidad/historial, expansión solo central, polling incremental, pausa, recuperación de errores, ejecuciones vacías e incompatibles, drenaje de los últimos registros al finalizar y layout móvil. También se comprobó seguimiento de un runner real (greedy, seed 7) mientras escribía, sin mocks.

La ejecución de Claude no se ha validado contra un modelo real. La UI soporta los campos de su respuesta, pero no se presentan las decisiones greedy como si fueran de IA. Las teselas del mapa siguen necesitando conexión a OpenFreeMap.
