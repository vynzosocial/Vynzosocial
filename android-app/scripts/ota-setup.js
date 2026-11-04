// Usage: node scripts/ota-setup.js [https://host/path/manifest.json]
// Creates the OTA signing key pair once (private key stays in android-app/ota-keys, git-ignored)
// and writes the public key and manifest URL into the Android app resources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const appRoot = path.resolve(__dirname, '..');
const keyDir = path.join(appRoot, 'ota-keys');
const privatePath = path.join(keyDir, 'private.pem');
const xmlPath = path.join(appRoot, 'android', 'app', 'src', 'main', 'res', 'values', 'ota.xml');

fs.mkdirSync(keyDir, { recursive: true });
if (!fs.existsSync(privatePath)) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('Created ota-keys/private.pem — back it up securely and never commit it.');
}

const publicDer = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(privatePath)))
  .export({ type: 'spki', format: 'der' }).toString('base64');

let url = process.argv[2] || '';
if (!url && fs.existsSync(xmlPath)) {
  url = (fs.readFileSync(xmlPath, 'utf8').match(/name="ota_manifest_url">([^<]*)</) || [])[1] || '';
}
if (url && !url.startsWith('https://')) throw new Error('The manifest URL must start with https://');

fs.writeFileSync(xmlPath, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="ota_manifest_url" translatable="false">${url}</string>
    <string name="ota_public_key" translatable="false">${publicDer}</string>
</resources>
`);
console.log(`OTA configured. Manifest URL: ${url || '(not set — updates disabled until you set it)'}`);
