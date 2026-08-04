# Cardrack — working context for Claude

This file is the hand-off note for any Claude session (Claude Code or Cowork).
Read it, then `ROADMAP.md` for the plan and `git log` for the decision trail —
the commit messages are written to be read.

## What this is

An **independent**, end-to-end encrypted document-collaboration web app for small
circles. Signal protocol (X3DH + Double Ratchet) does the crypto; Nostr relays are
dumb transport; any browser runs it. Named after the card-rack in Poe's *The
Purloined Letter* (a letter hidden in plain sight — the metadata-privacy model).
Not audited; a research prototype.

## Invariants (do not break without discussion)

1. **Identity signs, never encrypts.** The account key (a BIP39 mnemonic → nostr
   keypair, shown to users as a recovery phrase, not "npub") signs prekey bundles
   and (later) membership records only. It does not derive or hold document keys.
   Opt-in exception per circle: a NIP-44 recovery path may let the account key
   decrypt doc-key envelopes (convenience vs. blast radius — a policy switch).
2. **All encryption keys are random**, tiered by lifetime: Signal identity/prekeys
   (long-term), ratchet message keys (per message → forward secrecy), doc content
   keys (per epoch, rotated on membership change — planned).
3. **Stateless client.** Any device holding the mnemonic reopens every document:
   encrypted doc index + key envelopes + snapshots live on the network as
   ciphertext. Local storage is a cache. Only ratchet state is device-local and
   intentionally unrecoverable.
4. **Owner is the linearization point.** Every edit is a commit naming its parent
   (the confirmed head). The owner accepts only fast-forward commits (parent ===
   head, a CAS) and rejects stale ones; the rejected author keeps its text as a
   *conflict* — nobody's edit is silently clobbered. "Owner is always right" for
   ordering.
5. **Relays/storage see only ciphertext and unlinkable addresses.** Every envelope
   is sent from a throwaway key to a one-time mailbox address derived from a secret
   shared inside the encrypted invite. Real identity appears on the wire only in
   the signed prekey event and (until NIP-59 gift-wrap) the invite p-tag.

## Architecture

- `app/src/core/` — **DOM-free** protocol logic, unit-tested directly in Node:
  - `account.ts` mnemonic/identity + NIP-44 self-encryption
  - `signal.ts` / `signal-store.ts` libsignal wrappers + serializable store
  - `chains.ts` one-time address derivation: `sk_n = sha256(seed || 'sc-addr:'+dir+':' || u32be(n))`
  - `commit.ts` content-addressed commits (`id = hash(parent,author,ts,format,content)`)
  - `lww.ts` version total-order `cmp` (used by anti-entropy sync)
  - `kv.ts` `CachedKV`: sync `KV` cache over an async `AsyncStore` backend (+ read-only toggle, legacy-seed migration)
  - `app.ts` `CollabCore` orchestrator (transport, invites, ACL, sync, snapshots)
  - `types.ts` `Pool`/`KV`/`Hooks`/`DocState`
- `app/src/ui/` — thin DOM layer (`main.ts`, `editor.ts`, `sanitize.ts`, `idb.ts` = IndexedDB
  backend + Web Lock); calls core only.
- `app/index.html` — dev entry; `npm run build` emits a single-file `dist/index.html`.
- `legacy/` — the original single-file PoC, kept for reference; not used by the app.
- Event kinds: `30078` signed prekey bundle, `4078` anonymous envelope
  (`{v,type,body,boot?}`), `30079` NIP-44 self-encrypted account snapshot (doc index).
  Message types inside envelopes: `invite`/`ack`/`hello`/`update` (editor→owner
  Yjs delta)/`update-accepted` (owner→members merged delta)/`sync`/`sync-ack`.

## Current state (see git log for detail)

Working: X3DH+ratchet in browser; mnemonic accounts (create/restore); stateless
device restore from the phrase; owner-centric invites by npub with signed-prekey
verification; editor/viewer ACL enforced receiver-side; metadata-private transport;
**Yjs CRDT documents** (`core/ydoc.ts` — ops-as-truth per `docs/model.md`): commits
carry Yjs binary deltas, the owner merges + fans out (no more CAS-reject/conflict),
concurrent edits **auto-merge**; content materialized to `DocState.content`, durable
state in `DocState.ystate`; legacy pre-Yjs docs migrated owner-side into the CRDT;
**state-vector anti-entropy sync** (`sync`/`sync-ack`, role-gated deltas) self-heals
arbitrary loss / offline gaps; **dual-mode editing** — manual Commit by default, opt-in
per-doc real-time (debounced auto-send) behind a strong metadata-warning confirmation;
session self-healing (auto re-handshake on decrypt failure); **IndexedDB storage** (via
`CachedKV`, one-time migration from legacy localStorage — no 5MB cap) with a
**single-writer Web Lock** (a second tab of the same account is read-only, protecting
the Signal ratchet store).

## Next (from ROADMAP P0/P1)

The Yjs CRDT core + manual/real-time editing are done (see Current state). **Read
`docs/model.md` before touching commits/sync/editor** — the model is settled:
ops-as-truth (Yjs), owner-hub, snapshot-per-epoch at rest, owner-adjudicated
rollback, non-owner fork-as-exit (unilateral, provenance-tracked). Immediate next:
**Tiptap rich text** via y-prosemirror (structure-aware CRDT + presence; the editor
is still a textarea binding to a Y.Text — this swaps in real rich text). Then version
history (epoch snapshots, timeline/diff/restore, named checkpoints); fork + rollback +
merge-request; doc-key epochs + dual-path key envelopes; signed membership +
removal/rotation + owner-succession quorum; permanent links + knock; Blossom snapshot
storage via a StorageAdapter; beyond owner-hub → MLS.

## Conventions

- **Commands** (in `app/`): `npm install`, `npm test` (vitest, DOM-free), `npm run dev`,
  `npm run build`. If `node_modules` for vitest is flaky, install jsdom in a temp dir.
- **Tests**: put protocol logic in `core/` and test it in Node — avoid needing a
  browser. Fake relay + `MemKV` are in `app/test/helpers.ts`; drive `syncAllPeers`
  manually (`syncIntervalMs: 0`) for determinism.
- **Line endings**: LF enforced via `.gitattributes` (`.ps1` = CRLF). On Windows,
  don't fight it.
- **Commits**: small, one concern each; write the *why* in the body. Keep the
  single-file build out of commits (it's a `dist/` artifact, gitignored).
- **Don't** rename event kinds / storage keys casually (they are a wire/runtime
  namespace). Keep the product name out of protocol identifiers.
- Committer identity is a placeholder (`signal-collab-dev`); the human sets their
  own `git config user.*` locally.

## Using two Claudes

No shared chat memory between Cowork and Claude Code — they share this repo. Do
implementation-heavy work in Claude Code (it reads the whole tree, runs tests fast).
Use Cowork for design/decisions. This file + ROADMAP.md + commit messages are the
bridge; keep them current when a decision or the architecture changes.
