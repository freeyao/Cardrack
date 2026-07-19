import { describe, it, expect } from 'vitest';
import { applyRemote, localEdit, LwwDocState } from '../src/core/lww';

const fresh = (): LwwDocState => ({ version: 0, ts: 0, author: '', content: '', format: 'plain' });
const id = (h: string) => h;

describe('LWW merge', () => {
  it('applies newer versions, rejects stale', () => {
    const d = fresh();
    expect(applyRemote(d, { version: 2, ts: 10, author: 'a', content: 'x', format: 'plain' }, id)).toBe(true);
    expect(applyRemote(d, { version: 1, ts: 99, author: 'b', content: 'y', format: 'plain' }, id)).toBe(false);
    expect(d.content).toBe('x');
  });
  it('same version: later ts wins; same ts: larger author wins', () => {
    const d = fresh();
    applyRemote(d, { version: 1, ts: 10, author: 'a', content: 'x', format: 'plain' }, id);
    expect(applyRemote(d, { version: 1, ts: 11, author: 'a', content: 'y', format: 'plain' }, id)).toBe(true);
    expect(applyRemote(d, { version: 1, ts: 11, author: 'b', content: 'z', format: 'plain' }, id)).toBe(true);
    expect(applyRemote(d, { version: 1, ts: 11, author: 'a', content: 'w', format: 'plain' }, id)).toBe(false);
  });
  it('localEdit bumps version and returns the update', () => {
    const d = fresh();
    const u = localEdit(d, 'hello', 'plain', 'me', 123);
    expect(u.version).toBe(1);
    expect(d.content).toBe('hello');
  });
  it('rich content passes through the injected sanitizer', () => {
    const d = fresh();
    const called: string[] = [];
    applyRemote(d, { version: 1, ts: 1, author: 'a', content: '<b>x</b><script>evil()</script>', format: 'rich' },
      (h) => { called.push(h); return h.replace(/<script>.*<\/script>/, ''); });
    expect(called.length).toBe(1);
    expect(d.content).toBe('<b>x</b>');
  });
});
