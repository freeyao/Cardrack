import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic, skFromMnemonic, pkFromSk, selfEncrypt, selfDecrypt } from '../src/core/account';

describe('account', () => {
  it('mnemonic → deterministic key', () => {
    const w = generateMnemonic();
    expect(w.split(' ').length).toBe(12);
    expect(validateMnemonic(w)).toBe(true);
    expect(validateMnemonic('not a phrase')).toBe(false);
    const sk1 = skFromMnemonic(w), sk2 = skFromMnemonic(w);
    expect(Buffer.from(sk1).toString('hex')).toBe(Buffer.from(sk2).toString('hex'));
  });
  it('nip44 self-encryption round trip; ciphertext hides plaintext', () => {
    const w = generateMnemonic();
    const sk = skFromMnemonic(w), pk = pkFromSk(sk);
    const secret = JSON.stringify({ docs: { d1: { title: 'Top secret plan' } } });
    const c = selfEncrypt(sk, pk, secret);
    expect(c.includes('Top secret')).toBe(false);
    expect(selfDecrypt(sk, pk, c)).toBe(secret);
    // another key cannot decrypt
    const sk2 = skFromMnemonic(generateMnemonic());
    expect(() => selfDecrypt(sk2, pkFromSk(sk2), c)).toThrow();
  });
});
