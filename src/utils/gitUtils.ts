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
    rootUri: vscode.Uri | undefined;
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
     * Finds a repository in the Git API's repository list by matching its root URI.
     * @param api The Git API instance
     * @param rootUri The root URI of the target repository
     * @returns The matching Repository, or undefined if not found
     */
    static findRepositoryByRootUri(api: GitAPI, rootUri: vscode.Uri): Repository | undefined {
        for (const repo of api.repositories) {
            if (repo.rootUri && repo.rootUri.fsPath === rootUri.fsPath) {
                return repo;
            }
        }
        return undefined;
    }

    /**
     * Gets the staged diff for the specified repository, or the first available repository if no rootUri is provided.
     * @param rootUri Optional root URI of the target repository. When provided, the matching
     *                repository is used. When omitted, falls back to repositories[0] for backward compatibility.
     */
    static async getStagedDiff(rootUri?: vscode.Uri): Promise<string | undefined> {
        try {
            const api = await this.getGitAPI();
            if (!api || api.repositories.length === 0) {
                return undefined;
            }

            const repo = rootUri
                ? (this.findRepositoryByRootUri(api, rootUri) ?? api.repositories[0])
                : api.repositories[0];

            // We want the staged changes (diff between index and HEAD)
            // The Git API doesn't have a single "get full staged diff" method that returns a string easily
            // for all files at once in the stable API without running a command,
            // but we can use repository.diffIndexWithHEAD() to get changes and then aggregate.

            // However, a more reliable way to get the full unified diff for staged changes:
            const internalRepo = (repo as unknown as { repository?: { diff?: (cached: boolean) => Promise<string> } })
                .repository;
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
     * Compacts a Git diff by removing context lines and focusing on changes.
     * This is useful when the diff is too large for the context window.
     * @param diff The original diff string
     * @param maxTokens The target token limit
     * @returns A compacted diff string
     */
    static compactDiff(diff: string, maxTokens: number): string {
        const lines = diff.split("\n");
        const maxChars = maxTokens * 4;

        if (diff.length <= maxChars) {
            return diff;
        }

        Logger.info(`Compacting diff from ${diff.length} to ${maxChars} chars`);

        // First pass: remove most context lines, keeping only hunk headers and changes
        // A git diff line starts with:
        // '--- ' or '+++ ' (file headers)
        // '@@ ' (hunk header)
        // '+' or '-' (changes)
        // ' ' (context)

        const compactedLines: string[] = [];

        for (const line of lines) {
            // Check for file headers first
            if (line.startsWith("--- ") || line.startsWith("+++ ")) {
                compactedLines.push(line);
                continue;
            }

            // Check for hunk headers
            if (line.startsWith("@@ ")) {
                compactedLines.push(line);
                continue;
            }

            // Check for additions/deletions
            // We must be careful not to match file headers here, but we already handled them above
            if (line.startsWith("+") || line.startsWith("-")) {
                compactedLines.push(line);
                continue;
            }

            // If it's a context line, we only keep it if we have plenty of space,
            // or we just omit it to be safe and focus on the changes.
            // For now, let's omit context lines entirely if we're compacting.
            // This is the most aggressive form of compacting.
        }

        const result = compactedLines.join("\n");

        // Final sanity check: if we somehow removed everything (e.g. malformed diff),
        // fall back to truncation
        if (result.trim().length === 0 && diff.trim().length > 0) {
            return this.truncateToTokenLimit(diff, maxTokens);
        }

        // If it's still too large, we might need to truncate at the file level
        if (result.length > maxChars) {
            return this.truncateToTokenLimit(result, maxTokens);
        }

        return result;
    }

    /**
     * Truncates a string to fit within a specific token limit using a character-based heuristic.
     * @param text The text to truncate
     * @param maxTokens The maximum allowed tokens
     * @returns The truncated text
     */
    static truncateToTokenLimit(text: string, maxTokens: number): string {
        // Rough estimate: 4 characters per token
        const allowedChars = maxTokens * 4;
        if (text.length <= allowedChars) {
            return text;
        }

        return text.substring(0, allowedChars) + "\n\n[... Content truncated due to context limits ...]";
    }
}
