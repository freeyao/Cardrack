// Browser bindings for the storage layer: an IndexedDB-backed AsyncStore and
// the single-writer Web Lock. Both are browser-only, so they live in ui/ and
// stay out of the DOM-free core.
import type { AsyncStore } from '../core/kv';

/** A durable AsyncStore backed by a single IndexedDB object store. */
export class IdbBackend implements AsyncStore {
  private dbp: Promise<IDBDatabase>;
  constructor(private dbName = 'cardrack', private storeName = 'kv') {
    this.dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async loadAll(): Promise<Record<string, string>> {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const out: Record<string, string> = {};
      const req = db.transaction(this.storeName, 'readonly').objectStore(this.storeName).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { out[cur.key as string] = cur.value as string; cur.continue(); }
        else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  write(key: string, value: string): void {
    this.dbp.then((db) => db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).put(value, key)).catch(() => {});
  }
  remove(key: string): void {
    this.dbp.then((db) => db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).delete(key)).catch(() => {});
  }
}

/** Enumerate legacy localStorage entries under a prefix, for one-time migration. */
export function legacyEntries(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out[k] = localStorage.getItem(k)!;
  }
  return out;
}

/** Acquire an exclusive, tab-lifetime writer lock. Returns true if this tab is
 * the single writer, false if another tab already holds it. The lock is held
 * (via a never-resolving callback promise) until the page is discarded, which
 * releases it automatically. Degrades to `true` where Web Locks is unavailable. */
export async function acquireWriterLock(name = 'cardrack-writer'): Promise<boolean> {
  const locks = (navigator as any).locks;
  if (!locks?.request) return true;
  return new Promise<boolean>((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock: any) => {
        resolve(!!lock);
        if (lock) return new Promise<void>(() => {}); // hold until the tab closes
      })
      .catch(() => resolve(true));
  });
}
