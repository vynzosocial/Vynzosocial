const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/messages.js'), 'utf8');
const markRead = source.slice(source.indexOf('function markConversationRead('), source.indexOf('\nfunction renderChatWindow('));
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(hidden = false) {
  const requests = [], events = [], errors = [];
  let resolve, reject;
  const context = {
    currentConversationId: 'chat', conversationsAwaitingRead: new Map(), readReceiptVersion: 0,
    document: { hidden, dispatchEvent: event => events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    console: { error: (...args) => errors.push(args) },
    apiRequest: (url, options) => {
      requests.push({ url, options });
      return new Promise((done, fail) => { resolve = done; reject = fail; });
    },
    notifyPeer() {},
    refreshConversations: async () => []
  };
  vm.runInNewContext(markRead, context);
  return { context, requests, events, errors, resolve: () => resolve(), reject: () => reject(new Error('Offline')) };
}

test('background messages remain unread and are acknowledged after the chat becomes visible', async () => {
  const state = setup(true);
  state.context.markConversationRead('chat');
  assert.equal(state.requests.length, 0);
  assert.ok(state.context.conversationsAwaitingRead.has('chat'));
  state.context.document.hidden = false;
  state.context.markConversationRead('chat');
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.events, []);
  state.resolve();
  await flush();
  assert.deepEqual(state.events, ['vynzo:messages-read']);
  assert.equal(state.context.conversationsAwaitingRead.size, 0);
});

test('a failed read acknowledgement cannot clear badges and remains eligible for retry', async () => {
  const state = setup();
  state.context.markConversationRead('chat');
  state.reject();
  await flush();
  assert.deepEqual(state.events, []);
  assert.equal(state.errors.length, 1);
  assert.ok(state.context.conversationsAwaitingRead.has('chat'));
});

test('a conversation that is no longer open is not marked read', () => {
  const state = setup();
  state.context.currentConversationId = 'different-chat';
  state.context.markConversationRead('chat');
  assert.equal(state.requests.length, 0);
});

test('a late read acknowledgement cannot discard a newer background message awaiting display', async () => {
  const state = setup();
  state.context.markConversationRead('chat');
  state.context.document.hidden = true;
  state.context.markConversationRead('chat');
  state.resolve();
  await flush();
  assert.ok(state.context.conversationsAwaitingRead.has('chat'));
});
