// CollabCore — the DOM-free orchestrator. UI layers (browser, tests) inject
// pool/storage/hooks/sanitizer. All protocol logic lives here.
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { decrypt as nip49decrypt } from 'nostr-tools/nip49';
import {
  SignalProtocolAddress, SessionBuilder, SessionCipher,
  ensureSignalIdentity, serializeBundle, deserializeBundle, WireBundle,
} from './signal';
import { SignalProtocolStore } from './signal-store';
import { Chain, deriveAddr, newChain } from './chains';
import { Commit } from './commit';
import {
  newDoc, docText, applyStringEdit, encodeState, encodeSince, stateVector, applyUpdate,
  b64FromBytes, bytesFromB64, isEmptyUpdate, migrateTextToRich,
} from './ydoc';
import type { Doc as YDoc } from 'yjs';
import {
  generateMnemonic, validateMnemonic, skFromMnemonic, pkFromSk, selfEncrypt, selfDecrypt,
} from './account';
import { newDocKey } from './dockey';
import { enc, dec, now, short, hexFromBytes, bytesFromHex, b64FromBuf } from './util';
import type { Pool, KV, Hooks, DocState } from './types';

export const KIND_PREKEYS = 30078;
export const KIND_SELFSNAP = 30079;
export const KIND_ENVELOPE = 4078;
export const DTAG = 'cardrack-prekeys-v1';
export const DTAG_SNAP = 'sc-docs-v1';
export const ADDR_WINDOW = 16;
// relay.nostr.band replaced with primal: live probing showed it timing out on
// every operation while damus intermittently rate-limits — three defaults must
// not quietly degrade to one.
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

const LS = { nsk: 'sc2.nsk', mnemonic: 'sc2.mnemonic', signal: 'sc2.signal', docs: 'sc2.docs', seen: 'sc2.seen', chains: 'sc2.chains' };

export interface CoreOpts {
  pool: Pool;
  storage: KV;
  hooks: Hooks;
  sanitize?: (html: string) => string;
  relays?: string[];
  /** Anti-entropy sync interval (ms). 0 disables the timer (tests drive syncAllPeers manually). */
  syncIntervalMs?: number;
  /** Account-snapshot publish debounce after a change (ms). Owner-decided: 10s. */
  snapshotDebounceMs?: number;
  /** Minimum interval between snapshot publishes (ms). Owner-decided: 60s. */
  snapshotMinIntervalMs?: number;
}

export class CollabCore {
  pool: Pool; storage: KV; hooks: Hooks; relays: string[];
  sanitize: (h: string) => string;
  sk: Uint8Array | null = null;
  pk = '';
  mnemonic: string | null = null;
  restoring = false;
  muteSnap = true;
  /** True when another tab holds the single-writer lock: this tab reads and
   * displays state but must not persist or emit mutations (see ui/idb.ts). */
  readOnly = false;
  store = new SignalProtocolStore();
  cipher: Record<string, SessionCipher> = {};
  docs: Record<string, DocState> = {};
  ydocs: Record<string, YDoc> = {}; // in-memory Yjs docs; serialized to DocState.ystate
  chains: Record<string, Chain> = {};
  seen: string[] = [];
  addrMap: Record<string, { peerPk: string; n: number }> = {};
  chainSub: { close(): void } | null = null;
  identityBundle: any = null;
  healAttempts: Record<string, number> = {};
  snapTimer: any = null;
  syncTimer: any = null;
  syncIntervalMs: number;
  bootSub: { close(): void } | null = null;
  /** Signed events no relay accepted yet; retried until delivered (bounded). */
  outbox: { ev: any; tries: number }[] = [];
  private lastSnapPublish = 0;
  private lastSnapHash = '';
  private syncTick = 0;

  snapDebounceMs: number;
  snapFloorMs: number;

  constructor(o: CoreOpts) {
    this.pool = o.pool; this.storage = o.storage; this.hooks = o.hooks;
    this.relays = o.relays || DEFAULT_RELAYS;
    this.sanitize = o.sanitize || ((h) => h);
    this.syncIntervalMs = o.syncIntervalMs ?? 20000;
    this.snapDebounceMs = o.snapshotDebounceMs ?? 10000;
    this.snapFloorMs = o.snapshotMinIntervalMs ?? 60000;
  }

  /** Stop background timers (call on teardown / account switch). */
  stop() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null; }
    if (this.chainSub) { try { this.chainSub.close(); } catch {} this.chainSub = null; }
    if (this.bootSub) { try { this.bootSub.close(); } catch {} this.bootSub = null; }
  }

  private subscribeBoot() {
    if (this.bootSub) { try { this.bootSub.close(); } catch {} }
    this.bootSub = this.pool.subscribe(this.relays, { kinds: [KIND_ENVELOPE], '#p': [this.pk] }, {
      onevent: (ev) => { this.onBootEnvelope(ev).catch((e) => this.hooks.log('warn', 'boot handler: ' + e.message)); },
    });
  }

  private lastRefresh = 0;
  /** Re-open every subscription and reconcile — recovers from silently dropped
   * relay sockets (sleep/wake, network switch). Throttled hard: visibilitychange
   * fires on every tab switch, and an uncooled refresh turned each one into a
   * resubscribe + sync burst that tripped relay rate limits (observed live —
   * the limiter then rejects protocol envelopes like invites too). */
  refreshSubscriptions() {
    if (now() - this.lastRefresh < 30000) return;
    this.lastRefresh = now();
    this.subscribeBoot();
    this.resubscribeChains();
    this.flushOutbox();
    void this.syncAllPeers();
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
  /** Import an existing nostr key: nsec1…, 64-hex, or NIP-49 ncryptsec1… (+
   * password). No mnemonic exists for an imported key — the nsec itself is the
   * recovery secret (nsec() re-encodes it for the reveal UI). Boots in restore
   * mode: the identity may have used the app before, so fetch its snapshot. */
  async startWithNsec(key: string, password?: string) {
    const s = key.trim();
    let sk: Uint8Array;
    if (s.startsWith('ncryptsec1')) {
      if (!password) throw new Error('this key is password-protected (NIP-49) — enter its password');
      try { sk = nip49decrypt(s, password); } catch { throw new Error('could not decrypt — wrong password?'); }
    } else if (s.startsWith('nsec1')) {
      const d = nip19.decode(s);
      if (d.type !== 'nsec') throw new Error('not an nsec key');
      sk = d.data as Uint8Array;
    } else if (/^[0-9a-f]{64}$/i.test(s)) {
      sk = bytesFromHex(s.toLowerCase());
    } else {
      throw new Error('paste an nsec1…, ncryptsec1…, or 64-hex secret key');
    }
    this.sk = sk;
    this.mnemonic = null;
    this.storage.set(LS.nsk, hexFromBytes(sk));
    this.storage.set(LS.mnemonic, ''); // no phrase for imported keys
    this.restoring = true;
    await this.boot();
  }
  /** The account key as nsec — the recovery secret for imported accounts. */
  nsec() { return this.sk ? nip19.nsecEncode(this.sk) : null; }

  async startWithSaved() {
    const hex = this.storage.get(LS.nsk);
    if (!hex) throw new Error('no saved account');
    this.sk = bytesFromHex(hex);
    this.mnemonic = this.storage.get(LS.mnemonic) || null;
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
    this.subscribeBoot();
    this.resubscribeChains();
    if (this.restoring) await this.restoreFromSnapshot();
    this.muteSnap = false;
    // Anti-entropy: reconcile now (catch up on anything missed while offline),
    // then on a timer. Disabled when syncIntervalMs is 0 (tests drive it manually).
    void this.syncAllPeers();
    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        this.syncTick += 1;
        this.flushOutbox();
        // Relay sockets die silently (laptop sleep, network change) and their
        // subscriptions never come back on their own — refresh periodically so
        // a wedged tab recovers within ~1 minute instead of never.
        if (this.syncTick % 3 === 0) this.refreshSubscriptions();
        else void this.syncAllPeers();
      }, this.syncIntervalMs);
    }
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
    // Debounce + publish floor (owner-decided: 10s / 60s). The snapshot exists
    // only for device restore; eager republishing during editing tripped relay
    // rate limits that then rejected protocol envelopes too (observed live).
    const wait = Math.max(this.snapDebounceMs, this.lastSnapPublish + this.snapFloorMs - now());
    this.snapTimer = setTimeout(() => { this.publishSelfSnapshot().catch((e) => this.hooks.log('warn', 'snapshot: ' + e.message)); }, wait);
  }
  async publishSelfSnapshot() {
    const plain = JSON.stringify({ v: 1, docs: this.docs, chains: this.chains });
    if (plain === this.lastSnapHash) return; // nothing changed — don't spam relays
    this.lastSnapHash = plain;
    this.lastSnapPublish = now();
    const content = selfEncrypt(this.sk!, this.pk, JSON.stringify({ v: 1, t: now(), docs: this.docs, chains: this.chains }));
    this.publishAsIdentity(KIND_SELFSNAP, content, [['d', DTAG_SNAP]]);
    this.hooks.log('info', 'Encrypted account snapshot updated on relays.');
  }
  async restoreFromSnapshot() {
    // A solo account (nobody invited) has no peer to re-sync from — the encrypted
    // self-snapshot is the ONLY recovery path. Relay sockets may not be connected
    // when we first ask, so a single get() can return null and lose everything.
    // Retry a few times before concluding there is no snapshot.
    const filter = { kinds: [KIND_SELFSNAP], authors: [this.pk], '#d': [DTAG_SNAP] };
    let ev: any = null;
    for (let attempt = 0; attempt < 6 && !ev; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500)); // give relays time to connect
      try { ev = await this.pool.get(this.relays, filter); } catch { ev = null; }
    }
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
  /** Publish a signed event and account for delivery. Live-relay probing showed
   * publishes can fail on every relay at once (rate limits, dead relays, sockets
   * still connecting) — previously fire-and-forget, so a lost update looked like
   * a protocol bug. Now: log the accept count, and if NO relay accepted, queue
   * the event in the outbox for retry (same id — relays and receivers dedupe). */
  private publishEv(ev: any, retryable: boolean) {
    void Promise.allSettled(this.pool.publish(this.relays, ev)).then((results) => {
      // Some pool implementations resolve with a failure reason instead of
      // rejecting (seen live: 'connection failure: …'), so inspect the value too.
      const ok = results.filter(
        (r) => r.status === 'fulfilled' && !/fail|invalid|error|timed|rate-limit/i.test(String((r as any).value ?? ''))
      ).length;
      if (ok === 0) {
        this.hooks.log('warn', `event not accepted by any relay (kind ${ev.kind})${retryable ? ' — queued for retry' : ''}`);
        if (retryable && this.outbox.length < 50 && !this.outbox.some((o) => o.ev.id === ev.id)) {
          this.outbox.push({ ev, tries: 0 });
        }
      } else if (ok < this.relays.length) {
        this.hooks.log('wire', `↳ delivered to ${ok}/${this.relays.length} relays`);
      }
    });
  }
  /** Retry undelivered events (bounded). Called from the sync tick. */
  flushOutbox() {
    if (!this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];
    for (const o of batch) {
      if (o.tries >= 6) { this.hooks.log('warn', `giving up on undelivered event (kind ${o.ev.kind})`); continue; }
      o.tries += 1;
      this.outbox.push(o);
      void Promise.allSettled(this.pool.publish(this.relays, o.ev)).then((results) => {
        const ok = results.filter(
          (r) => r.status === 'fulfilled' && !/fail|invalid|error|timed|rate-limit/i.test(String((r as any).value ?? ''))
        ).length;
        if (ok > 0) {
          this.outbox = this.outbox.filter((x) => x.ev.id !== o.ev.id);
          this.hooks.log('ok', `↳ retried event delivered (kind ${o.ev.kind})`);
        }
      });
    }
  }
  private publishAnon(kind: number, content: string, tags: string[][]) {
    const throwaway = generateSecretKey();
    const ev = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags, content }, throwaway);
    this.publishEv(ev, true); // envelopes carry protocol messages — must arrive
  }
  private publishAsIdentity(kind: number, content: string, tags: string[][]) {
    const ev = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags, content }, this.sk!);
    this.publishEv(ev, false); // replaceable state (prekeys/snapshot) republishes anyway
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

  /* ---------- anti-entropy sync ----------
   * Relays are best-effort: an update can be dropped or missed while offline.
   * With a CRDT, convergence needs no linear version — peers exchange Yjs state
   * vectors and each sends the other the delta it is missing. Role is enforced
   * on application: the owner pushes authoritative `update-accepted`; an editor
   * contributes via `update` (which the owner re-checks); viewers push nothing.
   * A `sync` triggers a single `sync-ack` back, so both directions reconcile in
   * one round-trip with no ping-pong. Self-heals arbitrary loss, no cursors. */

  /** Docs I share with this peer (I own it and they're a member, or they own it). */
  private docsWith(peerPk: string): string[] {
    return Object.keys(this.docs).filter((id) => {
      const d = this.docs[id];
      return (d.ownerPk === this.pk && d.members.some((m) => m.pk === peerPk)) || d.ownerPk === peerPk;
    });
  }
  /** My current Yjs state vectors for every doc shared with this peer. */
  private vectorsFor(peerPk: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of this.docsWith(peerPk)) out[id] = b64FromBytes(stateVector(this.ydocFor(id)));
    return out;
  }
  /** For each shared doc, send `from` the delta they are missing (role-gated). */
  private reconcile(from: string, theirVectors: Record<string, string>) {
    for (const docId of this.docsWith(from)) {
      const doc = this.docs[docId];
      const y = this.ydocFor(docId);
      const theirSVb64 = theirVectors[docId];
      const delta = theirSVb64 ? encodeSince(y, bytesFromB64(theirSVb64)) : encodeState(y);
      if (isEmptyUpdate(delta)) continue; // they already have everything I do
      if (doc.ownerPk === this.pk) {
        void this.sendTo(from, { t: 'update-accepted', docId, version: doc.version, author: doc.author, ts: doc.ts, update: b64FromBytes(delta) });
      } else if (from === doc.ownerPk && doc.myRole === 'editor') {
        void this.sendTo(from, { t: 'update', docId, update: b64FromBytes(delta) });
      }
    }
  }

  async syncWithPeer(peerPk: string) {
    const vectors = this.vectorsFor(peerPk);
    if (!Object.keys(vectors).length) return;
    try { await this.sendTo(peerPk, { t: 'sync', vectors }); }
    catch (e: any) { this.hooks.log('warn', `sync to ${short(peerPk, 12)} failed: ${e.message}`); }
  }
  /** Reconcile with every peer we share a chain with. */
  async syncAllPeers() {
    for (const peerPk of Object.keys(this.chains)) await this.syncWithPeer(peerPk);
  }

  private onSync(from: string, m: any) {
    this.reconcile(from, m.vectors || {});
    const vectors = this.vectorsFor(from); // let the peer push me what I'm missing too
    if (Object.keys(vectors).length) void this.sendTo(from, { t: 'sync-ack', vectors });
  }
  private onSyncAck(from: string, m: any) {
    this.reconcile(from, m.vectors || {});
  }

  private dispatch(from: string, m: any) {
    if (m.t === 'invite') return this.onInvite(from, m);
    if (m.t === 'update') return void this.onUpdate(from, m);              // editor → owner: proposed delta
    if (m.t === 'update-accepted') return void this.onUpdateAccepted(from, m); // owner → members: merged delta
    if (m.t === 'ack') return this.hooks.log('ok', `${short(from, 12)} accepted the invite.`);
    if (m.t === 'hello') return this.hooks.log('ok', `Session with ${short(from, 12)} (re-)established.`);
    if (m.t === 'sync') return void this.onSync(from, m);
    if (m.t === 'sync-ack') return void this.onSyncAck(from, m);
    if (m.t === 'rename') return this.onRename(from, m);        // owner → members: title change
    if (m.t === 'key-envelope') return this.onKeyEnvelope(from, m); // owner → members: epoch key
    if (m.t === 'remove') return this.onRemoved(from, m);       // owner → member: you were removed
    this.hooks.log('info', 'unknown message type ' + m.t);
  }

  // ---- member: the owner distributed a doc-key epoch ----
  private onKeyEnvelope(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return;
    if (from !== doc.ownerPk) return this.hooks.log('warn', `REJECTED key-envelope not from owner (${short(from, 12)})`);
    if (typeof m.epoch !== 'number' || typeof m.key !== 'string') return this.hooks.log('warn', 'malformed key-envelope');
    doc.dockeys = { ...(doc.dockeys || {}), [String(m.epoch)]: m.key }; // keep old epochs readable
    if (!doc.epoch || m.epoch > doc.epoch) doc.epoch = m.epoch;
    this.saveAll();
    this.hooks.log('ok', `"${doc.title}" advanced to key epoch ${m.epoch}`);
  }

  // ---- member: the owner removed me from a doc ----
  private onRemoved(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return;
    if (from !== doc.ownerPk) return this.hooks.log('warn', `ignoring remove not from owner (${short(from, 12)})`);
    const title = doc.title;
    delete this.docs[m.docId];
    delete this.ydocs[m.docId];
    this.saveAll(); // also drops the doc from this account's snapshot
    this.hooks.docsChanged();
    this.hooks.log('warn', `You were removed from "${title}" — the document is no longer on this device.`);
  }

  // ---- member: the owner renamed the doc ----
  private onRename(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return;
    if (from !== doc.ownerPk) return this.hooks.log('warn', `ignoring rename not from owner (${short(from, 12)})`);
    const title = typeof m.title === 'string' ? m.title.trim() : '';
    if (!title || title === doc.title) return;
    doc.title = title;
    this.saveAll();
    this.hooks.docsChanged();
    this.hooks.log('ok', `"${doc.title}" renamed by owner`);
  }

  private onInvite(from: string, m: any) {
    const d = m.doc || {};
    this.docs[m.docId] = {
      title: m.title, ownerPk: from, myRole: m.role, members: m.members || [],
      content: d.content || '', format: d.format || 'plain',
      version: d.version || 0, ts: d.ts || 0, author: d.author || '',
      ystate: d.ystate || undefined, head: '', history: [], conflicts: [],
    };
    // The owner sent the current epoch key inside the (Signal-encrypted) invite.
    if (typeof m.epoch === 'number' && typeof m.dockey === 'string') {
      const doc = this.docs[m.docId];
      doc.epoch = m.epoch;
      doc.dockeys = { [String(m.epoch)]: m.dockey };
    }
    if (d.ystate) this.materialize(m.docId); // build the Yjs doc from the seeded state
    this.saveAll();
    this.hooks.docsChanged();
    this.hooks.log('ok', `Invited to "${m.title}" by ${short(from, 12)} as ${String(m.role).toUpperCase()}`);
    void this.sendTo(from, { t: 'ack', docId: m.docId });
  }

  /* ---------- CRDT document (Yjs) ---------- */
  /** The Yjs doc for docId, lazily rehydrated from DocState.ystate. Migrates a
   * legacy pre-Yjs doc (content but no ystate) by seeding its text into the CRDT
   * — owner-only, so a shared doc isn't re-seeded on both sides (which the CRDT
   * would merge as duplicated text); members receive the owner's state via sync. */
  private ydocFor(docId: string): YDoc {
    let y = this.ydocs[docId];
    if (!y) {
      y = newDoc();
      const doc = this.docs[docId];
      const st = doc?.ystate;
      if (st) {
        try { applyUpdate(y, bytesFromB64(st)); } catch (e: any) { this.hooks.log('warn', 'ystate load failed: ' + e.message); }
      } else if (doc && doc.ownerPk === this.pk && doc.content) {
        applyStringEdit(y, doc.content); // one-time migration of legacy content
      }
      this.ydocs[docId] = y;
      // Lift a flat pre-rich doc into the rich fragment — owner-side only, and
      // persisted immediately: re-running the lift next session would mint new
      // CRDT ids and duplicate the text after sync. Members receive the lifted
      // structure via anti-entropy.
      if (doc && doc.ownerPk === this.pk && migrateTextToRich(y)) {
        doc.ystate = b64FromBytes(encodeState(y));
        this.saveAll();
      }
    }
    return y;
  }
  /** Refresh a doc's materialized view (content + serialized state) from its Yjs doc. */
  private materialize(docId: string) {
    const doc = this.docs[docId];
    const y = this.ydocFor(docId);
    const txt = docText(y);
    doc.content = doc.format === 'rich' ? this.sanitize(txt) : txt;
    doc.ystate = b64FromBytes(encodeState(y));
  }

  // ---- owner: merge an editor's proposed delta and fan out ----
  private async onUpdate(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return this.hooks.log('warn', 'update for unknown doc ' + m.docId);
    if (doc.ownerPk !== this.pk) return this.hooks.log('warn', `ignoring update — I am not the owner of "${doc.title}"`);
    const member = doc.members.find((x) => x.pk === from);
    if (!member) return this.hooks.log('warn', `REJECTED update from non-member ${short(from, 12)}`);
    if (member.role !== 'editor') return this.hooks.log('warn', `REJECTED update from ${short(from, 12)} — role is ${member.role}`);
    let delta: Uint8Array;
    try { delta = bytesFromB64(m.update); } catch { return this.hooks.log('warn', `REJECTED update from ${short(from, 12)} — bad payload`); }

    const y = this.ydocFor(m.docId);
    const before = stateVector(y);
    applyUpdate(y, delta);
    const merged = encodeSince(y, before);
    if (isEmptyUpdate(merged)) return; // nothing new (duplicate delivery)
    doc.version += 1; doc.author = from; doc.ts = now();
    this.materialize(m.docId);
    this.saveAll();
    this.hooks.docApplied(m.docId);
    this.hooks.log('ok', `merged update from ${short(from, 12)} → v${doc.version} of "${doc.title}"`);
    for (const mem of doc.members)
      void this.sendTo(mem.pk, { t: 'update-accepted', docId: m.docId, version: doc.version, author: from, ts: doc.ts, update: b64FromBytes(merged) });
  }

  // ---- member: apply a delta the owner has sequenced ----
  private onUpdateAccepted(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return this.hooks.log('warn', 'accepted update for unknown doc ' + m.docId);
    if (from !== doc.ownerPk) return this.hooks.log('warn', `REJECTED accepted-update not from owner (${short(from, 12)})`);
    let delta: Uint8Array;
    try { delta = bytesFromB64(m.update); } catch { return; }
    const y = this.ydocFor(m.docId);
    const before = stateVector(y);
    applyUpdate(y, delta);
    const changed = !isEmptyUpdate(encodeSince(y, before));
    if (!changed && (m.version ?? 0) <= doc.version) return; // pure duplicate
    if (typeof m.version === 'number' && m.version > doc.version) doc.version = m.version;
    if (m.author) doc.author = m.author;
    if (m.ts) doc.ts = m.ts;
    this.materialize(m.docId);
    this.saveAll();
    this.hooks.docApplied(m.docId);
    this.hooks.log('ok', `"${doc.title}" advanced to v${doc.version}`);
  }

  /* ---------- public actions ---------- */
  /** Snapshot of a doc's current state (incl. serialized Yjs), to seed an invitee. */
  private docSnapshot(d: DocState) {
    return { content: d.content, format: d.format, version: d.version, ts: d.ts, author: d.author, ystate: d.ystate };
  }
  /** Conflict info for the UI. The CRDT path auto-merges, so this stays empty;
   * retained until the fork/rollback UI (see docs/model.md) replaces it. */
  conflictsOf(docId: string): Commit[] { return this.docs[docId]?.conflicts || []; }
  hasPending(_docId: string): boolean { return false; }
  async resolveConflict(_docId: string, _conflictId: string) { /* no-op under CRDT auto-merge */ }
  discardConflict(_docId: string, _conflictId: string) { /* no-op under CRDT auto-merge */ }

  /** Guard mutating actions in a read-only (non-writer) tab. */
  private mutable(): boolean {
    if (!this.readOnly) return true;
    this.hooks.log('warn', 'This tab is read-only — Cardrack is active in another tab.');
    return false;
  }

  /** Rename a doc. Owner-authoritative: only the owner's rename propagates to
   * members (matching the owner-hub model); a non-owner's local change would be
   * overwritten, so we refuse it. */
  async renameDoc(docId: string, title: string) {
    if (!this.mutable()) return;
    const doc = this.docs[docId];
    if (!doc) return;
    title = (title || '').trim();
    if (!title || title === doc.title) return;
    if (doc.ownerPk !== this.pk) return this.hooks.log('warn', 'only the owner can rename this document');
    doc.title = title;
    this.saveAll();
    this.hooks.docsChanged();
    for (const mem of doc.members) {
      try { await this.sendTo(mem.pk, { t: 'rename', docId, title }); }
      catch (e: any) { this.hooks.log('warn', `rename notify to ${short(mem.pk, 12)} failed: ${e.message}`); }
    }
  }

  /** Remove a member (owner-only). Fanout and sync exclude them from now on,
   * their client is told to drop the doc, later sends bounce off the non-member
   * check, and the doc key rotates so future epochs exclude them. No
   * cryptographic erasure of what they already hold — accepted: they may keep
   * local copies or old messages; real at-rest forward secrecy arrives with
   * sealed snapshots (docs/model.md §Key custody). */
  async removeMember(docId: string, pk: string) {
    if (!this.mutable()) return;
    const doc = this.docs[docId];
    if (!doc) return;
    if (doc.ownerPk !== this.pk) return this.hooks.log('warn', 'only the owner can remove members');
    if (!doc.members.some((x) => x.pk === pk)) return;
    doc.members = doc.members.filter((x) => x.pk !== pk);
    this.saveAll();
    this.hooks.docsChanged();
    try { await this.sendTo(pk, { t: 'remove', docId }); }
    catch (e: any) { this.hooks.log('warn', `remove notice to ${short(pk, 12)} failed: ${e.message}`); }
    this.hooks.log('ok', `Removed ${short(pk, 12)} from "${doc.title}".`);
    await this.rotateDocKey(docId); // fresh epoch for the remaining conclave
  }

  /** Rotate the doc key: owner-only, epoch+1 with a fresh random key (invariant
   * #2). Old epochs are kept so earlier snapshots stay readable; a removed
   * member (future) simply never receives the new one. Also the upgrade path
   * for a legacy doc without an epoch — its first rotation mints epoch 1. */
  async rotateDocKey(docId: string) {
    if (!this.mutable()) return;
    const doc = this.docs[docId];
    if (!doc) return;
    if (doc.ownerPk !== this.pk) return this.hooks.log('warn', 'only the owner can rotate the doc key');
    const epoch = (doc.epoch || 0) + 1;
    doc.epoch = epoch;
    doc.dockeys = { ...(doc.dockeys || {}), [String(epoch)]: newDocKey() };
    this.saveAll();
    this.hooks.log('ok', `"${doc.title}" rotated to key epoch ${epoch}`);
    for (const mem of doc.members) {
      try { await this.sendTo(mem.pk, { t: 'key-envelope', docId, epoch, key: doc.dockeys[String(epoch)] }); }
      catch (e: any) { this.hooks.log('warn', `key-envelope to ${short(mem.pk, 12)} failed: ${e.message}`); }
    }
  }

  createDoc(title: string): string {
    if (!this.mutable()) return '';
    const docId = hexFromBytes(crypto.getRandomValues(new Uint8Array(8)));
    // Epoch 1 minted at creation: a fresh random doc key (invariant #2). It rides
    // in DocState, so the NIP-44 account snapshot carries it to a restored device.
    this.docs[docId] = { title: title || 'Untitled', ownerPk: this.pk, myRole: 'owner', members: [], content: '', format: 'plain', version: 0, ts: 0, author: '', ystate: undefined, head: '', history: [], conflicts: [], epoch: 1, dockeys: { '1': newDocKey() } };
    this.ydocFor(docId); // initialize an empty Yjs doc
    this.saveAll();
    this.hooks.docsChanged();
    return docId;
  }

  async invite(docId: string, pkOrNpub: string, role: 'editor' | 'viewer') {
    if (!this.mutable()) throw new Error('read-only tab — Cardrack is active in another tab');
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
      // The invite travels Signal-encrypted, so the current epoch key rides along
      // (fast path); legacy docs without an epoch send none. Old epochs are not
      // shared — a new member reads from their joining epoch forward.
      const dockey = doc.epoch ? doc.dockeys?.[String(doc.epoch)] : undefined;
      await this.sendTo(peerPk, { t: 'invite', from: this.pk, seed, docId, title: doc.title, role, members: [], doc: this.docSnapshot(doc), epoch: doc.epoch, dockey });
      if (!hasChain) this.setupChain(peerPk, seed, true);
      this.hooks.log('ok', `Invite sent to ${short(peerPk, 16)} as ${role}.`);
    } catch (e) {
      doc.members = doc.members.filter((x) => x.pk !== peerPk);
      this.saveAll();
      throw e;
    }
  }

  /** Shared tail for a local change already applied to the shared Y.Doc:
   * the owner sequences and fans out; an editor proposes to the owner. */
  private async broadcastLocalDelta(docId: string, delta: Uint8Array) {
    const doc = this.docs[docId];
    if (doc.ownerPk === this.pk) {
      doc.version += 1; doc.author = this.pk; doc.ts = now();
      this.materialize(docId);
      this.saveAll();
      this.hooks.docApplied(docId);
      for (const mem of doc.members) {
        try { await this.sendTo(mem.pk, { t: 'update-accepted', docId, version: doc.version, author: this.pk, ts: doc.ts, update: b64FromBytes(delta) }); }
        catch (e: any) { this.hooks.log('warn', `send to ${short(mem.pk, 12)} failed: ${e.message}`); }
      }
    } else {
      // editor: the edit is already applied locally (optimistic); propose the
      // delta to the owner, who merges and echoes it back as update-accepted.
      this.materialize(docId);
      this.saveAll();
      try { await this.sendTo(doc.ownerPk, { t: 'update', docId, update: b64FromBytes(delta) }); }
      catch (e: any) { this.hooks.log('warn', `send update failed: ${e.message}`); }
    }
  }

  /** Apply a string edit (tests / headless peers; the rich editor uses
   * commitUpdate). Diffed into the doc at character granularity, so concurrent
   * edits to different regions auto-merge (see docs/model.md). The `parent`
   * argument is accepted for UI compatibility but unused — no base head needed. */
  async localEdit(docId: string, content: string, format: 'plain' | 'rich', _parent?: string) {
    if (!this.mutable()) return;
    const doc = this.docs[docId];
    if (!doc || doc.myRole === 'viewer') return;
    const y = this.ydocFor(docId);
    const before = stateVector(y);
    doc.format = format;
    applyStringEdit(y, content, this.pk);
    const delta = encodeSince(y, before);
    if (isEmptyUpdate(delta)) return; // no actual change
    await this.broadcastLocalDelta(docId, delta);
  }

  /** Commit a draft delta from the rich editor. The UI edits a local draft
   * replica (so manual-Commit semantics hold: nothing leaves the device until
   * this call); the delta between draft and shared doc arrives here as an
   * opaque update, is applied to the shared doc, then sequenced/proposed. */
  async commitUpdate(docId: string, updateB64: string) {
    if (!this.mutable()) return;
    const doc = this.docs[docId];
    if (!doc || doc.myRole === 'viewer') return;
    const y = this.ydocFor(docId);
    const before = stateVector(y);
    try { applyUpdate(y, bytesFromB64(updateB64), this.pk); }
    catch (e: any) { return this.hooks.log('warn', 'editor delta rejected: ' + e.message); }
    const delta = encodeSince(y, before);
    if (isEmptyUpdate(delta)) return; // duplicate / no change
    doc.format = 'rich';
    await this.broadcastLocalDelta(docId, delta);
  }
}
