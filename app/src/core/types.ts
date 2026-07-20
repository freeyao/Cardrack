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
  // Confirmed head state (what the owner has linearized):
  content: string; format: 'plain' | 'rich';
  version: number; ts: number; author: string;
  head: string;          // id of the confirmed head commit ('' = empty genesis)
  history?: Commit[];    // accepted commits, newest last (capped)
  conflicts?: Commit[];  // local commits the owner rejected as stale, kept for manual resolution
}
