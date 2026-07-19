/* Signal-Collab PoC application logic.
 * Modes:
 *  - DEMO: Alice & Bob in one page, in-memory transport, real X3DH + Double Ratchet.
 *  - RELAY: Nostr relays as transport; open the hosted page in Keychat's mini app
 *    browser on two devices, join the same room, edits sync E2E-encrypted.
 */
'use strict';

const { KeyHelper, SignalProtocolAddress, SessionBuilder, SessionCipher, SignalProtocolStore } =
  window.SignalLib;
const { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, SimplePool, nip19, sha256, nip06, nip44 } = window.NostrLib;

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const enc = (s) => new TextEncoder().encode(s).buffer;
const dec = (b) => new TextDecoder().decode(new Uint8Array(b));
const b64FromBuf = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const bufFromB64 = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};
const now = () => Date.now();
const short = (s, n = 12) => (s.length > n ? s.slice(0, n) + '…' : s);

// Minimal HTML sanitizer: allowlist of tags, no attributes survive.
const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'P', 'BR', 'DIV', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'SPAN']);
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  (function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED_TAGS.has(child.tagName)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          continue;
        }
        for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
        walk(child);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        node.removeChild(child);
      }
    }
  })(tpl.content);
  const div = document.createElement('div');
  div.appendChild(tpl.content.cloneNode(true));
  return div.innerHTML;
}

/* ---------------- Signal identity ---------------- */
async function createIdentity(name) {
  const store = new SignalProtocolStore();
  const registrationId = KeyHelper.generateRegistrationId();
  store.put('registrationId', registrationId);
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  store.put('identityKey', identityKeyPair);
  const preKeyId = 1 + Math.floor(Math.random() * 1000000);
  const preKey = await KeyHelper.generatePreKey(preKeyId);
  await store.storePreKey(preKeyId, preKey.keyPair);
  const signedPreKeyId = 1 + Math.floor(Math.random() * 1000000);
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
  await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);
  return {
    name,
    store,
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

function serializeBundle(b) {
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
function deserializeBundle(b) {
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

/* ---------------- Document model: last-write-wins ---------------- */
class LwwDoc {
  constructor() {
    this.version = 0;
    this.ts = 0;
    this.author = '';
    this.content = '';
    this.format = 'plain';
  }
  localEdit(content, format, author) {
    this.version += 1;
    this.ts = now();
    this.author = author;
    this.content = content;
    this.format = format;
    return { version: this.version, ts: this.ts, author, content, format };
  }
  applyRemote(u) {
    const newer =
      u.version > this.version ||
      (u.version === this.version && (u.ts > this.ts || (u.ts === this.ts && u.author > this.author)));
    if (!newer) return false;
    this.version = u.version;
    this.ts = u.ts;
    this.author = u.author;
    this.content = u.format === 'rich' ? sanitizeHtml(u.content) : u.content;
    this.format = u.format;
    return true;
  }
}

/* ---------------- Editor pane (shared by both modes) ---------------- */
class EditorPane {
  constructor(rootId, { title, onLocalEdit }) {
    this.root = $(rootId);
    this.onLocalEdit = onLocalEdit;
    this.format = 'plain';
    this.readonly = false;
    this.suppress = false;
    this.root.innerHTML = `
      <div class="pane-head">
        <span class="pane-title">${title}</span>
        <span class="badge" data-role="role-badge">editor</span>
        <span class="badge v" data-role="ver">v0</span>
      </div>
      <div class="toolbar" data-role="toolbar">
        <button data-cmd="format">Rich text: off</button>
        <span class="rich-btns" style="display:none">
          <button data-cmd="bold"><b>B</b></button>
          <button data-cmd="italic"><i>I</i></button>
          <button data-cmd="underline"><u>U</u></button>
          <button data-cmd="h2">H</button>
        </span>
      </div>
      <textarea class="editor-plain" data-role="plain" placeholder="Start typing… changes are Signal-encrypted before leaving this pane."></textarea>
      <div class="editor-rich" data-role="rich" contenteditable="true" style="display:none"></div>`;
    this.plainEl = this.root.querySelector('[data-role=plain]');
    this.richEl = this.root.querySelector('[data-role=rich]');
    this.verEl = this.root.querySelector('[data-role=ver]');
    this.roleBadge = this.root.querySelector('[data-role=role-badge]');

    const emit = this.debounce(() => {
      if (this.suppress || this.readonly) return;
      this.onLocalEdit(this.getContent(), this.format);
    }, 400);
    this.plainEl.addEventListener('input', emit);
    this.richEl.addEventListener('input', emit);

    this.root.querySelector('.toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || this.readonly) return;
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      if (cmd === 'format') {
        this.setFormat(this.format === 'plain' ? 'rich' : 'plain', true);
        this.onLocalEdit(this.getContent(), this.format);
      } else if (cmd === 'h2') {
        document.execCommand('formatBlock', false, 'h2');
        emit();
      } else {
        document.execCommand(cmd, false);
        emit();
      }
    });
  }
  debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }
  setFormat(fmt, convert) {
    if (fmt === this.format) return;
    this.format = fmt;
    const btn = this.root.querySelector('[data-cmd=format]');
    btn.textContent = 'Rich text: ' + (fmt === 'rich' ? 'on' : 'off');
    this.root.querySelector('.rich-btns').style.display = fmt === 'rich' ? '' : 'none';
    if (fmt === 'rich') {
      if (convert) this.richEl.innerHTML = sanitizeHtml(this.plainEl.value.replace(/\n/g, '<br>'));
      this.plainEl.style.display = 'none';
      this.richEl.style.display = '';
    } else {
      if (convert) this.plainEl.value = this.richEl.innerText;
      this.plainEl.style.display = '';
      this.richEl.style.display = 'none';
    }
  }
  getContent() {
    return this.format === 'rich' ? sanitizeHtml(this.richEl.innerHTML) : this.plainEl.value;
  }
  setContent(content, format, version) {
    this.suppress = true;
    this.setFormat(format, false);
    if (format === 'rich') this.richEl.innerHTML = sanitizeHtml(content);
    else this.plainEl.value = content;
    this.verEl.textContent = 'v' + version;
    this.suppress = false;
  }
  setVersion(v) {
    this.verEl.textContent = 'v' + v;
  }
  setReadonly(ro) {
    this.readonly = ro;
    this.plainEl.readOnly = ro;
    this.richEl.contentEditable = ro ? 'false' : 'true';
    this.roleBadge.textContent = ro ? 'viewer' : 'editor';
    this.roleBadge.classList.toggle('viewer', ro);
    this.root.classList.toggle('readonly', ro);
  }
}

function logTo(elId, kind, text) {
  const el = $(elId);
  const row = document.createElement('div');
  row.className = 'log-row ' + kind;
  const t = new Date().toTimeString().slice(0, 8);
  row.innerHTML = `<span class="log-time">${t}</span> <span class="log-kind">[${kind}]</span> ${text}`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

/* ==================================================================
 * DEMO MODE — Alice & Bob in one page
 * ================================================================== */
const demo = { started: false };

async function startDemo() {
  if (demo.started) return;
  demo.started = true;
  const log = (k, t) => logTo('demo-log', k, t);

  log('info', 'Generating identities (identity key, signed prekey, one-time prekey)…');
  const alice = await createIdentity('alice');
  const bob = await createIdentity('bob');
  const aliceAddr = new SignalProtocolAddress('alice', 1);
  const bobAddr = new SignalProtocolAddress('bob', 1);

  log('info', "Alice fetches Bob's prekey bundle and runs X3DH…");
  const builder = new SessionBuilder(alice.store, bobAddr);
  await builder.processPreKey(bob.preKeyBundle);
  log('ok', 'X3DH complete — Signal session established (Double Ratchet active).');

  const aliceCipher = new SessionCipher(alice.store, bobAddr);
  const bobCipher = new SessionCipher(bob.store, aliceAddr);
  const doc = { alice: new LwwDoc(), bob: new LwwDoc() };
  let bobSessionReady = false;

  const panes = {};
  const send = async (from, content, format) => {
    const to = from === 'alice' ? 'bob' : 'alice';
    const update = doc[from].localEdit(content, format, from);
    panes[from].setVersion(update.version);
    const cipher = from === 'alice' ? aliceCipher : bobCipher;
    const msg = await cipher.encrypt(enc(JSON.stringify({ t: 'update', ...update })));
    const wire = btoa(msg.body);
    log('wire', `${from} → ${to} · type ${msg.type === 3 ? '3 PreKeyWhisper' : '1 Whisper'} · ${wire.length} B ciphertext: <code>${short(wire, 48)}</code>`);
    await new Promise((r) => setTimeout(r, 150));
    const recvCipher = to === 'alice' ? aliceCipher : bobCipher;
    let plainBuf;
    if (msg.type === 3) {
      plainBuf = await recvCipher.decryptPreKeyWhisperMessage(msg.body, 'binary');
      if (to === 'bob') bobSessionReady = true;
    } else {
      plainBuf = await recvCipher.decryptWhisperMessage(msg.body, 'binary');
    }
    const u = JSON.parse(dec(plainBuf));
    const role = $('demo-role').value;
    if (u.author === 'bob' && role === 'viewer') {
      log('warn', `alice REJECTED bob's update v${u.version} — bob is viewer (not authorized).`);
      return;
    }
    if (doc[to].applyRemote(u)) {
      panes[to].setContent(doc[to].content, doc[to].format, doc[to].version);
      log('ok', `${to} decrypted & applied v${u.version} (${u.format}, ${u.content.length} chars).`);
    } else {
      log('info', `${to} ignored stale update v${u.version} (LWW).`);
    }
  };

  panes.alice = new EditorPane('pane-alice', {
    title: '👩 Alice (owner)',
    onLocalEdit: (c, f) => send('alice', c, f),
  });
  panes.bob = new EditorPane('pane-bob', {
    title: '👨 Bob',
    onLocalEdit: (c, f) => {
      if (!bobSessionReady) {
        log('warn', 'Bob has no session yet — Alice must send the first update (X3DH initiator).');
        return;
      }
      send('bob', c, f);
    },
  });

  $('demo-role').addEventListener('change', () => {
    const viewer = $('demo-role').value === 'viewer';
    panes.bob.setReadonly(viewer);
    log('info', `Owner set Bob's role to ${viewer ? 'VIEWER (edits will be rejected)' : 'EDITOR'}.`);
  });
  log('info', "Ready. Type in Alice's pane — the first message carries the X3DH handshake.");
}



/* ==================================================================
 * COLLAB MODE v3 — owner-centric invites + metadata-private transport
 *
 *   identity  : persistent nostr key + persistent Signal store
 *   prekeys   : npub-signed replaceable event (kind 30078)  [identity layer]
 *   invites   : Signal ciphertext, ANONYMOUS throwaway sender key,
 *               p-tagged to the invitee npub (bootstrap only)
 *   updates   : Signal ciphertext, ANONYMOUS throwaway sender key,
 *               p-tagged to ONE-TIME ADDRESSES derived from a secret seed
 *               shared inside the encrypted invite → relays cannot link
 *               messages to identities or to each other
 * ================================================================== */
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];
const KIND_PREKEYS = 30078;
const KIND_SELFSNAP = 30079; // NIP-44 self-encrypted doc index + chains (stateless client)
const KIND_ENVELOPE = 4078;
const DTAG = 'signal-collab-prekeys-v1';
const ADDR_WINDOW = 16; // how many future one-time addresses we watch per chain
const LS = { nsk: 'sc2.nsk', mnemonic: 'sc2.mnemonic', signal: 'sc2.signal', docs: 'sc2.docs', seen: 'sc2.seen', chains: 'sc2.chains' };

const hexFromBytes = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesFromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const clog = (k, t) => logTo('collab-log', k, t);

const App = {
  sk: null, pk: null,
  store: null, cipher: {},
  pool: null,
  docs: {},
  chains: {},   // peerPk -> {seed(b64), sendDir, recvDir, sendN, recvN}
  addrMap: {},  // one-time addr pk -> {peerPk, n}
  chainSub: null,
  seen: [],
  currentDoc: null,
  pane: null,
  identity: null,
  mnemonic: null,
  restoring: false,
  muteSnap: true, // no self-snapshots until boot/restore completes
};

function saveAll() {
  if (!App.store || !App.ns) return;
  scheduleSelfSnapshot();
  localStorage.setItem(App.ns(LS.signal), App.store.serialize());
  localStorage.setItem(App.ns(LS.docs), JSON.stringify(App.docs));
  localStorage.setItem(App.ns(LS.chains), JSON.stringify(App.chains));
  localStorage.setItem(App.ns(LS.seen), JSON.stringify(App.seen.slice(-500)));
}

function applyRemoteLww(doc, u) {
  const newer =
    u.version > doc.version ||
    (u.version === doc.version && (u.ts > doc.ts || (u.ts === doc.ts && u.author > doc.author)));
  if (!newer) return false;
  doc.version = u.version; doc.ts = u.ts; doc.author = u.author;
  doc.content = u.format === 'rich' ? sanitizeHtml(u.content) : u.content;
  doc.format = u.format;
  return true;
}

/* ---------- identity & signal store ---------- */
// NIP-07: Keychat's in-app browser (and extensions like nos2x/Alby) inject
// window.nostr. The bridge may attach slightly after page load, so poll briefly.
async function detectNip07() {
  for (let i = 0; i < 12; i++) { // up to ~3s total
    if (window.nostr && window.nostr.getPublicKey) {
      try {
        const pk = await window.nostr.getPublicKey();
        if (typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk)) return pk;
      } catch (e) { return null; } // user declined or bridge error
    } else if (i >= 3) {
      return null; // no provider object after 750ms — Keychat injects it at document start, so give up fast
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/* ---------- account gate (mnemonic ceremony) ---------- */
function accountGate() {
  return new Promise((resolve) => {
    $('acct-gate').classList.remove('hidden');
    const err = (t) => { $('acct-err').textContent = t; };
    $('acct-create').addEventListener('click', () => {
      App.mnemonic = nip06.generateSeedWords();
      $('acct-mnemonic').textContent = App.mnemonic;
      $('acct-mnemonic-box').classList.remove('hidden');
      $('acct-create-box').classList.add('hidden');
    });
    $('acct-saved').addEventListener('change', (e) => { $('acct-continue').disabled = !e.target.checked; });
    $('acct-continue').addEventListener('click', () => {
      if (!App.mnemonic) return;
      App.sk = nip06.privateKeyFromSeedWords(App.mnemonic);
      localStorage.setItem(LS.mnemonic, App.mnemonic);
      $('acct-gate').classList.add('hidden');
      resolve();
    });
    $('acct-restore').addEventListener('click', () => {
      const words = $('acct-restore-words').value.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!nip06.validateWords(words)) return err('That is not a valid 12-word recovery phrase.');
      App.mnemonic = words;
      App.sk = nip06.privateKeyFromSeedWords(words);
      localStorage.setItem(LS.mnemonic, words);
      App.restoring = true;
      $('acct-gate').classList.add('hidden');
      resolve();
    });
  });
}

/* ---------- self-encrypted snapshot (stateless client) ---------- */
let snapTimer = null;
function scheduleSelfSnapshot() {
  if (App.muteSnap) return;
  if (App.extSigner && !(window.nostr && window.nostr.nip44)) return; // no self-encrypt capability
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => { publishSelfSnapshot().catch((e) => clog('warn', 'snapshot: ' + e.message)); }, 2500);
}
async function selfEncrypt(plain) {
  if (App.extSigner) return await window.nostr.nip44.encrypt(App.pk, plain);
  return nip44.v2.encrypt(plain, nip44.v2.utils.getConversationKey(App.sk, App.pk));
}
async function selfDecrypt(cipherText) {
  if (App.extSigner) return await window.nostr.nip44.decrypt(App.pk, cipherText);
  return nip44.v2.decrypt(cipherText, nip44.v2.utils.getConversationKey(App.sk, App.pk));
}
async function publishSelfSnapshot() {
  const content = await selfEncrypt(JSON.stringify({ v: 1, t: now(), docs: App.docs, chains: App.chains }));
  await publishAsIdentity(KIND_SELFSNAP, content, [['d', 'sc-docs-v1']]);
  clog('info', 'Encrypted account snapshot updated on relays (docs + chains, readable only by this account).');
}
async function restoreFromSnapshot() {
  const ev = await App.pool.get(RELAYS, { kinds: [KIND_SELFSNAP], authors: [App.pk], '#d': ['sc-docs-v1'] });
  if (!ev) { clog('info', 'No account snapshot found on relays — starting fresh.'); return; }
  try {
    const data = JSON.parse(await selfDecrypt(ev.content));
    App.docs = data.docs || {};
    App.chains = data.chains || {};
    saveAll();
    renderDocList();
    resubscribeChains();
    clog('ok', `Account restored: ${Object.keys(App.docs).length} document(s), ${Object.keys(App.chains).length} peer chain(s). Sessions will re-establish on first contact.`);
  } catch (e) {
    clog('warn', 'snapshot decrypt failed: ' + e.message);
  }
}

/* ---------- session self-healing ---------- */
const healAttempts = {};
async function healSession(peerPk) {
  if (now() - (healAttempts[peerPk] || 0) < 60000) return;
  healAttempts[peerPk] = now();
  clog('warn', `Session with ${short(peerPk, 12)} unhealthy — re-running X3DH…`);
  await App.store.removeSession(peerPk + '.1');
  delete App.cipher[peerPk];
  try { await sendTo(peerPk, { t: 'hello' }); } catch (e) { clog('warn', 're-handshake failed: ' + e.message); }
}

async function initIdentity() {
  const extPk = await detectNip07();
  if (extPk) {
    App.pk = extPk;
    App.extSigner = true;
    clog('ok', 'Using external identity via window.nostr (key never touches this page).');
  } else {
    const savedSk = localStorage.getItem(LS.nsk);
    if (savedSk) {
      App.sk = bytesFromHex(savedSk);
      App.mnemonic = localStorage.getItem(LS.mnemonic);
    } else {
      await accountGate(); // create (mnemonic ceremony) or restore
      localStorage.setItem(LS.nsk, hexFromBytes(App.sk));
    }
    App.pk = getPublicKey(App.sk);
  }
  App.ns = (k) => k + '.' + App.pk.slice(0, 12); // per-identity storage namespace

  App.store = new SignalProtocolStore();
  const savedStore = localStorage.getItem(App.ns(LS.signal));
  if (savedStore) {
    try { App.store.deserialize(savedStore); } catch (e) { clog('warn', 'signal store corrupt, regenerating'); }
  }
  if (!(await App.store.getIdentityKeyPair())) {
    App.store.put('registrationId', KeyHelper.generateRegistrationId());
    App.store.put('identityKey', await KeyHelper.generateIdentityKeyPair());
  }
  const ikp = await App.store.getIdentityKeyPair();
  const preKeyId = 1 + Math.floor(Math.random() * 1000000);
  const preKey = await KeyHelper.generatePreKey(preKeyId);
  await App.store.storePreKey(preKeyId, preKey.keyPair);
  const signedPreKeyId = 1 + Math.floor(Math.random() * 1000000);
  const signedPreKey = await KeyHelper.generateSignedPreKey(ikp, signedPreKeyId);
  await App.store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);
  App.identity = {
    preKeyBundle: {
      registrationId: await App.store.getLocalRegistrationId(),
      identityKey: ikp.pubKey,
      preKey: { keyId: preKeyId, publicKey: preKey.keyPair.pubKey },
      signedPreKey: { keyId: signedPreKeyId, publicKey: signedPreKey.keyPair.pubKey, signature: signedPreKey.signature },
    },
  };
  App.docs = JSON.parse(localStorage.getItem(App.ns(LS.docs)) || '{}');
  App.chains = JSON.parse(localStorage.getItem(App.ns(LS.chains)) || '{}');
  App.seen = JSON.parse(localStorage.getItem(App.ns(LS.seen)) || '[]');
  saveAll();
}

/* ---------- one-time address chains ---------- */
function concatBytes(...arrs) {
  const total = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const utf8 = (s) => {
  const bin = unescape(encodeURIComponent(s));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
function deriveAddr(seedB64, dir, n) {
  const seed = new Uint8Array(bufFromB64(seedB64));
  const ctr = new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const sk = sha256(concatBytes(seed, utf8('sc-addr:' + dir + ':'), ctr));
  return getPublicKey(sk); // mailbox tag only; nobody ever signs with this key
}

function setupChain(peerPk, seedB64, iAmInviter) {
  App.chains[peerPk] = {
    seed: seedB64,
    sendDir: iAmInviter ? 'i2r' : 'r2i',
    recvDir: iAmInviter ? 'r2i' : 'i2r',
    sendN: 0, recvN: 0,
  };
  saveAll();
  resubscribeChains();
  clog('info', `One-time address chain established with ${short(peerPk, 12)} — future traffic is unlinkable on relays.`);
}

function resubscribeChains() {
  if (App.chainSub && App.chainSub.close) { try { App.chainSub.close(); } catch {} }
  App.addrMap = {};
  const pks = [];
  for (const [peerPk, ch] of Object.entries(App.chains)) {
    for (let n = ch.recvN; n < ch.recvN + ADDR_WINDOW; n++) {
      const a = deriveAddr(ch.seed, ch.recvDir, n);
      App.addrMap[a] = { peerPk, n };
      pks.push(a);
    }
  }
  if (pks.length) {
    App.chainSub = App.pool.subscribe(RELAYS, { kinds: [KIND_ENVELOPE], '#p': pks }, {
      onevent: (ev) => { onChainEnvelope(ev).catch((e) => clog('warn', 'chain handler: ' + e.message)); },
    });
  }
}

/* ---------- transport ---------- */
function publishAnon(kind, content, tags) {
  const throwaway = generateSecretKey(); // fresh key per event — sender is anonymous on the wire
  const ev = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags, content }, throwaway);
  App.pool.publish(RELAYS, ev).forEach((p) => p.catch(() => {}));
}

async function publishAsIdentity(kind, content, tags) {
  let ev;
  if (App.extSigner) {
    // Only the prekey announcement ever needs an identity signature in this design,
    // so the external signer is asked to confirm exactly once per launch.
    ev = await window.nostr.signEvent({ kind, created_at: Math.floor(now() / 1000), tags, content, pubkey: App.pk });
  } else {
    ev = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags, content }, App.sk);
  }
  App.pool.publish(RELAYS, ev).forEach((p) => p.catch(() => {}));
}

async function publishPrekeys() {
  try {
    await publishAsIdentity(KIND_PREKEYS, JSON.stringify(serializeBundle(App.identity.preKeyBundle)), [['d', DTAG]]);
    $('prekey-status').textContent = 'prekeys published ✓' + (App.extSigner ? ' (signed by Keychat/NIP-07)' : '');
    clog('info', 'Published npub-signed prekey bundle (kind 30078, replaceable).');
  } catch (e) {
    $('prekey-status').textContent = 'prekey publish FAILED';
    clog('warn', 'prekey publish failed (signer declined?): ' + e.message);
  }
}

async function fetchPrekeys(peerPk) {
  const ev = await App.pool.get(RELAYS, { kinds: [KIND_PREKEYS], authors: [peerPk], '#d': [DTAG] });
  if (!ev) throw new Error('no prekey bundle found for this npub — have they opened the app?');
  if (ev.pubkey !== peerPk || !verifyEvent(ev)) throw new Error('prekey bundle signature INVALID — refusing to connect');
  return JSON.parse(ev.content);
}

function cipherFor(peerPk) {
  if (!App.cipher[peerPk]) App.cipher[peerPk] = new SessionCipher(App.store, new SignalProtocolAddress(peerPk, 1));
  return App.cipher[peerPk];
}

async function ensureSession(peerPk) {
  const existing = await App.store.loadSession(peerPk + '.1');
  if (!existing) {
    const bundle = deserializeBundle(await fetchPrekeys(peerPk));
    clog('ok', 'Prekey bundle nostr-signature verified for ' + short(peerPk, 16));
    const builder = new SessionBuilder(App.store, new SignalProtocolAddress(peerPk, 1));
    await builder.processPreKey(bundle);
    clog('ok', 'X3DH complete — new Signal session with ' + short(peerPk, 16));
  }
  return cipherFor(peerPk);
}

async function sendTo(peerPk, obj) {
  const cipher = await ensureSession(peerPk);
  const msg = await cipher.encrypt(enc(JSON.stringify(obj)));
  const ch = App.chains[peerPk];
  if (ch) {
    const addrPk = deriveAddr(ch.seed, ch.sendDir, ch.sendN);
    ch.sendN += 1;
    publishAnon(KIND_ENVELOPE, JSON.stringify({ v: 2, type: msg.type, body: btoa(msg.body) }), [['p', addrPk]]);
    clog('wire', `→ one-time addr ${short(addrPk, 12)} (#${ch.sendN - 1}) · ${obj.t} · anon sender`);
  } else {
    // bootstrap: invite goes to the invitee's real npub, but from a throwaway key
    publishAnon(KIND_ENVELOPE, JSON.stringify({ v: 2, type: msg.type, body: btoa(msg.body), boot: 1 }), [['p', peerPk]]);
    clog('wire', `→ ${short(peerPk, 12)} (bootstrap invite) · ${obj.t} · anon sender`);
  }
  saveAll();
}

/* ---------- inbound ---------- */
async function onBootEnvelope(ev) {
  if (App.seen.includes(ev.id)) return;
  App.seen.push(ev.id);
  let payload;
  try { payload = JSON.parse(ev.content); } catch { return; }
  if (payload.type !== 3) return; // bootstrap must be a PreKey message
  // Sender is anonymous on the wire; identity comes from INSIDE the encrypted payload.
  const temp = 'boot-' + ev.id.slice(0, 16);
  const tempCipher = new SessionCipher(App.store, new SignalProtocolAddress(temp, 1));
  let m;
  try {
    m = JSON.parse(dec(await tempCipher.decryptPreKeyWhisperMessage(atob(payload.body), 'binary')));
  } catch (e) {
    return clog('info', 'ignored a bootstrap event (addressed to someone else, or a replay already processed)');
  }
  const from = m.from;
  if (!from || !/^[0-9a-f]{64}$/.test(from)) return clog('warn', 'bootstrap missing sender identity');
  // Verify the claimed npub: its published prekey bundle must carry the SAME Signal
  // identity key that just established this session (prevents impersonation).
  try {
    const bundle = await fetchPrekeys(from);
    const sessionIdk = await App.store.loadIdentityKey(temp);
    if (!sessionIdk || b64FromBuf(sessionIdk) !== bundle.identityKey)
      return clog('warn', `REJECTED invite: sender claims ${short(from, 12)} but Signal identity key does not match their npub-signed bundle`);
  } catch (e) {
    return clog('warn', 'cannot verify inviter identity: ' + e.message);
  }
  // migrate session from temp address to the verified sender npub
  const rec = await App.store.loadSession(temp + '.1');
  if (rec) { App.store.put('session' + from + '.1', rec); App.store.remove('session' + temp + '.1'); }
  const idk = App.store.get('identityKey' + temp, undefined);
  if (idk) { App.store.put('identityKey' + from, idk); App.store.remove('identityKey' + temp); }
  delete App.cipher[from];
  clog('ok', `Inviter identity verified: ${short(from, 16)} (Signal identity key matches npub-signed bundle)`);
  if (m.seed) setupChain(from, m.seed, false);
  saveAll();
  dispatch(from, m);
}

async function onChainEnvelope(ev) {
  if (App.seen.includes(ev.id)) return;
  App.seen.push(ev.id);
  const pTag = (ev.tags.find((t) => t[0] === 'p') || [])[1];
  const hit = App.addrMap[pTag];
  if (!hit) return;
  const ch = App.chains[hit.peerPk];
  let payload;
  try { payload = JSON.parse(ev.content); } catch { return; }
  let m;
  try {
    const cipher = cipherFor(hit.peerPk);
    const buf = payload.type === 3
      ? await cipher.decryptPreKeyWhisperMessage(atob(payload.body), 'binary')
      : await cipher.decryptWhisperMessage(atob(payload.body), 'binary');
    m = JSON.parse(dec(buf));
  } catch (e) {
    clog('warn', `chain decrypt failed from ${short(hit.peerPk, 12)}: ${e.message}`);
    healSession(hit.peerPk);
    return;
  }
  if (hit.n >= ch.recvN) { ch.recvN = hit.n + 1; resubscribeChains(); }
  saveAll();
  dispatch(hit.peerPk, m);
}

function dispatch(from, m) {
  if (m.t === 'invite') return onInvite(from, m);
  if (m.t === 'update') return onUpdate(from, m);
  if (m.t === 'ack') return clog('ok', `${short(from, 12)} accepted the invite.`);
  if (m.t === 'hello') return clog('ok', `Session with ${short(from, 12)} (re-)established.`);
  clog('info', 'unknown message type ' + m.t);
}

function onInvite(from, m) {
  App.docs[m.docId] = {
    title: m.title, ownerPk: from, myRole: m.role,
    members: m.members || [],
    content: m.doc ? m.doc.content : '', format: m.doc ? m.doc.format : 'plain',
    version: m.doc ? m.doc.version : 0, ts: m.doc ? m.doc.ts : 0, author: m.doc ? m.doc.author : '',
  };
  saveAll();
  renderDocList();
  clog('ok', `📄 Invited to "${m.title}" by ${short(from, 12)} as ${m.role.toUpperCase()}`);
  sendTo(from, { t: 'ack', docId: m.docId });
}

async function onUpdate(from, m) {
  const doc = App.docs[m.docId];
  if (!doc) return clog('warn', 'update for unknown doc ' + m.docId);
  const iAmOwner = doc.ownerPk === App.pk;
  if (iAmOwner) {
    const member = doc.members.find((x) => x.pk === from);
    if (!member) return clog('warn', `REJECTED update from non-member ${short(from, 12)}`);
    if (member.role !== 'editor') return clog('warn', `REJECTED update from ${short(from, 12)} — role is ${member.role}`);
  } else if (from !== doc.ownerPk) {
    return clog('warn', `REJECTED update not relayed by owner (${short(from, 12)})`);
  }
  if (applyRemoteLww(doc, m)) {
    saveAll();
    if (App.currentDoc === m.docId) App.pane.setContent(doc.content, doc.format, doc.version);
    clog('ok', `applied v${m.version} to "${doc.title}" (author ${short(m.author, 12)})`);
    if (iAmOwner) {
      for (const mem of doc.members) {
        if (mem.pk !== from) sendTo(mem.pk, { t: 'update', docId: m.docId, ...pickLww(doc) });
      }
    }
  }
}

const pickLww = (d) => ({ version: d.version, ts: d.ts, author: d.author, content: d.content, format: d.format });

/* ---------- doc actions ---------- */
function createDoc() {
  const title = $('doc-title').value.trim() || 'Untitled';
  const docId = hexFromBytes(crypto.getRandomValues(new Uint8Array(8)));
  App.docs[docId] = { title, ownerPk: App.pk, myRole: 'owner', members: [], content: '', format: 'plain', version: 0, ts: 0, author: '' };
  $('doc-title').value = '';
  saveAll();
  renderDocList();
  openDoc(docId);
  clog('info', `Created "${title}" — now invite a collaborator by npub.`);
}

async function inviteToDoc() {
  const doc = App.docs[App.currentDoc];
  if (!doc) return;
  if (doc.ownerPk !== App.pk) return clog('warn', 'only the owner can invite');
  let peerPk = $('invite-npub').value.trim();
  try {
    if (peerPk.startsWith('npub')) peerPk = nip19.decode(peerPk).data;
  } catch { return clog('warn', 'invalid npub'); }
  if (!/^[0-9a-f]{64}$/.test(peerPk)) return clog('warn', 'invalid npub / pubkey');
  if (peerPk === App.pk) return clog('warn', 'that is your own npub');
  const role = $('invite-role').value;
  if (!doc.members.find((x) => x.pk === peerPk)) doc.members.push({ pk: peerPk, role });
  saveAll();
  renderMembers(doc);
  try {
    const hasChain = !!App.chains[peerPk];
    const seed = hasChain ? App.chains[peerPk].seed : b64FromBuf(crypto.getRandomValues(new Uint8Array(32)).buffer);
    await sendTo(peerPk, { t: 'invite', from: App.pk, seed, docId: App.currentDoc, title: doc.title, role, members: [], doc: pickLww(doc) });
    if (!hasChain) setupChain(peerPk, seed, true);
    $('invite-npub').value = '';
    clog('ok', `Invite sent to ${short(peerPk, 16)} as ${role} (anonymous sender; only they can decrypt).`);
  } catch (e) {
    clog('warn', 'invite failed: ' + e.message);
    doc.members = doc.members.filter((x) => x.pk !== peerPk);
    saveAll();
  }
}

async function onLocalDocEdit(content, format) {
  const doc = App.docs[App.currentDoc];
  if (!doc) return;
  if (doc.myRole === 'viewer') return;
  doc.version += 1; doc.ts = now(); doc.author = App.pk;
  doc.content = content; doc.format = format;
  App.pane.setVersion(doc.version);
  saveAll();
  const targets = doc.ownerPk === App.pk ? doc.members.map((x) => x.pk) : [doc.ownerPk];
  for (const t of targets) {
    try { await sendTo(t, { t: 'update', docId: App.currentDoc, ...pickLww(doc) }); }
    catch (e) { clog('warn', `send to ${short(t, 12)} failed: ${e.message}`); }
  }
}

/* ---------- UI ---------- */
function renderDocList() {
  const el = $('doc-list');
  el.innerHTML = '';
  for (const [id, d] of Object.entries(App.docs)) {
    const div = document.createElement('div');
    div.className = 'docitem';
    const who = d.ownerPk === App.pk ? 'owner' : d.myRole + ' · by ' + short(d.ownerPk, 12);
    div.innerHTML = `<span class="t">📄 ${d.title}</span><span class="meta">${who} · v${d.version}</span>`;
    div.addEventListener('click', () => openDoc(id));
    el.appendChild(div);
  }
}

function renderMembers(doc) {
  const el = $('member-list');
  const rows = [`<div class="m"><span class="who">${short(nip19.npubEncode(doc.ownerPk), 24)}</span><span class="badge">owner${doc.ownerPk === App.pk ? ' (me)' : ''}</span></div>`];
  for (const m of doc.members) {
    rows.push(`<div class="m"><span class="who">${short(nip19.npubEncode(m.pk), 24)}</span><span class="badge ${m.role === 'viewer' ? 'viewer' : ''}">${m.role}</span></div>`);
  }
  el.innerHTML = rows.join('');
}

function openDoc(docId) {
  const doc = App.docs[docId];
  if (!doc) return;
  App.currentDoc = docId;
  $('doc-view').classList.remove('hidden');
  const isOwner = doc.ownerPk === App.pk;
  $('invite-npub').parentElement.style.display = isOwner ? '' : 'none';
  renderMembers(doc);
  $('pane-doc').innerHTML = '';
  App.pane = new EditorPane('pane-doc', { title: '📄 ' + doc.title, onLocalEdit: onLocalDocEdit });
  App.pane.setContent(doc.content, doc.format, doc.version);
  App.pane.setReadonly(doc.myRole === 'viewer');
}

/* ---------- boot collab ---------- */
async function initCollab() {
  await initIdentity();
  const npub = nip19.npubEncode(App.pk);
  $('my-npub').textContent = npub;
  $('my-npub').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(npub).then(() => clog('info', 'npub copied'));
  });
  App.pool = new SimplePool();
  await publishPrekeys();
  // bootstrap mailbox: only anonymous invites arrive here
  App.pool.subscribe(RELAYS, { kinds: [KIND_ENVELOPE], '#p': [App.pk] }, {
    onevent: (ev) => { onBootEnvelope(ev).catch((e) => clog('warn', 'boot handler: ' + e.message)); },
  });
  resubscribeChains(); // resume chains from previous sessions
  if (App.restoring) await restoreFromSnapshot();
  App.muteSnap = false;
  if (App.mnemonic) {
    const sm = $('show-mnemonic');
    sm.style.display = '';
    sm.addEventListener('click', () => {
      if (confirm('Reveal your 12-word recovery phrase on screen?')) alert(App.mnemonic);
    });
  }
  renderDocList();
  clog('info', `Listening for invites addressed to ${short(npub, 20)} + ${Object.keys(App.chains).length * ADDR_WINDOW} one-time addresses`);
}

$('doc-create').addEventListener('click', createDoc);
$('invite-send').addEventListener('click', inviteToDoc);
$('doc-close').addEventListener('click', () => { $('doc-view').classList.add('hidden'); App.currentDoc = null; renderDocList(); });

/* ---------- boot ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.mode').forEach((m) => m.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.target).classList.add('active');
  });
});
$('demo-start').addEventListener('click', startDemo);
initCollab().catch((e) => clog('warn', 'init failed: ' + e.message));
