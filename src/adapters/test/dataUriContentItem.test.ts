import * as assert from "assert";
import { isDataUriMimeType, toImageUrlContentItem } from "../dataUriContentItem";

suite("dataUriContentItem", () => {
    test("recognizes image and PDF MIME types", () => {
        assert.strictEqual(isDataUriMimeType("image/png"), true);
        assert.strictEqual(isDataUriMimeType("application/pdf"), true);
        assert.strictEqual(isDataUriMimeType("application/octet-stream"), false);
        assert.strictEqual(isDataUriMimeType("text/plain"), false);
    });

    test("encodes PDF bytes as an image_url data URI", () => {
        const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const item = toImageUrlContentItem("application/pdf", pdfBytes);

        assert.strictEqual(item.type, "image_url");
        assert.strictEqual(
            item.image_url?.url,
            `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`
        );
    });

    test("encodes string and ArrayBuffer data the same way as Uint8Array", () => {
        const bytes = new Uint8Array([0x61, 0x62, 0x63]);
        const expected = toImageUrlContentItem("image/png", bytes).image_url?.url;
        const asString = toImageUrlContentItem("image/png", "abc");
        const asBuffer = toImageUrlContentItem("image/png", bytes.buffer);

        assert.strictEqual(asString.image_url?.url, expected);
        assert.strictEqual(asBuffer.image_url?.url, expected);
    });
});
