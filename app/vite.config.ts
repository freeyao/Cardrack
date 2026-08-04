import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Make the single-file build openable directly over file://.
// Two problems with the default output: (1) it's a <script type="module">, which
// Chrome blocks from a file:// / opaque origin (so no JS runs at all); (2) the
// inlined script lives in <head>. A module script is deferred so that's fine, but
// a classic script there would run before the body exists. So: demote it to a
// classic <script> AND move it to the end of <body> so it runs after the DOM.
// The bundle is fully inlined with no top-level import/export, so this is safe.
function fileProtocolCompat(outDir = 'dist') {
  return {
    name: 'file-protocol-compat',
    apply: 'build' as const,
    closeBundle() {
      const p = resolve(outDir, 'index.html');
      let html = readFileSync(p, 'utf8');
      const m = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/);
      if (m) {
        const block = m[0];
        const classic = block.replace(/^<script\b[^>]*>/, '<script>'); // strip type="module"/crossorigin
        // NB: the bundle is full of '$' — never pass it as a String.replace()
        // replacement string (that interprets $&, $1, …). split/join and a
        // function replacer insert it literally.
        html = html.split(block).join('');                 // remove from <head>
        html = html.replace('</body>', () => `${classic}\n</body>`); // run after the DOM
        writeFileSync(p, html);
      }
    },
  };
}

export default defineConfig({
  plugins: [viteSingleFile(), fileProtocolCompat()],
  build: { target: 'es2020', outDir: 'dist' },
  test: { environment: 'node', globals: false },
});
