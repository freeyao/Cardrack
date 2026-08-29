// Yjs document primitives — the CRDT layer the P1 model is built on
// (see docs/model.md: ops-as-truth, snapshots-as-representation).
//
// DOM-free and unit-tested in Node. The protocol layer (app.ts) carries the
// binary updates produced here inside commit envelopes, and never inspects
// them. The canonical content is a rich Y.XmlFragment under 'rich' (what
// Tiptap/ProseMirror binds to); the older flat Y.Text under 'content' remains
// readable for docs created before rich text, and migrateTextToRich() lifts it.
//
// applyStringEdit() is the programmatic/test shim: it edits a single-paragraph
// document at character granularity (real CRDT merge semantics preserved), so
// the DOM-free tests and headless peers can edit without a ProseMirror view.
import * as Y from 'yjs';

export const CONTENT_KEY = 'content'; // legacy flat text (pre-rich docs)
export const RICH_KEY = 'rich';       // canonical rich fragment (Tiptap binds here)

export const newDoc = (): Y.Doc => new Y.Doc();
export const richFragment = (doc: Y.Doc): Y.XmlFragment => doc.getXmlFragment(RICH_KEY);

/** Plain text of one Y.XmlText: its insert ops, formatting ignored. */
function xmlTextPlain(t: Y.XmlText): string {
  return (t.toDelta() as { insert?: unknown }[]).map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
}
/** Recursive plain text of an element's inline content. */
function elementPlain(el: Y.XmlElement | Y.XmlFragment): string {
  let out = '';
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i);
    if (c instanceof Y.XmlText) out += xmlTextPlain(c);
    else if (c instanceof Y.XmlElement) out += elementPlain(c);
  }
  return out;
}

/** Materialized plain text: top-level blocks joined with newlines. Falls back
 * to the legacy flat Y.Text for docs that haven't been migrated yet. */
export function docText(doc: Y.Doc): string {
  const frag = richFragment(doc);
  if (frag.length > 0) {
    const blocks: string[] = [];
    for (let i = 0; i < frag.length; i++) {
      const c = frag.get(i);
      blocks.push(c instanceof Y.XmlText ? xmlTextPlain(c) : elementPlain(c as Y.XmlElement));
    }
    return blocks.join('\n');
  }
  return doc.getText(CONTENT_KEY).toString();
}

/** Minimal edit range between two strings via common prefix + suffix. */
function diffRange(a: string, b: string): { index: number; remove: number; insert: string } {
  let start = 0;
  const min = Math.min(a.length, b.length);
  while (start < min && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return { index: start, remove: endA - start, insert: b.slice(start, endB) };
}

/** The shim's editable text node: a fragment holding exactly one paragraph with
 * one Y.XmlText. Returns null when the doc has richer structure. */
function shimText(frag: Y.XmlFragment): Y.XmlText | null {
  if (frag.length !== 1) return null;
  const p = frag.get(0);
  if (!(p instanceof Y.XmlElement) || p.nodeName !== 'paragraph' || p.length !== 1) return null;
  const t = p.get(0);
  return t instanceof Y.XmlText ? t : null;
}

/** Reconcile the document's text to `next` at character granularity (CRDT merge
 * preserved for non-overlapping concurrent edits). Operates on the single-
 * paragraph shim shape; a Tiptap-structured document is replaced wholesale —
 * the UI never calls this (it commits real deltas), only tests/headless peers do. */
export function applyStringEdit(doc: Y.Doc, next: string, origin?: any): void {
  const frag = richFragment(doc);
  doc.transact(() => {
    let t = shimText(frag);
    if (!t && frag.length === 0) {
      const p = new Y.XmlElement('paragraph');
      t = new Y.XmlText();
      p.insert(0, [t]);
      frag.insert(0, [p]);
    }
    if (t) {
      const cur = xmlTextPlain(t);
      if (cur === next) return;
      const { index, remove, insert } = diffRange(cur, next);
      if (remove) t.delete(index, remove);
      if (insert) t.insert(index, insert);
    } else {
      // structured doc: replace content (programmatic writers lose structure)
      frag.delete(0, frag.length);
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(next)]);
      frag.insert(0, [p]);
    }
  }, origin);
}

/** One-time lift of a legacy flat-text doc into the rich fragment: one
 * paragraph per line. Returns true if it migrated (caller materializes/saves;
 * anti-entropy carries the delta to peers). Owner-side only, by convention. */
export function migrateTextToRich(doc: Y.Doc): boolean {
  const frag = richFragment(doc);
  const legacy = doc.getText(CONTENT_KEY).toString();
  if (frag.length > 0 || !legacy) return false;
  doc.transact(() => {
    const paras = legacy.split('\n').map((line) => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(line)]);
      return p;
    });
    frag.insert(0, paras);
  });
  return true;
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
