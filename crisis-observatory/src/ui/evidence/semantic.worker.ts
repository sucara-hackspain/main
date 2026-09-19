import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
env.allowLocalModels = false;
env.backends.onnx.wasm!.numThreads = 1;
let extractor: Promise<FeatureExtractionPipeline> | undefined;
// Narrow the generic task factory to avoid materialising every pipeline union in TypeScript.
const createExtractor = pipeline as (task: "feature-extraction", model: string, options: { dtype: "q8"; device: "wasm"; progress_callback: (p: { status: string; file?: string; progress?: number }) => void }) => Promise<FeatureExtractionPipeline>;
const vectors = new Map<string, number[]>();
let latest = 0;
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  latest = data.request;
  if (!data.query) return;
  queue = queue.then(async () => {
    if (data.request !== latest) return;
    const send = (payload: object) => self.postMessage({ request: data.request, ...payload });
    try {
      send({ status: "Preparando búsqueda semántica… La primera vez se descarga el modelo." });
      extractor ??= createExtractor("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", { dtype: "q8", device: "wasm", progress_callback: p => {
        if (p.status === "progress" && p.file?.endsWith(".onnx")) send({ status: `Descargando modelo · ${Math.round(p.progress ?? 0)} %` });
      } });
      const model = await extractor;
      const embed = async (text: string) => {
        if (!vectors.has(text)) {
          const out = await model(text, { pooling: "mean", normalize: true });
          vectors.set(text, Array.from(out.data as Float32Array));
        }
        return vectors.get(text)!;
      };
      const query = await embed(data.query);
      const results: {id: string; score: number}[] = [];
      for (const [index, policy] of data.policies.entries()) {
        if (data.request !== latest) return;
        send({ status: `Comparando políticas · ${index + 1}/${data.policies.length}` });
        const vector = await embed(policy.title + ". " + policy.body);
        results.push({ id: policy.id, score: vector.reduce((sum, v, i) => sum + v * query[i], 0) });
      }
      // Always rank neighbours, not probabilities of policy applicability.
      send({ results: results.sort((a,b) => b.score - a.score).slice(0, 8) });
    } catch {
      extractor = undefined;
      send({ error: "No se pudo cargar la búsqueda semántica. Revisa la conexión y reintenta, o utiliza la búsqueda por texto." });
    }
  });
};
