// Node test: full X3DH handshake + Double Ratchet round trip using the browser bundle.
// Run: node test/signal-roundtrip.test.js
global.window = globalThis;
require('../build/signal-bundle.js');

const { KeyHelper, SignalProtocolAddress, SessionBuilder, SessionCipher, SignalProtocolStore } =
  window.SignalLib;

async function createIdentity(store) {
  const registrationId = KeyHelper.generateRegistrationId();
  store.put('registrationId', registrationId);
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  store.put('identityKey', identityKeyPair);
  const preKeyId = Math.floor(Math.random() * 1000000);
  const preKey = await KeyHelper.generatePreKey(preKeyId);
  await store.storePreKey(preKeyId, preKey.keyPair);
  const signedPreKeyId = Math.floor(Math.random() * 1000000);
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
  await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);
  return {
    registrationId,
    preKeyBundle: {
      registrationId,
      identityKey: identityKeyPair.pubKey,
      preKey: { keyId: preKeyId, publicKey: preKey.keyPair.pubKey },
      signedPreKey: {
        keyId: signedPreKeyId,
        publicKey: signedPreKey.keyPair.pubKey,
        signature: signedPreKey.signature,
      },
    },
  };
}

const enc = (s) => new TextEncoder().encode(s).buffer;
const dec = (b) => new TextDecoder().decode(new Uint8Array(b));

async function main() {
  const aliceStore = new SignalProtocolStore();
  const bobStore = new SignalProtocolStore();
  const aliceAddr = new SignalProtocolAddress('alice', 1);
  const bobAddr = new SignalProtocolAddress('bob', 1);

  await createIdentity(aliceStore);
  const bob = await createIdentity(bobStore);

  const builder = new SessionBuilder(aliceStore, bobAddr);
  await builder.processPreKey(bob.preKeyBundle);

  const aliceCipher = new SessionCipher(aliceStore, bobAddr);
  const bobCipher = new SessionCipher(bobStore, aliceAddr);

  const msg1 = await aliceCipher.encrypt(enc(JSON.stringify({ v: 1, text: 'Hello doc v1' })));
  if (msg1.type !== 3) throw new Error('expected PreKey message type 3, got ' + msg1.type);
  const plain1 = dec(await bobCipher.decryptPreKeyWhisperMessage(msg1.body, 'binary'));
  console.log('bob decrypted:', plain1);
  if (JSON.parse(plain1).text !== 'Hello doc v1') throw new Error('mismatch 1');

  const msg2 = await bobCipher.encrypt(enc('Bob edit v2'));
  const plain2 = dec(await aliceCipher.decryptWhisperMessage(msg2.body, 'binary'));
  console.log('alice decrypted:', plain2);
  if (plain2 !== 'Bob edit v2') throw new Error('mismatch 2');

  for (let i = 3; i <= 12; i++) {
    const sender = i % 2 ? aliceCipher : bobCipher;
    const receiver = i % 2 ? bobCipher : aliceCipher;
    const m = await sender.encrypt(enc('update ' + i));
    const p = dec(await receiver.decryptWhisperMessage(m.body, 'binary'));
    if (p !== 'update ' + i) throw new Error('mismatch at ' + i);
  }
  console.log('10 alternating ratchet updates OK');

  const c1 = await aliceCipher.encrypt(enc('same text'));
  const c2 = await aliceCipher.encrypt(enc('same text'));
  if (c1.body === c2.body) throw new Error('ciphertexts identical');
  console.log('ciphertexts differ per message (ratchet advancing)');

  console.log('ALL SIGNAL PROTOCOL TESTS PASSED');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
