// UI wiring: account gate, doc list/view, logs. All protocol logic is in core/.
import { SimplePool } from 'nostr-tools/pool';
import { CollabCore } from '../core/app';
import { EditorPane } from './editor';
import { sanitizeHtml } from './sanitize';

const $ = (id: string) => document.getElementById(id)!;
const short = (s: string, n = 18) => (s.length > n ? s.slice(0, n) + '…' : s);

function logRow(kind: string, text: string) {
  const el = $('collab-log');
  const row = document.createElement('div');
  row.className = 'log-row ' + kind;
  row.innerHTML = `<span class="log-time">${new Date().toTimeString().slice(0, 8)}</span> <span class="log-kind">[${kind}]</span> ${text}`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 250) el.removeChild(el.firstChild!);
}

const core = new CollabCore({
  pool: new SimplePool() as any,
  storage: { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) },
  sanitize: sanitizeHtml,
  hooks: {
    log: logRow,
    docsChanged: () => renderDocList(),
    docApplied: (docId) => {
      if (docId !== currentDoc || !pane) return;
      const d = core.docs[docId];
      if (pane.isDirty()) {
        // don't clobber an unsaved draft; note that the head moved
        pane.setVersion(d.version);
        pane.noteBehind(d.version);
      } else {
        pane.setContent(d.content, d.format, d.version);
        baseHead = d.head;
      }
      renderConflicts(docId);
    },
    status: (t) => { $('prekey-status').textContent = t; },
    conflictsChanged: (docId) => { if (docId === currentDoc) renderConflicts(docId); },
  },
});

let currentDoc: string | null = null;
let pane: EditorPane | null = null;
let baseHead = ''; // the head the editor's content was written against

/* ---------- views ---------- */
function renderDocList() {
  const el = $('doc-list');
  el.innerHTML = '';
  for (const [id, d] of Object.entries(core.docs)) {
    const div = document.createElement('div');
    div.className = 'docitem';
    const who = d.ownerPk === core.pk ? 'owner' : `${d.myRole} · by ${short(d.ownerPk, 12)}`;
    div.innerHTML = `<span class="t">📄 ${d.title}</span><span class="meta">${who} · v${d.version}</span>`;
    div.addEventListener('click', () => openDoc(id));
    el.appendChild(div);
  }
}

function renderMembers(docId: string) {
  const d = core.docs[docId];
  const rows = [`<div class="m"><span class="who">${short(core.npubOf(d.ownerPk), 24)}</span><span class="badge">owner${d.ownerPk === core.pk ? ' (me)' : ''}</span></div>`];
  for (const m of d.members)
    rows.push(`<div class="m"><span class="who">${short(core.npubOf(m.pk), 24)}</span><span class="badge ${m.role === 'viewer' ? 'viewer' : ''}">${m.role}</span></div>`);
  $('member-list').innerHTML = rows.join('');
}

function renderConflicts(docId: string) {
  const box = $('conflict-box');
  const conflicts = core.conflictsOf(docId);
  if (!conflicts.length) { box.innerHTML = ''; return; }
  box.innerHTML =
    `<div class="conflict-hd">⚠ ${conflicts.length} unmerged edit${conflicts.length > 1 ? 's' : ''} — the document changed while you were editing. Your text was kept:</div>` +
    conflicts.map((c) =>
      `<div class="conflict-row"><pre>${escapeHtml(c.content).slice(0, 400)}</pre>` +
      `<span><button data-act="keep" data-id="${c.id}">Re-apply on latest</button>` +
      `<button data-act="drop" data-id="${c.id}">Discard</button></span></div>`
    ).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const id = (b as HTMLElement).dataset.id!;
    if ((b as HTMLElement).dataset.act === 'keep') void core.resolveConflict(docId, id);
    else core.discardConflict(docId, id);
  }));
}
function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

function openDoc(docId: string) {
  const d = core.docs[docId];
  if (!d) return;
  currentDoc = docId;
  $('doc-view').classList.remove('hidden');
  ($('invite-npub').parentElement as HTMLElement).style.display = d.ownerPk === core.pk ? '' : 'none';
  renderMembers(docId);
  $('pane-doc').innerHTML = '';
  baseHead = d.head;
  pane = new EditorPane($('pane-doc'), '📄 ' + d.title, (content, format) => {
    void core.localEdit(docId, content, format, baseHead);
    // owner advances immediately; editor keeps its base until the owner confirms
    baseHead = core.docs[docId].head;
  });
  pane.setContent(d.content, d.format, d.version);
  pane.setReadonly(d.myRole === 'viewer');
  renderConflicts(docId);
}

function showApp() {
  $('acct-gate').classList.add('hidden');
  $('app-main').classList.remove('hidden');
  const npub = core.npub();
  $('my-npub').textContent = npub;
  $('my-npub').addEventListener('click', () => { navigator.clipboard?.writeText(npub).then(() => logRow('info', 'npub copied')); });
  const mn = localStorage.getItem('sc2.mnemonic');
  if (mn) {
    const sm = $('show-mnemonic');
    sm.style.display = '';
    sm.addEventListener('click', () => { if (confirm('Reveal your 12-word recovery phrase on screen?')) alert(mn); });
  }
  renderDocList();
}

/* ---------- account gate ---------- */
async function gate() {
  if (core.hasSavedAccount()) { await core.startWithSaved(); showApp(); return; }
  $('acct-gate').classList.remove('hidden');
  let words = '';
  $('acct-create').addEventListener('click', () => {
    words = core.newMnemonic();
    $('acct-mnemonic').textContent = words;
    $('acct-mnemonic-box').classList.remove('hidden');
    $('acct-create-box').classList.add('hidden');
  });
  $('acct-saved').addEventListener('change', (e) => { ($('acct-continue') as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked; });
  $('acct-continue').addEventListener('click', async () => {
    if (!words) return;
    await core.startWithNewAccount(words);
    showApp();
  });
  $('acct-restore').addEventListener('click', async () => {
    const w = ($('acct-restore-words') as HTMLTextAreaElement).value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!CollabCore.validateMnemonic(w)) { $('acct-err').textContent = 'That is not a valid 12-word recovery phrase.'; return; }
    await core.startWithMnemonic(w);
    showApp();
  });
}

/* ---------- actions ---------- */
$('doc-create').addEventListener('click', () => {
  const title = ($('doc-title') as HTMLInputElement).value.trim();
  ($('doc-title') as HTMLInputElement).value = '';
  openDoc(core.createDoc(title));
  logRow('info', `Created "${title || 'Untitled'}" — invite a collaborator by npub.`);
});
$('invite-send').addEventListener('click', async () => {
  if (!currentDoc) return;
  const input = $('invite-npub') as HTMLInputElement;
  const role = ($('invite-role') as HTMLSelectElement).value as 'editor' | 'viewer';
  try {
    await core.invite(currentDoc, input.value, role);
    input.value = '';
    renderMembers(currentDoc);
  } catch (e: any) { logRow('warn', 'invite failed: ' + e.message); }
});
$('doc-close').addEventListener('click', () => { $('doc-view').classList.add('hidden'); currentDoc = null; renderDocList(); });

window.addEventListener('beforeunload', () => core.stop());

gate().catch((e) => logRow('warn', 'boot failed: ' + e.message));
