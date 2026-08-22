# Cardrack

End-to-end encrypted document collaboration for small **conclaves** — trusted
groups that, true to the word's Latin root (*cum clave*, "with a key"), are
defined by holding one. An **independent** web app: the Signal protocol
(X3DH + Double Ratchet) provides the crypto, Nostr relays are dumb transport,
and any browser can run it. No accounts live on any server.

> Named after the card-rack in Poe's *The Purloined Letter* — a letter hidden in
> plain sight, the model for the metadata-privacy design.

> Status: research prototype (v0.5). The cryptographic core is real; the system is
> **not audited**. Do not use for anything that actually needs to stay secret yet.

## What works today

- **Real Signal protocol in the browser** — X3DH key agreement + Double Ratchet,
  via `@privacyresearch/libsignal-protocol-typescript`.
- **Documents that merge themselves** — documents are Yjs CRDTs: concurrent
  edits **auto-merge** instead of overwriting each other; the owner sequences
  and fans out changes (see [`docs/model.md`](./docs/model.md)).
- **Manual + opt-in real-time editing** — by default edits stay on your device
  until you hit **Commit**; per document you can switch on real-time sync
  (edits stream as you type), gated behind a confirmation that spells out the
  metadata trade-off (relays can see edit timing, though never the text).
- **Owner-centric sharing** — invite collaborators by their public key with an
  `editor` / `viewer` role. Their signed prekey bundle is verified before the
  handshake; the ACL is enforced on the receiving side.
- **Document management** — create and rename documents (click the title to
  edit it inline); the owner's rename propagates to members.
- **Per-document key epochs** — owner-minted random content keys with rotation
  and encrypted distribution; groundwork for the decided key-custody model
  (the service never holds doc keys).
- **Metadata-private transport** — every message is sent from a throwaway key
  to a one-time mailbox address derived from a secret shared inside the
  encrypted invite. Relays see only ciphertext between unlinkable addresses,
  and the relay list is yours to configure (with per-relay health probes).
- **Self-healing sync** — state-vector anti-entropy recovers arbitrary message
  loss and offline gaps; a decrypt failure triggers an automatic re-handshake.
- **Mnemonic accounts** — a 12-word BIP39 phrase *is* the account (create,
  restore, and **log out** — logout wipes the device, and the phrase is the
  only way back in). No server login. Existing nostr identities can be
  **imported**: bare `nsec`, raw hex, or password-protected NIP-49 `ncryptsec`
  (an imported account has no phrase; its nsec is the recovery secret).
- **Stateless client** — a new device restores every document from the phrase
  alone (encrypted account snapshot on the relay); no other member need be online.
- **Local-first storage** — documents persist in IndexedDB (falling back to
  `localStorage` where IndexedDB is unavailable). A single-writer Web Lock
  makes a second tab of the same account read-only, protecting the Signal
  ratchet store.
- **Runs from a single file** — `npm run build` emits one self-contained
  `dist/index.html` you can open directly (`file://`), serve, or download as an
  offline copy from the deployed page itself.

## For developers: the module map

Development is organized into nine modules with 1:1 file seams — demands are
named by module, features branch by module. The full map (what each module
owns, what's done, what's next) lives in [`docs/modules.md`](./docs/modules.md):

| # | Module | Owns |
|---|--------|------|
| 1 | Identity | who *you* are (accounts, import, logout) |
| 2 | Files | document lifecycle |
| 3 | Editor | the editing surface |
| 4 | Conclave | who is in the group, what they may do |
| 5 | Sync | convergence of state (CRDT, anti-entropy) |
| 6 | Keys | cryptography & custody |
| 7 | Transport | wire + metadata privacy |
| 8 | Storage | where bytes rest |
| 9 | Distribution | how the app reaches people |

See [`ROADMAP.md`](./ROADMAP.md) for positioning, the five design invariants,
and the phased plan; [`docs/model.md`](./docs/model.md) for the settled document
model and key custody; [`docs/storage.md`](./docs/storage.md) for the storage
exploration.

## Layout

```
app/        current source — Vite + TypeScript workspace
  src/core/ DOM-free protocol logic (account, signal, dockey, chains, ydoc, kv, orchestrator)
  src/ui/   thin DOM layer (editor, IndexedDB backend + Web Lock, sanitizer)
  test/     vitest unit + integration tests (run in Node, no browser)
legacy/     the original single-file HTML proof of concept (v0.3–v0.4) + LAN serve scripts
docs/       design notes (modules.md — module map; model.md — document model; storage.md)
ROADMAP.md  design invariants, architecture, phased plan
```

The `core/` modules have no DOM dependency and are tested directly in Node. The
single-file `index.html` deliverable is produced as a build artifact, not hand-edited.

## Develop

```bash
cd app
npm install
npm test              # vitest (sequential files): signal, dockey, epochs, chains, ydoc, kv, collab, import
npm run dev           # local dev server (recommended way to run it)
npm run build         # single-file dist/index.html (vite-plugin-singlefile)
```

The single-file `dist/index.html` opens directly over `file://` (just double-click
it) as well as over HTTP. One caveat on `file://`: browsers block IndexedDB and Web
Locks there, so storage falls back to `localStorage` and the multi-tab read-only
lock is unavailable — for multi-tab use or day-to-day development, prefer
`npm run dev` or serving the build over HTTP.

## Security note

This is a research prototype. The cryptographic core is real, but the system has
known gaps documented in `ROADMAP.md` (prekey reuse, unsigned membership,
owner-online requirement, metadata at the invite bootstrap). It has not been
reviewed by anyone. Treat it as a design exploration.

## Dev's words

All documents and codes are generated by Claude Fable & Opus4.8 except for THIS sentence.
