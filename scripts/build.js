const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'frontend'), dist, { recursive: true });
require('./copy-live-face-assets')(dist);

const wranglerConfig = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
const publishableKey = process.env.VYNZO_SUPABASE_PUBLISHABLE_KEY?.trim()
  || wranglerConfig.vars?.VYNZO_SUPABASE_PUBLISHABLE_KEY?.trim();
if (!publishableKey) {
  console.warn('VYNZO_SUPABASE_PUBLISHABLE_KEY is unset; Supabase Auth will remain unavailable in this build.');
  process.exit(0);
}

if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(publishableKey)) {
  // Supabase publishable keys are intended for public clients.
} else {
  const parts = publishableKey.split('.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('VYNZO_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key or legacy anon JWT.');
  }
  if (parts.length !== 3 || claims.role !== 'anon' || claims.iss !== 'supabase') {
    throw new Error('Refusing to publish a Supabase key that is not a publishable/anon key.');
  }
}

const configPath = path.join(dist, 'js', 'supabase-config.js');
const config = fs.readFileSync(configPath, 'utf8');
const placeholder = "'__VYNZO_SUPABASE_PUBLISHABLE_KEY__'";
if (!config.includes(placeholder)) {
  throw new Error('Supabase key placeholder was not found in the frontend config.');
}
fs.writeFileSync(configPath, config.replace(placeholder, JSON.stringify(publishableKey)));
console.log('Injected the public Supabase key into the static build.');
