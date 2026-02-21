import type { CancellationToken } from "vscode";

/**
 * Decodes a ReadableStream of SSE data into raw payload strings.
 * Handles chunk boundaries, partial lines, and [DONE] marker.
 */
export async function* decodeSSE(
    stream: ReadableStream<Uint8Array>,
    token?: CancellationToken
): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            if (token?.isCancellationRequested) {
                break;
            }

            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) {
                    continue;
                }

                const payload = trimmed.slice(6);
                if (payload === "[DONE]") {
                    return;
                }
                yield payload;
            }
        }

        // Handle remaining buffer if it looks like a complete line (though SSE should end with \n)
        if (buffer.trim()) {
            const lines = buffer.split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) {
                    continue;
                }

                const payload = trimmed.slice(6);
                if (payload === "[DONE]") {
                    return;
                }
                yield payload;
            }
        }
    } finally {
        reader.releaseLock();
    }
}
