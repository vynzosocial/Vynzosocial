const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const AdmZip = require('adm-zip');

const appRoot = path.resolve(__dirname, '..');
const root = path.resolve(appRoot, '..');
const otaDir = path.join(root, 'dist', 'ota');
const xml = fs.readFileSync(path.join(appRoot, 'android', 'app', 'src', 'main', 'res', 'values', 'ota.xml'), 'utf8');

test('website build contains an authentic, compatible OTA bundle', () => {
  const key = xml.match(/<string name="ota_public_key"[^>]*>([^<]+)<\/string>/)[1];
  const url = xml.match(/<string name="ota_manifest_url"[^>]*>([^<]+)<\/string>/)[1];
  assert.equal(url, 'https://www.vynzosocial.com/ota/manifest.json');
  const publicKey = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), type: 'spki', format: 'der' });
  const manifestBytes = fs.readFileSync(path.join(otaDir, 'manifest.json'));
  const signature = Buffer.from(fs.readFileSync(path.join(otaDir, 'manifest.json.sig'), 'utf8'), 'base64');
  assert.ok(crypto.verify('sha256', manifestBytes, publicKey, signature));

  const manifest = JSON.parse(manifestBytes);
  assert.ok(Number.isSafeInteger(manifest.version) && manifest.version > 0);
  const gradle = fs.readFileSync(path.join(appRoot, 'android', 'app', 'build.gradle'), 'utf8');
  assert.equal(manifest.minBinaryVersionCode, Number(gradle.match(/versionCode\s+(\d+)/)[1]));
  assert.match(manifest.bundle, /^bundle-\d+\.zip$/);
  const bundle = fs.readFileSync(path.join(otaDir, manifest.bundle));
  assert.equal(bundle.length, manifest.size);
  assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), manifest.sha256);
  const zip = new AdmZip(bundle);
  assert.ok(zip.getEntry('index.html'));
  assert.ok(zip.getEntry('ota-ready.js'));
  assert.match(zip.readAsText('index.html'), /src="\/ota-ready\.js"/);
  assert.match(zip.readAsText('index.html'), /<html class="vynzo-android-app"/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'), /<html class="vynzo-android-app"/);
  assert.match(fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'), /\/ota\/manifest\.json\s+Cache-Control: no-store/);
});

test('publishing rejects a signing key that does not match the Android app', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const encoded = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  const result = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'ota-publish.js')], {
    env: { ...process.env, OTA_PRIVATE_KEY_BASE64: encoded },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the public key/);
  assert.ok(!result.stderr.includes(encoded));
});
