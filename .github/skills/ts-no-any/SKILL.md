---
name: ts-no-any
description: "Use when implementing or refactoring TypeScript code to ensure strict type safety and avoid the 'any' type. Provides strategies for unknown types, generics, and type guards."
---

# TypeScript Strict Typing (No-Any)

This skill enforces high-quality TypeScript implementation by eliminating the `any` type in favor of safer, more explicit alternatives.

## Core Principles

1.  **No `any` by default**: Treat `any` as a bug. If you can't type it yet, use `unknown`.
2.  **Type over Comment**: Use the type system to document behavior instead of comments.
3.  **Narrow Early**: Convert broad types (`unknown`, `string`, etc.) to specific types as close to the I/O boundary as possible.

## Workflow: Replacing `any`

When you encounter a situation where `any` feels tempting, follow this decision tree:

### 1. Is the structure truly unknown?
- **Action**: Use `unknown`.
- **Reasoning**: `unknown` is the type-safe counterpart to `any`. You cannot perform operations on it without first narrowing the type.
- **Example**:
  ```typescript
  // Bad
  function process(data: any) { data.run(); }
  // Good
  function process(data: unknown) {
    if (isRunnable(data)) { data.run(); }
  }
  ```

### 2. Is the type dependent on the caller?
- **Action**: Use Generics `<T>`.
- **Reasoning**: Generics allow the caller to define the type while maintaining a relationship between inputs and outputs.
- **Example**:
  ```typescript
  // Bad
  function wrap(val: any): any { return { val }; }
  // Good
  function wrap<T>(val: T): { val: T } { return { val }; }
  ```

### 3. Is it a complex object from an API?
- **Action**: Define an `interface` or `type`. Use `Record<string, unknown>` for dictionary-like objects.
- **Reasoning**: Provides autocomplete and build-time validation.

### 4. Are you handling union types?
- **Action**: Use **Type Guards** or **Discriminated Unions**.
- **Example**:
  ```typescript
  interface Success { status: 'success'; data: string; }
  interface Failure { status: 'error'; error: Error; }
  type Result = Success | Failure;

  function handle(res: Result) {
    if (res.status === 'success') {
      console.log(res.data); // res is Success
    }
  }
  ```

## Quality Checklist

- [ ] No `any` keywords exist in the new or modified code.
- [ ] `unknown` is used for data from external sources (API, JSON.parse).
- [ ] Custom type guards (`isType(val): val is Type`) are implemented for runtime narrowing.
- [ ] Generics are used where types are passed through without modification.
- [ ] Utility types like `Pick`, `Omit`, `Partial`, and `Record` are used to derive types.

## Prohibited Patterns

- `as any` type assertions.
- `any[]` for arrays (use `unknown[]` or a specific interface).
- Function signatures using `any` for arguments or return values.
