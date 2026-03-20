import { LanguageModelChatMessageRole } from "vscode";

/**
 * Converts a LanguageModelChatMessageRole to its string representation.
 */
export function lmcr_toString(role: LanguageModelChatMessageRole): string {
    // Use string comparison if possible, or fall back to numeric comparison
    // User = 1, Assistant = 2, System = 3
    if (role === LanguageModelChatMessageRole.User || (role as number) === 1) {
        return "user";
    }
    if (role === LanguageModelChatMessageRole.Assistant || (role as number) === 2) {
        return "assistant";
    }

    // Check for System role (Proposed API: languageModelSystem)
    // We use the numeric value 3 as the primary check to avoid compiler errors
    // when the proposed enum member is missing from the stable vscode namespace.
    if ((role as number) === 3) {
        return "system";
    }

    // Default to system for everything else
    return "system";
}

/**
 * Converts a string representation of a chat role to a LanguageModelChatMessageRole.
 */
export function lmcr_fromString(role: string): LanguageModelChatMessageRole {
    // Safety check: ensure role is a valid string and normalize
    const normalizedRole = (role || "").toLowerCase();

    switch (normalizedRole) {
        case "user":
            return LanguageModelChatMessageRole.User;
        case "assistant":
            return LanguageModelChatMessageRole.Assistant;
        case "system":
            return 3 as number as LanguageModelChatMessageRole.System;
        default:
            // Default should be the user role, we may change this down the road
            return LanguageModelChatMessageRole.User;
    }
}
