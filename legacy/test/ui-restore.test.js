// Device-switch test: E collaborates with O, then "loses the device".
// A fresh page restores E's account from the 12-word mnemonic alone:
// docs come back from the encrypted relay snapshot, and editing works again
// after automatic session re-establishment (X3DH self-heal).
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const clip = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
process.on('unhandledRejection', (e) => console.error('UNHANDLED:', clip(e && e.message || e)));

const relay = {
  events: [], subs: [],
  match(f, ev) {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    if (f.authors && !f.authors.includes(ev.pubkey)) return false;
    if (f['#p'] && !ev.tags.some((t) => t[0] === 'p' && f['#p'].includes(t[1]))) return false;
    if (f['#d'] && !ev.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1]))) return false;
    return true;
  },
  publish(ev) {
    if (ev.kind >= 30000 && ev.kind < 40000) {
      const d = (ev.tags.find((t) => t[0] === 'd') || [])[1];
      this.events = this.events.filter((e) => !(e.kind === ev.kind && e.pubkey === ev.pubkey && (e.tags.find((t) => t[0] === 'd') || [])[1] === d));
    }
    this.events.push(ev);
    setTimeout(() => {
      for (const s of this.subs) if (!s.closed && this.match(s.filter, ev)) { try { s.onevent(ev); } catch (e) { console.error('onevent:', clip(e.message)); } }
    }, 25);
  },
  subscribe(filter, onevent) {
    const sub = { filter, onevent, closed: false };
    this.subs.push(sub);
    setTimeout(() => { if (!sub.closed) for (const ev of this.events.slice()) if (this.match(filter, ev)) onevent(ev); }, 25);
    return sub;
  },
  get(filter) { const h = this.events.filter((e) => this.match(filter, e)); return h.length ? h[h.length - 1] : null; },
};

const raw = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const override = `<script>
  window.NostrLib.SimplePool = class FakePool {
    publish(relays, ev) { window.__RELAY__.publish(JSON.parse(JSON.stringify(ev))); return [Promise.resolve()]; }
    subscribe(relays, filter, handlers) {
      const sub = window.__RELAY__.subscribe(filter, (ev) => { if (!sub.closed) handlers.onevent(JSON.parse(JSON.stringify(ev))); });
      return { close() { sub.closed = true; } };
    }
    async get(relays, filter) {
      await new Promise(r => setTimeout(r, 20));
      const ev = window.__RELAY__.get(filter);
      return ev ? JSON.parse(JSON.stringify(ev)) : null;
    }
  };
</script>`;
const idx = raw.indexOf('</script>\n<script>');
const html = raw.slice(0, idx + 9) + '\n' + override + raw.slice(idx + 9);

function makePage(name) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.error(name, 'page error:', clip(e.detail && e.detail.message || e.message)));
  return new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://poc.test/' + name,
    beforeParse(window) {
      const { webcrypto } = require('crypto');
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.__RELAY__ = relay;
      window.eval(`window.TextEncoder = class { encode(s){const b=unescape(encodeURIComponent(s));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;} };
        window.TextDecoder = class { decode(x){const u=x instanceof Uint8Array?x:new Uint8Array(x);let b='';for(let i=0;i<u.length;i++)b+=String.fromCharCode(u[i]);return b.split('').map(c=>c).join('') && decodeURIComponent(escape(b));} };`);
    },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const type = (w, el, text) => { el.value = text; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
async function createAccount(dom) {
  const d = dom.window.document;
  d.getElementById('acct-create').click();
  await sleep(120);
  const cb = d.getElementById('acct-saved');
  cb.checked = true;
  cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  d.getElementById('acct-continue').click();
}
const paneOf = (dom) => dom.window.document.querySelector('#pane-doc [data-role=plain]');
const log = (dom) => dom.window.document.getElementById('collab-log').textContent;

async function main() {
  // --- phase 1: O and E collaborate ---
  const O = makePage('owner'), E = makePage('editor');
  await sleep(1400);
  await createAccount(O); await createAccount(E);
  await sleep(1800);

  const d = O.window.document;
  d.getElementById('doc-title').value = 'Spec';
  d.getElementById('doc-create').click();
  await sleep(300);
  d.getElementById('invite-npub').value = E.window.document.getElementById('my-npub').textContent;
  d.getElementById('invite-send').click();
  await sleep(2500);
  if (!log(E).includes('Invited to "Spec"')) throw new Error('invite failed: ' + clip(log(E)));

  E.window.document.querySelector('#doc-list .docitem').click();
  await sleep(200);
  type(O.window, paneOf(O), 'Shared draft v1.');
  await sleep(2500);
  if (paneOf(E).value !== 'Shared draft v1.') throw new Error('E not synced');
  console.log('✓ phase 1: O and E collaborating');

  // capture E's mnemonic, wait for E's debounced snapshot to publish
  const mnemonic = await E.window.eval('App.mnemonic');
  if (!mnemonic || mnemonic.split(' ').length !== 12) throw new Error('no mnemonic: ' + mnemonic);
  await sleep(3500);
  const ePk = await E.window.eval('App.pk');
  const snaps = relay.events.filter((e) => e.kind === 30079 && e.pubkey === ePk);
  if (snaps.length !== 1) throw new Error('expected 1 snapshot for E, got ' + snaps.length);
  console.log('✓ E published encrypted account snapshot (kind 30079, replaceable)');

  // --- phase 2: E's device dies; new device N restores from mnemonic ---
  const N = makePage('newdevice');
  await sleep(1400);
  const nd = N.window.document;
  nd.getElementById('acct-restore-words').value = mnemonic;
  nd.getElementById('acct-restore').click();
  await sleep(3000);

  if (await N.window.eval('App.pk') !== ePk) throw new Error('restored pk mismatch');
  if (!log(N).includes('Account restored')) throw new Error('restore log missing: ' + clip(log(N)));
  const items = nd.querySelectorAll('#doc-list .docitem');
  if (items.length !== 1) throw new Error('doc list not restored');
  items[0].click();
  await sleep(300);
  if (paneOf(N).value !== 'Shared draft v1.') throw new Error('doc content not restored: "' + paneOf(N).value + '"');
  console.log('✓ new device restored account + document from mnemonic alone (no member online needed)');

  // --- phase 3: N edits; O receives after automatic session re-establishment ---
  type(N.window, paneOf(N), 'Shared draft v1. Edited from the new device.');
  await sleep(4000);
  if (paneOf(O).value !== 'Shared draft v1. Edited from the new device.')
    throw new Error('O did not receive new-device edit.\nO log: ' + clip(log(O)) + '\nN log: ' + clip(log(N)));
  console.log('✓ new device edit reached owner (fresh X3DH over restored chain)');

  // O replies; N receives on the promoted session
  type(O.window, paneOf(O), 'Shared draft v1. Edited from the new device. Owner ack.');
  await sleep(3000);
  if (paneOf(N).value !== 'Shared draft v1. Edited from the new device. Owner ack.')
    throw new Error('N did not receive owner reply: "' + paneOf(N).value + '"\nN log: ' + clip(log(N)));
  console.log('✓ owner reply decrypts on new device (session fully converged)');

  console.log('\nALL DEVICE-RESTORE TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('RESTORE TEST FAILED:', clip(e.message || e)); process.exit(1); });
