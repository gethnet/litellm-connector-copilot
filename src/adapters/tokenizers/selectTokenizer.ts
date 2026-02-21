import type { LiteLLMModelInfo } from "../../types";
import { HeuristicTokenizer } from "./heuristicTokenizer";
import type { Tokenizer } from "./types";

export function selectTokenizer(_modelId: string, _modelInfo?: LiteLLMModelInfo): Tokenizer {
    // For now, always use heuristic.
    // Future: check modelInfo or settings to use Tiktoken for GPT models.
    return new HeuristicTokenizer();
}
