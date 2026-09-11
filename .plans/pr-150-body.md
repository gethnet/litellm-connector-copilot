### Change Log / Overview

Release v2.5.7 — fixes reasoning/thinking blocks being silently dropped on the LiteLLM `/responses` endpoint and promotes the package to **2.5.7**.

**The bug:** the stream interpreter listened for `/responses` reasoning event names LiteLLM never emits (`response.output_reasoning.delta`, raw Anthropic `content_block_*`), so thinking from every non-OpenAI reasoning model (Claude Fable 5.1, Z.ai GLM, DeepSeek) never surfaced and Anthropic signature continuity data was lost.

**The fix:**
- **New `src/adapters/streaming/responsesReasoningEvents.ts`**: pure event→thinking-part mapping for the real LiteLLM bridge sequence — `output_item.added`/`output_item.done` with `item.type "reasoning"`, `reasoning_summary_text.delta`, and the native OpenAI `reasoning_text.delta` alias. Block close captures `encrypted_content`/`signature` continuity metadata compatible with the existing replay path (`extractOpaqueThinkingBlock` → `responsesAdapter.ts` reasoning input items).
- **Interpreter wiring**: all `/responses` frames route through the reasoning module before other branches; the tool-call legacy flush-all is guarded so a reasoning item closing between tool-call fragments can no longer drain pending buffers early. Fictional handlers and their dead state are deleted (1148→1093 lines).
- **Request side**: `transformToResponsesFormat` now sends `reasoning: { effort, summary: "auto" }` (when effort is set and adaptive `thinking` is absent) so OpenAI o-series/gpt-5 actually return summary text.
- **Tests rewritten to the real sequence**: 10 new module tests; interpreter suite, e2e redacted-thinking test, and integration round-trip no longer assert fictional events. `/chat/completions` reasoning path unchanged.
- **Release artifacts**: `package.json` bumped 2.5.6 → 2.5.7, `CHANGELOG.md` `[2.5.7]` section with compare links, `README.md` / `README.marketplace.md` "What's New" sections updated.
- `AGENTS.md` Adapters section updated with the real event names.

### Related Issues, Builds, Pipeline Runs, etc.

- Fixes #149
- Plan: `.plans/completed/responses-reasoning-events.prompt.md` (local, not tracked)

### Pull Request Pre-check

- [x] Linting Validation Passed — `npm run lint` 0 errors (33 pre-existing warnings, none in changed files)
- [x] Formatting Validation Passed — `npm run format` clean
- [x] Unit Testing Passes — `npm run test:coverage` 1008 passing / 0 failing; coverage up in all categories vs baseline (Statements 91.78%, Branches 82.89%, Functions 89.08%, Lines 91.78%)
- [x] Documentation Updated — AGENTS.md, CHANGELOG.md, README.md, README.marketplace.md
