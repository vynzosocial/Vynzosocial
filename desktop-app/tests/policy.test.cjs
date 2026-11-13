const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedUrl, isExternalUrl, canRequestPermission, validateUpdateUrl } = require('../lib/policy.cjs');

test('only the exact HTTPS website origin can stay inside the desktop app', () => {
  assert.equal(isTrustedUrl('https://www.vynzosocial.com/pages/messages.html'), true);
  for (const url of [
    'http://www.vynzosocial.com/', 'https://www.vynzosocial.com.attacker.example/',
    'https://www.vynzosocial.com@attacker.example/', 'https://attacker@www.vynzosocial.com/',
    'https://www.vynzosocial.com:444/', 'file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'bad url'
  ]) assert.equal(isTrustedUrl(url), false, url);
});

test('external links accept only credential-free HTTP and HTTPS URLs', () => {
  assert.equal(isExternalUrl('https://www.instagram.com/vynzosocial/'), true);
  assert.equal(isExternalUrl('http://example.com/'), true);
  for (const url of [
    'https://www.vynzosocial.com/', 'file:///C:/Windows/notepad.exe',
    'javascript:alert(1)', 'ms-settings:privacy', 'https://name:password@example.com/', 'bad url'
  ]) assert.equal(isExternalUrl(url), false, url);
});

test('sensitive permissions require both a trusted requester and trusted top-level page', () => {
  const site = 'https://www.vynzosocial.com/pages/live.html';
  assert.equal(canRequestPermission('media', site, site), true);
  assert.equal(canRequestPermission('notifications', site, site), true);
  assert.equal(canRequestPermission('media', 'https://example.com', site), false);
  assert.equal(canRequestPermission('media', site, 'https://example.com'), false);
  assert.equal(canRequestPermission('display-capture', site, site), false);
  assert.equal(canRequestPermission('geolocation', site, site), false);
});

test('update hosting requires an HTTPS directory without embedded credentials or parameters', () => {
  assert.equal(validateUpdateUrl('https://downloads.example.com/desktop'), 'https://downloads.example.com/desktop/');
  for (const url of ['http://example.com/', 'https://name:password@example.com/', 'https://example.com/?token=secret', 'https://example.com/#fragment', 'file:///C:/updates', 'invalid']) {
    assert.throws(() => validateUpdateUrl(url), /HTTPS directory/);
  }
});
