// Unit: doc-key epoch primitives — AES-GCM seal/open and the NIP-44 recovery
// envelope. Pure crypto, no relay, no DOM.
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { newDocKey, sealDoc, openDoc, wrapKeyForAccount, unwrapKeyForAccount } from '../src/core/dockey';

describe('dockey', () => {
  it('mints distinct random 32-byte keys', () => {
    const a = newDocKey(), b = newDocKey();
    expect(a).not.toBe(b);
    expect(atob(a).length).toBe(32);
  });

  it('seal/open round-trips bytes under an epoch key', async () => {
    const key = newDocKey();
    const plain = new TextEncoder().encode('snapshot bytes — epoch 1');
    const sealed = await sealDoc(key, plain);
    expect(sealed).not.toContain('snapshot');
    expect(new TextDecoder().decode(await openDoc(key, sealed))).toBe('snapshot bytes — epoch 1');
    // fresh IV every time: sealing twice never repeats ciphertext
    expect(await sealDoc(key, plain)).not.toBe(sealed);
  });

  it('refuses tampered ciphertext and wrong keys', async () => {
    const key = newDocKey();
    const sealed = await sealDoc(key, new TextEncoder().encode('authentic'));
    const bytes = new Uint8Array(atob(sealed).split('').map((c) => c.charCodeAt(0)));
    bytes[bytes.length - 1] ^= 0x01; // flip one ciphertext bit
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(openDoc(key, tampered)).rejects.toThrow();
    await expect(openDoc(newDocKey(), sealed)).rejects.toThrow(); // wrong key
  });

  it('wrap/unwrap recovery envelope round-trips via the account key', () => {
    const memberSk = generateSecretKey();
    const memberPk = getPublicKey(memberSk);
    const key = newDocKey();
    const env = wrapKeyForAccount(memberPk, key);
    expect(env.sealed).not.toContain(key);
    expect(env.epk).not.toBe(memberPk); // sender is ephemeral, not any identity
    expect(unwrapKeyForAccount(memberSk, env.epk, env.sealed)).toBe(key);
    // a different account cannot unwrap
    expect(() => unwrapKeyForAccount(generateSecretKey(), env.epk, env.sealed)).toThrow();
  });
});
