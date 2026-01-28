import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { registerManageConfigCommand } from "../../commands/manageConfig";
import { ConfigManager } from "../../config/configManager";

suite("ManageConfig Command Unit Tests", () => {
	let sandbox: sinon.SinonSandbox;
	let mockConfigManager: sinon.SinonStubbedInstance<ConfigManager>;
	let mockContext: vscode.ExtensionContext;

	setup(() => {
		sandbox = sinon.createSandbox();
		mockConfigManager = sandbox.createStubInstance(ConfigManager);
		mockContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
	});

	teardown(() => {
		sandbox.restore();
	});

	test("registers command correctly", () => {
		const registerStub = sandbox.stub(vscode.commands, "registerCommand");
		registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);
		assert.strictEqual(registerStub.calledWith("litellm-connector.manage"), true);
	});

	test("updates config when input is provided", async () => {
		mockConfigManager.getConfig.resolves({ url: "old-url", key: "old-key" });
		const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
		showInputBoxStub.onFirstCall().resolves("new-url");
		showInputBoxStub.onSecondCall().resolves("new-key");
		const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

		// Get the registered command handler
		let commandHandler: (() => Promise<void>) | undefined;
		sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
			if (id === "litellm-connector.manage") {
				commandHandler = handler as () => Promise<void>;
			}
			return { dispose: () => {} } as vscode.Disposable;
		});

		registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

		if (commandHandler) {
			await commandHandler();
		}

		assert.strictEqual(
			mockConfigManager.setConfig.calledWith({
				url: "new-url",
				key: "new-key",
			}),
			true
		);
		assert.strictEqual(showInfoStub.calledOnce, true);
	});

	test("aborts if URL input is cancelled", async () => {
		mockConfigManager.getConfig.resolves({ url: "", key: "" });
		const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
		showInputBoxStub.onFirstCall().resolves(undefined);

		let commandHandler: (() => Promise<void>) | undefined;
		sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
			if (id === "litellm-connector.manage") {
				commandHandler = handler as () => Promise<void>;
			}
			return { dispose: () => {} } as vscode.Disposable;
		});

		registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

		if (commandHandler) {
			await commandHandler();
		}

		assert.strictEqual(mockConfigManager.setConfig.called, false);
	});

	test("shows unmasked API key when 'thisisunsafe' is entered with existing key", async () => {
		mockConfigManager.getConfig.resolves({ url: "my-url", key: "secret-api-key" });
		const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
		showInputBoxStub.onFirstCall().resolves("my-url"); // URL
		showInputBoxStub.onSecondCall().resolves("thisisunsafe"); // Magic string
		showInputBoxStub.onThirdCall().resolves("secret-api-key"); // Unmasked key (user didn't change it)
		const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

		let commandHandler: (() => Promise<void>) | undefined;
		sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
			if (id === "litellm-connector.manage") {
				commandHandler = handler as () => Promise<void>;
			}
			return { dispose: () => {} } as vscode.Disposable;
		});

		registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

		if (commandHandler) {
			await commandHandler();
		}

		// Should have called showInputBox 3 times: URL, masked key, then unmasked key
		assert.strictEqual(showInputBoxStub.callCount, 3);

		// The second call should have password: true
		const secondCall = showInputBoxStub.getCall(1);
		assert.strictEqual(secondCall.args[0]?.password, true);

		// The third call should have password: false
		const thirdCall = showInputBoxStub.getCall(2);
		assert.strictEqual(thirdCall.args[0]?.password, false);
		assert.strictEqual(thirdCall.args[0]?.value, "secret-api-key");

		// Should save the key unchanged
		assert.strictEqual(
			mockConfigManager.setConfig.calledWith({
				url: "my-url",
				key: "secret-api-key",
			}),
			true
		);
		assert.strictEqual(showInfoStub.calledOnce, true);
	});

	test("does not show unmasked key if 'thisisunsafe' is entered without existing key", async () => {
		mockConfigManager.getConfig.resolves({ url: "my-url", key: undefined });
		const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
		showInputBoxStub.onFirstCall().resolves("my-url"); // URL
		showInputBoxStub.onSecondCall().resolves("thisisunsafe"); // Magic string but no existing key
		const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

		let commandHandler: (() => Promise<void>) | undefined;
		sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
			if (id === "litellm-connector.manage") {
				commandHandler = handler as () => Promise<void>;
			}
			return { dispose: () => {} } as vscode.Disposable;
		});

		registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

		if (commandHandler) {
			await commandHandler();
		}

		// Should only call showInputBox 2 times (URL and masked key)
		assert.strictEqual(showInputBoxStub.callCount, 2);

		// Should save "thisisunsafe" as the key since there's no existing key to reveal
		assert.strictEqual(
			mockConfigManager.setConfig.calledWith({
				url: "my-url",
				key: "thisisunsafe",
			}),
			true
		);
		assert.strictEqual(showInfoStub.calledOnce, true);
	});

	test("allows editing API key in unmasked mode", async () => {
		mockConfigManager.getConfig.resolves({ url: "my-url", key: "old-secret" });
		const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
		showInputBoxStub.onFirstCall().resolves("my-url"); // URL
		showInputBoxStub.onSecondCall().resolves("thisisunsafe"); // Magic string
		showInputBoxStub.onThirdCall().resolves("new-secret"); // Changed key in unmasked mode
		const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

		let commandHandler: (() => Promise<void>) | undefined;
		sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
			if (id === "litellm-connector.manage") {
				commandHandler = handler as () => Promise<void>;
			}
			return { dispose: () => {} } as vscode.Disposable;
		});

		registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

		if (commandHandler) {
			await commandHandler();
		}

		// Should have called showInputBox 3 times
		assert.strictEqual(showInputBoxStub.callCount, 3);

		// Should save the new key
		assert.strictEqual(
			mockConfigManager.setConfig.calledWith({
				url: "my-url",
				key: "new-secret",
			}),
			true
		);
		assert.strictEqual(showInfoStub.calledOnce, true);
	});
});
