# Pluggable storage & the "encrypted container" idea

Status: **exploration, not decided.** Captured for discussion (idea raised 2026-08-05).

## The idea

Use VeraCrypt-style encrypted **container files** to play the role of local storage —
i.e. the document store (and possibly the *shared* medium) is a single portable,
password-encrypted file. Pluggable, alongside IndexedDB / relay snapshot / network
StorageAdapter.

## What VeraCrypt does, and the browser analog

VeraCrypt = an encrypted volume file mounted as a virtual disk: a password-derived
key (PBKDF2/Argon2), symmetric cipher (AES-XTS…), whole-container encryption at rest,
optional hidden-volume deniability. A browser app **can't** mount OS volumes, but can
implement the *spirit* — one portable file that **is** your encrypted store, decrypted
in memory with a password/key. Available primitives:

- **File System Access API** — open/read/write a real local file the user picks
  (portable: USB, synced folder). Chromium-strong; Safari/Firefox partial. A stored
  handle can persist across sessions (with a permission re-grant).
- **OPFS (Origin Private File System)** — fast, sandboxed, origin-private file storage.
  Supported in all modern engines (Chrome/Edge 86+, Firefox 111+, Safari 15.2+).
  Seamless but **not** user-visible/portable.
- **WebCrypto** — AES-GCM-256 + PBKDF2 (or Argon2 via WASM) for the container crypto.

## How it fits Cardrack (the seam already exists)

`core/kv.ts` already abstracts storage: `AsyncStore` (`loadAll/write/remove/clear`)
behind `CachedKV`. Backends are pluggable **today** (`IdbBackend`, `LocalStorageBackend`).
A `FileVaultBackend implements AsyncStore` drops straight in: serialize the KV, encrypt
to one blob, persist to a File System Access handle or an OPFS file, decrypt on open.
The roadmap's network `StorageAdapter` (Blossom/GitHub/S3/WebDAV) is the same
pluggability for *remote* snapshot chunks — the encrypted file is its local sibling.

## Two roles worth separating

1. **Local at-rest store** (replace/augment IndexedDB). Wins: **at-rest encryption**
   (IndexedDB today is plaintext on disk — a real gap), portability (carry docs on a
   USB), works over `file://`. This is the cheap, high-value version.
2. **The shared medium** (the container *is* what you exchange). A relay-less,
   sneakernet/cloud-folder collaboration model: two people swap a container and merge
   on import. Loses real-time sync, but our **CRDT already gives deterministic
   merge-on-import** — so an out-of-band container could reconcile cleanly. Bigger,
   more speculative, but interesting for air-gapped / no-relay use.

## Crypto & key questions

- **Container key**: password-derived (user picks a vault password; Argon2/PBKDF2) or
  derived from the mnemonic (no extra password, but couples vault to account). Per
  invariant #1 (identity signs, never encrypts), a vault tied to the account should be
  self-encrypted like the account snapshot (NIP-44), not signed-key-derived.
- **Whole-container vs per-doc chunks**: whole-blob is simplest but leaks total size and
  re-encrypts everything each save; per-doc sha256-addressed chunks align with the
  planned doc-key epochs and the StorageAdapter model.
- **Authenticated encryption** (AES-GCM) is mandatory; a MAC over the whole container if
  chunked.

## Trade-offs / open questions

- **Portability vs convenience**: File System Access = portable but re-pick/permission
  each session; OPFS = seamless but sandboxed (not portable).
- **Browser support**: OPFS is universal; the portable-file story is Chromium-mostly.
- **Deniability** (hidden volumes) is likely out of scope in-browser.
- Independent of transport privacy we already have — this closes the **local at-rest**
  gap specifically.

## Tentative recommendation (to discuss)

1. **Now, cheap, high-value**: encrypt the at-rest cache — a `FileVaultBackend` or an
   encrypting wrapper over `IdbBackend`, keyed from the mnemonic (self-encrypt, like the
   account snapshot). Closes "local storage is plaintext" reusing the `AsyncStore` seam.
2. **Next**: opt-in `FileVaultBackend` over File System Access / OPFS for portability.
3. **Later / research**: container-as-share-medium for relay-less collaboration —
   prototype once the network path is solid (the CRDT merge-on-import is the enabler).

## Precedents

- `mylofi/local-vault` — KV encrypted at rest, passkey-protected, OPFS/IDB backends.
- Penumbra — offline encrypted notes, AES-GCM-256 + PBKDF2.
- General caution: browser local storage is **not** encrypted by default.
