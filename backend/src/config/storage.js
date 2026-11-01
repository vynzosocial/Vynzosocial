const fs = require('fs');
const path = require('path');

const BUCKET = 'uploads';

function config() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '') ||
    (() => {
      const m = (process.env.SUPABASE_DATABASE_URL || '').match(/-U\s+postgres\.(\w+)/);
      return m ? `https://${m[1]}.supabase.co` : '';
    })();
  return { base, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

function enabled() {
  const { base, key } = config();
  return Boolean(base && key);
}

function publicUrl(name) {
  return `${config().base}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(name)}`;
}

async function ensureBucket() {
  const { base, key } = config();
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true })
  });
  if (!res.ok) {
    const text = await res.text();
    if (!/already exists|Duplicate/i.test(text)) throw new Error(`Bucket create failed: ${res.status} ${text}`);
  }
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};

async function uploadFile(filePath, name, mime) {
  const { base, key } = config();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': mime || MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: fs.readFileSync(filePath)
  });
  if (!res.ok) throw new Error(`Upload of ${name} failed: ${res.status} ${await res.text()}`);
}

module.exports = { enabled, publicUrl, ensureBucket, uploadFile };
