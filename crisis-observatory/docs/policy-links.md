# Escalation and coordination policies

## Editable escalation policies

`/escalation-policies` is the human-authored catalog defining when the AI should request an operator decision through the full-screen alert. Each draft has a stable ID, title, trigger category, condition text and alert severity. CRUD, soft deletion, restoration, text search and semantic search operate on this catalog.

The catalogue is the engine's: `gabriel/policies/escalation.json`, read and written through `GET`/`PUT /api/policies`. The engine's escalation desk applies it at the end of every tick, so saving a policy changes what the next run escalates; alerts cite the policy that raised them and each recording keeps the catalogue it ran under in `meta.json`. A policy carries the thresholds the desk applies (`afterTicks`, `withinTicks`, `minIncidents`), a switch (`enabled`) and one of the ten situations the engine knows how to recognise; a condition the engine cannot detect cannot be authored here.

Nothing is kept in browser storage any more: the old `crisis-policies-v1` and `crisis-escalation-policies-v1` keys are ignored, so prior coordination edits are never treated as escalation instructions. IDs remain reserved after deletion, an invalid catalogue is refused with the reason, and a policy edited elsewhere since the editor opened it is not overwritten.

## Read-only coordination policies

`/coordination-policies` reserves the read-only document for doctrine inferred during training. It currently shows a pending-training state; it does not present initial seed rules as trained policies. A cited ID remains visible while its published text and historical version are unavailable. No editing controls or persistence writes exist on this page.

Incident citations from `applies` point to `/coordination-policies#<id>`. An externally published document can still be configured using `VITE_POLICY_URL_TEMPLATE`; `{id}` is URL-encoded, or an anchor is appended if absent. Only HTTP(S) URLs are accepted. Links open another tab.

Legacy `/policies` URLs redirect to the escalation page. Legacy URLs with an anchor redirect to the read-only coordination document, preserving old citations.

## Search

Semantic search embeds current non-deleted escalation policies and queries locally using Transformers.js in a Web Worker. The multilingual MiniLM model downloads on first use and is cached by the library. The eight nearest policies are suggestions, not applicability probabilities. Text/ID search works without downloading the model; failures and retries are explicit.

Model: https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2
