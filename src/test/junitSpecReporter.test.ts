import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
// CommonJS import form: the reporter publishes `module.exports = <class>` for
// mocha's string-reporter loader, so the test imports it the same way.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import JunitSpecReporter = require("./junitSpecReporter");

/**
 * Minimal Runner double: an EventEmitter carrying the stats object mocha's
 * Base/Spec reporters read (runner.stats). We do not emulate mocha's full
 * Runner payload — the reporter contract only consumes suite/test shapes,
 * stats counters, and the events listed in junitSpecReporter.ts.
 */
type RunnerDouble = EventEmitter & {
    stats: { tests: number; passes: number; failures: number; pending: number; duration: number };
};

function createRunnerDouble(stats: { tests: number; passes: number; failures: number; pending: number }): RunnerDouble {
    const runner = new EventEmitter() as RunnerDouble;
    // `duration` is required: mocha's Spec epilogue formats stats.duration
    // through the ms package, which throws on undefined.
    runner.stats = { ...stats, duration: 1 };
    return runner;
}

function createTestDouble(
    overrides: Partial<{
        title: string;
        fullTitle: () => string;
        titlePath: () => string[];
        duration: number;
        slow: () => number;
        state: string;
    }> = {}
) {
    return {
        title: "sample test",
        fullTitle: () => "Suite sample test",
        // titlePath is required by mocha's Base failure listing (list()) at
        // run end; the double mirrors the mocha Test surface it reads.
        titlePath: () => ["Suite", "sample test"],
        duration: 5,
        slow: () => 75,
        state: "passed",
        ...overrides,
    };
}

function createSuiteDouble(overrides: Partial<{ title: string; root: boolean; file?: string }> = {}) {
    return {
        title: "",
        root: true,
        ...overrides,
    };
}

function tmpResultsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junit-reporter-"));
    return path.join(dir, "test-results.xml");
}

/** Assert helper: read the current XML artifact contents. */
function readXml(mochaFile: string): string {
    return fs.readFileSync(mochaFile, "utf8");
}

suite("JunitSpecReporter", () => {
    test("source never invokes the mocha Base constructor as a plain function call", () => {
        // The core regression this reporter exists to prevent: third-party
        // reporters constructed mocha 11-style by calling the Base reporter
        // function on `this`, which throws
        // "Class constructor Base cannot be invoked without 'new'" once the
        // resolved mocha is v12 (Base is an ES class there). This reporter
        // must only ever construct its parent through the class `extends`
        // mechanism, which works for both shapes.
        const source = fs.readFileSync(path.join(__dirname, "junitSpecReporter.js"), "utf8");
        assert.ok(!/\.\s*call\s*\(\s*this\b/.test(source), "must never invoke a parent constructor via .call(this)");
        assert.ok(/extends\s+Spec\b/.test(source), "must extend mocha's built-in Spec (works on mocha 11 and 12)");
    });

    test("writes a complete JUnit XML document with testsuites totals on run end", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 2, passes: 1, failures: 1, pending: 0 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        // Only passing events here: emitting 'fail' would make the real
        // mocha Spec epilogue list the phantom failure and fail the actual
        // test run's exit code. Totals are asserted from the runner stats
        // the reporter captures, not from emitted failures.
        runner.emit("suite", createSuiteDouble({ title: "Alpha", root: false }));
        runner.emit("pass", createTestDouble());
        runner.emit("suite end", createSuiteDouble({ title: "Alpha", root: false }));
        runner.emit("end");

        const xml = readXml(mochaFile);
        assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'), "XML prolog");
        assert.ok(/<testsuites[^>]*tests="2"/.test(xml), "total tests from runner stats");
        assert.ok(/<testsuites[^>]*failures="1"/.test(xml), "failures from runner stats");
        assert.ok(xml.trimEnd().endsWith("</testsuites>"), "document closed");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });

    test("suite completion writes a testsuite element with name, timestamp, and counts", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 1, passes: 1, failures: 0, pending: 0 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        runner.emit("suite", createSuiteDouble({ title: "RequestBuilder", root: false }));
        runner.emit("pass", createTestDouble());
        runner.emit("suite end", createSuiteDouble({ title: "RequestBuilder", root: false }));

        const xml = readXml(mochaFile);
        assert.ok(/<testsuite[^>]*name="RequestBuilder"/.test(xml), "suite name attribute");
        assert.ok(/<testsuite[^>]*timestamp="/.test(xml), "timestamp attribute");
        assert.ok(/<testsuite[^>]*tests="1"/.test(xml), "suite test count");
        assert.ok(/<testsuite[^>]*failures="0"/.test(xml), "suite failure count");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });

    test("passing test emits a testcase with classname and seconds-based time", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 1, passes: 1, failures: 0, pending: 0 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        runner.emit("suite", createSuiteDouble({ title: "RequestBuilder", root: false }));
        runner.emit("pass", createTestDouble({ title: "downgrades forced tool_choice", duration: 5 }));
        runner.emit("suite end", createSuiteDouble({ title: "RequestBuilder", root: false }));

        const xml = readXml(mochaFile);
        assert.ok(/<testcase[^>]*name="downgrades forced tool_choice"/.test(xml), "test name attribute");
        assert.ok(/<testcase[^>]*classname="RequestBuilder"/.test(xml), "classname from suite title");
        assert.ok(/<testcase[^>]*time="0\.005"/.test(xml), "duration in seconds with 3 decimals");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });

    test("failing test emits a failure child with escaped message and stack detail", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 1, passes: 0, failures: 1, pending: 0 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        runner.emit("suite", createSuiteDouble({ title: "StreamInterpreter", root: false }));
        runner.emit(
            "fail",
            createTestDouble({ title: "decodes partial frames", state: "failed" }),
            new Error('expected "chunk" but got "" (partial <frame> & more)')
        );
        runner.emit("suite end", createSuiteDouble({ title: "StreamInterpreter", root: false }));

        const xml = readXml(mochaFile);
        assert.ok(/<failure[^>]*message="/.test(xml), "failure element carries message attribute");
        assert.ok(xml.includes("&lt;frame&gt; &amp; more"), "XML-escaped error message content");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });

    test("pending test emits skipped count and a skipped child element", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 1, passes: 0, failures: 0, pending: 1 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        runner.emit("suite", createSuiteDouble({ title: "Pending", root: false }));
        runner.emit("pending", createTestDouble({ title: "not ready", state: "pending" }));
        runner.emit("suite end", createSuiteDouble({ title: "Pending", root: false }));

        const xml = readXml(mochaFile);
        assert.ok(/<testsuite[^>]*skipped="1"/.test(xml), "suite skipped count attribute");
        assert.ok(/<skipped\s*\/>/.test(xml), "skipped child element present");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });

    test("artifact is parseable immediately after a suite completes, not only at run end", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 0, passes: 0, failures: 0, pending: 0 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        runner.emit("suite", createSuiteDouble({ title: "EarlySuite", root: false }));
        runner.emit("pass", createTestDouble({ title: "first" }));
        runner.emit("suite end", createSuiteDouble({ title: "EarlySuite", root: false }));

        // No "end" emitted: the document must already be complete on disk so
        // a crashed run still leaves a parseable artifact for CI to upload.
        const xml = readXml(mochaFile);
        assert.ok(xml.includes("<testsuites"), "document root present");
        assert.ok(xml.trimEnd().endsWith("</testsuites>"), "document closed after suite end alone");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });

    test("nested suites report under their own names; root suite is excluded", () => {
        const mochaFile = tmpResultsPath();
        const runner = createRunnerDouble({ tests: 2, passes: 2, failures: 0, pending: 0 });
        new JunitSpecReporter(runner as never, { reporterOptions: { mochaFile } } as never);

        // Root suite start/end must not produce a testsuite element.
        runner.emit("suite", createSuiteDouble({ title: "", root: true }));
        runner.emit("suite", createSuiteDouble({ title: "Outer", root: false }));
        runner.emit("pass", createTestDouble({ title: "outer test" }));
        runner.emit("suite end", createSuiteDouble({ title: "Outer", root: false }));
        runner.emit("suite end", createSuiteDouble({ title: "", root: true }));

        const xml = readXml(mochaFile);
        // Anchored on '<testsuite ' (with space) so the root <testsuites>
        // element is not also matched by the [^>]* name capture.
        const suiteMatches = xml.match(/<testsuite [^>]*name="([^"]*)"/g) ?? [];
        assert.strictEqual(suiteMatches.length, 1, "only the non-root suite is emitted");
        assert.ok(/name="Outer"/.test(xml), "outer suite present by name");
        fs.rmSync(path.dirname(mochaFile), { recursive: true, force: true });
    });
});
