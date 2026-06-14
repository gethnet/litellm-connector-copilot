import type { CancellationToken } from "vscode";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";

/**
 * Decodes a ReadableStream of SSE data into raw payload strings.
 * Handles chunk boundaries, partial lines, and [DONE] marker.
 */
export async function* decodeSSE(
    stream: ReadableStream<Uint8Array>,
    token?: CancellationToken,
    signal?: AbortSignal
): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkCount = 0;
    let payloadCount = 0;
    let sawDone = false;
    let endError: Error | undefined;

    // If an AbortSignal is provided, abort the reader when signal fires
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        Logger.warn("[decodeSSE] Stream aborted by signal");
        StructuredLogger.warn("stream.aborted", {
            chunkCount,
            payloadCount,
            reason: "abort_signal",
        });
        reader.cancel().catch(() => {
            return undefined;
        });
    };
    if (signal) {
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort);
        }
    }

    const extractEvent = (rawEvent: string): { payload?: string; sawDone: boolean } => {
        if (!rawEvent.trim()) {
            return { sawDone: false };
        }

        const dataLines: string[] = [];
        sawDone = false;

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
        Logger.trace("[decodeSSE] Starting SSE stream decode");
        StructuredLogger.info("stream.started", {
            hasToken: !!token,
            hasSignal: !!signal,
        });

        while (true) {
            if (aborted || token?.isCancellationRequested) {
                Logger.debug("[decodeSSE] Loop break: aborted=", aborted, "cancelled=", token?.isCancellationRequested);
                StructuredLogger.debug("stream.loop_break", {
                    aborted,
                    cancellationRequested: token?.isCancellationRequested,
                    chunkCount,
                    payloadCount,
                });
                break;
            }

            const { done, value } = await reader.read();
            if (done) {
                Logger.trace("[decodeSSE] Stream done, chunkCount=", chunkCount, "payloadCount=", payloadCount);
                StructuredLogger.debug("stream.chunk_received", {
                    event: "done",
                    chunkCount,
                    payloadCount,
                    bufferLength: buffer.length,
                });
                break;
            }
            chunkCount++;
            Logger.trace("[decodeSSE] Chunk #" + chunkCount + " received, length=", value?.length);
            StructuredLogger.trace("stream.chunk_received", {
                chunkNumber: chunkCount,
                byteLength: value?.length,
                bufferLengthBefore: buffer.length,
            });

            buffer += decoder.decode(value, { stream: true });

            let separatorIndex = buffer.search(/\r?\n\r?\n/);
            while (separatorIndex >= 0) {
                const event = buffer.slice(0, separatorIndex);
                const separatorMatch = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
                const separatorLength = separatorMatch?.[0].length ?? 2;
                buffer = buffer.slice(separatorIndex + separatorLength);

                const { payload, sawDone } = extractEvent(event);
                if (sawDone) {
                    Logger.debug("[decodeSSE] Saw [DONE] marker");
                    StructuredLogger.info("stream.done_marker_received", {
                        chunkCount,
                        payloadCount,
                    });
                    return;
                }
                if (payload) {
                    payloadCount++;
                    Logger.trace("[decodeSSE] Yield payload #" + payloadCount, payload.slice(0, 100));
                    StructuredLogger.trace("stream.payload_yielded", {
                        payloadNumber: payloadCount,
                        payloadLength: payload.length,
                        payloadPreview: payload.slice(0, 100),
                    });
                    yield payload;
                }

                separatorIndex = buffer.search(/\r?\n\r?\n/);
            }
        }

        // Flush any trailing complete event if the stream ended without an extra separator.
        if (buffer.trim()) {
            Logger.debug("[decodeSSE] Flushing trailing buffer, length=", buffer.length);
            StructuredLogger.debug("stream.flushing_buffer", {
                bufferLength: buffer.length,
                chunkCount,
                payloadCount,
                sawDoneMarker: sawDone,
            });
            const { payload } = extractEvent(buffer);
            if (payload) {
                payloadCount++;
                Logger.trace("[decodeSSE] Yield final payload #" + payloadCount);
                StructuredLogger.trace("stream.payload_yielded", {
                    payloadNumber: payloadCount,
                    payloadLength: payload.length,
                    payloadPreview: payload.slice(0, 100),
                    isFinalFlush: true,
                });
                yield payload;
            }
        }

        // Check if stream ended without [DONE] marker
        if (!sawDone) {
            Logger.error("[decodeSSE] Stream ended without [DONE] marker - response incomplete");
            StructuredLogger.error("stream.ended_without_done", {
                chunkCount,
                payloadCount,
                bufferLength: buffer.length,
                note: "Stream ended prematurely - no [DONE] marker received",
            });

            // Prepare error to throw after finally block (unless aborted or cancelled)
            if (!aborted && !token?.isCancellationRequested) {
                endError = new Error(
                    `Stream ended before [DONE] marker - response may be incomplete (${payloadCount} payloads received, stream closed unexpectedly)`
                );
            }
        }
    } finally {
        Logger.trace("[decodeSSE] Stream decode completed, total chunks=", chunkCount, "total payloads=", payloadCount);
        StructuredLogger.info("stream.completed", {
            chunkCount,
            payloadCount,
            sawDoneMarker: sawDone,
            aborted,
            bufferRemaining: buffer.length,
        });
        if (signal) {
            signal.removeEventListener("abort", onAbort);
        }
        reader.releaseLock();
    }

    // Throw error after finally block cleanup completes
    if (endError) {
        throw endError;
    }
}
