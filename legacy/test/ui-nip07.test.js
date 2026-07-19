// NIP-07 integration: a mocked window.nostr (like Keychat's injected bridge) must be
// used as the identity — npub from the bridge, prekey event signed via signEvent.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const clip = (s) => String(s).replace(/\s+/g, ' ').slice(0, 200);

const relay = { events: [], subs: [] };
const raw = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const override = `<script>
  // mock Keychat bridge BEFORE app boots: fixed key held "outside" the page
  (() => {
    const sk = window.NostrLib.generateSecretKey();
    const pk = window.NostrLib.getPublicKey(sk);
    window.__MOCK_PK__ = pk;
    let signCount = 0;
    window.nostr = {
      getPublicKey: async () => pk,
      signEvent: async (ev) => { signCount++; window.__SIGN_COUNT__ = signCount; return window.NostrLib.finalizeEvent(ev, sk); },
    };
  })();
  window.NostrLib.SimplePool = class FakePool {
    publish(relays, ev) { window.__RELAY__.events.push(JSON.parse(JSON.stringify(ev))); return [Promise.resolve()]; }
    subscribe(relays, filter, handlers) { return { close() {} }; }
    async get() { return null; }
  };
</script>`;
const idx = raw.indexOf('</script>\n<script>');
const html = raw.slice(0, idx + 9) + '\n' + override + raw.slice(idx + 9);

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.error('page error:', clip(e.detail && e.detail.message || e.message)));
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://poc.test/nip07',
  beforeParse(window) {
    const { webcrypto } = require('crypto');
    Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
    window.__RELAY__ = relay;
    window.eval(`window.TextEncoder = class { encode(s){const b=unescape(encodeURIComponent(s));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;} };
      window.TextDecoder = class { decode(x){const u=x instanceof Uint8Array?x:new Uint8Array(x);let b='';for(let i=0;i<u.length;i++)b+=String.fromCharCode(u[i]);return decodeURIComponent(escape(b));} };`);
  },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(1500);
  const w = dom.window, d = w.document;
  const mockPk = w.__MOCK_PK__;
  const shownNpub = d.getElementById('my-npub').textContent;
  const expected = await w.eval(`window.NostrLib.nip19.npubEncode('${mockPk}')`);
  if (shownNpub !== expected) throw new Error('app did not adopt bridge identity: ' + shownNpub);
  console.log('✓ app adopted the external (Keychat/NIP-07) identity');

  const pkEvents = relay.events.filter((e) => e.kind === 30078);
  if (pkEvents.length !== 1) throw new Error('expected 1 prekey event, got ' + pkEvents.length);
  if (pkEvents[0].pubkey !== mockPk) throw new Error('prekey event not signed by bridge identity');
  const ok = await w.eval(`window.NostrLib.verifyEvent(${JSON.stringify(JSON.stringify(pkEvents[0]))} && JSON.parse(${JSON.stringify(JSON.stringify(pkEvents[0]))}))`);
  if (!ok) throw new Error('prekey event signature invalid');
  console.log('✓ prekey bundle signed via window.nostr.signEvent and verifies');

  if (w.__SIGN_COUNT__ !== 1) throw new Error('expected exactly 1 signEvent call, got ' + w.__SIGN_COUNT__);
  console.log('✓ external signer asked to sign exactly once (only the prekey announcement)');

  const log = d.getElementById('collab-log').textContent;
  if (!log.includes('external identity via window.nostr')) throw new Error('missing ext-identity log');
  console.log('\nALL NIP-07 TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('NIP07 TEST FAILED:', clip(e.message)); process.exit(1); });
