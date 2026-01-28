# API Key Reveal Magic String Feature

**Date**: January 28, 2026
**Status**: Implemented & Tested
**Related Files**:
- `src/commands/manageConfig.ts` - Core implementation
- `src/test/unit/command.test.ts` - Test coverage

## Overview

Added a special "magic string" feature that allows users to view their stored API key in plain text from the configuration screen when needed.

## Feature Description

### Trigger
When a user clicks the gear icon to manage the LiteLLM provider and reaches the API key input screen, they can type the magic string `thisisunsafe` to switch to an unmasked view of their API key.

### Behavior
1. **First Prompt (Always Masked)**: The initial API key prompt uses password masking for security
   - Shows masked placeholder: `••••••••••••••••`
   - Password mode enabled

2. **Magic String Detection**: If user enters exactly `thisisunsafe`:
   - AND there's an existing stored API key
   - THEN a second unmasked input dialog appears

3. **Second Prompt (Unmasked)**: Shows the actual API key in plain text
   - Password mode disabled
   - User can view and edit the key if needed
   - Changes can be saved normally

### Safety Features
- Magic string only works if there's an **existing API key** to reveal
- If entered without an existing key, `thisisunsafe` is treated as the literal API key value
- Primary configuration flow remains completely secure

## Implementation Details

### Modified Files
- **`src/commands/manageConfig.ts`**: Added magic string detection logic (lines 36-47)

### Code Logic
```typescript
// If user enters the magic string, show the actual API key in plain text
if (apiKey.trim() === "thisisunsafe" && config.key) {
    apiKey = await vscode.window.showInputBox({
        title: `LiteLLM API Key`,
        prompt: "Your API key (unmasked)",
        ignoreFocusOut: true,
        password: false,
        value: config.key,
        placeHolder: "Your API key",
    });

    if (apiKey === undefined) {
        return;
    }
}
```

## Test Coverage

Added 3 comprehensive unit tests in `src/test/unit/command.test.ts`:

1. **"shows unmasked API key when 'thisisunsafe' is entered with existing key"**
   - Verifies 3-step flow: URL input → masked key → unmasked key
   - Confirms correct password modes on each dialog
   - Tests successful save

2. **"does not show unmasked key if 'thisisunsafe' is entered without existing key"**
   - Verifies only 2 dialogs appear (no unmasked reveal)
   - Confirms `thisisunsafe` is saved as literal API key value

3. **"allows editing API key in unmasked mode"**
   - Tests that users can modify the key in unmasked dialog
   - Verifies changes are properly persisted

**Test Results**: All 61 tests passing ✅

## Usage Example

```
User clicks gear icon in model picker
↓
"Enter your LiteLLM base URL" (password: false)
↓
"Update your LiteLLM API key" (password: true, masked)
↓
User types: "thisisunsafe" [ENTER]
↓
"Your API key (unmasked)" (password: false, plaintext value shown)
↓
User can view/edit and confirm
```

## Security Considerations

- ✅ API keys remain masked by default
- ✅ Magic string requires intentional user action
- ✅ Magic string is descriptive (discourages accidental use)
- ✅ Only works with existing keys (no data exposure)
- ✅ All API keys still stored in VS Code's `SecretStorage`
- ✅ No logging of API keys in any format

## Future Considerations

- Consider adding user notification about the magic string feature in documentation
- Could add tracking/logging for when magic string is used (with user consent)
- Potential rate limiting if widely abused
