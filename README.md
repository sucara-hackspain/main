# HackSpain 2026 · ¿Puede la IA gestionar una crisis?

Tres paquetes independientes, cada uno con sus dependencias y su README:

| Directorio | Qué es | Arranque |
| --- | --- | --- |
| [`gabriel/`](gabriel/README.md) | Simulador de una DANA sobre el callejero real de València: mundo, información imperfecta (llamadas 112, incidentes, agua inferida), cuatro tipos de unidad, coordinadores (reglas y Claude) y visor propio. | `cd gabriel && pnpm install && pnpm run-sim --coordinator greedy && pnpm ui` |
| [`crisis-observatory/`](crisis-observatory/README.md) | Control Center: panel React conectado a HappyRobot V2 que lee las ejecuciones de `gabriel/runs/`. **Pendiente de portar al formato nuevo de ejecuciones.** | `cd crisis-observatory && npm install && npm run dev` |
| [`backend/`](backend/README.md) | Simulador de emergencias independiente con CLI y estado en `state.json`. | ver su README |
