# Modules — how the work is organized

Status: **adopted 2026-08-22.** Demands are named by module ("Keys: export
ceremony", "Editor: Tiptap"); bigger demands get a feature branch per module
seam. The seams below map 1:1 onto real file boundaries, so module-scoped
branches rarely collide.

**Terminology:** the trusted group around a document is a **Conclave** (from
Latin *cum clave*, "with a key" — the group is defined by holding the key,
which is exactly how the epoch model enforces membership). It replaces the
earlier working word "circle".

| # | Module | Owns | Key code |
|---|--------|------|----------|
| 1 | **Identity** | who *you* are | `core/account.ts`, gate in `ui/main.ts` |
| 2 | **Files** | document lifecycle | doc actions in `core/app.ts`, `core/types.ts` |
| 3 | **Editor** | the editing surface | `ui/editor.ts`, `ui/sanitize.ts` |
| 4 | **Conclave** | who is in the group, what they may do | invite/ACL logic in `core/app.ts` |
| 5 | **Sync** | convergence of state | `core/ydoc.ts`, sync/dispatch in `core/app.ts` |
| 6 | **Keys** | cryptography & custody | `core/signal.ts`, `core/signal-store.ts`, `core/dockey.ts` |
| 7 | **Transport** | wire + metadata privacy | `core/chains.ts`, envelope logic in `core/app.ts`, relay UI in `ui/main.ts` |
| 8 | **Storage** | where bytes rest | `core/kv.ts`, `ui/idb.ts` |
| 9 | **Distribution** | how the app reaches people | `app/vite.config.ts`, `.github/workflows/pages.yml` |

## 1 · Identity

Done: mnemonic accounts (create ceremony / restore / reveal), nsec · 64-hex ·
NIP-49 ncryptsec import (imported accounts have no phrase; the nsec is the
recovery secret), logout with device wipe.
Next: QR device migration, Signal deviceIds.

## 2 · Files

Done: create, inline rename (owner-authoritative, propagates), doc list, doc
index in the account snapshot.
Next: archive/delete, export (md/docx), **fork-as-exit** (unilateral,
provenance-tracked — see model.md), permanent links (`#/doc/…` locates,
invitation authorizes).

## 3 · Editor

Done: plain/rich panes, manual Commit by default, per-doc opt-in real-time
(debounced) behind the metadata-warning confirmation.
Next: **Tiptap** rich text over y-prosemirror (structure-aware merge), presence
cursors.

## 4 · Conclave

Done: owner-centric invites by npub, editor/viewer roles, receiver-side ACL
enforcement, prekey-signature verification of the inviter.
Next: signed membership records, removal → epoch rotation (with Keys), owner
succession by quorum, knock flow, contact nicknames, safety-number verification
(TOFU → verified, alarm on key change).

## 5 · Sync

Done: Yjs CRDT (ops-as-truth), owner-hub sequencing + fanout, auto-merge,
state-vector anti-entropy (`sync`/`sync-ack`), session self-healing.
Next: version history (encrypted update log, epoch-tagged snapshots,
timeline/diff/restore, named checkpoints), owner-adjudicated rollback (a
forward op), merge-requests from forks; later all-pairs (≤5) → MLS.

## 6 · Keys

Done: X3DH + Double Ratchet sessions, signed prekey bundles, doc-key epochs
(owner-minted random 32-byte keys, rotation with key-envelope fanout, AES-GCM
sealing primitives, NIP-44 recovery-path helpers — unwired by design).
Next: the **key-custody policy switch** (see model.md §Key custody — service
never holds doc keys; two-factor recovery; "balanced" as per-conclave opt-in),
key-export ceremony, recovery-path wiring, one-time prekey consumption +
signed-prekey rotation.

## 7 · Transport

Done: anonymous throwaway senders, one-time mailbox address chains, relay
customization UI (per-account list, health probes).
Next: NIP-59 gift-wrapped invites (the last bootstrap metadata leak), persisted
relay cursors.

## 8 · Storage

Done: `CachedKV` sync facade, IndexedDB backend with localStorage fallback,
single-writer Web Lock, legacy migration.
Next: **StorageAdapter** for user-provided online storage (Blossom / GitHub /
S3 / WebDAV), encrypted local key container (see storage.md), snapshots-at-rest
sealed under epoch keys.

## 9 · Distribution

Done: single-file build that runs over `file://`, GitHub Pages deploy gated on
tests, in-app offline-copy download, prototype warning banner.
Next: versioned releases (tags → artifacts). (No self-hosted infrastructure
guide: the project ships no infrastructure — owner decision, see ROADMAP
Positioning.)

## Naming notes

- **Conclave** is the adopted term for the trusted group (module 4 owns it).
  Product-wide wording (README, UI copy) migrates opportunistically.
- **Cabal** — reserved; a word the owner likes, not yet assigned. Natural
  candidates when they arrive: the all-pairs/MLS mode (a conclave with no
  owner) or a federation of conclaves.
