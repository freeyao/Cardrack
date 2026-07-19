// One-time mailbox address chains: both peers derive the same address sequence
// from a random seed shared inside the encrypted invite. Addresses route; they
// never encrypt or sign anything.
import { sha256 } from '@noble/hashes/sha2.js';
import { getPublicKey } from 'nostr-tools/pure';
import { bufFromB64, concatBytes, utf8 } from './util';

export interface Chain {
  seed: string;      // base64
  sendDir: string;   // 'i2r' | 'r2i'
  recvDir: string;
  sendN: number;
  recvN: number;
}

export function deriveAddr(seedB64: string, dir: string, n: number): string {
  const seed = new Uint8Array(bufFromB64(seedB64));
  const ctr = new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const sk = sha256(concatBytes(seed, utf8('sc-addr:' + dir + ':'), ctr));
  return getPublicKey(sk);
}

export function newChain(seedB64: string, iAmInviter: boolean): Chain {
  return {
    seed: seedB64,
    sendDir: iAmInviter ? 'i2r' : 'r2i',
    recvDir: iAmInviter ? 'r2i' : 'i2r',
    sendN: 0,
    recvN: 0,
  };
}
