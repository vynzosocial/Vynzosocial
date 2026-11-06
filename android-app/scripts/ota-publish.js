// Usage: npm run ota:publish
// Builds the web bundle from ../frontend, zips it, and signs a manifest.
// Output defaults to android-app/ota-dist/; OTA_OUTPUT_DIR can select another directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const appRoot = path.resolve(__dirname, '..');
const privatePath = process.env.OTA_PRIVATE_KEY_FILE || path.join(appRoot, 'ota-keys', 'private.pem');
const encodedKey = process.env.OTA_PRIVATE_KEY_BASE64;
if (!encodedKey && !fs.existsSync(privatePath)) {
  throw new Error('OTA signing key not found. Set OTA_PRIVATE_KEY_BASE64 or OTA_PRIVATE_KEY_FILE.');
}
const privateKey = crypto.createPrivateKey(encodedKey
  ? Buffer.from(encodedKey, 'base64')
  : fs.readFileSync(privatePath));
const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
const otaConfig = fs.readFileSync(path.join(appRoot, 'android', 'app', 'src', 'main', 'res', 'values', 'ota.xml'), 'utf8');
const expectedKey = (otaConfig.match(/<string name="ota_public_key"[^>]*>([^<]+)<\/string>/) || [])[1];
if (!expectedKey || publicKey !== expectedKey.trim()) {
  throw new Error('OTA signing key does not match the public key embedded in the Android app.');
}

execFileSync(process.execPath, [path.join(__dirname, 'prepare-web.js')], { stdio: 'inherit' });

const gradle = fs.readFileSync(path.join(appRoot, 'android', 'app', 'build.gradle'), 'utf8');
const versionCode = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1]);
if (!versionCode) throw new Error('Could not read versionCode from build.gradle');

const version = Date.now();
const out = process.env.OTA_OUTPUT_DIR
  ? path.resolve(process.env.OTA_OUTPUT_DIR)
  : path.join(appRoot, 'ota-dist');
if (process.env.OTA_OUTPUT_DIR && fs.existsSync(out)) {
  throw new Error('OTA_OUTPUT_DIR must not already exist.');
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const zip = new AdmZip();
zip.addLocalFolder(path.join(appRoot, 'www'));
const bundleName = `bundle-${version}.zip`;
const buffer = zip.toBuffer();
fs.writeFileSync(path.join(out, bundleName), buffer);

const manifest = JSON.stringify({
  version,
  minBinaryVersionCode: versionCode,
  bundle: bundleName,
  sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  size: buffer.length
});
fs.writeFileSync(path.join(out, 'manifest.json'), manifest);

const signature = crypto.sign('sha256', Buffer.from(manifest), privateKey);
fs.writeFileSync(path.join(out, 'manifest.json.sig'), signature.toString('base64'));
console.log(`Created signed OTA bundle ${version} (${(buffer.length / 1024 / 1024).toFixed(1)} MB) in ${out}`);
