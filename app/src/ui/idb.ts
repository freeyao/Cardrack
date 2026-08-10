// Browser bindings for the storage layer: an IndexedDB-backed AsyncStore and
// the single-writer Web Lock. Both are browser-only, so they live in ui/ and
// stay out of the DOM-free core.
import type { AsyncStore } from '../core/kv';

/** localStorage-backed AsyncStore — the fallback when IndexedDB is unavailable.
 * IndexedDB is blocked or throws in several local contexts (a single-file build
 * opened over file://, Firefox on file://, some privacy modes); localStorage
 * still works there, which is what the app used before IndexedDB. */
export class LocalStorageBackend implements AsyncStore {
  async loadAll(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) out[k] = localStorage.getItem(k)!; }
    } catch {}
    return out;
  }
  write(key: string, value: string): void { try { localStorage.setItem(key, value); } catch {} }
  remove(key: string): void { try { localStorage.removeItem(key); } catch {} }
  async clear(): Promise<void> {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('sc2.')) localStorage.removeItem(k); } catch {}
  }
}

/** A durable AsyncStore backed by a single IndexedDB object store, with a
 * transparent localStorage fallback if IndexedDB can't be opened or read. */
export class IdbBackend implements AsyncStore {
  private dbp: Promise<IDBDatabase | null>;
  private fb: LocalStorageBackend | null = null;
  constructor(private dbName = 'cardrack', private storeName = 'kv') {
    this.dbp = new Promise((resolve) => {
      let req: IDBOpenDBRequest;
      try { req = indexedDB.open(dbName, 1); } catch { resolve(null); return; } // IndexedDB missing entirely
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);   // e.g. blocked on file://
      req.onblocked = () => resolve(null);
    });
  }
  private lsfb(): LocalStorageBackend { return (this.fb ||= new LocalStorageBackend()); }

  async loadAll(): Promise<Record<string, string>> {
    const db = await this.dbp;
    if (!db) return this.lsfb().loadAll();
    try {
      return await new Promise<Record<string, string>>((resolve, reject) => {
        const out: Record<string, string> = {};
        const req = db.transaction(this.storeName, 'readonly').objectStore(this.storeName).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { out[cur.key as string] = cur.value as string; cur.continue(); }
          else resolve(out);
        };
        req.onerror = () => reject(req.error);
      });
    } catch { return this.lsfb().loadAll(); }
  }

  write(key: string, value: string): void {
    this.dbp.then((db) => {
      if (!db) return this.lsfb().write(key, value);
      db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).put(value, key);
    }).catch(() => this.lsfb().write(key, value));
  }
  remove(key: string): void {
    this.dbp.then((db) => {
      if (!db) return this.lsfb().remove(key);
      db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).delete(key);
    }).catch(() => this.lsfb().remove(key));
  }
  async clear(): Promise<void> {
    await this.lsfb().clear(); // also drop any legacy localStorage account data
    const db = await this.dbp;
    if (!db) return;
    await new Promise<void>((resolve) => {
      const req = db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
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
