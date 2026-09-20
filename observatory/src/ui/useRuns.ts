import { useEffect, useState } from "react";
import {
  assertEngineRecords,
  type GraphData,
  type RunMeta,
  type TickRecord,
} from "./engineTrace";
async function json<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (!response.ok)
    throw new Error(`No se pudo leer la ejecución (${response.status}).`);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "El servicio de datos no está disponible. Reinicia el servidor con npm run dev.",
    );
  return response.json();
}
export function useRuns() {
  const [runs, setRuns] = useState<RunMeta[]>([]),
    [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await json<RunMeta[]>("/api/runs", abort.signal);
        if (!Array.isArray(data))
          throw new Error("Listado de ejecuciones inválido");
        setRuns(data);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Error de conexión");
      } finally {
        if (!abort.signal.aborted) {
          setLoaded(true);
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  return { runs, error, loaded };
}
export function useRun(id: string) {
  const [meta, setMeta] = useState<RunMeta | null>(null),
    [ticks, setTicks] = useState<TickRecord[]>([]),
    [graph, setGraph] = useState<GraphData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loaded = 0,
      lastTick = -1,
      mapName = "";
    async function poll() {
      try {
        const data = await json<{ meta: RunMeta; ticks: TickRecord[] }>(
          `/api/runs/${encodeURIComponent(id)}?from=${loaded}`,
          abort.signal,
        );
        assertEngineRecords(data.ticks);
        let nextLastTick = lastTick;
        for (const record of data.ticks) {
          if (record.tick <= nextLastTick)
            throw new Error(
              "La ejecución cambió o contiene registros desordenados. Recarga la página.",
            );
          nextLastTick = record.tick;
        }
        if (mapName !== data.meta.map) {
          const next = await json<GraphData>(
            `/api/graph/${encodeURIComponent(data.meta.map)}`,
            abort.signal,
          );
          if (!next.nodes?.length || !next.edges?.length)
            throw new Error("El mapa de la ejecución no es válido.");
          setGraph(next);
          mapName = data.meta.map;
        }
        if (abort.signal.aborted) return;
        lastTick = nextLastTick;
        loaded += data.ticks.length;
        setMeta(data.meta);
        if (data.ticks.length) setTicks((prev) => [...prev, ...data.ticks]);
        setError("");
        // The existing API reads ticks before meta; the runner may finish between those reads.
        // Drain once more until an ended run returns no new records.
        if (data.meta.status !== "running" && data.ticks.length === 0) return;
      } catch (e) {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Error de lectura");
      }
      timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [id]);
  return { meta, ticks, graph, error };
}
