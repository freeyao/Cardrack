// Yjs document primitives — the CRDT layer the P1 model is built on
// (see docs/model.md: ops-as-truth, snapshots-as-representation).
//
// DOM-free and unit-tested in Node. The protocol layer (app.ts) will carry the
// binary updates produced here inside commit envelopes; the UI (Tiptap) will
// later bind directly to the Y.Doc. Content is a single shared Y.Text under the
// key 'content'.
//
// Until Tiptap lands, the plain-textarea UI only yields whole strings. To keep
// real CRDT merge semantics (so two peers editing different regions converge
// instead of clobbering), applyStringEdit() diffs the current text against the
// new string and applies only the minimal changed range as insert/delete ops.
import * as Y from 'yjs';

export const CONTENT_KEY = 'content';

export const newDoc = (): Y.Doc => new Y.Doc();
export const docText = (doc: Y.Doc): string => doc.getText(CONTENT_KEY).toString();

/** Minimal edit range between two strings via common prefix + suffix. */
function diffRange(a: string, b: string): { index: number; remove: number; insert: string } {
  let start = 0;
  const min = Math.min(a.length, b.length);
  while (start < min && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return { index: start, remove: endA - start, insert: b.slice(start, endB) };
}

/** Reconcile the shared text to `next` by applying only the changed range, in a
 * single transaction tagged with `origin`. Preserves CRDT merge for edits that
 * don't overlap another peer's concurrent change. */
export function applyStringEdit(doc: Y.Doc, next: string, origin?: any): void {
  const text = doc.getText(CONTENT_KEY);
  const cur = text.toString();
  if (cur === next) return;
  const { index, remove, insert } = diffRange(cur, next);
  doc.transact(() => {
    if (remove) text.delete(index, remove);
    if (insert) text.insert(index, insert);
  }, origin);
}

/** Full state as a single update (a snapshot; use for onboarding / at-rest). */
export const encodeState = (doc: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(doc);
/** This doc's state vector — hand to a peer so they can compute a minimal delta. */
export const stateVector = (doc: Y.Doc): Uint8Array => Y.encodeStateVector(doc);
/** The update carrying everything this doc has beyond `sinceStateVector` (a delta). */
export const encodeSince = (doc: Y.Doc, sinceStateVector: Uint8Array): Uint8Array =>
  Y.encodeStateAsUpdate(doc, sinceStateVector);
/** Merge an update into the doc (idempotent, order-independent). */
export const applyUpdate = (doc: Y.Doc, update: Uint8Array, origin?: any): void =>
  Y.applyUpdate(doc, update, origin);

/** Byte-exact base64 for putting binary updates inside JSON envelopes. */
export const b64FromBytes = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
export const bytesFromB64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

/** An update carrying no new structs/deletes encodes to 2 bytes ([0,0]); use to
 * skip sending "you're already up to date" deltas during reconciliation. */
export const isEmptyUpdate = (u: Uint8Array): boolean => u.length <= 2;
