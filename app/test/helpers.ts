// Shared test doubles: in-memory relay with storage semantics + KV storage.
import type { Pool, KV, Hooks } from '../src/core/types';

export class FakeRelay {
  events: any[] = [];
  subs: { filter: any; onevent: (ev: any) => void; closed: boolean }[] = [];
  wire: string[] = [];
  /** When set, a matching publish is silently dropped (simulates relay/network loss). */
  dropFn: ((ev: any) => boolean) | null = null;

  match(f: any, ev: any) {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    if (f.authors && !f.authors.includes(ev.pubkey)) return false;
    if (f['#p'] && !ev.tags.some((t: any) => t[0] === 'p' && f['#p'].includes(t[1]))) return false;
    if (f['#d'] && !ev.tags.some((t: any) => t[0] === 'd' && f['#d'].includes(t[1]))) return false;
    return true;
  }
  publish(ev: any) {
    this.wire.push(ev.content);
    if (this.dropFn && this.dropFn(ev)) return; // lost in transit: not stored, not delivered
    if (ev.kind >= 30000 && ev.kind < 40000) {
      const d = (ev.tags.find((t: any) => t[0] === 'd') || [])[1];
      this.events = this.events.filter(
        (e) => !(e.kind === ev.kind && e.pubkey === ev.pubkey && (e.tags.find((t: any) => t[0] === 'd') || [])[1] === d)
      );
    }
    this.events.push(ev);
    setTimeout(() => {
      for (const s of this.subs) if (!s.closed && this.match(s.filter, ev)) s.onevent(clone(ev));
    }, 5);
  }
  poolFor(): Pool {
    const relay = this;
    return {
      publish(_r: string[], ev: any) { relay.publish(clone(ev)); return [Promise.resolve()]; },
      subscribe(_r: string[], filter: any, handlers: { onevent: (ev: any) => void }) {
        const sub = { filter, onevent: handlers.onevent, closed: false };
        relay.subs.push(sub);
        setTimeout(() => { if (!sub.closed) for (const ev of relay.events.slice()) if (relay.match(filter, ev)) handlers.onevent(clone(ev)); }, 5);
        return { close() { sub.closed = true; } };
      },
      async get(_r: string[], filter: any) {
        await sleep(5);
        const hits = relay.events.filter((e) => relay.match(filter, e));
        return hits.length ? clone(hits[hits.length - 1]) : null;
      },
    };
  }
}
const clone = (x: any) => JSON.parse(JSON.stringify(x));

export class MemKV implements KV {
  m = new Map<string, string>();
  get(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  set(k: string, v: string) { this.m.set(k, v); }
}

export function collectHooks(): Hooks & { lines: string[]; text(): string } {
  const lines: string[] = [];
  return {
    lines,
    text: () => lines.join('\n'),
    log: (k, t) => lines.push(`[${k}] ${t}`),
    docsChanged: () => {},
    docApplied: () => {},
    status: () => {},
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
