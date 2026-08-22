// Integration: doc-key epochs over the in-memory relay — owner mints and
// rotates, members receive via invite / key-envelope, restore carries keys.
import { describe, it, expect, beforeAll } from 'vitest';
import { CollabCore } from '../src/core/app';
import { FakeRelay, MemKV, collectHooks, sleep } from './helpers';

beforeAll(() => { (globalThis as any).window = globalThis; });

async function makeCore(relay: FakeRelay) {
  const hooks = collectHooks();
  const core = new CollabCore({ pool: relay.poolFor(), storage: new MemKV(), hooks, syncIntervalMs: 0 });
  await core.startWithNewAccount(core.newMnemonic());
  return { core, hooks };
}

describe('doc-key epochs', () => {
  it('mints epoch 1 on create and delivers it with the invite', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay);
    await sleep(50);

    const docId = O.core.createDoc('Keyed doc');
    const owner = O.core.docs[docId];
    expect(owner.epoch).toBe(1);
    expect(owner.dockeys?.['1']).toBeTruthy();

    await O.core.invite(docId, E.core.npub(), 'editor');
    await sleep(300);
    expect(E.core.docs[docId].epoch).toBe(1);
    expect(E.core.docs[docId].dockeys?.['1']).toBe(owner.dockeys!['1']);

    // the key itself never appears on the wire in the clear
    for (const c of relay.wire) expect(String(c)).not.toContain(owner.dockeys!['1']);
  }, 30000);

  it('owner rotates to epoch 2; member receives it and both retain epoch 1', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay);
    await sleep(50);
    const docId = O.core.createDoc('Rotating');
    await O.core.invite(docId, E.core.npub(), 'editor');
    await sleep(300);
    const key1 = O.core.docs[docId].dockeys!['1'];

    await O.core.rotateDocKey(docId);
    await sleep(300);
    const owner = O.core.docs[docId], member = E.core.docs[docId];
    expect(owner.epoch).toBe(2);
    expect(member.epoch).toBe(2);
    expect(member.dockeys?.['2']).toBe(owner.dockeys!['2']);
    expect(owner.dockeys!['2']).not.toBe(key1);
    // old epoch stays readable on both sides
    expect(owner.dockeys!['1']).toBe(key1);
    expect(member.dockeys!['1']).toBe(key1);
  }, 30000);

  it('refuses rotation by a non-owner and forged key-envelopes', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay), E = await makeCore(relay);
    await sleep(50);
    const docId = O.core.createDoc('Guarded');
    await O.core.invite(docId, E.core.npub(), 'editor');
    await sleep(300);

    // member tries to rotate locally — refused, logged, nothing sent
    await E.core.rotateDocKey(docId);
    await sleep(200);
    expect(E.hooks.text()).toContain('only the owner can rotate');
    expect(E.core.docs[docId].epoch).toBe(1);
    expect(O.core.docs[docId].epoch).toBe(1);

    // member forges a key-envelope to the owner — sender is not the doc owner
    await E.core.sendTo(O.core.pk, { t: 'key-envelope', docId, epoch: 99, key: 'RVZJTA==' });
    await sleep(300);
    expect(O.hooks.text()).toContain('REJECTED key-envelope');
    expect(O.core.docs[docId].epoch).toBe(1);
    expect(O.core.docs[docId].dockeys?.['99']).toBeUndefined();
  }, 30000);

  it('a device restored from the mnemonic regains its doc keys', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay);
    await sleep(50);
    const docId = O.core.createDoc('Keys survive');
    await O.core.rotateDocKey(docId); // two epochs to carry across
    await sleep(2300); // let the debounced self-snapshot publish

    // fresh device, same mnemonic — nothing local
    const N = { hooks: collectHooks() } as any;
    N.core = new CollabCore({ pool: relay.poolFor(), storage: new MemKV(), hooks: N.hooks, syncIntervalMs: 0 });
    await N.core.startWithMnemonic(O.core.mnemonic!);
    await sleep(200);

    expect(N.core.pk).toBe(O.core.pk);
    expect(N.core.docs[docId].epoch).toBe(2);
    expect(N.core.docs[docId].dockeys?.['1']).toBe(O.core.docs[docId].dockeys!['1']);
    expect(N.core.docs[docId].dockeys?.['2']).toBe(O.core.docs[docId].dockeys!['2']);
  }, 30000);

  it('leaves a legacy doc keyless until the owner first rotates', async () => {
    const relay = new FakeRelay();
    const O = await makeCore(relay);
    await sleep(50);
    const docId = O.core.createDoc('Was legacy');
    // simulate a doc that predates epochs (no fabricated key on load)
    delete O.core.docs[docId].epoch;
    delete O.core.docs[docId].dockeys;
    expect(O.core.docs[docId].epoch).toBeUndefined();

    await O.core.rotateDocKey(docId); // first rotation mints epoch 1
    expect(O.core.docs[docId].epoch).toBe(1);
    expect(O.core.docs[docId].dockeys?.['1']).toBeTruthy();
  }, 30000);
});
