import * as assert from "assert";
import { isDataUriMimeType, isPdfMimeType, toFileContentItem, toImageUrlContentItem } from "../dataUriContentItem";

suite("dataUriContentItem", () => {
    test("recognizes image MIME types separately from PDF", () => {
        assert.strictEqual(isDataUriMimeType("image/png"), true);
        assert.strictEqual(isDataUriMimeType("application/pdf"), false);
        assert.strictEqual(isPdfMimeType("application/pdf"), true);
        assert.strictEqual(isPdfMimeType("image/png"), false);
        assert.strictEqual(isDataUriMimeType("application/octet-stream"), false);
        assert.strictEqual(isDataUriMimeType("text/plain"), false);
    });

    test("encodes PDF bytes as a file data URI", () => {
        const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const item = toFileContentItem("application/pdf", pdfBytes);

        assert.strictEqual(item.type, "file");
        assert.strictEqual(item.file?.filename, "document.pdf");
        assert.strictEqual(
            item.file?.file_data,
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
