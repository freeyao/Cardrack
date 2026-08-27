// Conclave: removing an editor/viewer. Removal revokes *access*, not the past —
// the removed client drops the doc, stops receiving updates, and its sends are
// rejected; the doc key rotates so future epochs exclude them.
import { describe, it, expect, beforeAll } from 'vitest';
import { CollabCore } from '../src/core/app';
import { FakeRelay, MemKV, collectHooks, sleep } from './helpers';

beforeAll(() => { (globalThis as any).window = globalThis; });

async function makeCore(relay: FakeRelay) {
  const hooks = collectHooks();
  const core = new CollabCore({ pool: relay.poolFor(), storage: new MemKV(), hooks, syncIntervalMs: 0, snapshotDebounceMs: 2000, snapshotMinIntervalMs: 0 });
  await core.startWithNewAccount(core.newMnemonic());
  return { core, hooks };
}

describe('member removal', () => {
  it('owner removes an editor: doc vanishes for them, updates stop, epoch rotates', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay), V = await makeCore(relay);
    await sleep(50);
    const docId = O.core.createDoc('Team notes');
    await O.core.invite(docId, E.core.npub(), 'editor');
    await O.core.invite(docId, V.core.npub(), 'viewer');
    await sleep(300);
    await O.core.localEdit(docId, 'shared baseline', 'plain');
    await sleep(300);
    expect(E.core.docs[docId].content).toBe('shared baseline');
    const epochBefore = O.core.docs[docId].epoch!;

    // remove the editor
    await O.core.removeMember(docId, E.core.pk);
    await sleep(400);

    // owner side: member gone, epoch rotated
    expect(O.core.docs[docId].members.map((m) => m.pk)).toEqual([V.core.pk]);
    expect(O.core.docs[docId].epoch).toBe(epochBefore + 1);
    // removed side: the document is gone from the device
    expect(E.core.docs[docId]).toBeUndefined();
    expect(E.hooks.text()).toContain('You were removed');
    // remaining viewer got the new epoch key; the removed editor did not
    expect(V.core.docs[docId].dockeys?.[String(epochBefore + 1)]).toBeTruthy();

    // future updates no longer reach the removed editor…
    await O.core.localEdit(docId, 'after the removal', 'plain');
    await sleep(300);
    expect(V.core.docs[docId].content).toBe('after the removal');
    expect(E.core.docs[docId]).toBeUndefined();

    // …and the removed editor's sends are rejected as non-member
    await E.core.sendTo(O.core.pk, { t: 'update', docId, update: 'AAAA' });
    await sleep(300);
    expect(O.core.docs[docId].content).toBe('after the removal');
    expect(O.hooks.text()).toContain('REJECTED update from non-member');
  }, 30000);

  it('a non-owner cannot remove members, and a forged remove is ignored', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay), V = await makeCore(relay);
    await sleep(50);
    const docId = O.core.createDoc('Safe');
    await O.core.invite(docId, E.core.npub(), 'editor');
    await O.core.invite(docId, V.core.npub(), 'viewer');
    await sleep(300);

    // editor tries to remove the viewer via the API — refused owner-side
    await E.core.removeMember(docId, V.core.pk);
    await sleep(200);
    expect(O.core.docs[docId].members.length).toBe(2);

    // editor forges a 'remove' at the viewer directly — dropped at the earliest
    // applicable gate (identity-less bootstrap, or the not-from-owner check)
    await E.core.sendTo(V.core.pk, { t: 'remove', docId });
    await sleep(300);
    expect(V.core.docs[docId]).toBeDefined();
    expect(/ignoring remove not from owner|bootstrap missing sender identity/.test(V.hooks.text())).toBe(true);
  }, 30000);
});
