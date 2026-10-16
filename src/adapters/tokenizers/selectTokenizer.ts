import type { LiteLLMModelInfo } from "../../types";
import { HeuristicTokenizer } from "./heuristicTokenizer";
import type { Tokenizer } from "./types";

/**
 * Tokenizer selection — currently heuristic-only, by design.
 *
 * History (#45/#47/#166): js-tiktoken shipped in v1.4.1 and was removed after
 * it crashed the extension host; its ~22 MB BPE tables are also prohibitive
 * for the web build (`dist/web/extension.js`). Accuracy is instead achieved by
 * per-model usage-feedback calibration applied in `countTokens`
 * (see `tokenCalibration.ts`) plus best-effort remote exact counts via
 * LiteLLM `/utils/token_counter`. Do not reintroduce a bundled tokenizer.
 *
 * The signature keeps `modelId`/`modelInfo` so future per-family strategies
 * can slot in without touching the many call sites.
 */
export function selectTokenizer(_modelId: string, _modelInfo?: LiteLLMModelInfo): Tokenizer {
    return new HeuristicTokenizer();
}
