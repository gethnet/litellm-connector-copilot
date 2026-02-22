import * as vscode from "vscode";
import { Logger } from "./logger";

/**
 * Interface for the Git Extension API.
 * This is a minimal definition of the VS Code Git extension API.
 */
export interface GitExtension {
    getAPI(version: number): GitAPI;
}

export interface GitAPI {
    repositories: Repository[];
}

export interface Repository {
    state: RepositoryState;
    diffIndexWithHEAD(): Promise<Change[]>;
    diff(path: string, options?: { cached?: boolean }): Promise<string>;
}

export interface RepositoryState {
    indexChanges: Change[];
}

export interface Change {
    uri: vscode.Uri;
    status: number;
}

/**
 * Utility for interacting with the VS Code Git extension.
 */
export class GitUtils {
    /**
     * Gets the Git API from the built-in VS Code Git extension.
     */
    static async getGitAPI(): Promise<GitAPI | undefined> {
        const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
        if (!extension) {
            Logger.warn("Git extension not found");
            return undefined;
        }

        if (!extension.isActive) {
            await extension.activate();
        }

        return extension.exports.getAPI(1);
    }

    /**
     * Gets the staged diff for the first available repository.
     */
    static async getStagedDiff(): Promise<string | undefined> {
        try {
            const api = await this.getGitAPI();
            if (!api || api.repositories.length === 0) {
                return undefined;
            }

            const repo = api.repositories[0];
            // We want the staged changes (diff between index and HEAD)
            // The Git API doesn't have a single "get full staged diff" method that returns a string easily
            // for all files at once in the stable API without running a command,
            // but we can use repository.diffIndexWithHEAD() to get changes and then aggregate.

            // However, a more reliable way to get the full unified diff for staged changes:
            // @ts-expect-error - Using internal repository if available, or fallback to manual
            const internalRepo = repo.repository;
            if (internalRepo && typeof internalRepo.diff === "function") {
                return await internalRepo.diff(true); // true means --cached
            }

            // Fallback: manually construct diff from changes if internal API is not available
            const changes = await repo.diffIndexWithHEAD();
            if (changes.length === 0) {
                return "";
            }

            let fullDiff = "";
            for (const change of changes) {
                const diff = await repo.diff(change.uri.fsPath, { cached: true });
                fullDiff += diff + "\n";
            }
            return fullDiff;
        } catch (err) {
            Logger.error("Failed to get staged diff", err);
            return undefined;
        }
    }

    /**
     * Checks if the diff exceeds a certain token threshold and determines truncation strategy.
     * @param diff The diff string
     * @param maxTokens The max tokens allowed by the model
     * @returns Object containing the (possibly truncated) diff and a flag
     */
    static checkDiffSize(diff: string, maxTokens: number): { diff: string; isTruncated: boolean } {
        // Rough estimate: 4 characters per token
        const estimatedTokens = diff.length / 4;

        if (estimatedTokens < maxTokens) {
            return { diff, isTruncated: false };
        }

        // If it exceeds model capacity
        Logger.warn(
            `Diff size (${estimatedTokens} tokens) exceeds model capacity (${maxTokens}) against reference GPT-4o-mini (128k)`
        );

        // Truncate to fit within 90% of maxTokens
        const allowedChars = maxTokens * 4 * 0.9;
        const truncatedDiff = diff.substring(0, allowedChars) + "\n\n[... Diff truncated due to context limits ...]";

        return { diff: truncatedDiff, isTruncated: true };
    }
}
