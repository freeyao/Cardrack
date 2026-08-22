export interface Pool {
  publish(relays: string[], ev: any): Promise<any>[];
  subscribe(relays: string[], filter: any, handlers: { onevent: (ev: any) => void }): { close(): void };
  get(relays: string[], filter: any): Promise<any | null>;
}
export interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
}
export interface Hooks {
  log(kind: 'info' | 'ok' | 'warn' | 'wire', text: string): void;
  docsChanged(): void;
  docApplied(docId: string): void;
  status(text: string): void;
  conflictsChanged?(docId: string): void;
}
import type { Commit } from './commit';

export interface DocState {
  title: string; ownerPk: string; myRole: 'owner' | 'editor' | 'viewer';
  members: { pk: string; role: 'editor' | 'viewer' }[];
  // Materialized view of the CRDT (owner-sequenced). `content` is the fold of the
  // Yjs doc; `ystate` is its serialized state (base64) — the durable source of truth.
  content: string; format: 'plain' | 'rich';
  version: number; ts: number; author: string;
  ystate?: string;       // base64 of the Yjs doc state (encodeStateAsUpdate)
  // Doc-key epochs (owner-minted, rotated on membership change). Old epochs are
  // kept so earlier snapshots stay readable. String keys: JSON round-trips.
  epoch?: number;                    // current epoch (1-based); absent on legacy docs
  dockeys?: Record<string, string>;  // epoch (as string) → key (base64, 32 random bytes)
  head: string;          // legacy commit-chain field, retained for compatibility ('' now)
  history?: Commit[];    // retained; unused by the Yjs path
  conflicts?: Commit[];  // retained for UI compatibility; the CRDT path leaves this empty
}
