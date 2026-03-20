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

    const extractEvent = (rawEvent: string): { payload?: string; sawDone: boolean } => {
        if (!rawEvent.trim()) {
            return { sawDone: false };
        }

        const dataLines: string[] = [];
        let sawDone = false;

        for (const line of rawEvent.split(/\r?\n/)) {
            if (!line.startsWith("data:")) {
                continue;
            }

            const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
            if (value === "[DONE]") {
                sawDone = true;
                continue;
            }
            dataLines.push(value);
        }

        if (dataLines.length === 0) {
            return { sawDone };
        }

        return {
            payload: dataLines.join("\n"),
            sawDone,
        };
    };

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

            let separatorIndex = buffer.search(/\r?\n\r?\n/);
            while (separatorIndex >= 0) {
                const event = buffer.slice(0, separatorIndex);
                const separatorMatch = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
                const separatorLength = separatorMatch?.[0].length ?? 2;
                buffer = buffer.slice(separatorIndex + separatorLength);

                const { payload, sawDone } = extractEvent(event);
                if (payload) {
                    yield payload;
                }
                if (sawDone) {
                    return;
                }

                separatorIndex = buffer.search(/\r?\n\r?\n/);
            }
        }

        // Flush any trailing complete event if the stream ended without an extra separator.
        if (buffer.trim()) {
            const { payload } = extractEvent(buffer);
            if (payload) {
                yield payload;
            }
        }
    } finally {
        reader.releaseLock();
    }
}
