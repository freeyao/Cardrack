// Doc-key epochs — per-document content keys, tiered under invariant #2:
// every epoch key is 32 fresh random bytes (never KDF-derived), minted and
// rotated by the owner only. sealDoc/openDoc are the snapshot-at-rest cipher
// (AES-256-GCM); wrap/unwrapKeyForAccount is the NIP-44 *recovery path* — an
// ephemeral sender key to the member's account pk, so the identity key still
// signs, never encrypts (invariant #1): it only ever *receives* envelopes.
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { b64FromBuf, bufFromB64, concatBytes } from './util';

const subtle = globalThis.crypto.subtle;

/** A fresh random 32-byte doc key (one per epoch), base64. */
export function newDocKey(): string {
  return b64FromBuf(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
}

async function aesKey(keyB64: string, usage: 'encrypt' | 'decrypt') {
  return subtle.importKey('raw', bufFromB64(keyB64), 'AES-GCM', false, [usage]);
}

/** Encrypt bytes under an epoch key: AES-256-GCM, fresh 12-byte IV prepended. */
export async function sealDoc(keyB64: string, bytes: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyB64, 'encrypt');
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes as any));
  return b64FromBuf(concatBytes(iv, ct).buffer as ArrayBuffer);
}

/** Decrypt sealDoc output. Throws if the key is wrong or the data was tampered. */
export async function openDoc(keyB64: string, sealed: string): Promise<Uint8Array> {
  const all = new Uint8Array(bufFromB64(sealed));
  const key = await aesKey(keyB64, 'decrypt');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12) as any));
}

/** Recovery path: wrap an epoch key to a member's *account* pk via NIP-44,
 * from a fresh ephemeral keypair (not the owner's identity sk — invariant #1).
 * The envelope carries the ephemeral pubkey so the member can derive the
 * shared secret with their account sk. */
export function wrapKeyForAccount(memberPk: string, keyB64: string): { epk: string; sealed: string } {
  const esk = generateSecretKey();
  const epk = getPublicKey(esk);
  const sealed = nip44.v2.encrypt(keyB64, nip44.v2.utils.getConversationKey(esk, memberPk));
  return { epk, sealed };
}

/** Unwrap a recovery envelope with the member's account sk. */
export function unwrapKeyForAccount(sk: Uint8Array, epk: string, sealed: string): string {
  return nip44.v2.decrypt(sealed, nip44.v2.utils.getConversationKey(sk, epk));
}
