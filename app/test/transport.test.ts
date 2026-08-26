// Delivery resilience: events rejected by every relay are queued and retried.
// Live probing showed real relays rate-limit or time out, sometimes all at once
// (the field failure: an editor's update silently lost). The outbox makes that
// a delay instead of a loss.
import { describe, it, expect, beforeAll } from 'vitest';
import { CollabCore } from '../src/core/app';
import { FakeRelay, MemKV, collectHooks, sleep } from './helpers';
import type { Pool } from '../src/core/types';

beforeAll(() => { (globalThis as any).window = globalThis; });

/** Wraps a FakeRelay pool; while `down` is true every publish is rejected
 * (nothing stored/delivered), simulating all relays refusing at once. */
function flakyPool(relay: FakeRelay): Pool & { down: boolean } {
  const inner = relay.poolFor();
  const p: any = {
    down: false,
    publish(relays: string[], ev: any) {
      if (p.down) return [Promise.reject(new Error('rate-limited: you are noting too much'))];
      return inner.publish(relays, ev);
    },
    subscribe: inner.subscribe.bind(inner),
    get: inner.get.bind(inner),
  };
  return p;
}

describe('transport resilience', () => {
  it('retries an update rejected by every relay until it reaches the owner', async () => {
    const relay = new FakeRelay();
    const ownerPool = relay.poolFor();
    const editorPool = flakyPool(relay);

    const O = new CollabCore({ pool: ownerPool, storage: new MemKV(), hooks: collectHooks(), syncIntervalMs: 0 });
    await O.startWithNewAccount(O.newMnemonic());
    const hooksE = collectHooks();
    const E = new CollabCore({ pool: editorPool, storage: new MemKV(), hooks: hooksE, syncIntervalMs: 0 });
    await E.startWithNewAccount(E.newMnemonic());
    await sleep(50);

    const docId = O.createDoc('Outbox');
    await O.invite(docId, E.npub(), 'editor');
    await sleep(300);
    expect(E.docs[docId]?.title).toBe('Outbox');

    // network breaks for the editor: every publish rejected
    editorPool.down = true;
    await E.localEdit(docId, 'written during the outage', 'plain');
    await sleep(200);
    expect(O.docs[docId].content).toBe('');                    // owner got nothing
    expect(hooksE.text()).toContain('not accepted by any relay'); // and the editor was told
    expect(E.outbox.length).toBeGreaterThan(0);                // update queued, not lost

    // network heals; the next tick retries the outbox
    editorPool.down = false;
    E.flushOutbox();
    await sleep(400);
    expect(O.docs[docId].content).toBe('written during the outage');
    expect(E.outbox.length).toBe(0);                           // delivered and cleared
  }, 30000);
});
