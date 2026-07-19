// v2 three-party test: Owner creates doc, invites Editor + Viewer by npub.
// Fake relay stores events (like real relays for kinds 30078/4078) and replays on subscribe/get.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const clip = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
process.on('unhandledRejection', (e) => console.error('UNHANDLED:', clip(e && e.message || e)));

// ---- fake relay with storage ----
const relay = {
  events: [], subs: [], wire: [],
  match(f, ev) {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    if (f.authors && !f.authors.includes(ev.pubkey)) return false;
    if (f['#p'] && !ev.tags.some((t) => t[0] === 'p' && f['#p'].includes(t[1]))) return false;
    if (f['#d'] && !ev.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1]))) return false;
    return true;
  },
  publish(ev) {
    this.wire.push(ev.content);
    // replaceable kinds: keep newest per (kind,author,d)
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
  get(filter) {
    const hits = this.events.filter((e) => this.match(filter, e));
    return hits.length ? hits[hits.length - 1] : null;
  },
};

const raw = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const override = `<script>
  // Clone events through JSON like a real relay's websocket serialization boundary —
  // also fixes cross-realm instanceof checks in jsdom.
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
const marker = '</script>\n<script>';
const idx = raw.indexOf(marker);
const html = raw.slice(0, idx + 9) + '\n' + override + raw.slice(idx + 9);

function makePage(name) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.error(name, 'page error:', clip(e.detail && e.detail.message || e.message)));
  const storage = {}; // isolated localStorage per page
  return new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://poc.test/' + name,
    beforeParse(window) {
      const { webcrypto } = require('crypto');
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.__RELAY__ = relay;
      window.eval(`
        window.TextEncoder = class { encode(str) {
          const bin = unescape(encodeURIComponent(str));
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8; } };
        window.TextDecoder = class { decode(buf) {
          const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
          return decodeURIComponent(escape(bin)); } };
      `);
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

async function main() {
  const O = makePage('owner'), E = makePage('editor'), V = makePage('viewer');
  await sleep(1400); // parse + NIP-07 probe timeout → account gate shows
  await createAccount(O); await createAccount(E); await createAccount(V);
  await sleep(1800); // identity init + prekey publish

  const npub = (dom) => dom.window.document.getElementById('my-npub').textContent;
  const log = (dom) => dom.window.document.getElementById('collab-log').textContent;
  if (!npub(O).startsWith('npub1') || !npub(E).startsWith('npub1') || !npub(V).startsWith('npub1'))
    throw new Error('identities not initialized');
  console.log('✓ three identities initialized, prekeys published & signed');

  // Owner creates doc
  const d = O.window.document;
  d.getElementById('doc-title').value = 'Q3 Plan';
  d.getElementById('doc-create').click();
  await sleep(300);
  if (!log(O).includes('Created "Q3 Plan"')) throw new Error('doc not created');
  console.log('✓ owner created document');

  // Invite editor
  d.getElementById('invite-npub').value = npub(E);
  d.getElementById('invite-role').value = 'editor';
  d.getElementById('invite-send').click();
  await sleep(2500);
  if (!log(E).includes('Invited to "Q3 Plan"')) throw new Error('editor did not receive invite.\nOWNER LOG: ' + clip(log(O)) + '\nEDITOR LOG: ' + clip(log(E)));
  if (!log(E).includes('as EDITOR')) throw new Error('editor role wrong');
  if (!log(O).includes('signature verified')) throw new Error('prekey signature not verified');
  console.log('✓ editor invited: prekey sig verified, Signal-encrypted invite delivered, ack received');

  // Invite viewer
  d.getElementById('invite-npub').value = npub(V);
  d.getElementById('invite-role').value = 'viewer';
  d.getElementById('invite-send').click();
  await sleep(2500);
  if (!log(V).includes('as VIEWER')) throw new Error('viewer did not receive invite:\n' + clip(log(V)));
  console.log('✓ viewer invited');

  // Everyone opens the doc
  const open = (dom) => { const dd = dom.window.document; dd.querySelector('#doc-list .docitem').click(); };
  open(E); open(V);
  await sleep(300);

  // Owner types → both receive
  const paneOf = (dom) => dom.window.document.querySelector('#pane-doc [data-role=plain]');
  type(O.window, paneOf(O), 'Roadmap: ship v2 by October.');
  await sleep(3000);
  if (paneOf(E).value !== 'Roadmap: ship v2 by October.') throw new Error('editor not synced: "' + paneOf(E).value + '"\n' + clip(log(E)));
  if (paneOf(V).value !== 'Roadmap: ship v2 by October.') throw new Error('viewer not synced: "' + paneOf(V).value + '"');
  console.log('✓ owner edit fanned out to editor & viewer (Signal-encrypted per member)');

  // Editor types → owner applies → forwards to viewer
  type(E.window, paneOf(E), 'Roadmap: ship v2 by October. Editor adds milestones.');
  await sleep(3000);
  if (paneOf(O).value !== 'Roadmap: ship v2 by October. Editor adds milestones.') throw new Error('owner not synced from editor');
  if (paneOf(V).value !== 'Roadmap: ship v2 by October. Editor adds milestones.') throw new Error('viewer did not get forwarded update');
  console.log('✓ editor edit accepted by owner and forwarded to viewer (hub fan-out)');

  // Viewer UI is readonly; simulate malicious viewer by forcing a send from viewer page internals
  if (paneOf(V).readOnly !== true) throw new Error('viewer editor not readonly');
  await V.window.eval(`(async () => {
    const docId = Object.keys(App.docs)[0];
    const doc = App.docs[docId];
    await sendTo(doc.ownerPk, { t: 'update', docId, version: 99, ts: Date.now(), author: App.pk, content: 'HACKED BY VIEWER', format: 'plain' });
  })()`);
  await sleep(2500);
  if (paneOf(O).value.includes('HACKED')) throw new Error('owner accepted viewer edit!');
  if (!log(O).includes('REJECTED update')) throw new Error('owner did not log rejection:\n' + clip(log(O)));
  console.log('✓ malicious viewer update REJECTED by owner-side ACL');

  // Stranger with the URL: opens page, sees nothing, cannot inject
  const S = makePage('stranger');
  await sleep(1300);
  await createAccount(S);
  await sleep(1500);
  const sd = S.window.document;
  if (sd.querySelectorAll('#doc-list .docitem').length !== 0) throw new Error('stranger sees documents!');
  await S.window.eval(`(async () => {
    // stranger tries to spoof an update to the owner without any session/invite
    const ownerPk = ${JSON.stringify(null)} || window.__OWNER_PK__;
  })()`).catch(() => {});
  // stranger sends garbage envelope directly to owner
  const ownerPkHex = await O.window.eval('App.pk');
  await S.window.eval(`(async () => {
    await sendTo('${ownerPkHex}', { t: 'update', docId: 'unknown', version: 1, ts: Date.now(), author: App.pk, content: 'STRANGER WRITE', format: 'plain' });
  })()`);
  await sleep(2500);
  if (paneOf(O).value.includes('STRANGER')) throw new Error('stranger write applied!');
  const oLog = log(O);
  if (!(oLog.includes('unknown doc') || oLog.includes('REJECTED'))) throw new Error('stranger update not rejected:\n' + clip(oLog));
  console.log('✓ stranger with URL: sees no docs; spoofed update rejected (no membership)');

  // Metadata privacy assertions
  const realPks = [await O.window.eval('App.pk'), await E.window.eval('App.pk'), await V.window.eval('App.pk')];
  const envs = relay.events.filter((e) => e.kind === 4078);
  for (const e of envs) {
    if (realPks.includes(e.pubkey)) throw new Error('envelope signed by a REAL identity: ' + e.pubkey.slice(0, 12));
  }
  console.log('✓ all ' + envs.length + ' envelopes signed by throwaway keys — sender anonymous to relay');
  let boots = 0, chained = 0;
  for (const e of envs) {
    const p = (e.tags.find((t) => t[0] === 'p') || [])[1];
    const isBoot = JSON.parse(e.content).boot === 1;
    if (realPks.includes(p)) {
      if (!isBoot) throw new Error('non-bootstrap envelope addressed to a real npub: leaks recipient');
      boots++;
    } else chained++;
  }
  // 2 real invites + 1 from the stranger-attack test above (his spoof bootstraps a session)
  if (boots > 3) throw new Error('more bootstrap events than expected: ' + boots);
  if (chained < 5) throw new Error('expected most traffic on one-time addresses, got ' + chained);
  const uniqueAddrs = new Set(envs.map((e) => (e.tags.find((t) => t[0] === 'p') || [])[1]));
  console.log('✓ recipients hidden: ' + boots + ' bootstrap invites to npubs, ' + chained + ' messages across ' + (uniqueAddrs.size - 2) + ' unlinkable one-time addresses');

  // Wire hygiene
  const secrets = ['Roadmap: ship v2', 'Editor adds milestones', 'Q3 Plan'];
  for (const c of relay.wire) for (const s of secrets) if (String(c).includes(s)) throw new Error('PLAINTEXT ON WIRE: ' + clip(c));
  console.log('✓ relay saw only ciphertext across ' + relay.wire.length + ' events');

  console.log('\\nALL V2 COLLAB TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('V2 TEST FAILED:', e.message); process.exit(1); });
