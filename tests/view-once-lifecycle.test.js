const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'frontend', 'js');

test('blob API preserves the temporary unavailability code', async () => {
  const source = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const marker = 'export async function apiBlobRequest(';
  assert.ok(source.includes(marker));
  const functionSource = source.slice(source.indexOf(marker)).replace('export async function', 'async function');
  const context = {
    supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_PUBLISHABLE_KEY: 'public',
    localStorage: { getItem: () => null },
    fetch: async () => ({
      ok: false,
      json: async () => ({ error: 'Temporarily unavailable.', code: 'view_once_temporarily_unavailable' })
    })
  };
  vm.runInNewContext(functionSource, context);
  await assert.rejects(context.apiBlobRequest('/messages/test'), error =>
    error.message === 'Temporarily unavailable.' && error.code === 'view_once_temporarily_unavailable');
});

test('view-once UI permits retry only for temporary unavailability', async () => {
  const source = fs.readFileSync(path.join(root, 'messages.js'), 'utf8');
  const start = "  msgContainer.addEventListener('click', async event => {";
  const end = "\n  socket.off('view_once_opened');";
  assert.ok(source.includes(start) && source.includes(end));
  const handlerSource = source.slice(source.indexOf(start), source.indexOf(end));
  async function run(error) {
    let handler;
    let replacement;
    const status = {};
    const button = {
      disabled: false,
      closest: () => ({ dataset: { messageId: 'message' } }),
      replaceWith: value => { replacement = value; }
    };
    const context = {
      msgContainer: { addEventListener: (_event, fn) => { handler = fn; } },
      currentConversationId: 'conversation',
      status,
      document: { createElement: () => ({}) },
      openViewOnce: async () => { if (error) throw error; },
      notifyPeer: () => {}
    };
    vm.runInNewContext(handlerSource, context);
    await handler({ target: { closest: selector => selector === '.view-once-open' ? button : null } });
    return { button, replacement, status };
  }
  const temporary = await run(Object.assign(new Error('Try later'), { code: 'view_once_temporarily_unavailable' }));
  assert.equal(temporary.button.disabled, false);
  assert.equal(temporary.replacement, undefined);
  assert.equal(temporary.status.textContent, 'Try later');
  const gone = await run(new Error('Gone'));
  assert.equal(gone.button.disabled, true);
  assert.equal(gone.replacement.className, 'view-once-chip opened');
  const success = await run(null);
  assert.equal(success.replacement.className, 'view-once-chip opened');
});
