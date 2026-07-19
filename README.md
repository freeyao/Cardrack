# Cardrack

End-to-end encrypted document collaboration for small circles. An **independent**
web app: the Signal protocol (X3DH + Double Ratchet) provides the crypto, Nostr
relays are dumb transport, and any browser can run it. No accounts live on any server.

> **The name.** In Poe's *The Purloined Letter*, the stolen letter is never
> hidden — it hangs in plain sight in a pasteboard **card-rack** on the mantel,
> turned inside out and re-sealed, so the police who dismantle the room miss it
> entirely. That is exactly this app's privacy model: ciphertext is posted openly
> on public relays, from throwaway keys to one-time addresses, visible to everyone
> and legible to no one. Concealment by defeating the observer's assumptions, not
> by hiding the object.

> Status: working proof of concept (v0.4), mid-refactor into a maintainable
> TypeScript workspace. Not audited. Do not use for anything that actually needs
> to stay secret yet.

## What works today

- **Real Signal protocol in the browser** — X3DH key agreement + Double Ratchet,
  via `@privacyresearch/libsignal-protocol-typescript`.
- **Owner-centric sharing** — create a document, invite collaborators by their
  public key with an `editor` / `viewer` role. Their signed prekey bundle is
  verified before the handshake; the ACL is enforced on the receiving side.
- **Metadata-private transport** — every message is sent from a throwaway key to a
  one-time mailbox address derived from a secret shared inside the encrypted
  invite. Relays see only ciphertext between unlinkable addresses.
- **Mnemonic accounts** — a 12-word BIP39 phrase *is* the account. No server login.
- **Stateless client** — a new device restores every document from the phrase
  alone (encrypted account snapshot on the relay); no other member need be online.
- **Session self-healing** — a decrypt failure triggers an automatic re-handshake.

See [`ROADMAP.md`](./ROADMAP.md) for positioning, the five design invariants, the
architecture, and the path to a v1.0 usable by a 2–10 person circle.

## Layout

```
app/        current source — Vite + TypeScript workspace
  src/core/ DOM-free protocol logic (account, signal, chains, lww, orchestrator)
  src/ui/   thin DOM layer that only calls core APIs
  test/     vitest unit + integration tests (run in Node, no browser)
legacy/     the original single-file HTML proof of concept (v0.3–v0.4) + LAN serve scripts
ROADMAP.md  design invariants, architecture, phased plan
```

The `core/` modules have no DOM dependency and are tested directly in Node. The
single-file `index.html` deliverable is produced as a build artifact, not hand-edited.

## Develop

```bash
cd app
npm install
npm test              # vitest: crypto round-trip, chains, lww, collab, account, impersonation
npm run dev           # local dev server
npm run build         # single-file dist/index.html (vite-plugin-singlefile)
```

## Security note

This is a research prototype. The cryptographic core is real, but the system has
known gaps documented in `ROADMAP.md` (prekey reuse, unsigned membership,
owner-online requirement, single-writer multi-tab hazard, metadata at the invite
bootstrap). It has not been reviewed by anyone. Treat it as a design exploration.
