# Signal-Collab PoC v2

Proof of concept: **owner-centric, end-to-end encrypted document collaboration** using the real Signal protocol (X3DH + Double Ratchet), identity-bound invitations over Nostr relays, testable in Keychat's mini app browser.

One deliverable file: **`index.html`** (~490 KB, static, no server).

## The flow (v2 — corrected model)

There are **no rooms and no public rendezvous**. Like Google Docs sharing, but E2EE:

1. **Create** — you open the page; a persistent identity is created (nostr key + Signal identity, stored locally). Your signed **prekey bundle** is published to relays as a replaceable event (kind 30078) — a decentralized version of Signal's prekey server.
2. **Share** — you create a document and invite a collaborator **by their npub**, choosing their role (editor / viewer). The app fetches *their* prekey bundle, **verifies its nostr signature** (keys provably belong to that npub), runs X3DH, and sends the invite as Signal ciphertext addressed only to them (kind 4078, p-tagged).
3. **Collaborate** — every edit is a Signal-encrypted update. The owner is the hub: accepts updates from editors, rejects viewers and non-members, fans out to everyone else.

**What an outsider with the URL gets: nothing.** The page shows an empty app; there is no room to join; unsolicited updates are rejected for lack of membership (verified by test).

## Security properties (tested)

| Property | Mechanism | Test |
|---|---|---|
| Confidentiality on the wire | Double Ratchet per recipient; relays see only ciphertext | ✓ 14-event wire scan |
| Key authenticity | Prekey bundles signed by the npub (nostr event sig verified before X3DH) | ✓ |
| Access control | Owner-side ACL; viewer/non-member updates rejected at the receiving side | ✓ malicious-viewer & stranger tests |
| Async invites | Signal PreKey messages allow offline invitees; envelope events are relay-stored | ✓ |
| Persistence | nostr key + Signal store + docs survive reload (localStorage) | — |

## Files

```
index.html            ← the whole app
src/page.html         ← page shell (HTML/CSS)
src/app.js            ← application logic (readable)
build/entry.js        ← bundle entry (libsignal + nostr-tools)
build/store.js        ← SignalProtocolStore + serialization
build/make.js         ← assembles index.html
test/signal-roundtrip.test.js  ← X3DH + ratchet round trip
test/ui-demo.test.js           ← headless demo-mode test
test/ui-collab.test.js         ← 3-party owner/editor/viewer + attack scenarios
```

## Run tests

```bash
cd build && npm install && cd ..
NODE_PATH=build/node_modules node test/signal-roundtrip.test.js
NODE_PATH=build/node_modules node test/ui-demo.test.js
NODE_PATH=build/node_modules node test/ui-collab.test.js
```

Rebuild after editing `src/`: `node build/make.js`

## Test in Keychat

Host `index.html` anywhere static; open the URL in Keychat's browser on two devices. Copy the npub shown on device B, invite it from device A.

## Known limitations / next steps

- **Editor**: plain + basic rich text, last-write-wins. Upgrade path: Tiptap (ProseMirror) + Yjs updates inside the same Signal envelopes (see secsync for prior art).
- **npub is page-local**: the nostr key is generated in-page, not the user's Keychat identity. Options: NIP-07 signer if Keychat injects one, or a Keychat `window.signal` bridge (feature request).
- **One-time prekeys are reused** (replaceable event, no server-side consumption) — acceptable for PoC; weakens forward secrecy for session-setup messages only.
- **Star topology** (owner hub): owner must be online to relay editor→viewer updates; hub-less N-party needs MLS (Keychat already ships MLS internally).
- **Metadata**: relays see who talks to whom (p-tags) and timing. Mitigations: NIP-17-style gift wrap, private relays.
- Membership records are not signed/portable yet; a production ACL needs owner-signed membership (cf. Encrypted Spaces whitepaper).

## Prior art

- **Encrypted Spaces** (Trevor Perrin et al., research preview 2026) — verifiable E2EE collaboration over untrusted servers.
- **secsync** — E2EE Yjs CRDT sync, Signal-inspired ratchet.
- **CryptPad, Serenity Notes** — earlier E2EE editors.
