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
import { cmp } from './lww';
import { Commit, makeCommit, validCommit } from './commit';
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
  /** Anti-entropy sync interval (ms). 0 disables the timer (tests drive syncAllPeers manually). */
  syncIntervalMs?: number;
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
  pending: Record<string, Commit> = {}; // docId -> my commit awaiting owner confirmation
  snapTimer: any = null;
  syncTimer: any = null;
  syncIntervalMs: number;

  constructor(o: CoreOpts) {
    this.pool = o.pool; this.storage = o.storage; this.hooks = o.hooks;
    this.relays = o.relays || DEFAULT_RELAYS;
    this.sanitize = o.sanitize || ((h) => h);
    this.syncIntervalMs = o.syncIntervalMs ?? 20000;
  }

  /** Stop background timers (call on teardown / account switch). */
  stop() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null; }
    if (this.chainSub) { try { this.chainSub.close(); } catch {} this.chainSub = null; }
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
    // Anti-entropy: reconcile now (catch up on anything missed while offline),
    // then on a timer. Disabled when syncIntervalMs is 0 (tests drive it manually).
    void this.syncAllPeers();
    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => { void this.syncAllPeers(); }, this.syncIntervalMs);
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

  /* ---------- anti-entropy sync ----------
   * Relays are best-effort: an update can be dropped or missed while offline.
   * LWW only needs the *latest* state to converge, so peers periodically
   * exchange a small version digest and re-push whichever side is behind.
   * This makes documents self-heal after arbitrary message loss without
   * persisted relay cursors. */

  /** Only the owner re-pushes confirmed state (it is the authority); members
   * that fall behind pull via sync-req instead. */
  private mayPush(doc: DocState, peerPk: string): boolean {
    return doc.ownerPk === this.pk && doc.members.some((m) => m.pk === peerPk);
  }
  private docsWith(peerPk: string): string[] {
    return Object.keys(this.docs).filter((id) => {
      const d = this.docs[id];
      return (d.ownerPk === this.pk && d.members.some((m) => m.pk === peerPk)) || d.ownerPk === peerPk;
    });
  }
  private pushDocTo(peerPk: string, docId: string) {
    const doc = this.docs[docId];
    if (!doc || !this.mayPush(doc, peerPk)) return;
    // Only the owner's confirmed head is authoritative; re-send it as an accepted commit.
    void this.sendTo(peerPk, { t: 'commit-accepted', docId, version: doc.version, commit: this.headCommit(doc) });
  }

  /** Send a version digest to one peer, and re-propose any of my commits still
   * awaiting that peer's (owner's) confirmation — this recovers editor commits
   * dropped in transit. */
  async syncWithPeer(peerPk: string) {
    const ids = this.docsWith(peerPk);
    if (!ids.length) return;
    const digest: Record<string, { version: number; ts: number; author: string }> = {};
    for (const id of ids) {
      const d = this.docs[id];
      digest[id] = { version: d.version, ts: d.ts, author: d.author };
      // resend an unconfirmed commit to the owner
      if (this.pending[id] && d.ownerPk === peerPk) {
        try { await this.sendTo(peerPk, { t: 'commit', docId: id, commit: this.pending[id] }); }
        catch (e: any) { this.hooks.log('warn', `resend commit failed: ${e.message}`); }
      }
    }
    try { await this.sendTo(peerPk, { t: 'sync', digest }); }
    catch (e: any) { this.hooks.log('warn', `sync to ${short(peerPk, 12)} failed: ${e.message}`); }
  }
  /** Reconcile with every peer we share a chain with. */
  async syncAllPeers() {
    for (const peerPk of Object.keys(this.chains)) await this.syncWithPeer(peerPk);
  }

  private onSync(from: string, m: any) {
    const digest = m.digest || {};
    const reqIds: string[] = [];
    for (const docId of Object.keys(digest)) {
      const remote = digest[docId];
      const local = this.docs[docId];
      if (local && cmp(local, remote) > 0) this.pushDocTo(from, docId); // I'm ahead → push
      else if (!local || cmp(local, remote) < 0) reqIds.push(docId);    // they're ahead → request
    }
    if (reqIds.length) void this.sendTo(from, { t: 'sync-req', docIds: reqIds });
  }
  private onSyncReq(from: string, m: any) {
    for (const docId of m.docIds || []) this.pushDocTo(from, docId);
  }

  private dispatch(from: string, m: any) {
    if (m.t === 'invite') return this.onInvite(from, m);
    if (m.t === 'commit') return void this.onCommit(from, m);            // editor → owner: proposed edit
    if (m.t === 'commit-accepted') return void this.onCommitAccepted(from, m); // owner → members: linearized
    if (m.t === 'commit-rejected') return void this.onCommitRejected(from, m); // owner → author: stale base
    if (m.t === 'ack') return this.hooks.log('ok', `${short(from, 12)} accepted the invite.`);
    if (m.t === 'hello') return this.hooks.log('ok', `Session with ${short(from, 12)} (re-)established.`);
    if (m.t === 'sync') return void this.onSync(from, m);
    if (m.t === 'sync-req') return void this.onSyncReq(from, m);
    this.hooks.log('info', 'unknown message type ' + m.t);
  }

  private onInvite(from: string, m: any) {
    const d = m.doc || {};
    this.docs[m.docId] = {
      title: m.title, ownerPk: from, myRole: m.role, members: m.members || [],
      content: d.content || '', format: d.format || 'plain',
      version: d.version || 0, ts: d.ts || 0, author: d.author || '',
      head: d.head || '', history: [], conflicts: [],
    };
    this.saveAll();
    this.hooks.docsChanged();
    this.hooks.log('ok', `Invited to "${m.title}" by ${short(from, 12)} as ${String(m.role).toUpperCase()}`);
    void this.sendTo(from, { t: 'ack', docId: m.docId });
  }

  /** Advance the confirmed head to `commit` at chain depth `version`. Shared by
   * owner (on accept) and members (on receiving an accepted commit). */
  private applyCommit(doc: DocState, commit: Commit, version: number) {
    doc.head = commit.id;
    doc.version = version;
    doc.author = commit.author;
    doc.ts = commit.ts;
    doc.format = commit.format;
    doc.content = commit.format === 'rich' ? this.sanitize(commit.content) : commit.content;
    (doc.history ||= []).push(commit);
    if (doc.history.length > 200) doc.history = doc.history.slice(-200);
  }

  /** A minimal commit object describing a doc's current confirmed head. */
  private headCommit(doc: DocState): Commit {
    return { id: doc.head, parent: '', author: doc.author, ts: doc.ts, content: doc.content, format: doc.format };
  }

  // ---- owner: linearize a proposed edit ----
  private onCommit(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return this.hooks.log('warn', 'commit for unknown doc ' + m.docId);
    if (doc.ownerPk !== this.pk) return this.hooks.log('warn', `ignoring commit — I am not the owner of "${doc.title}"`);
    const member = doc.members.find((x) => x.pk === from);
    if (!member) return this.hooks.log('warn', `REJECTED commit from non-member ${short(from, 12)}`);
    if (member.role !== 'editor') return this.hooks.log('warn', `REJECTED commit from ${short(from, 12)} — role is ${member.role}`);
    const c: Commit = m.commit;
    if (!validCommit(c)) return this.hooks.log('warn', `REJECTED commit from ${short(from, 12)} — bad commit id`);

    if (c.parent === doc.head) {
      // fast-forward: accept and linearize
      const version = doc.version + 1;
      this.applyCommit(doc, c, version);
      this.saveAll();
      this.hooks.docApplied(m.docId);
      this.hooks.log('ok', `accepted commit ${short(c.id, 10)} → v${version} of "${doc.title}"`);
      for (const mem of doc.members) void this.sendTo(mem.pk, { t: 'commit-accepted', docId: m.docId, version, commit: c });
    } else {
      // stale base: reject, hand back the current head so the author can reconcile
      this.hooks.log('warn', `REJECTED stale commit from ${short(from, 12)} (based on old version of "${doc.title}")`);
      void this.sendTo(from, { t: 'commit-rejected', docId: m.docId, version: doc.version, commit: this.headCommit(doc) });
    }
  }

  // ---- member: a commit the owner has confirmed ----
  private onCommitAccepted(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return this.hooks.log('warn', 'accepted-commit for unknown doc ' + m.docId);
    if (from !== doc.ownerPk) return this.hooks.log('warn', `REJECTED accepted-commit not from owner (${short(from, 12)})`);
    const c: Commit = m.commit;
    // my own edit got confirmed?
    if (this.pending[m.docId] && this.pending[m.docId].id === c.id) delete this.pending[m.docId];
    if (m.version > doc.version) {
      this.applyCommit(doc, c, m.version);
      this.saveAll();
      this.hooks.docApplied(m.docId);
      this.hooks.log('ok', `"${doc.title}" advanced to v${m.version}`);
    }
  }

  // ---- author: my commit was based on stale history ----
  private onCommitRejected(from: string, m: any) {
    const doc = this.docs[m.docId];
    if (!doc) return;
    if (from !== doc.ownerPk) return this.hooks.log('warn', `ignoring reject not from owner (${short(from, 12)})`);
    const mine = this.pending[m.docId];
    // adopt the owner's newer head
    if (m.version >= doc.version) { this.applyCommit(doc, m.commit, m.version); }
    if (mine) {
      (doc.conflicts ||= []).push(mine);
      delete this.pending[m.docId];
      this.hooks.log('warn', `Your edit to "${doc.title}" was based on an older version — kept as a conflict; document updated to v${doc.version}.`);
    }
    this.saveAll();
    this.hooks.docApplied(m.docId);
    this.hooks.conflictsChanged?.(m.docId);
  }

  /* ---------- public actions ---------- */
  /** Snapshot of a doc's confirmed head, used to seed an invitee. */
  private docSnapshot(d: DocState) {
    return { content: d.content, format: d.format, version: d.version, ts: d.ts, author: d.author, head: d.head };
  }
  /** Pending/conflict info for the UI. */
  conflictsOf(docId: string): Commit[] { return this.docs[docId]?.conflicts || []; }
  hasPending(docId: string): boolean { return !!this.pending[docId]; }
  /** Re-submit a preserved conflict's content as a fresh edit on the current head. */
  async resolveConflict(docId: string, conflictId: string) {
    const doc = this.docs[docId];
    if (!doc) return;
    const c = (doc.conflicts || []).find((x) => x.id === conflictId);
    if (!c) return;
    doc.conflicts = (doc.conflicts || []).filter((x) => x.id !== conflictId);
    await this.localEdit(docId, c.content, c.format);
    this.hooks.conflictsChanged?.(docId);
  }
  discardConflict(docId: string, conflictId: string) {
    const doc = this.docs[docId];
    if (!doc) return;
    doc.conflicts = (doc.conflicts || []).filter((x) => x.id !== conflictId);
    this.saveAll();
    this.hooks.conflictsChanged?.(docId);
  }

  createDoc(title: string): string {
    const docId = hexFromBytes(crypto.getRandomValues(new Uint8Array(8)));
    this.docs[docId] = { title: title || 'Untitled', ownerPk: this.pk, myRole: 'owner', members: [], content: '', format: 'plain', version: 0, ts: 0, author: '', head: '', history: [], conflicts: [] };
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
      await this.sendTo(peerPk, { t: 'invite', from: this.pk, seed, docId, title: doc.title, role, members: [], doc: this.docSnapshot(doc) });
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
    const c = makeCommit(doc.head, this.pk, now(), content, format);
    if (doc.ownerPk === this.pk) {
      // owner is the linearization point: self-accept, then fan out
      const version = doc.version + 1;
      this.applyCommit(doc, c, version);
      this.saveAll();
      for (const mem of doc.members) {
        try { await this.sendTo(mem.pk, { t: 'commit-accepted', docId, version, commit: c }); }
        catch (e: any) { this.hooks.log('warn', `send to ${short(mem.pk, 12)} failed: ${e.message}`); }
      }
    } else {
      // editor: propose to owner. Show my text optimistically, but leave the
      // confirmed head/version untouched until the owner confirms.
      this.pending[docId] = c;
      doc.content = format === 'rich' ? this.sanitize(content) : content;
      doc.format = format;
      this.saveAll();
      try { await this.sendTo(doc.ownerPk, { t: 'commit', docId, commit: c }); }
      catch (e: any) { this.hooks.log('warn', `send commit failed: ${e.message}`); }
    }
  }
}
