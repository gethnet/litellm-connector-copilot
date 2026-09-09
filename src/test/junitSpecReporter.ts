/**
 * JunitSpecReporter — in-repo, version-agnostic Mocha reporter.
 *
 * Replaces the `mocha-junit-reporter` + `mocha-multi-reporters` pair. Those
 * third-party reporters construct mocha's Base reporter as a plain function
 * invocation on `this`, which throws
 * "Class constructor Base cannot be invoked without 'new'" when the resolved
 * mocha is v12 (where `Mocha.reporters.Base` became an ES class).
 *
 * Why extend `Spec`: a class `extends` clause constructs the parent correctly
 * whether it resolves to mocha 11's function-style reporter or mocha 12's
 * class reporter, so the suite keeps human-readable console output on every
 * mocha major without any dependency on how the parent is invoked. The JUnit
 * XML is produced entirely by this module — no third-party reporter involved.
 *
 * Output contract (consumed by Codecov `report_type: test_results` in CI):
 * - `<testsuites>` root element carrying `name/tests/failures/time` totals
 * - one `<testsuite>` per suite with `name/file/timestamp/tests/failures/
 *   skipped/time` attributes and `<testcase>` children (`name/classname/time`)
 * - `<failure message="…">stack</failure>` children for failed tests and
 *   `<skipped/>` for pending ones; every attribute value is XML-escaped
 * - the whole document is re-rendered on every suite completion, so a run
 *   that crashes mid-way still leaves a parseable artifact for CI to upload
 *
 * Loading: mocha resolves string reporters through `require.resolve(name)`
 * from the working directory (mocha `lib/mocha.js` `reporter()`), so
 * `.vscode-test.mjs` passes this module's absolute compiled path.
 */
import * as fs from "fs";
import * as path from "path";
// CommonJS import form: @types/mocha publishes `export =` style types and
// this module must itself publish `module.exports = <class>` for mocha's
// string-reporter loader (see the export assignment at the bottom).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Mocha = require("mocha");

const Spec = Mocha.reporters.Spec;

/** Per-suite counters and content accumulated between suite start and end. */
interface SuiteRecord {
    name: string;
    file?: string;
    timestamp: string;
    testCount: number;
    failureCount: number;
    skippedCount: number;
    time: number;
    testcases: string[];
}

/** Subset of the mocha `Test` surface this reporter reads. */
interface TestLike {
    title: string;
    duration?: number;
    err?: Error;
}

/** Subset of the mocha `Suite` surface this reporter reads. */
interface SuiteLike {
    title: string;
    root: boolean;
    file?: string;
}

/** Runner event names (mocha Runner constants, stable across majors). */
const EVENTS = {
    SUITE: "suite",
    SUITE_END: "suite end",
    TEST_PASS: "pass",
    TEST_FAIL: "fail",
    TEST_PENDING: "pending",
    RUN_END: "end",
} as const;

const ROOT_SUITE_NAME = "Root Suite";

/** XML-escape an attribute or text value (mocha-junit-reporter parity). */
function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/** Timestamp format matching the previous reporter output (space-separated). */
function suiteTimestamp(): string {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Published via the CommonJS export assignment at the bottom of this file.
class JunitSpecReporter extends Spec {
    private readonly mochaFile: string;
    private readonly rootSuiteName: string;
    private readonly suites: SuiteRecord[] = [];
    private currentSuite: SuiteRecord | undefined;
    /** Assigned by mocha's Base reporter at runtime; not on the TS surface. */
    private statsRef: { tests?: number; failures?: number; pending?: number } | undefined;

    constructor(runner: ConstructorParameters<typeof Spec>[0], options?: ConstructorParameters<typeof Spec>[1]) {
        // Class `extends` construction only — the parent is never invoked as
        // a plain function. This is the core of the version-agnostic design:
        // it works identically on mocha 11 (function-style reporters) and
        // mocha 12 (class reporters).
        super(runner, options);

        // mocha's Base reporter stores `runner.stats` on the instance at
        // runtime; capture a typed reference once so flush() can read totals
        // without depending on the parent's undeclared TS surface.
        this.statsRef = (runner as { stats?: { tests?: number; failures?: number; pending?: number } } | undefined)
            ?.stats;

        const reporterOptions = (
            options as { reporterOptions?: { mochaFile?: string; suiteName?: string } } | undefined
        )?.reporterOptions;
        this.mochaFile = reporterOptions?.mochaFile ?? "test-results.xml";
        this.rootSuiteName = reporterOptions?.suiteName ?? "Mocha Tests";

        this.ensureOutputDir();

        runner.on(EVENTS.SUITE, (suite: unknown) => this.onSuiteStart(suite));
        runner.on(EVENTS.SUITE_END, (suite: unknown) => this.onSuiteEnd(suite));
        runner.on(EVENTS.TEST_PASS, (test: unknown) => this.appendTestcase(test, "passed"));
        // mocha's contract is ('fail', test, err): the error travels as the
        // second event argument, and mocha's Base handler (registered by
        // super() before ours) is what writes it onto test.err. Read it from
        // the event argument first so we do not depend on Base's mutation
        // ordering — and never call helpers that assume test.err is the only
        // carrier.
        runner.on(EVENTS.TEST_FAIL, (test: unknown, err: unknown) => this.appendTestcase(test, "failed", err));
        runner.on(EVENTS.TEST_PENDING, (test: unknown) => this.appendTestcase(test, "pending"));
        runner.on(EVENTS.RUN_END, () => this.flush());
    }

    /** Create the output directory before the first write (junit-reporter parity). */
    private ensureOutputDir(): void {
        const dir = path.dirname(this.mochaFile);
        if (dir && dir !== "." && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private onSuiteStart(suite: unknown): void {
        const s = this.asSuite(suite);
        if (!s || s.root) {
            return;
        }
        this.currentSuite = {
            name: s.title || ROOT_SUITE_NAME,
            file: s.file,
            timestamp: suiteTimestamp(),
            testCount: 0,
            failureCount: 0,
            skippedCount: 0,
            time: 0,
            testcases: [],
        };
    }

    private onSuiteEnd(suite: unknown): void {
        const s = this.asSuite(suite);
        if (!s || s.root) {
            return;
        }
        const record = this.currentSuite;
        this.currentSuite = undefined;
        if (!record) {
            return;
        }
        this.suites.push(record);
        // Rewrite the whole document so the artifact on disk is always a
        // complete, parseable XML file — even if the process dies mid-run.
        this.flush();
    }

    private appendTestcase(test: unknown, outcome: "passed" | "failed" | "pending", failErr?: unknown): void {
        const t = this.asTest(test);
        const record = this.ensureCurrentSuiteRecord();
        const durationSeconds = (t.duration ?? 0) / 1000;
        record.testCount += 1;
        record.time += t.duration ?? 0;

        if (outcome === "pending") {
            record.skippedCount += 1;
            record.testcases.push(
                `<testcase name="${escapeXml(t.title)}" classname="${escapeXml(record.name)}"><skipped/></testcase>`
            );
            return;
        }

        if (outcome === "failed") {
            record.failureCount += 1;
            // Prefer the event-argument error (mocha's documented carrier);
            // fall back to test.err for reporters driven through the Base
            // mutation path.
            const err = failErr instanceof Error ? failErr : t.err;
            const message = err?.message ?? "unknown error";
            const detail = err?.stack ?? message;
            record.testcases.push(
                `<testcase name="${escapeXml(t.title)}" classname="${escapeXml(
                    record.name
                )}" time="${durationSeconds.toFixed(3)}">` +
                    `<failure message="${escapeXml(message)}">${escapeXml(detail)}</failure>` +
                    `</testcase>`
            );
            return;
        }

        record.testcases.push(
            `<testcase name="${escapeXml(t.title)}" classname="${escapeXml(record.name)}" time="${durationSeconds.toFixed(3)}"/>`
        );
    }

    /** Suite record for tests that fire outside any started suite (root-level tests). */
    private ensureCurrentSuiteRecord(): SuiteRecord {
        if (!this.currentSuite) {
            this.currentSuite = {
                name: ROOT_SUITE_NAME,
                timestamp: suiteTimestamp(),
                testCount: 0,
                failureCount: 0,
                skippedCount: 0,
                time: 0,
                testcases: [],
            };
        }
        return this.currentSuite;
    }

    /** Render the complete document from all completed suites plus the active one. */
    private flush(): void {
        // Base assigns `this.stats` at runtime (runner.stats) but the TS
        // surface of Spec does not declare it, so read it through the runner
        // reference captured at construction time instead.
        const stats = this.statsRef;
        const all = this.currentSuite ? [...this.suites, this.currentSuite] : this.suites;
        const totalTests = stats?.tests ?? all.reduce((sum, s) => sum + s.testCount, 0);
        const totalFailures = stats?.failures ?? all.reduce((sum, s) => sum + s.failureCount, 0);
        const totalTime = all.reduce((sum, s) => sum + s.time, 0) / 1000;

        const lines: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<testsuites name="${escapeXml(this.rootSuiteName)}" tests="${totalTests}" failures="${totalFailures}" time="${totalTime.toFixed(3)}">`,
        ];
        for (const suite of all) {
            const attrs = [
                `name="${escapeXml(suite.name)}"`,
                suite.file ? `file="${escapeXml(suite.file)}"` : "",
                `timestamp="${suite.timestamp}"`,
                `tests="${suite.testCount}"`,
                `failures="${suite.failureCount}"`,
                `skipped="${suite.skippedCount}"`,
                `time="${(suite.time / 1000).toFixed(3)}"`,
            ]
                .filter(Boolean)
                .join(" ");
            lines.push(`<testsuite ${attrs}>`);
            lines.push(...suite.testcases);
            lines.push("</testsuite>");
        }
        lines.push("</testsuites>");
        fs.writeFileSync(this.mochaFile, lines.join("\n") + "\n");
    }

    private asSuite(suite: unknown): SuiteLike | undefined {
        const s = suite as SuiteLike | undefined;
        if (!s || typeof s.title !== "string") {
            return undefined;
        }
        return s;
    }

    private asTest(test: unknown): TestLike {
        const t = test as TestLike | undefined;
        const title = typeof t?.title === "string" ? t.title : "unknown test";
        const duration = typeof t?.duration === "number" ? t.duration : 0;
        const err = t?.err instanceof Error ? t.err : undefined;
        return { title, duration, err };
    }
}

// Mocha loads string reporters with `new (require(resolved))` and passes the
// whole module as the constructor, so the class itself must be the CommonJS
// export (namespace-object exports — `exports.X = ...` — are not
// constructible and fail with "this._reporter is not a constructor").
// This mirrors how mocha-junit-reporter publishes itself.
export = JunitSpecReporter;
