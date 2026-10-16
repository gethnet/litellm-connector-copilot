import { StructuredLogger } from "../../observability/structuredLogger";

/**
 * Per-model token-count calibration from upstream usage feedback.
 *
 * Why: the heuristic tokenizer (`max(chars/3.5, words×1.3)`) undercounts dense
 * code/diff content on some backend tokenizers (observed ~1.37× on vLLM, #164).
 * Bundling real tokenizers is off the table (~22 MB js-tiktoken vs. our web
 * build; see #45/#47 history), so we learn a per-model correction factor from
 * `usage.prompt_tokens` that every request already returns.
 *
 * Invariants:
 * - The update is MULTIPLICATIVE and SELF-CORRECTING: observations compare
 *   upstream counts against the *calibrated* estimate that was actually used,
 *   so when estimates match reality the ratio is 1 and the factor is stable.
 *   No "raw estimate" bookkeeping exists anywhere.
 * - The factor only inflates estimates (clamped to [1.0, 2.0]). Shrinking
 *   budgets is the safe failure direction; the heuristic remains the floor.
 * - State is in-memory per session. Convergence takes a handful of requests;
 *   persistence is deliberately out of scope (KISS).
 */

/** Smoothing weight for each observation (EWMA-style multiplicative step). */
const CALIBRATION_ALPHA = 0.3;
/** The factor never deflates estimates below the heuristic. */
const CALIBRATION_FACTOR_MIN = 1.0;
/** Cap runaway corrections; >2× means something else is wrong. */
const CALIBRATION_FACTOR_MAX = 2.0;

const factors = new Map<string, number>();

/** Current correction factor for a model (1.0 when uncalibrated). */
export function getCalibrationFactor(modelId: string): number {
    return factors.get(modelId) ?? CALIBRATION_FACTOR_MIN;
}

/**
 * Feed one upstream usage observation.
 *
 * @param modelId raw model name (the same key `countTokens` is called with)
 * @param upstreamPromptTokens `usage.prompt_tokens` reported by the backend
 * @param calibratedEstimate the local estimate that was produced for the same
 *   prompt WITH the then-current factor already applied (i.e. whatever
 *   `countTokens` returned — callers never un-apply anything)
 */
export function recordCalibrationObservation(
    modelId: string,
    upstreamPromptTokens: number,
    calibratedEstimate: number
): void {
    if (
        !Number.isFinite(upstreamPromptTokens) ||
        !Number.isFinite(calibratedEstimate) ||
        upstreamPromptTokens <= 0 ||
        calibratedEstimate <= 0
    ) {
        return;
    }

    const observedRatio = upstreamPromptTokens / calibratedEstimate;
    const current = getCalibrationFactor(modelId);
    const updated = Math.min(
        CALIBRATION_FACTOR_MAX,
        Math.max(CALIBRATION_FACTOR_MIN, current * (1 + CALIBRATION_ALPHA * (observedRatio - 1)))
    );

    if (updated !== current) {
        factors.set(modelId, updated);
        StructuredLogger.debug("tokenizer.calibration_updated", {
            model: modelId,
            observedRatio: Number(observedRatio.toFixed(4)),
            factor: Number(updated.toFixed(4)),
        });
    }
}

/** Test seam + manual-reload hook: wipe all learned factors. */
export function resetCalibration(): void {
    factors.clear();
}
