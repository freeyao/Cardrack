// UI wiring: account gate, doc list/view, logs. All protocol logic is in core/.
import { SimplePool } from 'nostr-tools/pool';
import { CollabCore } from '../core/app';
import { CachedKV } from '../core/kv';
import { IdbBackend, acquireWriterLock, legacyEntries } from './idb';
import { EditorPane } from './editor';
import { sanitizeHtml } from './sanitize';

const $ = (id: string) => document.getElementById(id)!;
const LEGACY_PREFIX = 'sc2.'; // localStorage keys used before IndexedDB

// Durable IndexedDB storage behind a synchronous cache. Preloaded (and, for the
// writer tab, seeded from any legacy localStorage) during setup() before boot.
const storage = new CachedKV(new IdbBackend());
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
  storage,
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
let readOnly = false; // true when another tab holds the single-writer lock

// Per-doc real-time toggle (default off = manual Commit). Local-only preference,
// persisted outside the synced account snapshot.
const liveModes: Record<string, boolean> = {};
function loadLiveModes() { try { Object.assign(liveModes, JSON.parse(storage.get('sc2.livemodes') || '{}')); } catch {} }
function saveLiveModes() { storage.set('sc2.livemodes', JSON.stringify(liveModes)); }

let liveTimer: any = null;
function scheduleLive(docId: string, content: string, format: 'plain' | 'rich') {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    void core.localEdit(docId, content, format, baseHead);
    baseHead = core.docs[docId].head;
  }, 400);
}

/** Enable/disable real-time for a doc. Turning it on requires a strong,
 * explicit confirmation of the metadata trade-off; turning it off is immediate. */
function toggleLive(docId: string) {
  if (liveModes[docId]) {
    liveModes[docId] = false; saveLiveModes();
    pane?.setLive(false);
    logRow('info', 'Real-time editing off — edits sync only when you Commit.');
    return;
  }
  showLiveModal(() => {
    liveModes[docId] = true; saveLiveModes();
    pane?.setLive(true);
    logRow('warn', 'Real-time editing ON — your edit timing is now visible to relays.');
  });
}

function showLiveModal(onConfirm: () => void) {
  const modal = $('live-modal');
  const ack = $('live-ack') as HTMLInputElement;
  const confirmBtn = $('live-confirm') as HTMLButtonElement;
  ack.checked = false; confirmBtn.disabled = true;
  modal.classList.remove('hidden');
  const close = () => {
    modal.classList.add('hidden');
    ack.onchange = null; confirmBtn.onclick = null; ($('live-cancel') as HTMLButtonElement).onclick = null;
  };
  ack.onchange = () => { confirmBtn.disabled = !ack.checked; };
  ($('live-cancel') as HTMLButtonElement).onclick = close;
  confirmBtn.onclick = () => { close(); onConfirm(); };
}

function applyReadOnly() {
  if (!readOnly) return;
  $('ro-banner').classList.remove('hidden');
  ($('doc-create') as HTMLButtonElement).disabled = true;
  ($('invite-send') as HTMLButtonElement).disabled = true;
  ($('doc-title') as HTMLInputElement).disabled = true;
}

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
  }, {
    onChange: (content, format) => scheduleLive(docId, content, format),
    onToggleLive: () => toggleLive(docId),
  });
  pane.setContent(d.content, d.format, d.version);
  pane.setReadonly(d.myRole === 'viewer' || readOnly);
  if (d.myRole !== 'viewer' && !readOnly) pane.setLive(!!liveModes[docId]);
  // Owner: click the title to rename it inline (discoverable, no native prompt).
  if (d.ownerPk === core.pk && !readOnly) {
    const titleEl = $('pane-doc').querySelector('.pane-title') as HTMLElement | null;
    if (titleEl) {
      titleEl.style.cursor = 'pointer';
      titleEl.title = 'Click to rename';
      titleEl.addEventListener('click', () => startRename(docId));
    }
  }
  renderConflicts(docId);
}

function showApp() {
  $('acct-gate').classList.add('hidden');
  $('app-main').classList.remove('hidden');
  const npub = core.npub();
  $('my-npub').textContent = npub;
  $('my-npub').addEventListener('click', () => { navigator.clipboard?.writeText(npub).then(() => logRow('info', 'npub copied')); });
  loadLiveModes();
  applyReadOnly();
  const mn = storage.get('sc2.mnemonic');
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
  const id = core.createDoc(title);
  if (!id) return; // read-only tab (or failed) — don't pretend we created anything
  ($('doc-title') as HTMLInputElement).value = '';
  openDoc(id);
  logRow('info', `Created "${title || 'Untitled'}" — invite a collaborator by npub.`);
});
$('doc-rename').addEventListener('click', () => { if (currentDoc) startRename(currentDoc); });

/** Inline-rename the open doc: swap the pane title for an input, save on Enter/blur,
 * cancel on Escape. Owner-only; avoids the fragile native prompt(). */
function startRename(docId: string) {
  const d = core.docs[docId];
  if (!d || d.ownerPk !== core.pk || readOnly) return;
  const titleEl = $('pane-doc').querySelector('.pane-title') as HTMLElement | null;
  if (!titleEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = d.title;
  input.className = 'title-edit';
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return; done = true;
    const nv = input.value.trim();
    input.replaceWith(titleEl);
    if (save && nv && nv !== d.title) { await core.renameDoc(docId, nv); renderDocList(); }
    titleEl.textContent = '📄 ' + (core.docs[docId]?.title ?? d.title);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
  });
  input.addEventListener('blur', () => void finish(true));
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}
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

$('logout').addEventListener('click', async () => {
  if (!confirm(
    'Log out and clear this device?\n\n' +
    'Your documents stay safe (encrypted) on the network. But this device will be ' +
    'wiped, and the ONLY way back in is your 12-word recovery phrase — make sure you ' +
    'have it saved first.'
  )) return;
  const btn = $('logout') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Logging out…';
  core.stop();
  try { await storage.clear(); } catch {}
  location.reload();
});

window.addEventListener('beforeunload', () => core.stop());

/** Acquire the single-writer lock, preload storage (migrating any legacy
 * localStorage on the writer tab), then run the account gate. A second tab of
 * the same account becomes read-only so it cannot corrupt the Signal store. */
async function setup() {
  let isWriter = true;
  try { isWriter = await acquireWriterLock(); } catch { isWriter = true; }
  readOnly = !isWriter;
  storage.setWritable(isWriter);
  core.readOnly = readOnly;
  // Storage init must never block the UI: on file:// or where IndexedDB/localStorage
  // is unavailable the app still boots (in-memory), so the account gate always shows.
  try {
    const seed = isWriter ? legacyEntries(LEGACY_PREFIX) : undefined;
    await storage.open(seed);
  } catch (e: any) {
    logRow('warn', 'storage unavailable — continuing without persistence: ' + e.message);
  }
  if (readOnly) logRow('warn', 'Cardrack is already open in another tab — this tab is read-only.');
  await gate();
}

setup().catch((e) => logRow('warn', 'boot failed: ' + e.message));
