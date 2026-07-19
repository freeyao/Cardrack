// CollabCore — the DOM-free orchestrator. UI layers (browser, tests) inject
// pool/storage/hooks/sanitizer. All protocol logic lives here.
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import {
  SignalProtocolAddress, SessionBuilder, SessionCipher,
  ensureSignalIdentity, serializeBundle, deserializeBundle, WireBundle,
} from './signal';
import { SignalProtocolStore } from './signal-store';
import { Chain, deriveAddr, newChain } from './chains';
import { applyRemote, localEdit } from './lww';
import {
  generateMnemonic, validateMnemonic, skFromMnemonic, pkFromSk, selfEncrypt, selfDecrypt,
} from './account';
import { enc, dec, now, short, hexFromBytes, bytesFromHex, b64FromBuf } from './util';
import type { Pool, KV, Hooks, DocState } from './types';

export const KIND_PREKEYS = 30078;
export const KIND_SELFSNAP = 30079;
export const KIND_ENVELOPE = 4078;
export const DTAG = 'cardrack-prekeys-v1';
export const DTAG_SNAP = 'sc-docs-v1';
export const ADDR_WINDOW = 16;
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

const LS = { nsk: 'sc2.nsk', mnemonic: 'sc2.mnemonic', signal: 'sc2.signal', docs: 'sc2.docs', seen: 'sc2.seen', chains: 'sc2.chains' };

export interface CoreOpts {
  pool: Pool;
  storage: KV;
  hooks: Hooks;
  sanitize?: (html: string) => string;
  relays?: string[];
}

export class CollabCore {
  pool: Pool; storage: KV; hooks: Hooks; relays: string[];
  sanitize: (h: string) => string;
  sk: Uint8Array | null = null;
  pk = '';
  mnemonic: string | null = null;
  restoring = false;
  muteSnap = true;
  store = new SignalProtocolStore();
  cipher: Record<string, SessionCipher> = {};
  docs: Record<string, DocState> = {};
  chains: Record<string, Chain> = {};
  seen: string[] = [];
  addrMap: Record<string, { peerPk: string; n: number }> = {};
  chainSub: { close(): void } | null = null;
  identityBundle: any = null;
  healAttempts: Record<string, number> = {};
  snapTimer: any = null;

  constructor(o: CoreOpts) {
    this.pool = o.pool; this.storage = o.storage; this.hooks = o.hooks;
    this.relays = o.relays || DEFAULT_RELAYS;
    this.sanitize = o.sanitize || ((h) => h);
  }

  /* ---------- account lifecycle ---------- */
  hasSavedAccount() { return !!this.storage.get(LS.nsk); }
  newMnemonic() { return generateMnemonic(); }
  static validateMnemonic(w: string) { return validateMnemonic(w); }

  async startWithNewAccount(mnemonic: string) {
    this.mnemonic = mnemonic;
    this.sk = skFromMnemonic(mnemonic);
    this.storage.set(LS.nsk, hexFromBytes(this.sk));
    this.storage.set(LS.mnemonic, mnemonic);
    await this.boot();
  }
  async startWithMnemonic(words: string) {
    if (!validateMnemonic(words)) throw new Error('invalid recovery phrase');
    this.mnemonic = words;
    this.sk = skFromMnemonic(words);
    this.storage.set(LS.nsk, hexFromBytes(this.sk));
    this.storage.set(LS.mnemonic, words);
    this.restoring = true;
    await this.boot();
  }
  async startWithSaved() {
    const hex = this.storage.get(LS.nsk);
    if (!hex) throw new Error('no saved account');
    this.sk = bytesFromHex(hex);
    this.mnemonic = this.storage.get(LS.mnemonic);
    await this.boot();
  }

  npub() { return nip19.npubEncode(this.pk); }
  npubOf(pk: string) { return nip19.npubEncode(pk); }
  private ns(k: string) { return k + '.' + this.pk.slice(0, 12); }

  private async boot() {
    this.pk = pkFromSk(this.sk!);
    const savedStore = this.storage.get(this.ns(LS.signal));
    if (savedStore) { try { this.store.deserialize(savedStore); } catch { this.hooks.log('warn', 'signal store corrupt — regenerating'); } }
    this.identityBundle = await ensureSignalIdentity(this.store);
    this.docs = JSON.parse(this.storage.get(this.ns(LS.docs)) || '{}');
    this.chains = JSON.parse(this.storage.get(this.ns(LS.chains)) || '{}');
    this.seen = JSON.parse(this.storage.get(this.ns(LS.seen)) || '[]');
    this.saveAll();

    await this.publishPrekeys();
    this.pool.subscribe(this.relays, { kinds: [KIND_ENVELOPE], '#p': [this.pk] }, {
      onevent: (ev) => { this.onBootEnvelope(ev).catch((e) => this.hooks.log('warn', 'boot handler: ' + e.message)); },
    });
    this.resubscribeChains();
    if (this.restoring) await this.restoreFromSnapshot();
    this.muteSnap = false;
    this.hooks.docsChanged();
    this.hooks.status('listening');
    this.hooks.log('info', `Listening for invites to ${short(this.npub(), 20)} + ${Object.keys(this.chains).length * ADDR_WINDOW} one-time addresses`);
  }

  /* ---------- persistence & snapshot ---------- */
  saveAll() {
    if (!this.pk) return;
    this.scheduleSelfSnapshot();
    this.storage.set(this.ns(LS.signal), this.store.serialize());
    this.storage.set(this.ns(LS.docs), JSON.stringify(this.docs));
    this.storage.set(this.ns(LS.chains), JSON.stringify(this.chains));
    this.storage.set(this.ns(LS.seen), JSON.stringify(this.seen.slice(-500)));
  }
  private scheduleSelfSnapshot() {
    if (this.muteSnap) return;
    clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => { this.publishSelfSnapshot().catch((e) => this.hooks.log('warn', 'snapshot: ' + e.message)); }, 2000);
  }
  async publishSelfSnapshot() {
    const content = selfEncrypt(this.sk!, this.pk, JSON.stringify({ v: 1, t: now(), docs: this.docs, chains: this.chains }));
    this.publishAsIdentity(KIND_SELFSNAP, content, [['d', DTAG_SNAP]]);
    this.hooks.log('info', 'Encrypted account snapshot updated on relays.');
  }
  async restoreFromSnapshot() {
    const ev = await this.pool.get(this.relays, { kinds: [KIND_SELFSNAP], authors: [this.pk], '#d': [DTAG_SNAP] });
    if (!ev) { this.hooks.log('info', 'No account snapshot found — starting fresh.'); return; }
    try {
      const data = JSON.parse(selfDecrypt(this.sk!, this.pk, ev.content));
      this.docs = data.docs || {};
      this.chains = data.chains || {};
      this.saveAll();
      this.resubscribeChains();
      this.hooks.docsChanged();
      this.hooks.log('ok', `Account restored: ${Object.keys(this.docs).length} document(s), ${Object.keys(this.chains).length} chain(s).`);
    } catch (e: any) {
      this.hooks.log('warn', 'snapshot decrypt failed: ' + e.message);
    }
  }

  /* ---------- transport ---------- */
  private publishAnon(kind: number, content: string, tags: string[][]) {
    const throwaway = generateSecretKey();
    const ev = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags, content }, throwaway);
    this.pool.publish(this.relays, ev).forEach((p) => p.catch(() => {}));
  }
  private publishAsIdentity(kind: number, content: string, tags: string[][]) {
    const ev = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags, content }, this.sk!);
    this.pool.publish(this.relays, ev).forEach((p) => p.catch(() => {}));
  }
  async publishPrekeys() {
    this.publishAsIdentity(KIND_PREKEYS, JSON.stringify(serializeBundle(this.identityBundle)), [['d', DTAG]]);
    this.hooks.log('info', 'Published signed prekey bundle (kind 30078, replaceable).');
  }
  async fetchPrekeys(peerPk: string): Promise<WireBundle> {
    const ev = await this.pool.get(this.relays, { kinds: [KIND_PREKEYS], authors: [peerPk], '#d': [DTAG] });
    if (!ev) throw new Error('no prekey bundle found for this account — have they opened the app?');
    if (ev.pubkey !== peerPk || !verifyEvent(ev)) throw new Error('prekey bundle signature INVALID — refusing to connect');
    return JSON.parse(ev.content);
  }
  private cipherFor(peerPk: string) {
    if (!this.cipher[peerPk]) this.cipher[peerPk] = new SessionCipher(this.store as any, new SignalProtocolAddress(peerPk, 1));
    return this.cipher[peerPk];
  }
  private async ensureSession(peerPk: string) {
    if (!(await this.store.loadSession(peerPk + '.1'))) {
      const bundle = deserializeBundle(await this.fetchPrekeys(peerPk));
      this.hooks.log('ok', 'Prekey signature verified for ' + short(peerPk, 16));
      await new SessionBuilder(this.store as any, new SignalProtocolAddress(peerPk, 1)).processPreKey(bundle as any);
      this.hooks.log('ok', 'X3DH complete — session with ' + short(peerPk, 16));
    }
    return this.cipherFor(peerPk);
  }
  async sendTo(peerPk: string, obj: any) {
    const cipher = await this.ensureSession(peerPk);
    const msg = await cipher.encrypt(enc(JSON.stringify(obj)));
    const ch = this.chains[peerPk];
    if (ch) {
      const addrPk = deriveAddr(ch.seed, ch.sendDir, ch.sendN);
      ch.sendN += 1;
      this.publishAnon(KIND_ENVELOPE, JSON.stringify({ v: 2, type: msg.type, body: btoa(msg.body!) }), [['p', addrPk]]);
      this.hooks.log('wire', `→ one-time addr ${short(addrPk, 12)} (#${ch.sendN - 1}) · ${obj.t} · anon sender`);
    } else {
      this.publishAnon(KIND_ENVELOPE, JSON.stringify({ v: 2, type: msg.type, body: btoa(msg.body!), boot: 1 }), [['p', peerPk]]);
      this.hooks.log('wire', `→ ${short(peerPk, 12)} (bootstrap) · ${obj.t} · anon sender`);
    }
    this.saveAll();
  }

  /* ---------- chains & subscriptions ---------- */
  private setupChain(peerPk: string, seedB64: string, iAmInviter: boolean) {
    this.chains[peerPk] = newChain(seedB64, iAmInviter);
    this.saveAll();
    this.resubscribeChains();
    this.hooks.log('info', `One-time address chain established with ${short(peerPk, 12)}.`);
  }
  resubscribeChains() {
    if (this.chainSub) { try { this.chainSub.close(); } catch {} }
    this.addrMap = {};
    const pks: string[] = [];
    for (const [peerPk, ch] of Object.entries(this.chains)) {
      for (let n = ch.recvN; n < ch.recvN + ADDR_WINDOW; n++) {
        const a = deriveAddr(ch.seed, ch.recvDir, n);
        this.addrMap[a] = { peerPk, n };
        pks.push(a);
      }
    }
    this.chainSub = pks.length
      ? this.pool.subscribe(this.relays, { kinds: [KIND_ENVELOPE], '#p': pks }, {
          onevent: (ev) => { this.onChainEnvelope(ev).catch((e) => this.hooks.log('warn', 'chain handler: ' + e.message)); },
        })
      : null;
  }

  /* ---------- inbound ---------- */
  private async onBootEnvelope(ev: any) {
    if (this.seen.includes(ev.id)) return;
    this.seen.push(ev.id);
    let payload: any;
    try { payload = JSON.parse(ev.content); } catch { return; }
    if (payload.type !== 3) return;
    const temp = 'boot-' + ev.id.slice(0, 16);
    const tempCipher = new SessionCipher(this.store as any, new SignalProtocolAddress(temp, 1));
    let m: any;
    try {
      m = JSON.parse(dec(await tempCipher.decryptPreKeyWhisperMessage(atob(payload.body), 'binary')));
    } catch {
      return this.hooks.log('info', 'ignored a bootstrap event (not addressed to us, or replay)');
    }
    const from = m.from;
    if (!from || !/^[0-9a-f]{64}$/.test(from)) return this.hooks.log('warn', 'bootstrap missing sender identity');
    try {
      const bundle = await this.fetchPrekeys(from);
      const sessionIdk = await this.store.loadIdentityKey(temp);
      if (!sessionIdk || b64FromBuf(sessionIdk) !== bundle.identityKey)
        return this.hooks.log('warn', `REJECTED invite: claimed sender ${short(from, 12)} does not match their signed prekey bundle`);
    } catch (e: any) {
      return this.hooks.log('warn', 'cannot verify inviter identity: ' + e.message);
    }
    const rec = await this.store.loadSession(temp + '.1');
    if (rec) { this.store.put('session' + from + '.1', rec); this.store.remove('session' + temp + '.1'); }
    const idk = this.store.get('identityKey' + temp);
    if (idk) { this.store.put('identityKey' + from, idk); this.store.remove('identityKey' + temp); }
    delete this.cipher[from];
    this.hooks.log('ok', `Inviter identity verified: ${short(from, 16)}`);
    if (m.seed) this.setupChain(from, m.seed, false);
    this.saveAll();
    this.dispatch(from, m);
  }

  private async onChainEnvelope(ev: any) {
    if (this.seen.includes(ev.id)) return;
    this.seen.push(ev.id);
    const pTag = (ev.tags.find((t: any) => t[0] === 'p') || [])[1];
    const hit = this.addrMap[pTag];
    if (!hit) return;
    const ch = this.chains[hit.peerPk];
    let payload: any;
    try { payload = JSON.parse(ev.content); } catch { return; }
    let m: any;
    try {
      const cipher = this.cipherFor(hit.peerPk);
      const buf = payload.type === 3
        ? await cipher.decryptPreKeyWhisperMessage(atob(payload.body), 'binary')
        : await cipher.decryptWhisperMessage(atob(payload.body), 'binary');
      m = JSON.parse(dec(buf));
    } catch (e: any) {
      this.hooks.log('warn', `chain decrypt failed from ${short(hit.peerPk, 12)}: ${e.message}`);
      this.healSession(hit.peerPk);
      return;
    }
    if (hit.n >= ch.recvN) { ch.recvN = hit.n + 1; this.resubscribeChains(); }
    this.saveAll();
    this.dispatch(hit.peerPk, m);
  }

  private async healSession(peerPk: string) {
    if (now() - (this.healAttempts[peerPk] || 0) < 60000) return;
    this.healAttempts[peerPk] = now();
    this.hooks.log('warn', `Session with ${short(peerPk, 12)} unhealthy — re-running X3DH…`);
    await this.store.removeSession(peerPk + '.1');
    delete this.cipher[peerPk];
    try { await this.sendTo(peerPk, { t: 'hello' }); } catch (e: any) { this.hooks.log('warn', 're-handshake failed: ' + e.message); }
  }

  private dispatch(from: string, m: any) {
    if (m.t === 'invite') return this.onInvite(from, m);
    if (m.t === 'update') return void this.onUpdate(from, m);
    if (m.t === 'ack') return this.hooks.log('ok', `${short(from, 12)} accepted the invite.`);
    if (m.t === 'hello') return this.hooks.log('ok', `Session with ${short(from, 12)} (re-)established.`);
    this.hooks.log('info', 'unknown message type ' + m.t);
  }

  private onInvite(from: string, m: any) {
    this.docs[m.docId] = {
      title: m.title, ownerPk: from, myRole: m.role, members: m.members || [],
      content: m.doc ? m.doc.content : '', format: m.doc ? m.doc.format : 'plain',
      version: m.doc ? m.doc.version : 0, ts: m.doc ? m.doc.ts : 0, author: m.doc ? m.doc.author : '',
    };
    this.saveAll();
    this.hooks.docsChanged();
    this.hooks.log('ok', `Invited to "${m.title}" by ${short(from, 12)} as ${String(m.role).toUpperCase()}`);
    void this.sendTo(from, { t: 'ack', docId: m.docId });
  }

  private async onUpdate(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return this.hooks.log('warn', 'update for unknown doc ' + m.docId);
    const iAmOwner = doc.ownerPk === this.pk;
    if (iAmOwner) {
      const member = doc.members.find((x) => x.pk === from);
      if (!member) return this.hooks.log('warn', `REJECTED update from non-member ${short(from, 12)}`);
      if (member.role !== 'editor') return this.hooks.log('warn', `REJECTED update from ${short(from, 12)} — role is ${member.role}`);
    } else if (from !== doc.ownerPk) {
      return this.hooks.log('warn', `REJECTED update not relayed by owner (${short(from, 12)})`);
    }
    if (applyRemote(doc, m, this.sanitize)) {
      this.saveAll();
      this.hooks.docApplied(m.docId);
      this.hooks.log('ok', `applied v${m.version} to "${doc.title}"`);
      if (iAmOwner) {
        for (const mem of doc.members) if (mem.pk !== from) void this.sendTo(mem.pk, { t: 'update', docId: m.docId, ...this.pickLww(doc) });
      }
    }
  }

  private pickLww(d: DocState) {
    return { version: d.version, ts: d.ts, author: d.author, content: d.content, format: d.format };
  }

  /* ---------- public actions ---------- */
  createDoc(title: string): string {
    const docId = hexFromBytes(crypto.getRandomValues(new Uint8Array(8)));
    this.docs[docId] = { title: title || 'Untitled', ownerPk: this.pk, myRole: 'owner', members: [], content: '', format: 'plain', version: 0, ts: 0, author: '' };
    this.saveAll();
    this.hooks.docsChanged();
    return docId;
  }

  async invite(docId: string, pkOrNpub: string, role: 'editor' | 'viewer') {
    const doc = this.docs[docId];
    if (!doc) throw new Error('no such doc');
    if (doc.ownerPk !== this.pk) throw new Error('only the owner can invite');
    let peerPk = pkOrNpub.trim();
    if (peerPk.startsWith('npub')) peerPk = nip19.decode(peerPk).data as string;
    if (!/^[0-9a-f]{64}$/.test(peerPk)) throw new Error('invalid npub / pubkey');
    if (peerPk === this.pk) throw new Error('that is your own account');
    if (!doc.members.find((x) => x.pk === peerPk)) doc.members.push({ pk: peerPk, role });
    this.saveAll();
    try {
      const hasChain = !!this.chains[peerPk];
      const seed = hasChain ? this.chains[peerPk].seed : b64FromBuf(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
      await this.sendTo(peerPk, { t: 'invite', from: this.pk, seed, docId, title: doc.title, role, members: [], doc: this.pickLww(doc) });
      if (!hasChain) this.setupChain(peerPk, seed, true);
      this.hooks.log('ok', `Invite sent to ${short(peerPk, 16)} as ${role}.`);
    } catch (e) {
      doc.members = doc.members.filter((x) => x.pk !== peerPk);
      this.saveAll();
      throw e;
    }
  }

  async localEdit(docId: string, content: string, format: 'plain' | 'rich') {
    const doc = this.docs[docId];
    if (!doc || doc.myRole === 'viewer') return;
    localEdit(doc, content, format, this.pk, now());
    this.saveAll();
    const targets = doc.ownerPk === this.pk ? doc.members.map((x) => x.pk) : [doc.ownerPk];
    for (const t of targets) {
      try { await this.sendTo(t, { t: 'update', docId, ...this.pickLww(doc) }); }
      catch (e: any) { this.hooks.log('warn', `send to ${short(t, 12)} failed: ${e.message}`); }
    }
  }
}
