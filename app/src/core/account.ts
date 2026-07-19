// Account = BIP39 mnemonic → nostr keypair. NIP-44 self-encryption for the
// account snapshot (stateless client).
import * as nip06 from 'nostr-tools/nip06';
import * as nip44 from 'nostr-tools/nip44';
import { getPublicKey } from 'nostr-tools/pure';

export const generateMnemonic = (): string => nip06.generateSeedWords();
export const validateMnemonic = (w: string): boolean => nip06.validateWords(w);
export const skFromMnemonic = (w: string): Uint8Array => nip06.privateKeyFromSeedWords(w);
export const pkFromSk = (sk: Uint8Array): string => getPublicKey(sk);

export function selfEncrypt(sk: Uint8Array, pk: string, plain: string): string {
  return nip44.v2.encrypt(plain, nip44.v2.utils.getConversationKey(sk, pk));
}
export function selfDecrypt(sk: Uint8Array, pk: string, cipher: string): string {
  return nip44.v2.decrypt(cipher, nip44.v2.utils.getConversationKey(sk, pk));
}
