// LIVE-NETWORK PROBE — runs only with LIVE=1 (never in npm test / CI).
// Reproduces the two-party flow over the real default relays to diagnose
// field-reported delivery failures: invite (owner→editor) vs update
// (editor→owner). Logs per-relay publish outcomes and subscription lifecycle,
// which the app currently swallows.
//   LIVE=1 npx vitest run test/live-relay.probe.test.ts
import { describe, it, expect } from 'vitest';
import { SimplePool } from 'nostr-tools/pool';
import { CollabCore, DEFAULT_RELAYS } from '../src/core/app';
import { MemKV, collectHooks, sleep } from './helpers';
import type { Pool } from '../src/core/types';

const LIVE = process.env.LIVE === '1';

function loggingPool(tag: string): Pool {
  const sp = new SimplePool();
  return {
    publish(relays: string[], ev: any) {
      const ps = sp.publish(relays, ev);
      ps.forEach((p, i) =>
        p.then(
          (r: any) => console.log(`[${tag}] PUB ok    ${relays[i]} kind=${ev.kind} (${String(r).slice(0, 40)})`),
          (e: any) => console.log(`[${tag}] PUB FAIL  ${relays[i]} kind=${ev.kind}: ${String(e).slice(0, 120)}`),
        ),
      );
      return ps;
    },
    subscribe(relays: string[], filter: any, handlers: { onevent: (ev: any) => void }) {
      const sub = (sp as any).subscribe(relays, filter, {
        onevent: handlers.onevent,
        oneose: () => console.log(`[${tag}] SUB eose  (${JSON.stringify(filter).slice(0, 90)}…)`),
        onclose: (reasons: any) => console.log(`[${tag}] SUB CLOSE ${JSON.stringify(reasons).slice(0, 120)}`),
      });
      return { close: () => sub.close() };
    },
    async get(relays: string[], filter: any) {
      try { return await sp.get(relays, filter); }
      catch (e: any) { console.log(`[${tag}] GET FAIL: ${e.message}`); return null; }
    },
  };
}

async function makeCore(tag: string) {
  const hooks = collectHooks();
  const origLog = hooks.log;
  hooks.log = (k, t) => { console.log(`[${tag}] ${k}: ${t}`); origLog(k, t); };
  const core = new CollabCore({ pool: loggingPool(tag), storage: new MemKV(), hooks, relays: DEFAULT_RELAYS, syncIntervalMs: 0 });
  await core.startWithNewAccount(core.newMnemonic());
  return core;
}

describe.skipIf(!LIVE)('live relay probe', () => {
  it('owner invites editor; editor update reaches owner (real relays)', async () => {
    console.log('=== relays:', DEFAULT_RELAYS.join(', '));
    const A = await makeCore('A/owner');
    const B = await makeCore('B/editor');
    await sleep(4000);

    const docId = A.createDoc('Live probe');
    console.log('=== A invites B…');
    await A.invite(docId, B.npub(), 'editor');
    await sleep(8000);
    console.log('=== B sees doc?', !!B.docs[docId], JSON.stringify(B.docs[docId]?.title));

    console.log('=== B commits an edit…');
    await B.localEdit(docId, 'hello from B over real relays', 'plain');
    await sleep(10000);
    console.log('=== A content after edit:', JSON.stringify(A.docs[docId]?.content));

    if (A.docs[docId]?.content !== 'hello from B over real relays') {
      console.log('=== NOT delivered; trying anti-entropy (B syncs)…');
      await B.syncAllPeers();
      await sleep(8000);
      console.log('=== A content after sync:', JSON.stringify(A.docs[docId]?.content));
    }
    expect(B.docs[docId]?.title).toBe('Live probe');
  }, 120000);
});
