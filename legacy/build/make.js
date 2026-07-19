// Assemble the single-file index.html
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'build/signal-bundle.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const out = page.replace('/*__SIGNAL_BUNDLE__*/', () => bundle).replace('/*__APP_JS__*/', () => app);
fs.writeFileSync(path.join(root, 'index.html'), out);
console.log('index.html written:', (out.length / 1024).toFixed(0), 'KB');
