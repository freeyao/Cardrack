# Cardrack

End-to-end encrypted document collaboration for small circles. An **independent**
web app: the Signal protocol (X3DH + Double Ratchet) provides the crypto, Nostr
relays are dumb transport, and any browser can run it. No accounts live on any server.

> Named after the card-rack in Poe's *The Purloined Letter* — a letter hidden in
> plain sight, the model for the metadata-privacy design.

> Status: research prototype (v0.5). The cryptographic core is real; the system is
> **not audited**. Do not use for anything that actually needs to stay secret yet.

## What works today

- **Real Signal protocol in the browser** — X3DH key agreement + Double Ratchet,
  via `@privacyresearch/libsignal-protocol-typescript`.
- **Yjs CRDT documents** — edits are Conflict-free Replicated Data Type operations:
  concurrent edits **auto-merge** instead of clobbering. The owner is the hub that
  sequences and fans out changes; the durable state is a serialized Yjs doc, and
  content is materialized from it (see [`docs/model.md`](./docs/model.md)).
- **Manual + opt-in real-time editing** — by default edits stay on your device
  until you hit **Commit**; per document you can switch on real-time sync (edits
  stream as you type), gated behind a confirmation that spells out the metadata
  trade-off (relays can see edit timing, though never the text).
- **Owner-centric sharing** — create a document, invite collaborators by their
  public key with an `editor` / `viewer` role. Their signed prekey bundle is
  verified before the handshake; the ACL is enforced on the receiving side.
- **Document management** — create and **rename** documents (click the title to
  edit it inline); the owner's rename propagates to members.
- **Metadata-private transport** — every message is sent from a throwaway key to a
  one-time mailbox address derived from a secret shared inside the encrypted
  invite. Relays see only ciphertext between unlinkable addresses.
- **Custom relays** — edit the relay list in the app (📡 relays, with a per-relay
  health probe), from the account gate too, so a circle can run its own relay —
  no rebuild needed.
- **Self-healing sync** — state-vector anti-entropy reconciliation recovers
  arbitrary message loss / offline gaps; a decrypt failure triggers an automatic
  Signal re-handshake.
- **Mnemonic accounts** — a 12-word BIP39 phrase *is* the account (create, restore,
  and **log out** — logout wipes the device, and the phrase is the only way back in).
  No server login. Existing nostr identities can be **imported**: bare `nsec`, raw
  hex, or password-protected NIP-49 `ncryptsec` (an imported account has no phrase;
  its nsec is the recovery secret).
- **Stateless client** — a new device restores every document from the phrase
  alone (encrypted account snapshot on the relay); no other member need be online.
- **Local-first storage** — documents persist in IndexedDB, falling back to
  `localStorage` where IndexedDB is unavailable. A single-writer Web Lock makes a
  second tab of the same account read-only, protecting the Signal ratchet store.
- **Runs from a single file** — `npm run build` emits one self-contained
  `dist/index.html` you can open directly (`file://`), serve, or hand to someone.

See [`ROADMAP.md`](./ROADMAP.md) for positioning, the five design invariants, the
architecture, and the path to a v1.0 usable by a 2–10 person circle, and
[`docs/model.md`](./docs/model.md) for the settled document model.

## Layout

```
app/        current source — Vite + TypeScript workspace
  src/core/ DOM-free protocol logic (account, signal, chains, commit, ydoc, kv, orchestrator)
  src/ui/   thin DOM layer (editor, IndexedDB backend + Web Lock, sanitizer)
  test/     vitest unit + integration tests (run in Node, no browser)
legacy/     the original single-file HTML proof of concept (v0.3–v0.4) + LAN serve scripts
docs/       design notes (model.md — document model; storage.md — storage exploration)
ROADMAP.md  design invariants, architecture, phased plan
```

The `core/` modules have no DOM dependency and are tested directly in Node. The
single-file `index.html` deliverable is produced as a build artifact, not hand-edited.

## Develop

```bash
cd app
npm install
npm test              # vitest: signal round-trip, chains, ydoc CRDT, kv, collab, account
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
