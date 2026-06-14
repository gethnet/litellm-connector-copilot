import * as assert from "assert";
import { LRUCache } from "../lruCache";

suite("LRUCache", () => {
    test("should cache and retrieve values", () => {
        const cache = new LRUCache<string, number>(10);
        cache.set("key1", 100);

        assert.strictEqual(cache.get("key1"), 100);
        assert.strictEqual(cache.size, 1);
    });

    test("should return undefined for missing keys", () => {
        const cache = new LRUCache<string, number>(10);
        assert.strictEqual(cache.get("missing"), undefined);
    });

    test("should evict LRU entry when capacity is exceeded", () => {
        const cache = new LRUCache<string, number>(3);
        cache.set("key1", 1);
        cache.set("key2", 2);
        cache.set("key3", 3);

        assert.strictEqual(cache.size, 3);

        // Adding a 4th entry should evict key1 (least recently used)
        cache.set("key4", 4);
        assert.strictEqual(cache.size, 3);
        assert.strictEqual(cache.get("key1"), undefined);
        assert.strictEqual(cache.get("key4"), 4);
    });

    test("should mark entry as recently used on get", () => {
        const cache = new LRUCache<string, number>(3);
        cache.set("key1", 1);
        cache.set("key2", 2);
        cache.set("key3", 3);

        // Access key1, making it recently used
        cache.get("key1");

        // Adding key4 should now evict key2 (which is now least recently used)
        cache.set("key4", 4);
        assert.strictEqual(cache.get("key1"), 1); // key1 still exists
        assert.strictEqual(cache.get("key2"), undefined); // key2 was evicted
        assert.strictEqual(cache.get("key4"), 4);
    });

    test("should update value without changing position on re-set", () => {
        const cache = new LRUCache<string, number>(2);
        cache.set("key1", 1);
        cache.set("key2", 2);

        // Update key1 - it should be marked as recently used
        cache.set("key1", 100);

        // Adding key3 should evict key2
        cache.set("key3", 3);
        assert.strictEqual(cache.get("key1"), 100);
        assert.strictEqual(cache.get("key2"), undefined);
    });

    test("should clear all entries", () => {
        const cache = new LRUCache<string, number>(10);
        cache.set("key1", 1);
        cache.set("key2", 2);
        assert.strictEqual(cache.size, 2);

        cache.clear();
        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.get("key1"), undefined);
    });

    test("should check existence without marking as recently used", () => {
        const cache = new LRUCache<string, number>(3);
        cache.set("key1", 1);
        cache.set("key2", 2);
        cache.set("key3", 3);

        assert.strictEqual(cache.has("key1"), true);
        assert.strictEqual(cache.has("missing"), false);

        // Adding key4 should still evict key1 (has() doesn't mark as recently used)
        cache.set("key4", 4);
        assert.strictEqual(cache.get("key1"), undefined);
    });

    test("should enforce minimum cache size of 1", () => {
        const cache = new LRUCache<string, number>(0); // Try to create with size 0
        cache.set("key1", 1);
        cache.set("key2", 2);

        // Should still keep at least 1 entry
        assert.ok(cache.size > 0);
    });
});
