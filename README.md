![El 112 de la Generalitat dejó sin atender más de 40.000 llamadas durante los días de la dana en Valencia.](docs/readme-happyrobot/112-valencia.png)
<sub>elDiario.es · Recorte aportado por el equipo.</sub>

# ¿Puede la IA gestionar una crisis?

**HackSpain 2026 · HappyRobot · DANA en Valencia**

**Objetivo:** minimizar la tasa de fallecidos por catástrofe.
**Solución:** agentes para priorizar incidencias, asignar recursos y adaptar intervenciones.
**Validación:** escenarios simulados. Sin resultados acreditados en emergencias reales.

Una noche de DANA se simula entera —llamadas al 112, dotaciones, agua que corta calles, gente que no puede llamar— y un agente coordina la respuesta. Sobre esa simulación, el **Control Center** deja entender la situación, ver qué está haciendo el sistema e intervenir cuando hace falta.

## Levantarlo en local

Necesitas **Node 22.13 o superior** (el motor usa el SQLite que trae Node) y unos 500 MB libres. No hace falta ninguna clave para lo básico.

```sh
cd observatory
npm install
npm run data:local     # graba una noche de ejemplo (coordinador por reglas, ~1 min)
npm run dev            # http://127.0.0.1:5173
```

En el selector **Ejecución** aparecen las noches grabadas; se abre la última. Pulsa «Ir al final» para ver la noche completa, o mueve la línea temporal para revivirla registro a registro.

Qué mirar:

- **Incidencias**: cada aviso con su expediente. Al abrir uno, su cronología cuenta quién llamó, qué dijo, qué ordenó el coordinador y por qué, con la política que citó.
- **Territorio**: el mapa con las dotaciones, el agua conocida frente a la real y las zonas aisladas. Al seleccionar una incidencia, el mapa la enfoca y atenúa el resto.
- **La sala de decisión**: cuando el motor escala algo, toma la pantalla en rojo (o ámbar si es supervisión) con el mapa del incidente, la recomendación, el plazo y las opciones. Sale de las políticas de `observatory/policies/escalation.json`, editables en `/escalation-policies`.

Para una noche grande, con cientos de incidencias a la vez:

```sh
npm run lab:demo X2 palabras    # ~4 min; queda en runs/demo-X2-palabras
```

Con el catálogo que viene por defecto, esa noche pide una decisión humana una sola vez.

## Hacer correr el simulador

```sh
npm run sim                                  # una noche por consola, coordinador por reglas
npm run sim -- --runs 20 --quiet             # 20 noches y su media
npm run run-sim -- --coordinator greedy      # noche grabada en runs/, sin agentes
npm run viewer                               # visor del motor: verdad contra creencia, memoria
```

Con agentes de verdad hace falta una clave. Copia `observatory/.env.example` a `observatory/.env` y rellénala:

```sh
npm run run-sim -- --coordinator happyrobot  # el agente decide dentro de un workflow de HappyRobot
npm run run-sim -- --coordinator claude      # el agente decide con el CLI de Claude Code
```

El agente decide con una doctrina que aprende de sus propias noches (`observatory/memory/`), y cita las reglas que sigue en cada orden. `npm run lab` entrena esa doctrina sobre noches congeladas; `docs/engine.md` lo explica entero.

## Qué hay dónde

| Directorio | Qué es |
| --- | --- |
| `observatory/src/ui/` | El Control Center: mapa, incidencias, sala de decisión. |
| `observatory/src/engine/` | El simulador: mundo, víctimas, agua, llamadas, escalado. Sin dependencias del navegador. |
| `observatory/src/coordinators/`, `masters/`, `phone/`, `triage/` | Los agentes: quien coordina, quien decide la noche, la línea 112 y el triaje. |
| `observatory/src/memory/`, `src/lab/` | La doctrina del agente y el laboratorio que la entrena y la mide. |
| `observatory/server/` | La API de lectura que sirve ejecuciones, callejero y políticas a la UI. |
| `observatory/data/`, `lab/`, `policies/`, `memory/`, `runs/` | Callejero, noches congeladas, catálogo de escalado, memoria y grabaciones. |
| `observatory/viewer/` | Visor del motor, aparte del Control Center. |
| `docs/` | `engine.md` (el simulador a fondo) e imágenes. |

Más detalle: [`observatory/README.md`](observatory/README.md) para el Control Center, [`docs/engine.md`](docs/engine.md) para el motor, [`observatory/docs/`](observatory/docs/) para el contrato de datos y las políticas.

## Tests

```sh
cd observatory
npm test            # modelos del Control Center
npm run test:engine # el simulador
npm run test:ui     # navegador, con Chrome instalado
npm run build       # TypeScript + build de producción
```
