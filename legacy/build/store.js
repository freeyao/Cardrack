// In-memory SignalProtocolStore implementing the StorageType interface
// required by @privacyresearch/libsignal-protocol-typescript.
// PoC only — a production app would persist to IndexedDB.

export class SignalProtocolStore {
  constructor() {
    this._store = {};
  }

  get(key, defaultValue) {
    if (key === null || key === undefined) throw new Error('Tried to get value for undefined/null key');
    if (key in this._store) return this._store[key];
    return defaultValue;
  }

  remove(key) {
    if (key === null || key === undefined) throw new Error('Tried to remove value for undefined/null key');
    delete this._store[key];
  }

  put(key, value) {
    if (key === undefined || value === undefined || key === null || value === null)
      throw new Error('Tried to store undefined/null');
    this._store[key] = value;
  }

  async getIdentityKeyPair() {
    return this.get('identityKey', undefined);
  }

  async getLocalRegistrationId() {
    return this.get('registrationId', undefined);
  }

  async isTrustedIdentity(identifier, identityKey, _direction) {
    if (identifier === null || identifier === undefined)
      throw new Error('tried to check identity key for undefined/null key');
    const trusted = this.get('identityKey' + identifier, undefined);
    if (trusted === undefined) return true; // trust on first use
    return arrayBufferToString(identityKey) === arrayBufferToString(trusted);
  }

  async loadIdentityKey(identifier) {
    if (identifier === null || identifier === undefined)
      throw new Error('Tried to get identity key for undefined/null key');
    return this.get('identityKey' + identifier, undefined);
  }

  async saveIdentity(identifier, identityKey) {
    if (identifier === null || identifier === undefined)
      throw new Error('Tried to put identity key for undefined/null key');
    const address = window.SignalLib.SignalProtocolAddress.fromString(identifier);
    const existing = this.get('identityKey' + address.getName(), undefined);
    this.put('identityKey' + address.getName(), identityKey);
    if (existing && arrayBufferToString(identityKey) !== arrayBufferToString(existing)) {
      return true; // identity changed
    }
    return false;
  }

  async loadPreKey(keyId) {
    let res = this.get('25519KeypreKey' + keyId, undefined);
    if (res !== undefined) res = { pubKey: res.pubKey, privKey: res.privKey };
    return res;
  }

  async storePreKey(keyId, keyPair) {
    return this.put('25519KeypreKey' + keyId, keyPair);
  }

  async removePreKey(keyId) {
    // PoC: keep one-time prekeys instead of consuming them. Relay ordering is not
    // guaranteed, so two PreKeyWhisperMessages referencing the same prekey can
    // arrive in either order; deleting after first use would break the second.
    // (Documented tradeoff — a production build would use a prekey server.)
    return;
  }

  async loadSignedPreKey(keyId) {
    let res = this.get('25519KeysignedKey' + keyId, undefined);
    if (res !== undefined) res = { pubKey: res.pubKey, privKey: res.privKey };
    return res;
  }

  async storeSignedPreKey(keyId, keyPair) {
    return this.put('25519KeysignedKey' + keyId, keyPair);
  }

  async removeSignedPreKey(keyId) {
    return this.remove('25519KeysignedKey' + keyId);
  }

  async loadSession(identifier) {
    return this.get('session' + identifier, undefined);
  }

  async storeSession(identifier, record) {
    return this.put('session' + identifier, record);
  }

  async removeSession(identifier) {
    return this.remove('session' + identifier);
  }

  async removeAllSessions(identifier) {
    for (const id in this._store) {
      if (id.startsWith('session' + identifier)) delete this._store[id];
    }
  }
}

function arrayBufferToString(b) {
  return new Uint8Array(b).join(',');
}

/* ---- persistence: serialize the store to JSON-safe form ---- */
const AB = '__ab__';
function encVal(v) {
  if (v instanceof ArrayBuffer) return { [AB]: bufToB64(v) };
  if (v && typeof v === 'object' && (v.pubKey instanceof ArrayBuffer || v.privKey instanceof ArrayBuffer)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = v[k] instanceof ArrayBuffer ? { [AB]: bufToB64(v[k]) } : v[k];
    return { __kp__: o };
  }
  return v;
}
function decVal(v) {
  if (v && typeof v === 'object') {
    if (AB in v) return b64ToBuf(v[AB]);
    if ('__kp__' in v) {
      const o = {};
      for (const k of Object.keys(v.__kp__)) {
        const x = v.__kp__[k];
        o[k] = x && typeof x === 'object' && AB in x ? b64ToBuf(x[AB]) : x;
      }
      return o;
    }
  }
  return v;
}
function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}

SignalProtocolStore.prototype.serialize = function () {
  const out = {};
  for (const k of Object.keys(this._store)) out[k] = encVal(this._store[k]);
  return JSON.stringify(out);
};
SignalProtocolStore.prototype.deserialize = function (json) {
  const raw = JSON.parse(json);
  this._store = {};
  for (const k of Object.keys(raw)) this._store[k] = decVal(raw[k]);
};
