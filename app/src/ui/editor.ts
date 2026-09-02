// Rich-text editor pane: Tiptap (ProseMirror) bound to a LOCAL DRAFT replica
// of the document's Y.Doc. Typing never touches the shared doc — Commit hands
// the draft's delta to core.commitUpdate (manual mode), or a debounced timer
// does (opt-in live mode). Incoming changes are absorbed into the draft as CRDT
// merges, so remote edits land under your cursor instead of clobbering your
// draft — the old "document moved on, your commit will conflict" warning is
// obsolete by construction.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import * as Y from 'yjs';
import { RICH_KEY, bytesFromB64, b64FromBytes } from '../core/ydoc';

export interface PaneHooks {
  /** b64 full shared state (seeds the draft). */
  exportState: () => string;
  /** b64 shared state vector (what the draft diffs against). */
  sharedVector: () => string;
  /** b64 delta of shared state beyond a given vector (absorbed into the draft). */
  exportSince: (svB64: string) => string;
  /** Commit a draft delta (b64) to the shared doc. */
  onCommit: (deltaB64: string) => void;
  onToggleLive?: () => void;
}

const LIVE_DEBOUNCE_MS = 400; // unchanged from the textarea era (user-agreed)

export class EditorPane {
  live = false;
  readonly = false;
  private draft: Y.Doc;
  private editor: Editor;
  private commitBtn: HTMLButtonElement;
  private verEl: HTMLElement;
  private roleBadge: HTMLElement;
  private noteEl: HTMLElement;
  private liveTimer: any = null;
  private destroyed = false;

  constructor(private root: HTMLElement, title: string, private hooks: PaneHooks) {
    root.innerHTML = `
      <div class="pane-head">
        <span class="pane-title">${title}</span>
        <span class="badge" data-role="role-badge">editor</span>
        <span class="badge v" data-role="ver">v0</span>
        <span class="ed-note" data-role="note"></span>
      </div>
      <div class="toolbar" data-role="toolbar">
        <button data-cmd="bold" title="bold (Ctrl+B)"><b>B</b></button>
        <button data-cmd="italic" title="italic (Ctrl+I)"><i>I</i></button>
        <button data-cmd="strike" title="strikethrough"><s>S</s></button>
        <button data-cmd="h1" title="heading 1">H1</button>
        <button data-cmd="h2" title="heading 2">H2</button>
        <button data-cmd="bullet" title="bullet list">•≡</button>
        <button data-cmd="ordered" title="numbered list">1.</button>
        <button data-cmd="task" title="task list">☑</button>
        <button data-cmd="quote" title="quote">❝</button>
        <button data-cmd="codeblock" title="code block">{ }</button>
        <button data-cmd="undo" title="undo (Ctrl+Z)">↶</button>
        <button data-cmd="redo" title="redo (Ctrl+Shift+Z)">↷</button>
        <button data-role="live-toggle" class="live-btn" title="How your edits reach collaborators">⚡ Live: off</button>
        <button data-role="commit" class="commit-btn" disabled>Commit ⌘↵</button>
      </div>
      <div class="editor-rich" data-role="editor"></div>`;
    this.commitBtn = root.querySelector('[data-role=commit]')!;
    this.verEl = root.querySelector('[data-role=ver]')!;
    this.roleBadge = root.querySelector('[data-role=role-badge]')!;
    this.noteEl = root.querySelector('[data-role=note]')!;

    // Local draft replica, seeded from the shared doc.
    this.draft = new Y.Doc();
    const seed = hooks.exportState();
    if (seed) Y.applyUpdate(this.draft, bytesFromB64(seed));
    // Dirty tracking is event-driven: any draft change NOT caused by absorb()
    // means the user edited. (Byte-comparing deltas misfires: a Yjs update's
    // delete set rides along even when both replicas are level, so a
    // deletion-containing draft never looks "clean" by length.)
    this.draft.on('update', (_u: Uint8Array, origin: any) => {
      if (this.destroyed || origin === 'absorb') return;
      this.dirty = true;
      this.renderDirty();
      if (this.live && !this.readonly) {
        clearTimeout(this.liveTimer);
        this.liveTimer = setTimeout(() => this.commit(), LIVE_DEBOUNCE_MS);
      }
    });

    this.editor = new Editor({
      element: root.querySelector('[data-role=editor]')!,
      extensions: [
        StarterKit.configure({ undoRedo: false }), // Collaboration brings y-undo
        Collaboration.configure({ fragment: this.draft.getXmlFragment(RICH_KEY) }),
        TaskList,
        TaskItem.configure({ nested: true }),
      ],
      onSelectionUpdate: () => this.refreshToolbar(),
      onTransaction: () => this.refreshToolbar(),
    });

    (globalThis as any).__pane = this; // debug handle (harmless; latest pane wins)

    root.querySelector('[data-role=toolbar]')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('button');
      if (!btn || this.readonly) return;
      const cmd = (btn as HTMLElement).dataset.cmd;
      if (!cmd) return; // commit / live-toggle have their own handlers
      e.preventDefault();
      const c = this.editor.chain().focus();
      if (cmd === 'bold') c.toggleBold().run();
      else if (cmd === 'italic') c.toggleItalic().run();
      else if (cmd === 'strike') c.toggleStrike().run();
      else if (cmd === 'h1') c.toggleHeading({ level: 1 }).run();
      else if (cmd === 'h2') c.toggleHeading({ level: 2 }).run();
      else if (cmd === 'bullet') c.toggleBulletList().run();
      else if (cmd === 'ordered') c.toggleOrderedList().run();
      else if (cmd === 'task') c.toggleTaskList().run();
      else if (cmd === 'quote') c.toggleBlockquote().run();
      else if (cmd === 'codeblock') c.toggleCodeBlock().run();
      else if (cmd === 'undo') c.undo().run();
      else if (cmd === 'redo') c.redo().run();
    });
    this.commitBtn.addEventListener('click', () => this.commit());
    (root.querySelector('[data-role=live-toggle]') as HTMLElement).addEventListener('click', () => this.hooks.onToggleLive?.());
    this.editor.view.dom.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.commit(); }
    });
  }

  /** Everything the draft has beyond the shared doc (b64) — the commit payload.
   * Includes the delete set, so structure removals travel too. */
  private pendingDelta(): string {
    return b64FromBytes(Y.encodeStateAsUpdate(this.draft, bytesFromB64(this.hooks.sharedVector())));
  }

  private commit() {
    if (this.readonly || this.destroyed || !this.dirty) return;
    this.hooks.onCommit(this.pendingDelta());
    this.dirty = false; // edits made after this instant re-dirty via the update event
    this.renderDirty();
  }

  /** Merge everything the shared doc has beyond the draft into the draft.
   * Pure CRDT merge — safe while the user is mid-edit, cursor preserved. */
  absorb() {
    if (this.destroyed) return;
    const bytes = bytesFromB64(this.hooks.exportSince(b64FromBytes(Y.encodeStateVector(this.draft))));
    if (bytes.length > 2) Y.applyUpdate(this.draft, bytes, 'absorb');
  }

  private dirty = false;
  private renderDirty() {
    this.commitBtn.disabled = !this.dirty || this.readonly;
    this.commitBtn.textContent = this.dirty ? 'Commit ⌘↵ •' : 'Commit ⌘↵';
  }
  isDirty() { return this.dirty; }

  private refreshToolbar() {
    // Editor callbacks fire during `new Editor(...)`, before `this.editor` is
    // assigned — guard or the constructor dies on `undefined.isActive`.
    if (this.destroyed || !this.editor) return;
    const map: [string, () => boolean][] = [
      ['bold', () => this.editor.isActive('bold')],
      ['italic', () => this.editor.isActive('italic')],
      ['strike', () => this.editor.isActive('strike')],
      ['h1', () => this.editor.isActive('heading', { level: 1 })],
      ['h2', () => this.editor.isActive('heading', { level: 2 })],
      ['bullet', () => this.editor.isActive('bulletList')],
      ['ordered', () => this.editor.isActive('orderedList')],
      ['task', () => this.editor.isActive('taskList')],
      ['quote', () => this.editor.isActive('blockquote')],
      ['codeblock', () => this.editor.isActive('codeBlock')],
    ];
    for (const [cmd, active] of map)
      this.root.querySelector(`[data-cmd=${cmd}]`)?.classList.toggle('is-active', active());
  }

  setVersion(v: number) { this.verEl.textContent = 'v' + v; }
  setTitle(title: string) { (this.root.querySelector('.pane-title') as HTMLElement).textContent = title; }
  private setNote(t: string) { this.noteEl.textContent = t; }

  setReadonly(ro: boolean) {
    this.readonly = ro;
    this.editor.setEditable(!ro);
    this.commitBtn.style.display = ro || this.live ? 'none' : '';
    (this.root.querySelector('[data-role=live-toggle]') as HTMLElement).style.display = ro ? 'none' : '';
    (this.root.querySelector('[data-role=toolbar]') as HTMLElement).classList.toggle('readonly', ro);
    this.roleBadge.textContent = ro ? 'viewer' : 'editor';
    this.roleBadge.classList.toggle('viewer', ro);
    this.root.classList.toggle('readonly', ro);
  }

  /** Real-time mode: edits stream out as you type (Commit is hidden). */
  setLive(live: boolean) {
    this.live = live;
    const btn = this.root.querySelector('[data-role=live-toggle]') as HTMLElement;
    btn.textContent = '⚡ Live: ' + (live ? 'on' : 'off');
    btn.classList.toggle('on', live);
    this.commitBtn.style.display = live || this.readonly ? 'none' : '';
    this.setNote(live ? 'real-time — edits sync as you type' : '');
    if (live) this.commit(); // flush any pending draft when switching on
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.liveTimer);
    try { this.editor.destroy(); } catch {}
    try { this.draft.destroy(); } catch {}
  }
}
