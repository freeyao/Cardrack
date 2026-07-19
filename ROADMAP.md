# Signal-Collab — positioning, invariants, roadmap

## Positioning

An **independent** E2EE document-collaboration app. Nostr is plumbing (relays, event format,
keys); Signal protocol is the crypto; Keychat/NIP-07 is an optional external signer, nothing
more. Any browser can run it.

**v1.0 target:** a circle of 2–10 people, one self-hosted relay, mnemonic-backed accounts,
documents never lost, automatic catch-up after offline, device switch without asking anyone.

## Invariants (settled)

1. **Identity signs, never encrypts.** The account key (nostr keypair, shown to users as a
   mnemonic, not "npub") signs prekey bundles and membership records only. Exception, opt-in
   per circle: a NIP-44 *recovery path* lets the account key decrypt doc-key envelopes —
   convenience vs. blast radius, explicit policy switch (balanced / paranoid).
2. **All encryption keys are random**, tiered by lifetime: Signal identity+prekeys (long-term,
   bound to account by signature), ratchet message keys (per message, discarded → forward
   secrecy), doc content keys (per epoch, rotated on membership change — fresh random, not
   KDF-derived, so removed members can't compute forward).
3. **Stateless client.** Any device holding the account opens every document: encrypted doc
   index + key envelopes + snapshots all live on the network as ciphertext. Local storage is
   cache. Only ratchet state is device-local and unrecoverable — by design, per device.
4. **Link locates, invitation authorizes.** `#/doc/<docId>/<owner>` sends a knock to the
   owner; optional per-doc capability key enables link-read. docId never changes; rekeys
   don't break links.
5. **Relays and storage see only ciphertext and unlinkable addresses.** Anonymous throwaway
   sender keys; one-time mailbox chains from an encrypted seed; identity appears on the wire
   only in the signed prekey event and (until gift-wrapped) the invite p-tag.

## Architecture

| Layer | Component | Notes |
|---|---|---|
| Client | Tiptap+Yjs editor · version log/snapshots · Signal engine · address chains · account (mnemonic) | browser or any webview |
| Signaling | Nostr relay(s), self-hosted preferred | live deltas, invites, envelopes, pointers |
| State | StorageAdapter: Blossom / GitHub repo / S3 / WebDAV | encrypted snapshot chunks, sha256-addressed; GitHub = zero-setup option, replaces storage never signaling |
| Identity | app-native mnemonic account; NIP-07 optional | multi-device via Signal deviceIds, ratchets never synced |

## Phases

**P0 — reliability (blocking daily use)**
Delivery: sequence numbers, gap detection, resend, persisted relay cursors. Session
self-healing (auto re-handshake). Web Locks single-writer per identity. IndexedDB + migration.
Encrypted doc index event (new device discovers its docs). Account: mnemonic backup ceremony,
restore/QR migration, deviceId support.

**P1 — collaboration core**
Tiptap+Yjs (rich text, CRDT merge, presence). Version history: encrypted update log +
epoch-tagged snapshots, timeline/diff/restore, named checkpoints. Doc-key epochs + dual-path
key envelopes (Signal session fast path; NIP-44 recovery path per policy). Signed membership
credentials; removal → rotation; owner succession by member quorum. Permanent links + knock
flow. Beyond owner-hub: all-pairs (≤5), then MLS.

**P2 — trust polish**
Safety-number verification UI (TOFU → verified, alarm on key change). Contact nicknames, QR
invites. NIP-59 gift-wrapped invites (last metadata leak). Restore one-time prekey
consumption + signed-prekey rotation.

**P3 — productization**
Doc management (rename/archive/export md-docx). Encrypted attachments (chunked to storage,
uniform sizes). Self-hosted relay+storage docker guide. Notifications. Mobile UI, i18n.
Hardening: dependency pinning, reproducible build, CSP, envelope-parser fuzzing, external
review of the address-chain construction.

**Ruled out / parked:** DHT (no persistence guarantees; lookups leak; browsers can't join;
tiny DHTs are worse than a relay list). Pkarr-style DHT publication of prekey *pointers* —
watch as a censorship escape hatch, don't build. IPFS — metadata + pinning centralization.

## Already done (v0.4)

**v0.4 (P0 slice):** mnemonic accounts (BIP39 ceremony: create/confirm/restore, reveal in
idbar); stateless client v1 — NIP-44 self-encrypted account snapshot (docs + chains, kind
30079 replaceable, debounced) lets a fresh device restore everything from the 12 words alone;
session self-healing (decrypt failure → rate-limited automatic X3DH re-handshake over the
restored address chain). Verified by ui-restore test: collaborate → device dies → restore
from mnemonic → doc intact → edits flow both ways again.

## Earlier (PoC v3)

X3DH + Double Ratchet in browser (single 495 KB html). Owner-centric invites by pubkey with
signed prekey verification. editor/viewer ACL enforced receiver-side. Metadata-private
transport: anonymous senders, one-time address chains. NIP-07 signer integration (optional).
Persistent identity/sessions/docs (localStorage). Plain+rich LWW editing. Headless test
suite: crypto round-trip, demo mode, 3-party collab incl. malicious-viewer / stranger-with-URL
attacks, wire plaintext-leak scan, NIP-07 mock. Zero-install LAN servers (http + self-signed
https PowerShell scripts).
