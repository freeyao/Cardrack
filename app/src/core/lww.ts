// Last-write-wins document model (to be replaced by Yjs in P1).
export interface LwwUpdate {
  version: number; ts: number; author: string; content: string; format: 'plain' | 'rich';
}
export interface LwwDocState extends LwwUpdate {}

export function localEdit(doc: LwwDocState, content: string, format: 'plain' | 'rich', author: string, ts: number): LwwUpdate {
  doc.version += 1; doc.ts = ts; doc.author = author; doc.content = content; doc.format = format;
  return { version: doc.version, ts, author, content, format };
}

/** Total order over LWW versions: compare by version, then ts, then author.
 * Returns >0 if a is newer than b, <0 if older, 0 if identical. */
export function cmp(
  a: { version: number; ts: number; author: string },
  b: { version: number; ts: number; author: string }
): number {
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return 0;
}

export function applyRemote(doc: LwwDocState, u: LwwUpdate, sanitize: (h: string) => string): boolean {
  if (cmp(u, doc) <= 0) return false;
  doc.version = u.version; doc.ts = u.ts; doc.author = u.author;
  doc.content = u.format === 'rich' ? sanitize(u.content) : u.content;
  doc.format = u.format;
  return true;
}
