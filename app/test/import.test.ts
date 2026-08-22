// Importing an existing nostr key at the gate: nsec / hex / NIP-49 ncryptsec.
import { describe, it, expect, beforeAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { encrypt as nip49encrypt } from 'nostr-tools/nip49';
import { CollabCore } from '../src/core/app';
import { FakeRelay, MemKV, collectHooks, sleep } from './helpers';

beforeAll(() => { (globalThis as any).window = globalThis; });

function makeCore(relay: FakeRelay) {
  return new CollabCore({ pool: relay.poolFor(), storage: new MemKV(), hooks: collectHooks(), syncIntervalMs: 0 });
}

describe('key import', () => {
  it('imports a bare nsec and derives the matching identity', async () => {
    const sk = generateSecretKey();
    const core = makeCore(new FakeRelay());
    await core.startWithNsec(nip19.nsecEncode(sk));
    expect(core.pk).toBe(getPublicKey(sk));
    expect(core.mnemonic).toBeNull();       // no phrase for imported keys
    expect(core.nsec()).toBe(nip19.nsecEncode(sk)); // the recovery secret
    await sleep(50);
    const docId = core.createDoc('Imported works');
    expect(core.docs[docId].ownerPk).toBe(core.pk);
  }, 15000);

  it('imports a 64-hex secret key', async () => {
    const sk = generateSecretKey();
    const hex = Array.from(sk, (b) => b.toString(16).padStart(2, '0')).join('');
    const core = makeCore(new FakeRelay());
    await core.startWithNsec(hex);
    expect(core.pk).toBe(getPublicKey(sk));
  }, 15000);

  it('imports a NIP-49 ncryptsec with the right password; rejects the wrong one', async () => {
    const sk = generateSecretKey();
    const ncryptsec = nip49encrypt(sk, 'hunter2');
    const bad = makeCore(new FakeRelay());
    await expect(bad.startWithNsec(ncryptsec, 'wrong')).rejects.toThrow(/wrong password/);
    await expect(bad.startWithNsec(ncryptsec)).rejects.toThrow(/password-protected/);
    const core = makeCore(new FakeRelay());
    await core.startWithNsec(ncryptsec, 'hunter2');
    expect(core.pk).toBe(getPublicKey(sk));
  }, 20000);

  it('rejects garbage input', async () => {
    const core = makeCore(new FakeRelay());
    await expect(core.startWithNsec('npub1notasecret')).rejects.toThrow();
    await expect(core.startWithNsec('hello')).rejects.toThrow();
  }, 15000);
});
