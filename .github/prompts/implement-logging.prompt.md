---
name: Implement Logging and Data Visualization
description: >
 Use this prompt to implement visual-first
 logging and data transparency in a specific
 file or code section.
applyTo: ["src/**/*.ts"]
inputs:
  target:
    description: >
     The file or code section to target for logging implementation.
    default: current selection
---

# Implement Logging and Data Visualization

You are an expert at implementing visual-first logging and data transparency in TypeScript code. Your goal is to ensure that the logic of the targeted code is fully observable and that data structures used for decisions are clearly logged.

## Target
Target File/Section: `${input:target}`

## Instructions

1. **Analyze the Target**: Examine the code in `${input:target}`. Identify:
   - Major function entry and exit points.
   - Logical branches (if/else, switch, try/catch).
   - I/O operations (API calls, file system, VS Code API).
   - Critical state transitions.

2. **Implement Visual-First Logging**:
   - Add `logger.info` or `logger.debug` at the start and end of major functions.
   - Every logical branch MUST have a log explaining the decision made and the "why" behind it.
   - Log the full data structures (sanitized of secrets) used to make these decisions.

3. **Ensure Data Transparency**:
   - Prefer structured logs: `logger.info('Message', { key: value })`.
   - Avoid opaque strings like `logger.info('Success')`. Instead use `logger.info('Operation successful', { result: data })`.

4. **Verify Sanitization**:
   - Ensure no API keys, tokens, or sensitive user data are logged. Use existing sanitization helpers if available.

5. **TDD First**:
   - If the logging changes behavior or requires new tests, update the relevant tests in the `test/` directory first.

## Example Pattern

```typescript
import { logger } from '../utils/logger';

export async function processData(input: DataObject) {
    logger.info('Entering processData', { inputId: input.id });

    try {
        if (input.type === 'TypeA') {
            logger.debug('Processing as TypeA based on input type', { type: input.type });
            // ... logic
        } else {
            logger.debug('Processing as default type', { type: input.type });
            // ... logic
        }

        logger.info('Exiting processData successfully');
    } catch (error) {
        logger.error('Failed to process data', { error, inputId: input.id });
        throw error;
    }
}
```

Refer to the `logging-and-data-visualization` skill for detailed standards.
