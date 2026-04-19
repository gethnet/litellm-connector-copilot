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

## Bypass Comments Are Prohibited

**Never use `// eslint-disable-next-line @typescript-eslint/no-explicit-any` (or any equivalent `eslint-disable` comment) to silence the linter.** This is the same as using `any` — it defeats the purpose of the rule.

If ESLint flags an `any`, fix the type. Do not suppress the warning.

## Exceptions
The only acceptable use of `any` is:
1. **Type definition files (`.d.ts`)**: Vendor-provided files that cannot be modified (e.g., `vscode.d.ts`, `vscode.proposed.*.d.ts`)

**Note**: The `.d.ts` files in this repository (`src/vscode.d.ts`, `src/vscode.proposed.*.d.ts`) are VS Code API type definitions and are explicitly excluded from this rule.

All other cases — including VS Code proposed API access, test files, and third-party wrappers — must use proper types (`unknown`, generics, type guards, or explicit interfaces) instead of `any`.

## Quick Reference
| Instead of | Use |
|------------|-----|
| `any` | `unknown` |
| `any[]` | `unknown[]` or specific type |
| `function(x: any)` | `function<T>(x: T)` or define interface |
| `as any` | Create proper type guard |
| `: any` return type | Define return type or use generics |
