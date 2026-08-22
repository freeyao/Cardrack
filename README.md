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

## What works today, by module

The project is organized into nine modules — see [`docs/modules.md`](./docs/modules.md)
for the full map, the file seams, and what's next in each.

**1 · Identity** — a 12-word BIP39 phrase *is* the account: create it with a
backup ceremony, restore from the phrase alone, reveal it later, log out with a
device wipe. Existing nostr identities import too: bare `nsec`, raw hex, or
password-protected NIP-49 `ncryptsec` (imported accounts have no phrase — the
nsec itself is the recovery secret).

**2 · Files** — create and rename documents (click the title to edit it inline;
the owner's rename propagates to members), a doc list, and an encrypted doc
index so a new device rediscovers everything.

**3 · Editor** — plain and basic rich text. Manual **Commit** by default:
nothing leaves your device until you say so. Per-document opt-in real-time
sync, gated behind a confirmation that spells out the metadata trade-off
(relays can see edit timing, never the text).

**4 · Conclave** — owner-centric sharing: invite by npub with an `editor` /
`viewer` role. The inviter's signed prekey bundle is verified before the
handshake; the ACL is enforced on the receiving side.

**5 · Sync** — documents are Yjs CRDTs: concurrent edits **auto-merge** instead
of clobbering, with the owner sequencing and fanning out changes. State-vector
anti-entropy recovers arbitrary message loss and offline gaps; a decrypt
failure triggers an automatic re-handshake.

**6 · Keys** — real Signal protocol in the browser (X3DH + Double Ratchet via
libsignal). Per-document key epochs: owner-minted random keys, rotation with
encrypted distribution — groundwork for the decided key-custody model (the
service never holds doc keys; see [`docs/model.md`](./docs/model.md)).

**7 · Transport** — metadata-private by construction: every message is sent
from a throwaway key to a one-time mailbox address derived from a secret shared
inside the encrypted invite. Relays see only ciphertext between unlinkable
addresses. The relay list is user-configurable, with per-relay health probes.

**8 · Storage** — local-first: IndexedDB behind a synchronous cache (with
localStorage fallback where IndexedDB is unavailable), one-time migration, and
a single-writer Web Lock — a second tab of the same account is read-only,
protecting the Signal ratchet store.

**9 · Distribution** — the whole app is one self-contained `dist/index.html`:
open it directly over `file://`, serve it anywhere, or download an offline copy
from the deployed page itself. GitHub Pages deploys `main` on every push, gated
on the test suite.

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
