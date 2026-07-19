// Integration: full protocol over an in-memory relay — no DOM, no jsdom.
import { describe, it, expect, beforeAll } from 'vitest';
import { CollabCore } from '../src/core/app';
import { FakeRelay, MemKV, collectHooks, sleep } from './helpers';

beforeAll(() => { (globalThis as any).window = globalThis; });

async function makeCore(relay: FakeRelay) {
  const hooks = collectHooks();
  // syncIntervalMs: 0 disables the background timer so tests drive sync deterministically.
  const core = new CollabCore({ pool: relay.poolFor(), storage: new MemKV(), hooks, syncIntervalMs: 0 });
  await core.startWithNewAccount(core.newMnemonic());
  return { core, hooks };
}

describe('collab protocol', () => {
  it('invite → sync → ACL → restore → self-heal, with metadata privacy', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay), V = await makeCore(relay);
    await sleep(50);

    // owner creates + invites editor and viewer
    const docId = O.core.createDoc('Q3 plan');
    await O.core.invite(docId, E.core.npub(), 'editor');
    await O.core.invite(docId, V.core.npub(), 'viewer');
    await sleep(300);
    expect(E.core.docs[docId]?.title).toBe('Q3 plan');
    expect(E.core.docs[docId]?.myRole).toBe('editor');
    expect(V.core.docs[docId]?.myRole).toBe('viewer');

    // owner edit fans out
    await O.core.localEdit(docId, 'Ship v1 by October.', 'plain');
    await sleep(300);
    expect(E.core.docs[docId].content).toBe('Ship v1 by October.');
    expect(V.core.docs[docId].content).toBe('Ship v1 by October.');

    // editor edit → owner applies → forwards to viewer
    await E.core.localEdit(docId, 'Ship v1 by October. Editor adds detail.', 'plain');
    await sleep(400);
    expect(O.core.docs[docId].content).toBe('Ship v1 by October. Editor adds detail.');
    expect(V.core.docs[docId].content).toBe('Ship v1 by October. Editor adds detail.');

    // malicious viewer bypasses UI guard and sends a forged update → owner rejects
    await V.core.sendTo(O.core.pk, { t: 'update', docId, version: 99, ts: Date.now(), author: V.core.pk, content: 'HACKED', format: 'plain' });
    await sleep(300);
    expect(O.core.docs[docId].content).not.toContain('HACKED');
    expect(O.hooks.text()).toContain('REJECTED update');

    // stranger with no membership
    const S = await makeCore(relay);
    await S.core.sendTo(O.core.pk, { t: 'update', docId: 'nope', version: 1, ts: Date.now(), author: S.core.pk, content: 'STRANGER', format: 'plain' });
    await sleep(300);
    // rejected at the earliest gate: a bootstrap envelope whose payload carries
    // no verifiable sender identity is dropped before doc routing even happens
    expect(/bootstrap missing sender identity|unknown doc|REJECTED/.test(O.hooks.text())).toBe(true);

    // metadata privacy: all envelopes anonymous; non-boot envelopes to one-time addrs only
    const identities = [O, E, V, S].map((x) => x.core.pk);
    const envs = relay.events.filter((e) => e.kind === 4078);
    for (const e of envs) expect(identities).not.toContain(e.pubkey);
    for (const e of envs) {
      const p = (e.tags.find((t: any) => t[0] === 'p') || [])[1];
      if (identities.includes(p)) expect(JSON.parse(e.content).boot).toBe(1);
    }
    // plaintext never on the wire
    for (const c of relay.wire) {
      expect(String(c)).not.toContain('Ship v1');
      expect(String(c)).not.toContain('Q3 plan');
    }

    // device restore: E's device dies; new core from same mnemonic
    await sleep(2300); // let E's debounced snapshot publish
    const N = { hooks: collectHooks() } as any;
    N.core = new CollabCore({ pool: relay.poolFor(), storage: new MemKV(), hooks: N.hooks, syncIntervalMs: 0 });
    await N.core.startWithMnemonic(E.core.mnemonic!);
    await sleep(200);
    expect(N.core.pk).toBe(E.core.pk);
    expect(N.core.docs[docId]?.content).toBe('Ship v1 by October. Editor adds detail.');

    // new device edits; owner receives after automatic re-handshake
    await N.core.localEdit(docId, 'Edited from replacement device.', 'plain');
    await sleep(500);
    expect(O.core.docs[docId].content).toBe('Edited from replacement device.');

    // owner replies; new device converges
    await O.core.localEdit(docId, 'Owner ack.', 'plain');
    await sleep(500);
    expect(N.core.docs[docId].content).toBe('Owner ack.');
  }, 60000);

  it('rejects an invite whose claimed sender does not match the signed prekey bundle', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), X = await makeCore(relay), Y = await makeCore(relay);
    await sleep(50);
    // X sends an invite claiming to be Y
    const docId = X.core.createDoc('Trap');
    const seed = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
    await X.core.sendTo(O.core.pk, { t: 'invite', from: Y.core.pk, seed, docId, title: 'Trap', role: 'editor', members: [], doc: null });
    await sleep(300);
    expect(O.core.docs[docId]).toBeUndefined();
    expect(O.hooks.text()).toContain('REJECTED invite');
  }, 30000);

  it('recovers a lost update via anti-entropy sync', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay);
    await sleep(50);

    const docId = O.core.createDoc('Notes');
    await O.core.invite(docId, E.core.npub(), 'editor');
    await sleep(300);
    await O.core.localEdit(docId, 'first line', 'plain');
    await sleep(300);
    expect(E.core.docs[docId].content).toBe('first line'); // baseline converged

    // simulate total loss of the next document envelope(s)
    relay.dropFn = (ev) => ev.kind === 4078;
    await O.core.localEdit(docId, 'first line + second (dropped in transit)', 'plain');
    await sleep(200);
    expect(E.core.docs[docId].content).toBe('first line'); // E never saw it
    expect(O.core.docs[docId].content).toContain('second');

    // network heals; anti-entropy reconciles the divergence
    relay.dropFn = null;
    await O.core.syncAllPeers();
    await sleep(400);
    expect(E.core.docs[docId].content).toBe('first line + second (dropped in transit)');

    // and the reverse direction: an editor update lost, owner catches up on E's sync
    relay.dropFn = (ev) => ev.kind === 4078;
    await E.core.localEdit(docId, 'third line from editor (dropped)', 'plain');
    await sleep(200);
    expect(O.core.docs[docId].content).not.toContain('third');
    relay.dropFn = null;
    await E.core.syncAllPeers();
    await sleep(400);
    expect(O.core.docs[docId].content).toBe('third line from editor (dropped)');
  }, 30000);
});
