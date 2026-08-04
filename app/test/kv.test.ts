import { describe, it, expect } from 'vitest';
import { AsyncStore, CachedKV } from '../src/core/kv';

/** In-memory AsyncStore double that records write-through calls. */
class FakeStore implements AsyncStore {
  data: Record<string, string> = {};
  writes: [string, string][] = [];
  removes: string[] = [];
  constructor(initial: Record<string, string> = {}) { this.data = { ...initial }; }
  async loadAll() { return { ...this.data }; }
  write(k: string, v: string) { this.writes.push([k, v]); this.data[k] = v; }
  remove(k: string) { this.removes.push(k); delete this.data[k]; }
}

describe('CachedKV', () => {
  it('preloads the cache from the backend (sync reads afterwards)', async () => {
    const kv = new CachedKV(new FakeStore({ a: '1', b: '2' }));
    await kv.open();
    expect(kv.get('a')).toBe('1');
    expect(kv.get('b')).toBe('2');
    expect(kv.get('missing')).toBeNull();
  });

  it('writes through to the backend and updates the cache', async () => {
    const store = new FakeStore();
    const kv = new CachedKV(store);
    await kv.open();
    kv.set('k', 'v');
    expect(kv.get('k')).toBe('v');
    expect(store.writes).toEqual([['k', 'v']]);
  });

  it('read-only mode: cache updates but nothing is persisted', async () => {
    const store = new FakeStore({ existing: 'x' });
    const kv = new CachedKV(store);
    await kv.open();
    kv.setWritable(false);
    kv.set('k', 'v');
    expect(kv.get('k')).toBe('v');          // visible in-memory
    expect(store.writes).toHaveLength(0);   // but never written through
    expect(kv.isWritable).toBe(false);
  });

  it('seeds from a legacy store only when the backend is empty', async () => {
    const store = new FakeStore();
    const kv = new CachedKV(store);
    await kv.open({ 'sc2.nsk': 'abc', 'sc2.docs': '{}' });
    expect(kv.get('sc2.nsk')).toBe('abc');
    expect(store.writes).toEqual([['sc2.nsk', 'abc'], ['sc2.docs', '{}']]);
  });

  it('ignores the seed when the backend already has data', async () => {
    const store = new FakeStore({ 'sc2.nsk': 'real' });
    const kv = new CachedKV(store);
    await kv.open({ 'sc2.nsk': 'stale-seed' });
    expect(kv.get('sc2.nsk')).toBe('real');
    expect(store.writes).toHaveLength(0);
  });

  it('a non-writer tab does not persist the migration seed', async () => {
    const store = new FakeStore();
    const kv = new CachedKV(store);
    kv.setWritable(false);
    await kv.open({ 'sc2.nsk': 'abc' });
    expect(kv.get('sc2.nsk')).toBe('abc');  // adopted in memory for reading
    expect(store.writes).toHaveLength(0);   // but the writer tab owns persistence
  });
});
