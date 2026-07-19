// In-memory SignalProtocolStore implementing libsignal's StorageType, with
// JSON serialization for persistence. One-time prekeys are deliberately NOT
// consumed (relay ordering is not guaranteed; documented PoC tradeoff).
import { b64FromBuf, bufFromB64 } from './util';

const AB = '__ab__';
function encVal(v: any): any {
  if (v instanceof ArrayBuffer) return { [AB]: b64FromBuf(v) };
  if (v && typeof v === 'object' && (v.pubKey instanceof ArrayBuffer || v.privKey instanceof ArrayBuffer)) {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = v[k] instanceof ArrayBuffer ? { [AB]: b64FromBuf(v[k]) } : v[k];
    return { __kp__: o };
  }
  return v;
}
function decVal(v: any): any {
  if (v && typeof v === 'object') {
    if (AB in v) return bufFromB64(v[AB]);
    if ('__kp__' in v) {
      const o: any = {};
      for (const k of Object.keys(v.__kp__)) {
        const x = v.__kp__[k];
        o[k] = x && typeof x === 'object' && AB in x ? bufFromB64(x[AB]) : x;
      }
      return o;
    }
  }
  return v;
}
const abEq = (a: ArrayBuffer, b: ArrayBuffer) => new Uint8Array(a).join(',') === new Uint8Array(b).join(',');

export class SignalProtocolStore {
  private _store: Record<string, any> = {};

  get(key: string, defaultValue?: any) {
    if (key == null) throw new Error('null key');
    return key in this._store ? this._store[key] : defaultValue;
  }
  put(key: string, value: any) {
    if (key == null || value == null) throw new Error('null key/value');
    this._store[key] = value;
  }
  remove(key: string) { delete this._store[key]; }

  async getIdentityKeyPair() { return this.get('identityKey'); }
  async getLocalRegistrationId() { return this.get('registrationId'); }
  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer) {
    const trusted = this.get('identityKey' + identifier);
    return trusted === undefined ? true : abEq(identityKey, trusted);
  }
  async loadIdentityKey(identifier: string) { return this.get('identityKey' + identifier); }
  async saveIdentity(identifier: string, identityKey: ArrayBuffer) {
    const name = identifier.split('.')[0];
    const existing = this.get('identityKey' + name);
    this.put('identityKey' + name, identityKey);
    return existing !== undefined && !abEq(identityKey, existing);
  }
  async loadPreKey(keyId: number | string) {
    const r = this.get('25519KeypreKey' + keyId);
    return r ? { pubKey: r.pubKey, privKey: r.privKey } : undefined;
  }
  async storePreKey(keyId: number | string, keyPair: any) { this.put('25519KeypreKey' + keyId, keyPair); }
  async removePreKey(_keyId: number | string) { /* deliberately kept — see header */ }
  async loadSignedPreKey(keyId: number | string) {
    const r = this.get('25519KeysignedKey' + keyId);
    return r ? { pubKey: r.pubKey, privKey: r.privKey } : undefined;
  }
  async storeSignedPreKey(keyId: number | string, keyPair: any) { this.put('25519KeysignedKey' + keyId, keyPair); }
  async removeSignedPreKey(keyId: number | string) { this.remove('25519KeysignedKey' + keyId); }
  async loadSession(identifier: string) { return this.get('session' + identifier); }
  async storeSession(identifier: string, record: any) { this.put('session' + identifier, record); }
  async removeSession(identifier: string) { this.remove('session' + identifier); }
  async removeAllSessions(identifier: string) {
    for (const id of Object.keys(this._store)) if (id.startsWith('session' + identifier)) delete this._store[id];
  }

  serialize(): string {
    const out: Record<string, any> = {};
    for (const k of Object.keys(this._store)) out[k] = encVal(this._store[k]);
    return JSON.stringify(out);
  }
  deserialize(json: string) {
    const raw = JSON.parse(json);
    this._store = {};
    for (const k of Object.keys(raw)) this._store[k] = decVal(raw[k]);
  }
}
