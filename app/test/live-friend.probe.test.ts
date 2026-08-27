// LIVE-NETWORK COUNTERPARTY — runs only with LIVE=1, never in npm test / CI.
// Acts as the "friend" for a manual cross-test against the deployed page:
// prints its npub, waits to be invited, then (as editor) commits an edit so the
// inviting browser can be watched end-to-end.
//   LIVE=1 npx vitest run test/live-friend.probe.test.ts
import { describe, it } from 'vitest';
import { SimplePool } from 'nostr-tools/pool';
import { CollabCore, DEFAULT_RELAYS } from '../src/core/app';
import { MemKV, collectHooks, sleep } from './helpers';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live friend counterparty', () => {
  it('waits for an invite from the deployed page, then edits', async () => {
    const hooks = collectHooks();
    const orig = hooks.log;
    hooks.log = (k, t) => { console.log(`[friend] ${k}: ${t}`); orig(k, t); };
    const core = new CollabCore({
      pool: new SimplePool() as any, storage: new MemKV(), hooks,
      relays: DEFAULT_RELAYS, syncIntervalMs: 20000,
    });
    await core.startWithNewAccount(core.newMnemonic());
    console.log('=== FRIEND NPUB:', core.npub());

    // wait up to 8 minutes for an invite
    let docId: string | null = null;
    for (let i = 0; i < 240 && !docId; i++) {
      await sleep(2000);
      docId = Object.keys(core.docs)[0] ?? null;
    }
    if (!docId) { console.log('=== NO INVITE RECEIVED within 150s'); return; }
    console.log('=== INVITED to doc:', JSON.stringify(core.docs[docId].title), 'role:', core.docs[docId].myRole);

    await sleep(2000);
    await core.localEdit(docId, 'edit from the node friend', 'plain');
    console.log('=== friend committed an edit; staying online 8 min (test removal on me!)…');
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      if (!core.docs[docId]) { console.log('=== I WAS REMOVED — doc deleted from my device.'); break; }
    }
    console.log('=== final:', core.docs[docId] ? `still member, v${core.docs[docId].version}, ${JSON.stringify(core.docs[docId].content)}` : 'removed (doc gone)');
    core.stop();
  }, 1200000);
});
