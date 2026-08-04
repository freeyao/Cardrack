import { describe, it, expect } from 'vitest';
import {
  newDoc, docText, applyStringEdit, encodeState, encodeSince, stateVector, applyUpdate,
} from '../src/core/ydoc';

describe('ydoc CRDT primitives', () => {
  it('applyStringEdit materializes the given string', () => {
    const d = newDoc();
    applyStringEdit(d, 'hello world');
    expect(docText(d)).toBe('hello world');
    applyStringEdit(d, 'hello brave world');
    expect(docText(d)).toBe('hello brave world');
  });

  it('two peers editing different regions auto-converge (no clobber)', () => {
    // Common base, replicated to B via a full-state update.
    const A = newDoc();
    applyStringEdit(A, 'The quick brown fox');
    const B = newDoc();
    applyUpdate(B, encodeState(A));
    expect(docText(B)).toBe('The quick brown fox');

    // Concurrent, non-overlapping edits from whole-string commits.
    applyStringEdit(A, 'The very quick brown fox'); // insert "very "
    applyStringEdit(B, 'The quick brown fox jumps'); // append " jumps"

    // Exchange snapshots both ways.
    const ua = encodeState(A);
    const ub = encodeState(B);
    applyUpdate(A, ub);
    applyUpdate(B, ua);

    // Both edits survive; both peers agree.
    expect(docText(A)).toBe('The very quick brown fox jumps');
    expect(docText(B)).toBe(docText(A));
  });

  it('convergence is order-independent', () => {
    const base = newDoc();
    applyStringEdit(base, 'alpha');
    const seed = encodeState(base);

    const A = newDoc(); applyUpdate(A, seed);
    const B = newDoc(); applyUpdate(B, seed);
    applyStringEdit(A, 'alpha-A');
    applyStringEdit(B, 'B-alpha');
    const ua = encodeState(A), ub = encodeState(B);

    // A third replica applies the two updates in the opposite order.
    const X = newDoc(); applyUpdate(X, seed); applyUpdate(X, ua); applyUpdate(X, ub);
    const Yr = newDoc(); applyUpdate(Yr, seed); applyUpdate(Yr, ub); applyUpdate(Yr, ua);
    expect(docText(X)).toBe(docText(Yr));
  });

  it('encodeSince produces a minimal delta a peer can apply', () => {
    const A = newDoc();
    applyStringEdit(A, 'first line');
    const B = newDoc();
    applyUpdate(B, encodeState(A)); // B caught up

    const svB = stateVector(B);
    applyStringEdit(A, 'first line + more'); // A moves ahead
    const delta = encodeSince(A, svB);       // only what B is missing

    // The delta is smaller than a full snapshot, and brings B to parity.
    expect(delta.length).toBeLessThan(encodeState(A).length);
    applyUpdate(B, delta);
    expect(docText(B)).toBe('first line + more');
    expect(docText(B)).toBe(docText(A));
  });

  it('applying the same update twice is idempotent', () => {
    const A = newDoc();
    applyStringEdit(A, 'idempotent');
    const u = encodeState(A);
    const B = newDoc();
    applyUpdate(B, u);
    applyUpdate(B, u); // no double-apply corruption
    expect(docText(B)).toBe('idempotent');
  });
});
