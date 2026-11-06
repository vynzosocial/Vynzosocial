const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const js = path.join(__dirname, '..', 'frontend', 'js');
const source = fs.readFileSync(path.join(js, 'users.js'), 'utf8');
const formCode = source.slice(source.indexOf('function createProfileReportForm('), source.indexOf('\nfunction renderUserProfile('));
const labels = [
  'Choose a reason',
  'Harassment, threats, hate speech or bullying',
  'Nudity, sexual content or sharing private images without consent',
  'Violence, graphic abuse, self-harm or illegal activity',
  'Spam, scams, fake account or impersonation',
  'Privacy or copyright violation',
  'Something else'
];
const values = [
  '', 'Harassment, threats, hate speech or bullying', 'Nudity or sexual content',
  'Violence or self-harm', 'Spam, scams, fake account or impersonation',
  'Privacy or copyright', 'Other'
];

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute() {}
  removeAttribute() {}
  reportValidity() { return true; }
}

test('report reasons describe the issue and retain the existing submitted categories', async () => {
  let request;
  const sandbox = {
    document: { createElement: tag => new Element(tag) },
    apiRequest: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { message: 'Submitted' };
    },
    console
  };
  vm.runInNewContext(`${formCode}\nthis.form = createProfileReportForm('profile-id', {});`, sandbox);
  const form = sandbox.form;
  const select = form.children[1].children[0];
  assert.deepEqual(select.children.map(option => option.textContent), labels);
  assert.deepEqual(select.children.map(option => option.value), values);
  assert.equal(select.required, true);
  assert.equal(select.children[0].disabled, true);
  select.value = values[4];
  form.children[2].children[0].value = 'Example details';
  await form.events.submit({ preventDefault() {} });
  assert.equal(request.url, '/moderation/report');
  assert.deepEqual(request.body, { target_type: 'profile', target_id: 'profile-id', reason: `${values[4]}: Example details` });
});

test('all supported languages include the report reason translations', () => {
  for (const language of ['ar', 'de', 'es', 'fr', 'hi', 'nl', 'pt', 'ru', 'ur']) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(js, `i18n-${language}.js`), 'utf8'), sandbox);
    const dict = sandbox.window.VynzoI18nDicts[language];
    for (const label of labels) {
      assert.equal(typeof dict[label], 'string', `${language} missing ${label}`);
      assert.notEqual(dict[label], '');
    }
  }
});
