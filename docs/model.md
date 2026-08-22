# Document model — ops-as-truth, owner-hub, fork-as-exit

Status: **decided** (design), not yet implemented. This is the target the
Tiptap+Yjs work in ROADMAP P1 builds toward. It replaces the current
whole-snapshot commit chain (`commit.ts`) and its manual conflict resolution.

## The core choice: operations are the truth, snapshots are the representation

A snapshot *is* a serialized fold of operations, so "versioned binary" and
"sequence of operations" are the same bytes at two granularities. What matters is
which is canonical:

- **Live editing → operations (CRDT / Yjs).** State = fold of the op set.
  Concurrent and offline edits merge deterministically. This is what buys
  automatic convergence, undo/redo, presence, and per-author attribution.
- **At rest / on the wire → snapshot.** A Yjs binary update (the folded state)
  encrypted under the current doc-key **epoch**, content-addressed, stored via the
  StorageAdapter. This is the clean crypto boundary: a removed member holding
  epoch N's key can decrypt snapshot N and nothing after (invariant #2).

Ops give convergence; snapshots give durability, onboarding, and forward secrecy.
They are not opposed — the snapshot is the fold of the ops.

## Retention — two tiers, both bounded

Keeping old ops means keeping decryptable old content, which is in tension with
forward secrecy. So bound retention and align it to epoch boundaries:

1. **Recent fine-grained ops (bounded op log)** — a short window (e.g. last N
   updates, or "within the current epoch"). Purpose: live merge, local undo/redo,
   short-range rollback. Older ops are compacted into a snapshot and dropped.
2. **Checkpoint snapshots (bounded ring)** — a few immutable, content-addressed,
   epoch-keyed snapshots plus named checkpoints. Purpose: rollback targets and
   new-member onboarding. This — not the raw op log — is what humans roll back to.

On epoch rotation (membership change): materialize current state into a snapshot
under the new key, drop the prior epoch's op log.

## Rollback is a *forward* operation

In a CRDT you cannot move state backwards without breaking convergence.
"Restore to checkpoint X" = compute the diff (Yjs `snapshot`+`diff`) and apply it
as a **new forward operation** that makes the current state look like X.

## Owner-hub authority

The owner holds the canonical Yjs doc and is the ordering + snapshot anchor
(invariant #4, generalized from "linearizer" to "sequencing relay + snapshotter").
With CRDT auto-merge, the owner no longer needs to *reject* stale commits — so the
`commit-rejected` → manual-conflict machinery retires. Rollback consensus is
owner-adjudicated: a member *requests* a rollback to checkpoint X; the owner
materializes X as the new head and broadcasts it; members adopt it.

## Non-owner sovereignty: fork-as-exit (not veto)

A non-owner can never force their version onto `main`, but is never forced to lose
it either. The guaranteed protection is an **exit right**, not a veto — vetoes
deadlock, forks never do (cf. git: no non-fast-forward push to a protected branch,
but you may always keep your commits and fork).

**Fork semantics:**
- A fork is a **new document** (new docId), genesis = a snapshot of the divergence
  point, seeded from the forker's local Yjs state.
- The genesis records **which commit id it forked from** (provenance — content
  addressing gives this nearly for free), so shared history is recoverable.
- The **forker becomes owner** of the fork, with its own ACL and its own random
  epoch key (invariant #2). Original members do **not** auto-join the fork.
- Forking is **unilateral** — no original-owner permission. This is the root of the
  exit right.
- A fork is a normal document that initially has exactly one member (the forker);
  they invite others if/when they want.

## Fork is the last resort, not the default

Fragmentation risk ("if everyone forks, nothing gets collaborated") is handled by
making convergence the path of least resistance, not by limiting the right. A
gradient of reconciliation, cheapest first, fork last:

1. **Auto-merge (default, invisible)** — CRDT merges concurrent edits; no prompt.
   Covers the vast majority of cases. *This* is the main anti-fragmentation force:
   the CRDT dissolves the mechanical conflicts that the snapshot model forced.
2. **Re-apply on latest (rebase)** — one click for rare structural conflicts; stays
   on `main`.
3. **Rollback to checkpoint (owner-adjudicated)** — shared-line "undo".
4. **Fork** — deliberate button, only for genuine semantic divergence.

Members **auto-follow** the owner's head by default, so you never fork by accident;
`main` stays the canonical line others join. And because a fork keeps its
provenance, it is not a dead end — it may later send a **merge-request** back to
`main` (owner-adjudicated, like a PR), which keeps people willing to diverge
temporarily and converge later.

## Protocol delta (from today)

- Commit envelope: carries a **Yjs binary update** (delta), not full text.
- Retires: `commit-rejected` and the manual conflict-preservation flow.
- Adds (all user-initiated): `checkpoint` (name a checkpoint), `rollback`
  (request/execute an owner-adjudicated rollback), `fork` (unilateral),
  optional `merge-request` (fork → main, owner-adjudicated).
- `DocState`: gains serialized Yjs state, a bounded op/checkpoint ring, epoch tag,
  and a fork-provenance field (parent docId + forked-from commit id).

## Key custody & recovery (decided 2026-08-22)

Direction decided with the owner. The current implementation — "balanced by
construction": doc keys ride inside the NIP-44 account snapshot, so the mnemonic
alone recovers everything — intentionally **stays as-is** until the storage work
lands. This section is the target model.

- **Ciphertext may live online; keys may not.** Content at rest is sealed under
  the per-epoch doc key (`dockey.ts` sealDoc). The service (relays / storage)
  holds ciphertext and signaling only — never a doc key in any form the account
  key alone can open.
- **The account snapshot carries metadata only**: doc index, address chains,
  membership. No content, no doc keys. The mnemonic alone restores identity and
  the circle map — not documents.
- **Recovery is two-factor**: the account key (identity — locates ciphertext,
  receives envelopes) PLUS doc-key material the service never held. That material
  comes from: local storage, re-delivery by any circle member over Signal
  (`key-envelope`), or a user-exported encrypted key container (see
  [storage.md](storage.md) — the container idea is the portable local half).
- **Loss is real, and accepted**: a solo member who loses every local copy and
  never exported a container has lost the document — even though its ciphertext
  sits online. No third-party copy exists that the user doesn't know about. The
  UX must say this out loud: a key-export ceremony, sibling of the mnemonic one.
- **Circles degrade gracefully**: any surviving member restores both keys and
  content to a rejoining device (key-envelope + anti-entropy sync). "Everyone
  lost it" is the only true loss.
- **"Balanced" becomes an explicit opt-in per circle** (invariant #1's exception
  turned into a real policy switch): wrap doc keys to members' account pks online
  for phrase-only recovery — convenience vs. blast radius, chosen knowingly.
- Epoch mechanics folded in: an invite carries the **current epoch key only** (an
  owner-side "also share history" option may come later); the NIP-44
  recovery-path wiring ships together with this policy work, not before.
- Note: this narrows invariant #3's "everything lives on the network as
  ciphertext". The *stateless client* property shrinks to identity + membership;
  content statelessness becomes the user's own storage choice.
