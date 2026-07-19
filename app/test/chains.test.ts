import { describe, it, expect } from 'vitest';
import { deriveAddr, newChain } from '../src/core/chains';

const seed = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const seed2 = Buffer.from(new Uint8Array(32).fill(8)).toString('base64');

describe('one-time address chains', () => {
  it('is deterministic', () => {
    expect(deriveAddr(seed, 'i2r', 0)).toBe(deriveAddr(seed, 'i2r', 0));
    expect(deriveAddr(seed, 'i2r', 41)).toBe(deriveAddr(seed, 'i2r', 41));
  });
  it('separates directions and seeds', () => {
    expect(deriveAddr(seed, 'i2r', 0)).not.toBe(deriveAddr(seed, 'r2i', 0));
    expect(deriveAddr(seed, 'i2r', 0)).not.toBe(deriveAddr(seed2, 'i2r', 0));
  });
  it('has no collisions across 1000 indexes x 2 directions', () => {
    const seen = new Set<string>();
    for (const dir of ['i2r', 'r2i']) for (let n = 0; n < 1000; n++) seen.add(deriveAddr(seed, dir, n));
    expect(seen.size).toBe(2000);
  });
  it('newChain assigns mirrored directions', () => {
    const a = newChain(seed, true), b = newChain(seed, false);
    expect(a.sendDir).toBe(b.recvDir);
    expect(a.recvDir).toBe(b.sendDir);
  });
});
