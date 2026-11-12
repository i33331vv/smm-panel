'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const htmlPath = path.join(root, 'public', 'index.html');
const serverPath = path.join(root, 'server.js');
let html = fs.readFileSync(htmlPath, 'utf8');
let server = fs.readFileSync(serverPath, 'utf8');

if (html.includes('/app.csp.js')) {
  throw new Error('CSP migration already applied. Do not run it twice.');
}

const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const config = scripts.find(s => s[2].includes('tailwind.config ='));
const application = scripts.filter(s => !s[1].trim() && s !== config);
const cdn = scripts.filter(s => /src="https:\/\/cdn\.tailwindcss\.com"/.test(s[1]));
const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
if (!config || application.length !== 1 || cdn.length !== 1 || scripts.length !== 3 || styles.length !== 1) {
  throw new Error('Unexpected HTML layout. No files changed.');
}

// Only move known, fixed function calls. Never evaluate HTML as JavaScript.
const listeners = [];
let count = 0;
html = html.replace(/\s(onclick|onchange|oninput|onsubmit)="([^"]*)"/g, (_, attr, code) => {
  if (!/^[A-Za-z_$][\w$]*\((?:'\w+'|\d+|event)?\);?$/.test(code.trim())) {
    throw new Error('Unexpected event handler. No files changed.');
  }
  const id = 'csp-' + (++count);
  listeners.push(
    `document.querySelector('[data-csp-bind="${id}"]').addEventListener('${attr.slice(2)}', function(event) { ${code}; });`
  );
  return ` data-csp-bind="${id}"`;
});

if (count !== 32) throw new Error('Unexpected event count: ' + count);
for (const script of scripts) html = html.replace(script[0], '');
html = html.replace(styles[0][0], '<link rel="stylesheet" href="/styles.csp.css">');
html = html.replace('</body>', '<script src="/app.csp.js" defer></script>\n</body>');
if (/\son[a-z]+\s*=|javascript:/i.test(html)) throw new Error('Inline handler remains.');

const app = application[0][2] + '\n\n// CSP-compatible event bindings\n' + listeners.join('\n') + '\n';
const configText = config[2].replace('tailwind.config =', 'module.exports =') +
  '\nmodule.exports.content = ["./public/index.html", "./public/app.csp.js"];\n';
const css = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' + styles[0][1];

const policy = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "style-src-attr 'none'",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

const policyPattern = /res\.set\(\s*'Content-Security-Policy',[\s\S]*?\n    \);/g;
if ([...server.matchAll(policyPattern)].length !== 1) {
  throw new Error('Expected exactly one CSP header. No files changed.');
}
server = server.replace(policyPattern, () =>
  `res.set('Content-Security-Policy', ${JSON.stringify(policy)});`
);

// Save originals outside the repository before changing anything.
const backup = path.join(path.dirname(root), 'csp-originals-' + Date.now());
fs.mkdirSync(backup);
fs.copyFileSync(htmlPath, path.join(backup, 'index.html'));
fs.copyFileSync(serverPath, path.join(backup, 'server.js'));

fs.writeFileSync(path.join(root, 'public', 'app.csp.js'), app);
fs.writeFileSync(path.join(root, 'csp-tailwind.config.cjs'), configText);
fs.writeFileSync(path.join(root, 'csp-input.css'), css);
fs.writeFileSync(htmlPath, html);
fs.writeFileSync(serverPath, server);
console.log('CSP migration complete. Event handlers: ' + count);
console.log('Original files: ' + backup);
console.log('NEXT: Compile styles.csp.css before deploying.');
