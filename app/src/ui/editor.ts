// Editor pane: plain textarea + basic rich contenteditable, debounced change events.
import { sanitizeHtml } from './sanitize';

export class EditorPane {
  root: HTMLElement;
  format: 'plain' | 'rich' = 'plain';
  readonly = false;
  private suppress = false;
  private plainEl: HTMLTextAreaElement;
  private richEl: HTMLElement;
  private verEl: HTMLElement;
  private roleBadge: HTMLElement;

  constructor(root: HTMLElement, title: string, private onEdit: (content: string, format: 'plain' | 'rich') => void) {
    this.root = root;
    root.innerHTML = `
      <div class="pane-head">
        <span class="pane-title">${title}</span>
        <span class="badge" data-role="role-badge">editor</span>
        <span class="badge v" data-role="ver">v0</span>
      </div>
      <div class="toolbar" data-role="toolbar">
        <button data-cmd="format">Rich text: off</button>
        <span class="rich-btns" style="display:none">
          <button data-cmd="bold"><b>B</b></button>
          <button data-cmd="italic"><i>I</i></button>
          <button data-cmd="underline"><u>U</u></button>
          <button data-cmd="h2">H</button>
        </span>
      </div>
      <textarea class="editor-plain" data-role="plain" placeholder="Start typing — every change leaves this pane Signal-encrypted."></textarea>
      <div class="editor-rich" data-role="rich" contenteditable="true" style="display:none"></div>`;
    this.plainEl = root.querySelector('[data-role=plain]')!;
    this.richEl = root.querySelector('[data-role=rich]')!;
    this.verEl = root.querySelector('[data-role=ver]')!;
    this.roleBadge = root.querySelector('[data-role=role-badge]')!;

    let t: any;
    const emit = () => {
      clearTimeout(t);
      t = setTimeout(() => { if (!this.suppress && !this.readonly) this.onEdit(this.getContent(), this.format); }, 400);
    };
    this.plainEl.addEventListener('input', emit);
    this.richEl.addEventListener('input', emit);
    root.querySelector('.toolbar')!.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('button');
      if (!btn || this.readonly) return;
      e.preventDefault();
      const cmd = (btn as HTMLElement).dataset.cmd;
      if (cmd === 'format') {
        this.setFormat(this.format === 'plain' ? 'rich' : 'plain', true);
        this.onEdit(this.getContent(), this.format);
      } else if (cmd === 'h2') { document.execCommand('formatBlock', false, 'h2'); emit(); }
      else { document.execCommand(cmd!, false); emit(); }
    });
  }

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
  setContent(content: string, format: 'plain' | 'rich', version: number) {
    this.suppress = true;
    this.setFormat(format, false);
    if (format === 'rich') this.richEl.innerHTML = sanitizeHtml(content);
    else this.plainEl.value = content;
    this.verEl.textContent = 'v' + version;
    this.suppress = false;
  }
  setVersion(v: number) { this.verEl.textContent = 'v' + v; }
  setReadonly(ro: boolean) {
    this.readonly = ro;
    this.plainEl.readOnly = ro;
    (this.richEl as HTMLElement).contentEditable = ro ? 'false' : 'true';
    this.roleBadge.textContent = ro ? 'viewer' : 'editor';
    this.roleBadge.classList.toggle('viewer', ro);
    this.root.classList.toggle('readonly', ro);
  }
}
