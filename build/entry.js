// Bundle entry: expose libsignal (TypeScript impl) + nostr-tools to the browser page.
import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
} from '@privacyresearch/libsignal-protocol-typescript';
import { SignalProtocolStore } from './store.js';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
} from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { sha256 } from '@noble/hashes/sha2.js';
import * as nip06 from 'nostr-tools/nip06';
import * as nip44 from 'nostr-tools/nip44';

window.SignalLib = {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
  SignalProtocolStore,
};
window.NostrLib = {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
  SimplePool,
  nip19,
  sha256,
  nip06,
  nip44,
};
