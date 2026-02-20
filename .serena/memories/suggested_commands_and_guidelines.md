# Suggested Commands & Development Guidelines

## Essential Development Commands

### Compilation & Type Checking
```bash
npm run compile              # Type-check and emit TypeScript to out/
npm run watch              # Watch mode - recompile on file change
```

### Testing
```bash
npm run test               # Run unit tests (minimal output)
npm run test:report        # Run tests with JUnit XML report (CI mode)
npm run test:coverage      # Run tests + generate coverage report (HTML + LCOV)
                           # Coverage dir: coverage/
                           # Coverage targets: 80%+ lines (min), 90%+ statements (preferred)
```

### Code Quality
```bash
npm run lint               # ESLint with auto-fix enabled
npm run lint:check         # ESLint check only (no fixes)
npm run format             # Prettier format (all files)
npm run format:check       # Prettier check only (no fixes)
```

### Full Validation (Before PR/Release)
```bash
npm run compile && npm run lint && npm run format:check && npm run test:coverage
```

### Packaging
```bash
npm run vscode:pack:dev    # Build debug VSIX (esbuild, no minify)
npm run vscode:pack        # Build production VSIX (esbuild + minify)
npm run package:marketplace # Build for VS Code Marketplace (custom README)
npm run bump-version       # Increment version in package.json
npm run clean              # Remove dist/, out/, coverage/, test-results/
```

### Utilities
```bash
npm run download-api       # Update VS Code type definitions
npm run postinstall        # Auto-run by npm (downloads API defs)
```

## Development Workflow

### When Starting New Work
1. Pull latest: `git pull`
2. Install: `npm install` (auto-runs postinstall)
3. Watch mode: `npm run watch` (leave running in terminal)
4. Edit code in another terminal

### Before Committing
1. `npm run lint` - Auto-fix linting issues
2. `npm run format` - Auto-format code
3. `npm run test:coverage` - Run tests and check coverage
4. Verify coverage didn't regress > 1% in any category
5. Review changes: `git diff`

### Common Development Tasks

#### Adding a New Feature
1. Create feature branch: `git checkout -b feat/my-feature`
2. Add code in appropriate module
3. Add tests in `src/test/unit/{module}.test.ts`
4. Ensure coverage targets met: 80%+ lines, 90%+ statements
5. Run `npm run lint && npm run format && npm run test:coverage`
6. Commit with emoji prefix (e.g., "🚀 Add new feature")

#### Fixing a Bug
1. Create bug branch: `git checkout -b fix/bug-name`
2. Add regression test that fails before fix
3. Implement fix
4. Verify test passes
5. Check coverage didn't regress
6. Run quality checks: `npm run lint && npm run format && npm run test:coverage`
7. Commit with emoji (e.g., "🛠️ Fix tool-call ID normalization")

#### Modifying Provider Base Class
Since `LiteLLMProviderBase` is shared by chat, completions, and inline providers:
1. Make changes to base class
2. **Run tests for all three providers**:
   - `src/test/unit/chatProvider.test.ts`
   - `src/test/unit/completionProvider.test.ts`
   - `src/test/unit/inlineCompletionProvider.test.ts`
3. Ensure no provider-specific logic breaks
4. Verify coverage didn't regress globally

#### Adding Telemetry/Logging
- Always use `Logger` class methods (info, warn, error, debug, trace)
- Never console.log in production code
- Log major decision points (model selection, parameter filtering, retries)
- Include context but no secrets or large payloads
- For telemetry: Call `LiteLLMTelemetry.reportMetric()` with structured IMetrics
- Remember: current telemetry logs to debug channel (ready for external backend)

## Code Style Conventions

### TypeScript Patterns
- Strict null checking enabled (`tsconfig.json`)
- No `any` type (ESLint enforces)
- Explicit return types on all functions/methods
- Interface segregation: Small, focused interfaces
- Type imports: `import type { ... } from "..."`

### Naming Conventions
```typescript
// Classes: PascalCase
class LiteLLMClient { }

// Methods/functions: camelCase
method() { }
function getData() { }

// Constants: UPPER_SNAKE_CASE
const MAX_RETRIES = 3;

// Private members: _leadingUnderscore
private _cache: Map<...> = new Map();

// Interfaces/Types: PascalCase
interface IMetrics { }
type OpenAIChatRole = "system" | "user" | ...;
```

### Error Handling Pattern
```typescript
try {
  // Main logic
  const result = await someOperation();
} catch (err: unknown) {
  if (err instanceof Error) {
    Logger.error("Operation failed", err);
    // Handle specific error type
  } else {
    Logger.error("Unknown error occurred", err);
  }
  // Re-throw or handle gracefully
  throw err;
}
```

### Testing Pattern
```typescript
suite("ModuleName Unit Tests", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Setup mocks, stubs
  });

  teardown(() => {
    sandbox.restore();
  });

  test("should do X when Y happens", () => {
    // Arrange: Setup
    const input = ...;
    
    // Act: Execute
    const result = functionUnderTest(input);
    
    // Assert: Verify
    assert.strictEqual(result, expected);
  });
});
```

### Comment Style
- Use TSDoc comments for public APIs:
  ```typescript
  /**
   * Brief description.
   * 
   * Longer explanation if needed.
   * 
   * @param param1 Description
   * @returns Description of return value
   */
  public method(param1: Type): ReturnType { }
  ```
- Inline comments for "why", not "what"
- Avoid obvious comments

## Architecture Principles (from AGENTS.md)

### Code Quality
- ✅ Elegant, clean, readable at a glance
- ✅ No black boxes: explain assumptions & invariants
- ✅ Reusable by default: extract pure helpers
- ✅ Small, composable modules: single responsibility
- ✅ Consistent style: match existing patterns

### Organization
- ✅ Prefer pure transformations (input → output) over side effects
- ✅ Push protocol/payload shaping into adapters
- ✅ Centralize cross-cutting concerns (logging, telemetry, token management)
- ✅ Keep orchestration layers thin

### Provider Architecture
- ✅ Base class (`LiteLLMProviderBase`) handles orchestration
- ✅ Derived classes implement VS Code protocols only
- ✅ Both chat & completions share same request pipeline
- ✅ New provider types extend base (no duplication)

## Testing Requirements

### Coverage Targets
- **Lines**: 80%+ minimum (must not regress > 1%)
- **Statements**: 90%+ preferred (must not regress > 1%)
- **Branches**: 90%+ preferred (must not regress > 1%)
- **Functions**: 90%+ preferred (must not regress > 1%)

### Test Quality Standards
- ✅ Explanatory: Intent obvious from test name
- ✅ Clean setup/act/assert structure
- ✅ Focused unit tests with deterministic inputs
- ✅ Regression tests for every bug fix
- ✅ No assertions with `any` type

### Test Locations
- One test file per source file
- Test file: `src/test/unit/{module}.test.ts`
- Import from source: `import { ... } from "../../{module}"`
- Mock VS Code APIs via sinon

## File Structure Best Practices

### Module Exports
- `src/providers/index.ts` - Re-export public providers
- `src/adapters/` - Keep request/response shaping in adapters
- `src/utils/` - Pure utilities (logging, telemetry, model helpers)
- `src/config/` - Configuration management (secrets, workspace settings)

### When Creating New Files
1. Determine responsibility (provider, adapter, utility, config, command)
2. Place in appropriate directory
3. Name clearly (e.g., `fooClient.ts`, `fooAdapter.ts`, `fooProvider.ts`)
4. Create test file: `src/test/unit/{name}.test.ts`
5. Add to relevant index.ts if public export
6. Update architecture notes if responsibility unclear

## Git Commit Message Style

### Format
```
<emoji> <type>: <short summary>

<optional longer description>
```

### Types
- 🚀 feat: New feature
- 🛠️ fix: Bug fix (include #issue if applicable)
- 📚 docs: Documentation
- 🧹 chore: Build, dependencies, config
- 🧪 test: Test additions/updates
- 🎨 refactor: Code refactoring
- ⚡ perf: Performance improvement
- 🔒 security: Security fix

### Examples
- `🚀 Add PostHog telemetry integration`
- `🛠️ Fix tool-call ID normalization for long names`
- `🧪 Add regression test for quota error detection`
- `📚 Update telemetry documentation`

## Configuration Management Quick Reference

### Provider Configuration (V1.109+, Encrypted by VS Code)
- **Storage**: VS Code SecretStorage (encrypted)
- **Location**: Language Model provider settings UI
- **Fields**: `baseUrl` (required), `apiKey` (optional)
- **Access**: `options.configuration` in request methods OR `ConfigManager.getConfig()`

### Workspace Settings (Not Encrypted)
- **Storage**: `.vscode/settings.json` or workspace settings
- **Access**: `vscode.workspace.getConfiguration("litellm-connector")`
- **Settings**:
  - `inlineCompletions.enabled`: boolean
  - `inlineCompletions.modelId`: string
  - `modelIdOverride`: string (deprecated)
  - `disableQuotaToolRedaction`: boolean
  - `modelOverrides`: object (model ID → tags)
  - `inactivityTimeout`: number (seconds)
  - `disableCaching`: boolean

### Adding New Config Setting
1. Add to `package.json` `configuration.properties`
2. Add constant to `ConfigManager` (e.g., `SETTING_KEY = "litellm-connector.setting"`)
3. Add retrieval method to `ConfigManager`
4. Use `ConfigManager.getConfig()` or workspace settings as appropriate
5. Add tests in `src/test/unit/config.test.ts`

## Debugging Tips

### Enable Debug Logging
In VS Code, open the Output panel (Ctrl+Shift+U) and select "LiteLLM" channel. All Logger.debug() calls will appear.

### Debug Telemetry
Look for `[Telemetry]` log lines in the LiteLLM output channel. They contain JSON-serialized IMetrics.

### Mock External Calls
Use `sinon.stub()` to mock:
- `LiteLLMClient.chat()` - HTTP requests
- `vscode.window.createOutputChannel()` - Logger initialization
- `ConfigManager.getConfig()` - Configuration

### Inspect Model Cache
In tests, cast provider to `any` and access:
- `_lastModelList`: Cached model list
- `_modelInfoCache`: Per-model capabilities
- `_parameterProbeCache`: Supported parameters per model

## Resources

- **VS Code Extension API**: https://code.visualstudio.com/api
- **VS Code Language Models**: https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- **LiteLLM Docs**: https://docs.litellm.ai
- **OpenAI API**: https://platform.openai.com/docs
- **Repository**: https://github.com/gethnet/litellm-connector-copilot

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| Tests fail with "LogOutputChannel undefined" | Mock vscode.window.createOutputChannel() in setup |
| Coverage regression | Run `npm run test:coverage` and check `coverage/index.html` for missing lines |
| Build fails | Run `npm run clean && npm install && npm run compile` |
| Format issues | Run `npm run format` and `npm run lint` |
| Type errors | Ensure `src/vscode.d.ts` is current (run `npm run download-api`) |
| Extension won't load | Check `npm run compile` output for syntax errors, look at VS Code debug console |
