// Owner-sequenced commit chain.
//
// Every edit is a commit that names the confirmed commit it was based on
// (`parent`). The document owner is the single linearization point: it accepts
// a commit only if its parent equals the current head (a compare-and-swap, like
// git rejecting a non-fast-forward push). A commit built on stale history is
// rejected and the author is told, rather than silently clobbering someone.
//
// Content is a whole-document snapshot for now (not a diff), so conflict
// *resolution* is manual until CRDT payloads land (P1). Detection and
// preservation, however, work today.
import { sha256 } from '@noble/hashes/sha2.js';
import { hexFromBytes, utf8 } from './util';

export interface Commit {
  id: string;
  parent: string; // id of the commit this was based on ('' = genesis)
  author: string; // pubkey
  ts: number;
  content: string;
  format: 'plain' | 'rich';
}

/** Deterministic content-addressed id. Any tamper changes the id. */
export function commitId(c: Omit<Commit, 'id'>): string {
  const s = [c.parent, c.author, String(c.ts), c.format, c.content].join('\n');
  return hexFromBytes(sha256(utf8(s)));
}

export function makeCommit(
  parent: string,
  author: string,
  ts: number,
  content: string,
  format: 'plain' | 'rich'
): Commit {
  const base = { parent, author, ts, content, format };
  return { id: commitId(base), ...base };
}

/** Verify a received commit's id matches its contents. */
export function validCommit(c: Commit): boolean {
  return !!c && typeof c.id === 'string' && commitId(c) === c.id;
}
