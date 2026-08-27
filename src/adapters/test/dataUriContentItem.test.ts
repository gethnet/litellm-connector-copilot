import * as assert from "assert";
import { isBinaryContentMimeType, toBinaryContentItem } from "../dataUriContentItem";

suite("dataUriContentItem", () => {
    test("keeps image and PDF MIME types and drops everything else", () => {
        assert.strictEqual(isBinaryContentMimeType("image/png"), true);
        assert.strictEqual(isBinaryContentMimeType("application/pdf"), true);
        assert.strictEqual(isBinaryContentMimeType("application/octet-stream"), false);
        assert.strictEqual(isBinaryContentMimeType("text/plain"), false);
    });

    test("encodes images as an image_url data URI", () => {
        const bytes = new Uint8Array([0x89, 0x50]);
        const item = toBinaryContentItem("image/png", bytes);

        assert.strictEqual(item.type, "image_url");
        assert.strictEqual(item.image_url?.url, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    test("encodes PDFs as file_data because Azure rejects them inside image_url", () => {
        const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const item = toBinaryContentItem("application/pdf", pdfBytes);

        assert.strictEqual(item.type, "file");
        assert.strictEqual(item.image_url, undefined);
        assert.strictEqual(item.file?.filename, "document.pdf");
        assert.strictEqual(
            item.file?.file_data,
            `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`
        );
    });

    test("encodes string and ArrayBuffer data the same way as Uint8Array", () => {
        const bytes = new Uint8Array([0x61, 0x62, 0x63]);
        const expected = toBinaryContentItem("image/png", bytes).image_url?.url;

        assert.strictEqual(toBinaryContentItem("image/png", "abc").image_url?.url, expected);
        assert.strictEqual(toBinaryContentItem("image/png", bytes.buffer).image_url?.url, expected);
    });
});
