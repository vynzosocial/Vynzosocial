// Usage: npm run ota:publish
// Builds the web bundle from ../frontend, zips it, and signs a manifest.
// Output (upload these 3 files to the folder behind the manifest URL): android-app/ota-dist/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const appRoot = path.resolve(__dirname, '..');
const privatePath = process.env.OTA_PRIVATE_KEY_FILE || path.join(appRoot, 'ota-keys', 'private.pem');
if (!fs.existsSync(privatePath)) throw new Error('Signing key not found. Run: npm run ota:setup');

execFileSync(process.execPath, [path.join(__dirname, 'prepare-web.js')], { stdio: 'inherit' });

const gradle = fs.readFileSync(path.join(appRoot, 'android', 'app', 'build.gradle'), 'utf8');
const versionCode = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1]);
if (!versionCode) throw new Error('Could not read versionCode from build.gradle');

const version = Math.floor(Date.now() / 1000);
const out = path.join(appRoot, 'ota-dist');
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

const signature = crypto.sign('sha256', Buffer.from(manifest), crypto.createPrivateKey(fs.readFileSync(privatePath)));
fs.writeFileSync(path.join(out, 'manifest.json.sig'), signature.toString('base64'));
console.log(`Published bundle ${version} (${(buffer.length / 1024 / 1024).toFixed(1)} MB) to ota-dist/`);
