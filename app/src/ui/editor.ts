// Editor pane: plain textarea + basic rich contenteditable.
// Edits stay LOCAL until the user clicks Commit — nothing is sent per keystroke.
import { sanitizeHtml } from './sanitize';

export class EditorPane {
  root: HTMLElement;
  format: 'plain' | 'rich' = 'plain';
  readonly = false;
  private suppress = false;
  private dirty = false;
  private plainEl: HTMLTextAreaElement;
  private richEl: HTMLElement;
  private verEl: HTMLElement;
  private roleBadge: HTMLElement;
  private commitBtn: HTMLButtonElement;
  private noteEl: HTMLElement;

  live = false;

  constructor(
    root: HTMLElement,
    title: string,
    private onCommit: (content: string, format: 'plain' | 'rich') => void,
    private opts: { onChange?: (content: string, format: 'plain' | 'rich') => void; onToggleLive?: () => void } = {}
  ) {
    this.root = root;
    root.innerHTML = `
      <div class="pane-head">
        <span class="pane-title">${title}</span>
        <span class="badge" data-role="role-badge">editor</span>
        <span class="badge v" data-role="ver">v0</span>
        <span class="ed-note" data-role="note"></span>
      </div>
      <div class="toolbar" data-role="toolbar">
        <button data-cmd="format">Rich text: off</button>
        <span class="rich-btns" style="display:none">
          <button data-cmd="bold"><b>B</b></button>
          <button data-cmd="italic"><i>I</i></button>
          <button data-cmd="underline"><u>U</u></button>
          <button data-cmd="h2">H</button>
        </span>
        <button data-role="live-toggle" class="live-btn" title="How your edits reach collaborators">⚡ Live: off</button>
        <button data-role="commit" class="commit-btn" disabled>Commit ⌘↵</button>
      </div>
      <textarea class="editor-plain" data-role="plain" placeholder="Type freely — nothing is shared until you Commit."></textarea>
      <div class="editor-rich" data-role="rich" contenteditable="true" style="display:none"></div>`;
    this.plainEl = root.querySelector('[data-role=plain]')!;
    this.richEl = root.querySelector('[data-role=rich]')!;
    this.verEl = root.querySelector('[data-role=ver]')!;
    this.roleBadge = root.querySelector('[data-role=role-badge]')!;
    this.commitBtn = root.querySelector('[data-role=commit]')!;
    this.noteEl = root.querySelector('[data-role=note]')!;

    const onInput = () => {
      if (this.suppress || this.readonly) return;
      this.setDirty(true);
      // in real-time mode every edit is streamed out; main.ts debounces it
      if (this.live) this.opts.onChange?.(this.getContent(), this.format);
    };
    this.plainEl.addEventListener('input', onInput);
    this.richEl.addEventListener('input', onInput);
    const keyCommit = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.commit(); } };
    this.plainEl.addEventListener('keydown', keyCommit);
    this.richEl.addEventListener('keydown', keyCommit as any);
    this.commitBtn.addEventListener('click', () => this.commit());
    (root.querySelector('[data-role=live-toggle]') as HTMLElement).addEventListener('click', () => this.opts.onToggleLive?.());

    root.querySelector('.toolbar')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('button');
      if (!btn || this.readonly) return;
      const cmd = (btn as HTMLElement).dataset.cmd;
      if (!cmd) return; // the commit button has no data-cmd
      e.preventDefault();
      if (cmd === 'format') { this.setFormat(this.format === 'plain' ? 'rich' : 'plain', true); this.setDirty(true); }
      else if (cmd === 'h2') { document.execCommand('formatBlock', false, 'h2'); this.setDirty(true); }
      else { document.execCommand(cmd, false); this.setDirty(true); }
    });
  }

  private commit() {
    if (this.readonly || !this.dirty) return;
    this.onCommit(this.getContent(), this.format);
    this.setDirty(false);
    this.setNote('');
  }
  private setDirty(d: boolean) {
    this.dirty = d;
    this.commitBtn.disabled = !d || this.readonly;
    this.commitBtn.textContent = d ? 'Commit ⌘↵ •' : 'Commit ⌘↵';
  }
  isDirty() { return this.dirty; }

  setFormat(fmt: 'plain' | 'rich', convert: boolean) {
    if (fmt === this.format) return;
    this.format = fmt;
    (this.root.querySelector('[data-cmd=format]') as HTMLElement).textContent = 'Rich text: ' + (fmt === 'rich' ? 'on' : 'off');
    (this.root.querySelector('.rich-btns') as HTMLElement).style.display = fmt === 'rich' ? '' : 'none';
    if (fmt === 'rich') {
      if (convert) this.richEl.innerHTML = sanitizeHtml(this.plainEl.value.replace(/\n/g, '<br>'));
      this.plainEl.style.display = 'none'; this.richEl.style.display = '';
    } else {
      if (convert) this.plainEl.value = (this.richEl as HTMLElement).innerText;
      this.plainEl.style.display = ''; this.richEl.style.display = 'none';
    }
  }
  getContent() { return this.format === 'rich' ? sanitizeHtml(this.richEl.innerHTML) : this.plainEl.value; }

  /** Load confirmed content and clear the dirty flag. */
  setContent(content: string, format: 'plain' | 'rich', version: number) {
    this.suppress = true;
    this.setFormat(format, false);
    if (format === 'rich') this.richEl.innerHTML = sanitizeHtml(content);
    else this.plainEl.value = content;
    this.verEl.textContent = 'v' + version;
    this.suppress = false;
    this.setDirty(false);
    this.setNote('');
  }
  setVersion(v: number) { this.verEl.textContent = 'v' + v; }
  /** A newer confirmed version exists while the user has an unsaved draft. */
  noteBehind(v: number) { this.setNote(`updated to v${v} elsewhere — your draft is preserved; committing will conflict`); }
  private setNote(t: string) { this.noteEl.textContent = t; }

  setReadonly(ro: boolean) {
    this.readonly = ro;
    this.plainEl.readOnly = ro;
    (this.richEl as HTMLElement).contentEditable = ro ? 'false' : 'true';
    this.commitBtn.style.display = ro || this.live ? 'none' : '';
    (this.root.querySelector('[data-role=live-toggle]') as HTMLElement).style.display = ro ? 'none' : '';
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
  }
}
