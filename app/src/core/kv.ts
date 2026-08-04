// Synchronous KV facade over an asynchronous, durable backend.
//
// The core reads and writes storage synchronously (boot() and saveAll() are not
// async), but IndexedDB is async. CachedKV bridges the two: it holds an
// in-memory cache that is the runtime source of truth, preloaded once from the
// backend at open() time. Reads hit the cache; writes update the cache and
// write through to the backend fire-and-forget.
//
// A `writable` flag lets a tab that does NOT hold the single-writer lock keep
// working in memory (so the user still sees their docs) without persisting —
// two tabs persisting the same Signal ratchet store would corrupt each other.
//
// DOM-free and unit-tested in Node; the IndexedDB binding lives in ui/idb.ts.
import type { KV } from './types';

/** Durable, asynchronous backend. write()/remove() are fire-and-forget. */
export interface AsyncStore {
  loadAll(): Promise<Record<string, string>>;
  write(key: string, value: string): void;
  remove?(key: string): void;
}

export class CachedKV implements KV {
  private cache = new Map<string, string>();
  private writable = true;

  constructor(private backend: AsyncStore) {}

  /** Preload the cache from the backend. If the backend is empty and `seed` is
   * given (one-time migration from a legacy store), adopt and persist it. */
  async open(seedIfEmpty?: Record<string, string>): Promise<void> {
    const all = await this.backend.loadAll();
    const keys = Object.keys(all);
    if (keys.length === 0 && seedIfEmpty && Object.keys(seedIfEmpty).length) {
      for (const [k, v] of Object.entries(seedIfEmpty)) {
        this.cache.set(k, v);
        if (this.writable) this.backend.write(k, v);
      }
    } else {
      for (const k of keys) this.cache.set(k, all[k]);
    }
  }

  get(k: string): string | null {
    return this.cache.has(k) ? this.cache.get(k)! : null;
  }
  set(k: string, v: string): void {
    this.cache.set(k, v);
    if (this.writable) this.backend.write(k, v);
  }

  /** Toggle durable persistence. A non-writer tab runs cache-only. */
  setWritable(w: boolean): void { this.writable = w; }
  get isWritable(): boolean { return this.writable; }
}
