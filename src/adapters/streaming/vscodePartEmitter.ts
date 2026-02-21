import * as vscode from "vscode";
import type { EmittedPart } from "./liteLLMStreamInterpreter";

export function emitPartsToVSCode(
    parts: EmittedPart[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
    for (const part of parts) {
        switch (part.type) {
            case "text":
                progress.report(new vscode.LanguageModelTextPart(part.value));
                break;
            case "tool_call":
                if (part.id && part.name) {
                    progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, JSON.parse(part.args)));
                }
                break;
            case "finish":
                // VS Code doesn't have a specific finish part in the progress stream,
                // it's inferred by the end of the stream.
                break;
        }
    }
}
