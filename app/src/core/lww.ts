// Last-write-wins document model (to be replaced by Yjs in P1).
export interface LwwUpdate {
  version: number; ts: number; author: string; content: string; format: 'plain' | 'rich';
}
export interface LwwDocState extends LwwUpdate {}

export function localEdit(doc: LwwDocState, content: string, format: 'plain' | 'rich', author: string, ts: number): LwwUpdate {
  doc.version += 1; doc.ts = ts; doc.author = author; doc.content = content; doc.format = format;
  return { version: doc.version, ts, author, content, format };
}

export function applyRemote(doc: LwwDocState, u: LwwUpdate, sanitize: (h: string) => string): boolean {
  const newer =
    u.version > doc.version ||
    (u.version === doc.version && (u.ts > doc.ts || (u.ts === doc.ts && u.author > doc.author)));
  if (!newer) return false;
  doc.version = u.version; doc.ts = u.ts; doc.author = u.author;
  doc.content = u.format === 'rich' ? sanitize(u.content) : u.content;
  doc.format = u.format;
  return true;
}
