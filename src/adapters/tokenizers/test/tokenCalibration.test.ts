import * as assert from "assert";
import { getCalibrationFactor, recordCalibrationObservation, resetCalibration } from "../tokenCalibration";

suite("TokenCalibration Unit Tests", () => {
    setup(() => {
        resetCalibration();
    });

    teardown(() => {
        resetCalibration();
    });

    test("factor defaults to 1.0 for unseen models", () => {
        assert.strictEqual(getCalibrationFactor("never-seen"), 1.0);
    });

    test("observation above estimate raises the factor toward the observed ratio", () => {
        // Upstream counted 1370 where we estimated 1000 → ratio 1.37 (the #164 shape).
        recordCalibrationObservation("vllm-model", 1370, 1000);
        const factor = getCalibrationFactor("vllm-model");
        assert.ok(factor > 1.0, `factor should rise above 1.0, got ${factor}`);
        assert.ok(factor <= 1.37, `single EWMA step must not overshoot the ratio, got ${factor}`);
    });

    test("repeated observations converge near the true ratio", () => {
        for (let i = 0; i < 25; i++) {
            // Simulate the self-correcting loop: upstream is 1.37× the *raw* heuristic,
            // and the caller's estimate is already inflated by the current factor.
            const calibratedEstimate = Math.round(1000 * getCalibrationFactor("vllm-model"));
            recordCalibrationObservation("vllm-model", 1370, calibratedEstimate);
        }
        const factor = getCalibrationFactor("vllm-model");
        assert.ok(Math.abs(factor - 1.37) < 0.05, `expected convergence near 1.37, got ${factor}`);
    });

    test("factor never deflates below 1.0 when upstream counts less than the estimate", () => {
        recordCalibrationObservation("prose-model", 500, 1000);
        assert.strictEqual(getCalibrationFactor("prose-model"), 1.0);
    });

    test("factor is clamped at 2.0", () => {
        for (let i = 0; i < 100; i++) {
            recordCalibrationObservation("wild-model", 10000, 1000);
        }
        assert.strictEqual(getCalibrationFactor("wild-model"), 2.0);
    });

    test("zero or invalid observations are ignored", () => {
        recordCalibrationObservation("m", 0, 1000);
        recordCalibrationObservation("m", 1000, 0);
        recordCalibrationObservation("m", -5, 100);
        recordCalibrationObservation("m", NaN, 100);
        assert.strictEqual(getCalibrationFactor("m"), 1.0);
    });

    test("models calibrate independently", () => {
        recordCalibrationObservation("model-a", 1500, 1000);
        assert.strictEqual(getCalibrationFactor("model-b"), 1.0);
        assert.ok(getCalibrationFactor("model-a") > 1.0);
    });
});
