# Skill: TypeScript Unit Test Generation

## Goal
Generate robust, type-safe unit tests for TypeScript code sections (files or blocks) ensuring 100% branch coverage and zero usage of `any` casts.

## Process
1. **Analyze Source**:
   - Identify the target file/lines.
   - Map all logic paths (if/else, switch, loops, error handling).
2. **Setup Test Structure**:
   - Create/open a corresponding test file (e.g., `src/.../test/foo.test.ts`).
   - Use standard testing framework (e.g., Jest/Vitest).
3. **Draft Tests**:
   - **No `any`**: Strictly define interfaces or use proper mock types for all dependencies.
   - **Branch Coverage**: Create specific test cases for every branch/path identified in step 1.
   - **Logical Grouping**: Use `describe` blocks to organize by functionality or behavior.
4. **Validation**:
   - Ensure the test code itself is type-checked.
   - Verify that test cases cover all boundary conditions and error scenarios.

## Principles
- **Type Safety**: Avoid `any`. Use `jest.Mocked<T>` or specific interface mocks.
- **Completeness**: Every conditional branch must have at least one test case.
- **Isolation**: Mock dependencies to ensure tests are deterministic.
