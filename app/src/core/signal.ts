// Thin wrapper over libsignal: identity creation, prekey bundle (de)serialization.
import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
} from '@privacyresearch/libsignal-protocol-typescript';
import { SignalProtocolStore } from './signal-store';
import { b64FromBuf, bufFromB64 } from './util';

export { SignalProtocolAddress, SessionBuilder, SessionCipher };

export interface WireBundle {
  registrationId: number;
  identityKey: string;
  preKey: { keyId: number; publicKey: string };
  signedPreKey: { keyId: number; publicKey: string; signature: string };
}

export async function ensureSignalIdentity(store: SignalProtocolStore) {
  if (!(await store.getIdentityKeyPair())) {
    store.put('registrationId', KeyHelper.generateRegistrationId());
    store.put('identityKey', await KeyHelper.generateIdentityKeyPair());
  }
  const ikp = await store.getIdentityKeyPair();
  const preKeyId = 1 + Math.floor(Math.random() * 1000000);
  const preKey = await KeyHelper.generatePreKey(preKeyId);
  await store.storePreKey(preKeyId, preKey.keyPair);
  const signedPreKeyId = 1 + Math.floor(Math.random() * 1000000);
  const signedPreKey = await KeyHelper.generateSignedPreKey(ikp, signedPreKeyId);
  await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);
  return {
    registrationId: await store.getLocalRegistrationId(),
    identityKey: ikp.pubKey as ArrayBuffer,
    preKey: { keyId: preKeyId, publicKey: preKey.keyPair.pubKey as ArrayBuffer },
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: signedPreKey.keyPair.pubKey as ArrayBuffer,
      signature: signedPreKey.signature as ArrayBuffer,
    },
  };
}

export function serializeBundle(b: any): WireBundle {
  return {
    registrationId: b.registrationId,
    identityKey: b64FromBuf(b.identityKey),
    preKey: { keyId: b.preKey.keyId, publicKey: b64FromBuf(b.preKey.publicKey) },
    signedPreKey: {
      keyId: b.signedPreKey.keyId,
      publicKey: b64FromBuf(b.signedPreKey.publicKey),
      signature: b64FromBuf(b.signedPreKey.signature),
    },
  };
}
export function deserializeBundle(b: WireBundle) {
  return {
    registrationId: b.registrationId,
    identityKey: bufFromB64(b.identityKey),
    preKey: { keyId: b.preKey.keyId, publicKey: bufFromB64(b.preKey.publicKey) },
    signedPreKey: {
      keyId: b.signedPreKey.keyId,
      publicKey: bufFromB64(b.signedPreKey.publicKey),
      signature: bufFromB64(b.signedPreKey.signature),
    },
  };
}
