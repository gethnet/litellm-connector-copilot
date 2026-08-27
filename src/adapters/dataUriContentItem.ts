import type { OpenAIChatMessageContentItem } from "../types";

/**
 * Binary MIME types that Copilot data parts should keep as OpenAI
 * `image_url` data URIs. PDFs reuse the image content-item shape so
 * `/chat/completions` and `/responses` copy-through stay unchanged.
 */
export function isDataUriMimeType(mimeType: string): boolean {
    return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

/**
 * Encode a Copilot data part as an OpenAI `image_url` content item.
 * Images and PDFs share this shape: `data:<mime>;base64,<bytes>`.
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

function encodeAsBase64(data: Uint8Array | string | ArrayBuffer): string {
    if (data instanceof Uint8Array) {
        return Buffer.from(data).toString("base64");
    }
    if (typeof data === "string") {
        return Buffer.from(data, "utf-8").toString("base64");
    }
    return Buffer.from(data).toString("base64");
}
