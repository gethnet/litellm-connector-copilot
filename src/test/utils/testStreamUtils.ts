export function createMockSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) {
                const data = {
                    choices: [
                        {
                            delta: { content: chunk },
                            finish_reason: null,
                        },
                    ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
}

export function createMockToolCallStream(toolName: string, args: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            const data = {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_123",
                                    type: "function",
                                    function: { name: toolName, arguments: args },
                                },
                            ],
                        },
                    },
                ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
}
