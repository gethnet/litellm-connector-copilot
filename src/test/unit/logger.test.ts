import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { Logger } from "../../utils/logger";

suite("Logger Unit Tests", () => {
	let mockChannel: {
		info: sinon.SinonSpy;
		warn: sinon.SinonSpy;
		error: sinon.SinonSpy;
		debug: sinon.SinonSpy;
		trace: sinon.SinonSpy;
		show: sinon.SinonSpy;
		dispose: sinon.SinonSpy;
	};
	let createOutputChannelStub: sinon.SinonStub;

	setup(() => {
		mockChannel = {
			info: sinon.spy(),
			warn: sinon.spy(),
			error: sinon.spy(),
			debug: sinon.spy(),
			trace: sinon.spy(),
			show: sinon.spy(),
			dispose: sinon.spy(),
		};
		createOutputChannelStub = sinon
			.stub(vscode.window, "createOutputChannel")
			.returns(mockChannel as unknown as vscode.LogOutputChannel);
	});

	teardown(() => {
		sinon.restore();
	});

	test("Logger.initialize creates channel and adds to subscriptions", () => {
		const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
		Logger.initialize(mockContext as vscode.ExtensionContext);

		assert.ok(createOutputChannelStub.calledOnce);
		assert.strictEqual(createOutputChannelStub.firstCall.args[0], "LiteLLM");
		assert.strictEqual(mockContext.subscriptions?.length, 1);
		assert.strictEqual(mockContext.subscriptions?.[0], mockChannel as unknown as vscode.LogOutputChannel);
	});

	test("Logger methods call channel methods", () => {
		const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
		Logger.initialize(mockContext as vscode.ExtensionContext);

		Logger.info("info message");
		assert.ok(mockChannel.info.calledWith("info message"));

		Logger.warn("warn message");
		assert.ok(mockChannel.warn.calledWith("warn message"));

		Logger.debug("debug message");
		assert.ok(mockChannel.debug.calledWith("debug message"));

		Logger.trace("trace message");
		assert.ok(mockChannel.trace.calledWith("trace message"));

		Logger.show();
		assert.ok(mockChannel.show.calledOnce);
	});

	test("Logger.error handles strings and Errors", () => {
		const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
		Logger.initialize(mockContext as vscode.ExtensionContext);

		Logger.error("error string");
		assert.ok(mockChannel.error.calledWith("error string"));

		const error = new Error("test error");
		error.stack = "test stack";
		Logger.error(error);
		assert.ok(mockChannel.error.calledWith("test error", "test stack"));
	});
});
