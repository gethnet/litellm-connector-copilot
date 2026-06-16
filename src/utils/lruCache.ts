/**
 * Simple LRU (Least Recently Used) cache implementation.
 *
 * When the cache exceeds maxSize, the least recently used entry is evicted.
 * This prevents unbounded memory growth in long-running agentic sessions.
 *
 * Time complexity: O(1) for get, put, and eviction.
 * Space complexity: O(maxSize).
 */
export class LRUCache<K, V> {
    private cache: Map<K, V>;
    private accessOrder: K[]; // Tracks insertion/access order for LRU eviction
    private readonly maxSize: number;

    /**
     * @param maxSize - Maximum number of entries before LRU eviction
     */
    constructor(maxSize: number) {
        this.maxSize = Math.max(1, maxSize); // Ensure at least 1
        this.cache = new Map();
        this.accessOrder = [];
    }

    /**
     * Gets a value from the cache and marks it as recently used.
     *
     * @param key - Cache key
     * @returns Cached value or undefined if not found
     */
    get(key: K): V | undefined {
        if (this.cache.has(key)) {
            // Mark as recently used by moving to end
            const index = this.accessOrder.indexOf(key);
            if (index !== -1) {
                this.accessOrder.splice(index, 1);
            }
            this.accessOrder.push(key);
            return this.cache.get(key);
        }
        return undefined;
    }

    /**
     * Sets a value in the cache. If cache exceeds maxSize, evicts LRU entry.
     *
     * @param key - Cache key
     * @param value - Value to cache
     */
    set(key: K, value: V): void {
        // If key already exists, remove it from access order
        if (this.cache.has(key)) {
            const index = this.accessOrder.indexOf(key);
            if (index !== -1) {
                this.accessOrder.splice(index, 1);
            }
        }

        // Add new entry
        this.cache.set(key, value);
        this.accessOrder.push(key);

        // Evict LRU if over capacity
        while (this.cache.size > this.maxSize && this.accessOrder.length > 0) {
            const lruKey = this.accessOrder.shift(); // Remove oldest (least recently used)
            if (lruKey !== undefined) {
                this.cache.delete(lruKey);
            }
        }
    }

    /**
     * Checks if a key exists in the cache (does NOT mark as recently used).
     *
     * @param key - Cache key
     * @returns True if key exists
     */
    has(key: K): boolean {
        return this.cache.has(key);
    }

    /**
     * Returns the current size of the cache.
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Clears all entries from the cache.
     */
    clear(): void {
        this.cache.clear();
        this.accessOrder = [];
    }
}
