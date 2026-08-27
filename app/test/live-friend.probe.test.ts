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
    console.log('=== friend committed an edit; waiting for owner echo…');
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      if (core.docs[docId].version > 0) break;
    }
    console.log('=== final: version', core.docs[docId].version, 'content', JSON.stringify(core.docs[docId].content));
    core.stop();
  }, 300000);
});
