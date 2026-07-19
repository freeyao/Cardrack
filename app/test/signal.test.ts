import { describe, it, expect, beforeAll } from 'vitest';
import { SignalProtocolStore } from '../src/core/signal-store';
import { ensureSignalIdentity, serializeBundle, deserializeBundle, SignalProtocolAddress, SessionBuilder, SessionCipher } from '../src/core/signal';
import { enc, dec } from '../src/core/util';

beforeAll(() => { (globalThis as any).window = globalThis; });

describe('signal layer', () => {
  it('X3DH + ratchet round trip; store serialize/deserialize preserves sessions', async () => {
    const aStore = new SignalProtocolStore(), bStore = new SignalProtocolStore();
    await ensureSignalIdentity(aStore);
    const bBundle = await ensureSignalIdentity(bStore);

    const wire = serializeBundle(bBundle);
    const rebuilt = deserializeBundle(JSON.parse(JSON.stringify(wire)));
    await new SessionBuilder(aStore as any, new SignalProtocolAddress('bob', 1)).processPreKey(rebuilt as any);

    const aCipher = new SessionCipher(aStore as any, new SignalProtocolAddress('bob', 1));
    const bCipher = new SessionCipher(bStore as any, new SignalProtocolAddress('alice', 1));

    const m1 = await aCipher.encrypt(enc('hello'));
    expect(m1.type).toBe(3);
    expect(dec(await bCipher.decryptPreKeyWhisperMessage(m1.body!, 'binary'))).toBe('hello');

    const m2 = await bCipher.encrypt(enc('reply'));
    expect(dec(await aCipher.decryptWhisperMessage(m2.body!, 'binary'))).toBe('reply');

    // persistence round trip: serialize alice's store, restore into a new store, keep talking
    const json = aStore.serialize();
    const aStore2 = new SignalProtocolStore();
    aStore2.deserialize(json);
    const aCipher2 = new SessionCipher(aStore2 as any, new SignalProtocolAddress('bob', 1));
    const m3 = await aCipher2.encrypt(enc('after restore'));
    expect(dec(await bCipher.decryptWhisperMessage(m3.body!, 'binary'))).toBe('after restore');

    const m4 = await bCipher.encrypt(enc('ack'));
    expect(dec(await aCipher2.decryptWhisperMessage(m4.body!, 'binary'))).toBe('ack');
  }, 30000);
});
