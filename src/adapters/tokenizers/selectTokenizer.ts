import type { LiteLLMModelInfo } from "../../types";
import { HeuristicTokenizer } from "./heuristicTokenizer";
import { TiktokenTokenizer } from "./tiktokenTokenizer";
import type { Tokenizer } from "./types";

export function selectTokenizer(modelId: string, modelInfo?: LiteLLMModelInfo): Tokenizer {
    // OpenAI and compatible models (most LiteLLM proxies) use Tiktoken (cl100k_base)
    const provider = modelInfo?.litellm_provider || "";
    const isOpenAICompatible =
        provider === "openai" ||
        provider === "azure" ||
        modelId.startsWith("gpt-") ||
        modelId.startsWith("text-embedding-");

    if (isOpenAICompatible) {
        return new TiktokenTokenizer(modelId);
    }

    // For other providers (Anthropic, Google, etc.), we still use heuristic
    // until we add their specific tokenizers.
    return new HeuristicTokenizer();
}
