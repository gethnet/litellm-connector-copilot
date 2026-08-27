import type { OpenAIChatMessageContentItem } from "../types";

/** Image MIME types that Copilot data parts should keep as OpenAI `image_url` data URIs. */
export function isDataUriMimeType(mimeType: string): boolean {
    return mimeType.startsWith("image/");
}

/** PDF MIME type encoded as an OpenAI `file` content item, not `image_url`. */
export function isPdfMimeType(mimeType: string): boolean {
    return mimeType === "application/pdf";
}

/**
 * Binary MIME types that converters should keep instead of dropping.
 * Images use `image_url`; PDFs use `file.file_data`.
 */
export function isBinaryContentMimeType(mimeType: string): boolean {
    return isDataUriMimeType(mimeType) || isPdfMimeType(mimeType);
}

/**
 * Encode a Copilot data part as an OpenAI `image_url` content item.
 * Images use this shape: `data:<mime>;base64,<bytes>`.
 */
export function toImageUrlContentItem(
    mimeType: string,
    data: Uint8Array | string | ArrayBuffer
): OpenAIChatMessageContentItem {
    return {
        type: "image_url",
        image_url: {
            url: `data:${mimeType};base64,${encodeAsBase64(data)}`,
        },
    };
}

/**
 * Encode a Copilot PDF data part as an OpenAI `file` content item.
 * Azure, Gemini, and Claude all accepted `file.file_data` as a
 * `data:application/pdf;base64,...` URI on `/chat/completions`.
 */
export function toFileContentItem(
    mimeType: string,
    data: Uint8Array | string | ArrayBuffer,
    filename = "document.pdf"
): OpenAIChatMessageContentItem {
    return {
        type: "file",
        file: {
            filename,
            file_data: `data:${mimeType};base64,${encodeAsBase64(data)}`,
        },
    };
}

/** Route a kept binary MIME type to the matching OpenAI content-item shape. */
export function toBinaryContentItem(
    mimeType: string,
    data: Uint8Array | string | ArrayBuffer
): OpenAIChatMessageContentItem {
    if (isPdfMimeType(mimeType)) {
        return toFileContentItem(mimeType, data);
    }
    return toImageUrlContentItem(mimeType, data);
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
