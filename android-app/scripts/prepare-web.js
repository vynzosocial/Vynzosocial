// Copies the website (read-only) into android-app/www and injects the public Supabase key,
// mirroring the root build without touching the website's files or dist/.
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const www = path.join(appRoot, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(repoRoot, 'frontend'), www, { recursive: true });
require(path.join(repoRoot, 'scripts', 'copy-live-face-assets'))(www);
fs.rmSync(path.join(www, '_headers'), { force: true });

const homePath = path.join(www, 'index.html');
const home = fs.readFileSync(homePath, 'utf8');
if (!home.includes('<html lang="en" dir="ltr">')) {
  throw new Error('Could not mark the Android landing page.');
}
fs.writeFileSync(homePath, home.replace('<html lang="en" dir="ltr">', '<html class="vynzo-android-app" lang="en" dir="ltr">'));

const wrangler = fs.readFileSync(path.join(repoRoot, 'wrangler.jsonc'), 'utf8');
const key = (process.env.VYNZO_SUPABASE_PUBLISHABLE_KEY
  || (wrangler.match(/"VYNZO_SUPABASE_PUBLISHABLE_KEY"\s*:\s*"([^"]+)"/) || [])[1] || '').trim();
if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) {
  throw new Error('A Supabase publishable key (sb_publishable_...) was not found.');
}

const configPath = path.join(www, 'js', 'supabase-config.js');
const config = fs.readFileSync(configPath, 'utf8');
const placeholder = "'__VYNZO_SUPABASE_PUBLISHABLE_KEY__'";
if (!config.includes(placeholder)) throw new Error('Supabase key placeholder not found.');
fs.writeFileSync(configPath, config.replace(placeholder, JSON.stringify(key)));

// Lets the native updater know the page loaded (enables automatic rollback of bad updates).
fs.writeFileSync(path.join(www, 'ota-ready.js'),
  "(function(){function r(){try{var p=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.Ota;if(p)p.notifyReady();}catch(e){}}" +
  "if(document.readyState==='complete')r();else window.addEventListener('load',r);})();\n");
const prepareHtml = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) prepareHtml(full);
    else if (entry.name.endsWith('.html')) {
      let html = fs.readFileSync(full, 'utf8');
      if (!/<\/head>/i.test(html) || !/<\/body>/i.test(html)) {
        throw new Error(`Cannot prepare Android page: ${full}`);
      }
      if (!html.includes('/css/tablet-app.css')) {
        html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="/css/tablet-app.css?v=2"></head>');
      }
      if (!html.includes('/ota-ready.js')) {
        html = html.replace(/<\/body>/i, '<script src="/ota-ready.js"></script></body>');
      }
      fs.writeFileSync(full, html);
    }
  }
};
prepareHtml(www);
console.log('Prepared android-app/www');
