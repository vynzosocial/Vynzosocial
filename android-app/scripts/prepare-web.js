// Copies the website (read-only) into android-app/www and injects the public Supabase key,
// mirroring the root build without touching the website's files or dist/.
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const www = path.join(appRoot, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(repoRoot, 'frontend'), www, { recursive: true });
fs.rmSync(path.join(www, '_headers'), { force: true });

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
const injectReady = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) injectReady(full);
    else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(full, 'utf8');
      if (!html.includes('/ota-ready.js') && /<\/body>/i.test(html)) {
        fs.writeFileSync(full, html.replace(/<\/body>/i, '<script src="/ota-ready.js"></script></body>'));
      }
    }
  }
};
injectReady(www);
console.log('Prepared android-app/www');
