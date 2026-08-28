import type { OpenAIChatMessageContentItem } from "../types";

const PDF_MIME_TYPE = "application/pdf";

/** Filename LiteLLM/providers echo back for inline PDF bytes; they key off the MIME, not this name. */
const PDF_FILENAME = "document.pdf";

/**
 * Binary data parts the converters encode inline instead of dropping.
 * Everything else (audio, octet-stream, …) has no agreed OpenAI shape.
 */
export function isBinaryContentMimeType(mimeType: string): boolean {
    return mimeType.startsWith("image/") || mimeType === PDF_MIME_TYPE;
}

/**
 * Encode a binary data part as an OpenAI content item carrying a
 * `data:<mime>;base64,<bytes>` URI.
 *
 * The two shapes are not interchangeable: Azure rejects `application/pdf`
 * inside `image_url` ("Expected … an image MIME type"), so PDFs must use
 * `file.file_data`. That shape is the only one accepted by Azure, Vertex
 * Gemini, and Bedrock/Vertex Claude alike, so it is applied for every
 * backend rather than branched per provider.
 */
export function toBinaryContentItem(
    mimeType: string,
    data: Uint8Array | string | ArrayBuffer
): OpenAIChatMessageContentItem {
    const dataUri = `data:${mimeType};base64,${encodeAsBase64(data)}`;

    if (mimeType === PDF_MIME_TYPE) {
        return { type: "file", file: { filename: PDF_FILENAME, file_data: dataUri } };
    }

    return { type: "image_url", image_url: { url: dataUri } };
}

function encodeAsBase64(data: Uint8Array | string | ArrayBuffer): string {
    if (data instanceof Uint8Array) {
        return Buffer.from(data).toString("base64");
    }
    if (typeof data === "string") {
        return Buffer.from(data, "utf-8").toString("base64");
    }
    return Buffer.from(data).toString("base64");
}
