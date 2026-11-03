const PUBLIC_BUCKET = 'uploads';
const PRIVATE_BUCKET = 'view-once';

function config() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase Storage.');
  }
  return { base, key };
}

function headers(key, extra = {}) {
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

async function ensureBucket({ id, public: isPublic }) {
  const { base, key } = config();
  const response = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id, name: id, public: isPublic })
  });
  if (response.ok) return;

  const error = await response.text();
  if (response.status !== 409 && !/already exists|duplicate/i.test(error)) {
    throw new Error(`Supabase Storage bucket "${id}" setup failed: ${response.status} ${error}`);
  }

  const existing = await fetch(`${base}/storage/v1/bucket/${encodeURIComponent(id)}`, {
    headers: headers(key)
  });
  if (!existing.ok) {
    throw new Error(`Unable to verify Supabase Storage bucket "${id}": ${existing.status} ${await existing.text()}`);
  }
  const bucket = await existing.json();
  if (bucket.public !== isPublic) {
    throw new Error(`Supabase Storage bucket "${id}" must be ${isPublic ? 'public' : 'private'}.`);
  }
}

async function ensureBuckets() {
  await ensureBucket({ id: PUBLIC_BUCKET, public: true });
  await ensureBucket({ id: PRIVATE_BUCKET, public: false });
}

async function uploadBuffer(name, buffer, mime, bucket = PUBLIC_BUCKET) {
  const { base, key } = config();
  const response = await fetch(
    `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: headers(key, {
        'Content-Type': mime || 'application/octet-stream',
        'x-upsert': 'true'
      }),
      body: buffer
    }
  );
  if (!response.ok) {
    throw new Error(`Supabase Storage upload of ${name} failed: ${response.status} ${await response.text()}`);
  }
}

async function downloadFile(name, bucket = PUBLIC_BUCKET) {
  const { base, key } = config();
  const response = await fetch(
    `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(name)}`,
    { headers: headers(key) }
  );
  if (!response.ok) {
    throw new Error(`Supabase Storage download of ${name} failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function deleteFile(name, bucket = PUBLIC_BUCKET) {
  const { base, key } = config();
  const response = await fetch(
    `${base}/storage/v1/object/${encodeURIComponent(bucket)}`,
    {
      method: 'DELETE',
      headers: headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [name] })
    }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Supabase Storage deletion of ${name} failed: ${response.status} ${await response.text()}`);
  }
}

function publicUrl(name) {
  const { base } = config();
  return `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${encodeURIComponent(name)}`;
}

function nameFromPublicPath(publicPath) {
  const name = String(publicPath || '').split('/').pop();
  if (!name || name === publicPath) {
    throw new Error('Expected a stored Supabase public media path.');
  }
  return decodeURIComponent(name);
}

function deletePublicPath(publicPath) {
  return deleteFile(nameFromPublicPath(publicPath), PUBLIC_BUCKET);
}

module.exports = {
  PUBLIC_BUCKET,
  PRIVATE_BUCKET,
  ensureBuckets,
  uploadBuffer,
  downloadFile,
  deleteFile,
  publicUrl,
  nameFromPublicPath,
  deletePublicPath
};
