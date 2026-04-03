---
description: "Use when writing or modifying TypeScript code under src/ to enforce strict type safety and eliminate 'any' declarations or definitions."
applyTo: "src/**/*.ts,src/**/*.test.ts"
---

# TypeScript No-Any Policy

## Core Rule
**Never use `any` type in TypeScript code under `src/`.** Treat `any` as a type safety bug that must be fixed.

## Why This Matters
- `any` bypasses TypeScript's type checking, defeating the purpose of using TypeScript
- It hides bugs that would otherwise be caught at compile time
- It makes code harder to understand, maintain, and refactor
- It prevents IDE features like autocomplete and type hints from working

## Acceptable Alternatives

### 1. Use `unknown` for truly unknown data
```typescript
// ❌ Bad
function processData(data: any) {
  return data.someMethod(); // No type checking!
}

// ✅ Good
function processData(data: unknown) {
  if (typeof data === 'object' && data !== null && 'someMethod' in data) {
    return (data as { someMethod: () => void }).someMethod();
  }
  throw new Error('Invalid data');
}
```

### 2. Use Generics for flexible but type-safe APIs
```typescript
// ❌ Bad
function wrap(value: any): any {
  return { value, timestamp: Date.now() };
}

// ✅ Good
function wrap<T>(value: T): { value: T; timestamp: number } {
  return { value, timestamp: Date.now() };
}
```

### 3. Define interfaces for complex objects
```typescript
// ❌ Bad
const config: any = {
  baseUrl: 'https://api.example.com',
  timeout: 5000
};

// ✅ Good
interface ApiConfig {
  baseUrl: string;
  timeout: number;
}
const config: ApiConfig = {
  baseUrl: 'https://api.example.com',
  timeout: 5000
};
```

### 4. Use type guards for runtime type checking
```typescript
// ✅ Good
interface User {
  id: string;
  name: string;
}

function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value &&
    typeof (value as User).id === 'string' &&
    typeof (value as User).name === 'string'
  );
}

function processUser(data: unknown): User {
  if (isUser(data)) {
    return data; // TypeScript knows this is User
  }
  throw new Error('Invalid user data');
}
```

### 5. Use utility types for transformations
```typescript
// ❌ Bad
type PartialUser = any;

// ✅ Good
type PartialUser = Partial<User>;
type UserPreview = Pick<User, 'id' | 'name'>;
type UserWithoutId = Omit<User, 'id'>;
```

## Common Scenarios and Solutions

### API Responses
```typescript
// ❌ Bad
const response: any = await fetch('/api/data');

// ✅ Good
interface ApiResponse {
  data: unknown;
  status: number;
}
const response: ApiResponse = await fetch('/api/data').then(r => r.json());
```

### Event Handlers
```typescript
// ❌ Bad
function handleClick(event: any) {
  console.log(event.target.value);
}

// ✅ Good
function handleClick(event: React.ChangeEvent<HTMLInputElement>) {
  console.log(event.target.value);
}
```

### JSON Parsing
```typescript
// ❌ Bad
const data = JSON.parse(jsonString) as any;

// ✅ Good
const data: unknown = JSON.parse(jsonString);
if (isValidData(data)) {
  // Use data with confidence
}
```

## Enforcement
- ESLint will flag `any` usage with `@typescript-eslint/no-explicit-any`
- Code reviews should reject any PR containing `any` types
- When encountering existing `any` in legacy code, refactor it when you touch that code

## Exceptions
The only acceptable use of `any` is:
1. **Type definition files (`.d.ts`)**: Vendor-provided files that cannot be modified (e.g., `vscode.d.ts`, `vscode.proposed.*.d.ts`)
2. **Third-party JavaScript libraries**: When interfacing with a library that has no type definitions and you're creating a minimal wrapper (document why and create a proper type as soon as possible)
3. **VS Code proposed API features**: When accessing features not yet fully typed - **must** include `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment explaining why
4. **Test files (`*.test.ts`)**: When stubbing private members or accessing internal state for testing purposes - minimize usage and prefer public API testing when possible

**Note**: The `.d.ts` files in this repository (`src/vscode.d.ts`, `src/vscode.proposed.*.d.ts`) are VS Code API type definitions and are explicitly excluded from this rule.

### Example of Acceptable `as any` Usage in Production Code
```typescript
// When accessing a proposed VS Code API feature not yet in the type definitions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(progress as any).report({
    kind: "usage",
    promptTokens: tokensIn,
    completionTokens: tokensOut,
});
```

### Example of Acceptable `as any` Usage in Test Files
```typescript
// Stubbing private method for testing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doDiscoverStub = sandbox.stub(provider as any, "_doDiscoverModels").resolves(mockModels);

// Setting internal state for test setup
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(provider as any)._modelListFetchedAtMs = Date.now() - 10000;
```

**Important**: Even in these cases, add a TODO comment to remove the `any` once the proper types are available.

## Quick Reference
| Instead of | Use |
|------------|-----|
| `any` | `unknown` |
| `any[]` | `unknown[]` or specific type |
| `function(x: any)` | `function<T>(x: T)` or define interface |
| `as any` | Create proper type guard |
| `: any` return type | Define return type or use generics |
