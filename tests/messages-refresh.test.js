const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export async function initMessaging', 'async function initMessaging');
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

test('message refresh preserves existing content, playback, drafts and contact images', { skip: !chrome }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-message-refresh-'));
  try {
    const fixture = path.join(directory, 'fixture.html');
    fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
      <style>#chat-messages-container{height:160px;overflow:auto}.message-row{min-height:80px}img{width:24px;height:24px}video{width:40px;height:40px}</style>
      <div id="conversations-list"></div><span id="unread-total"></span><div id="chat-area"></div>
      <script>
        const API_ORIGIN = 'https://example.test';
        const attachEmojiPicker = () => {};
        const attachChatComposer = () => () => {};
        const parseSharedMessage = content => content === '[shared-blog]' ? {
          preview: {type:'blog',id:'article'},text:'Shared article',url:'https://example.test/article'
        } : null;
        const setScreenGuard = () => {};
        const pageMemoryAccount = () => null;
        const readPageMemory = () => null;
        const writePageMemory = () => {};
        let messages, conversations, delayed, sendDeferred, postCalls = 0, previewLoads = 0, uploadUrlCalls = 0, directUploads = 0;
        const uploadedFiles = [], encodings = [];
        const supabase = {storage:{from:()=>({uploadToSignedUrl:async(path,token,file)=>{directUploads++;uploadedFiles.push(file);return{error:null};}})}};
        const MAX_CAMERA_VIDEO_SECONDS = 10;
        const encodePlaybackVideo = async(file,onProgress,options) => {
          encodings.push(options);
          onProgress(1);
          return{playback:new File([new Uint8Array(30)],'compressed.mp4',{type:'video/mp4'})};
        };
        const chooseMessageCamera = (photo,video) => video();
        const recordMessageVideo = capture => capture(new File([new Uint8Array(1000)],'camera.webm',{type:'video/webm'}));
        const apiRequest = async (url, options = {}) => {
          if (url === '/messages/chat/messages' && options.method === 'POST') {
            postCalls++;
            if (options.body instanceof FormData && options.body.get('media')) uploadedFiles.push(options.body.get('media'));
            return await sendDeferred;
          }
          if (url === '/messages') return {conversations};
          if (url === '/messages/chat/upload-url') {uploadUrlCalls++;return {path:'owner/messages/chat/upload.mp4',token:'signed'};}
          if (url === '/messages/chat/messages') return delayed ? await delayed : {messages,members:[],read_receipts:true};
          if (url === '/blogs/article') {
            previewLoads++;
            return {article:{title:'Loaded article',cover_url:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'}};
          }
          return {};
        };
        ${source}
        (async () => {
          const check = (condition, message) => {if (!condition) throw new Error(message);};
          const permit = (file, scope, expires) => 'https://media.example.test/media?permit=' +
            btoa(JSON.stringify({storage:'legacy-file',scope,path:'owner/'+file,viewerId:'self',resourceId:'resource',expires}))
              .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'') + '.signature';
          const avatar = expires => permit('avatar.png','avatar',expires);
          const user = {id:'self',display_name:'You',avatar_url:avatar(300)};
          localStorage.setItem('vynzo_user',JSON.stringify(user));
          socket = {connected:false,on(){},off(){},emit(){}};
          currentConversationId = 'chat';
          const message = (id, content = '', extension = '') => ({
            id,conversation_id:'chat',sender_id:id === 'voice' ? 'self' : 'peer',
            sender_display_name:id === 'voice' ? 'You' : 'Friend',sender_avatar_url:avatar(300),
            content,created_at:'2026-11-13T10:00:00Z',can_unsend:true,seen:false,
            media_url:extension ? permit(id+'.'+extension,'message',300) : null
          });
          messages = [message('text','Hello there'),message('photo','','jpg'),message('sticker','[vynzo-sticker]','png'),
            message('voice','','weba'),message('video','','mp4'),message('shared','[shared-blog]')];
          conversations = [
            {id:'chat',other_user_id:'peer',other_display_name:'Friend',other_avatar_url:avatar(300),last_message:messages[0]},
            {id:'other',other_user_id:'second',other_display_name:'Second friend',other_avatar_url:avatar(300),unread_count:2}
          ];
          renderConversations(conversations,user);
          renderChatWindow(document.getElementById('chat-area'),messages,user,'Friend',avatar(300));
          await Promise.resolve();
          const container = document.getElementById('chat-messages-container');
          const row = id => container.querySelector('[data-message-id="'+id+'"]').closest('.message-row');
          const original = new Map(messages.map(message => [message.id,row(message.id)]));
          const images = [...container.querySelectorAll('img')];
          const contact = document.querySelector('[data-conversation-id="chat"]');
          const contactImage = contact.querySelector('img');
          const text = row('text').querySelector('.message-content').firstChild;
          const selection = getSelection();
          const range = document.createRange();
          range.selectNodeContents(text);
          selection.addRange(range);
          const player = row('voice').querySelector('.voice-player');
          player._audio = {currentTime:17,paused:false,pause(){this.paused = true;}};
          player.querySelector('.voice-time').textContent = '0:17';
          const input = document.getElementById('chat-input-field');
          input.value = 'Unsent draft';
          container.scrollTop = 30;
          const scrollTop = container.scrollTop;
          messages = messages.map(message => ({
            ...message,sender_avatar_url:avatar(600),
            media_url:message.media_url ? permit(message.id+'.'+({photo:'jpg',sticker:'png',voice:'weba',video:'mp4'}[message.id]),'message',600) : null
          }));
          conversations = conversations.map(conversation => ({...conversation,other_avatar_url:avatar(600)}));
          await refreshCurrentConversation();
          await refreshConversations();
          check(messages.every(message => row(message.id) === original.get(message.id)), 'Unchanged message replaced');
          check(images.every(image => image.isConnected), 'Image or shared preview replaced');
          check(contact.querySelector('img') === contactImage, 'Contact image replaced');
          check(selection.anchorNode === text, 'Text selection lost');
          check(container.scrollTop === scrollTop, 'Reading position changed');
          check(input.value === 'Unsent draft', 'Draft lost');
          check(previewLoads === 1, 'Shared preview fetched again');
          check(player._audio.currentTime === 17 && !player._audio.paused, 'Voice playback reset');
          check(player.dataset.src === messages.find(message => message.id === 'voice').media_url, 'Voice permit not refreshed');
          messages.find(message => message.id === 'voice').seen = true;
          messages.find(message => message.id === 'voice').can_unsend = false;
          await refreshCurrentConversation();
          check(row('voice') === original.get('voice'), 'Read receipt replaced voice message');
          check(row('voice').querySelector('.message-status').textContent === 'Seen', 'Read receipt stale');
          check(!player._audio.paused && player.querySelector('.voice-time').textContent === '0:17', 'Read receipt interrupted playback');
          messages.push(message('new','New arrival'));
          await refreshCurrentConversation();
          check(row('photo') === original.get('photo') && row('sticker') === original.get('sticker'), 'New arrival reloaded older media');
          messages[0] = {...messages[0],content:'Edited text',edited_at:'2026-11-13T10:01:00Z'};
          await refreshCurrentConversation();
          check(row('text').querySelector('.message-content').textContent === 'Edited text', 'Edit not rendered');
          check(row('photo') === original.get('photo'), 'Edit replaced unrelated photo');
          messages = messages.filter(message => message.id !== 'new');
          await refreshCurrentConversation();
          check(!container.querySelector('[data-message-id="new"]'), 'Deleted message retained');
          conversations[0] = {...conversations[0],other_user_id:'updated-peer',last_message:messages[0],unread_count:5};
          await refreshConversations();
          check(document.querySelector('[data-conversation-id="chat"]') === contact, 'Updated conversation replaced');
          check(contact.querySelector('img') === contactImage, 'Preview update replaced contact image');
          check(contact.children[1].children[1].textContent === 'Edited text', 'Conversation preview stale');
          let selected;
          selectConversation = conversation => { selected = conversation; };
          contact.click();
          check(selected.other_user_id === 'updated-peer', 'Click used stale conversation metadata');
          const photo = row('photo').querySelector('img.photo-thumb');
          const freshPhoto = messages.find(message => message.id === 'photo').media_url;
          photo.dispatchEvent(new Event('error'));
          check(photo.getAttribute('src') === freshPhoto, 'Expired media did not use latest authorized URL');
          conversations[0] = {...conversations[0],other_avatar_url:permit('new-avatar.png','avatar',900)};
          await refreshConversations();
          check(contact.querySelector('img') !== contactImage, 'Real avatar change ignored');
          const form = document.getElementById('chat-form');
          let resolveSend;
          sendDeferred = new Promise(resolve => {resolveSend = resolve;});
          input.value = 'Immediate outgoing text';
          const started = performance.now();
          form.dispatchEvent(new Event('submit',{cancelable:true}));
          const pendingRow = container.querySelector('[data-pending-id]');
          check(pendingRow && performance.now()-started < 100, 'Message did not appear immediately');
          check(pendingRow.querySelector('.message-status').textContent === 'Sending...', 'Pending message incorrectly shown as sent');
          form.dispatchEvent(new Event('submit',{cancelable:true}));
          for(let i=0;i<6;i++) await Promise.resolve();
          check(postCalls === 1, 'Duplicate send was submitted');
          await refreshCurrentConversation();
          check(pendingRow.isConnected, 'Background refresh removed pending message');
          resolveSend({message:{...message('confirmed','Immediate outgoing text'),sender_id:'self'}});
          for(let i=0;i<6;i++) await Promise.resolve();
          check(!pendingRow.isConnected && container.querySelector('[data-message-id="confirmed"]'), 'Acknowledgement did not replace pending message');
          let rejectSend;
          sendDeferred = new Promise((resolve,reject) => {rejectSend = reject;});
          input.value = 'Keep failed draft';
          form.dispatchEvent(new Event('submit',{cancelable:true}));
          rejectSend(new Error('Connection interrupted'));
          for(let i=0;i<6;i++) await Promise.resolve();
          check(input.value === 'Keep failed draft', 'Failed message draft was lost');
          check(!container.querySelector('[data-pending-id]'), 'Failed message still claims to be sending');
          check(!document.getElementById('chat-send-status').hidden, 'Send failure was hidden');
          window.confirm = () => { throw new Error('Sending attachments must not ask for confirmation'); };
          input.value = '';
          document.getElementById('camera-btn').click();
          for(let i=0;i<6;i++) await Promise.resolve();
          check(encodings.at(-1).trimToSeconds === 10, 'Camera capture did not enforce ten seconds');
          sendDeferred = new Promise(resolve => {resolveSend = resolve;});
          form.dispatchEvent(new Event('submit',{cancelable:true}));
          check(container.querySelector('[data-pending-id] video'), 'Camera video did not appear before upload');
          for(let i=0;i<6;i++) await Promise.resolve();
          check(uploadedFiles.at(-1).size === 30 && uploadedFiles.at(-1).type === 'video/mp4', 'Uncompressed video was uploaded');
          resolveSend({message:{...message('camera-confirmed'),sender_id:'self'}});
          for(let i=0;i<6;i++) await Promise.resolve();
          check(!container.querySelector('[data-pending-id]'), 'Completed camera upload remained pending');
          check(uploadUrlCalls === 0 && directUploads === 0, 'Small camera file used the slower separate upload path');
          for (const type of ['image/png','audio/webm']) {
            const selected = new File(['attachment'],'single-click',{type});
            const transfer = new DataTransfer();
            transfer.items.add(selected);
            const attachmentInput = document.getElementById('chat-file-input');
            attachmentInput.files = transfer.files;
            attachmentInput.dispatchEvent(new Event('change'));
            for(let i=0;i<6;i++) await Promise.resolve();
            sendDeferred = new Promise(resolve => {resolveSend = resolve;});
            const previousPosts = postCalls;
            form.dispatchEvent(new Event('submit',{cancelable:true}));
            for(let i=0;i<6;i++) await Promise.resolve();
            check(uploadedFiles.at(-1) === selected, 'One-click attachment send failed: '+type);
            check(postCalls === previousPosts+1 && uploadUrlCalls === 0 && directUploads === 0, 'Small attachment did not use exactly one send request');
            resolveSend({message:{...message('single-click-'+type),sender_id:'self'}});
            for(let i=0;i<6;i++) await Promise.resolve();
            check(!container.querySelector('[data-pending-id]'), 'Attachment send was not completed: '+type);
          }
          const large = new File([new Uint8Array(6*1024*1024+1)],'large.gif',{type:'image/gif'});
          const largeBody = JSON.parse(await prepareMessageBody('chat',{content:'Large attachment',file:large,replyId:'reply-id'}));
          check(uploadUrlCalls === 1 && directUploads === 1 && uploadedFiles.at(-1) === large, 'Large files lost their direct signed upload path');
          check(largeBody.media_path === 'owner/messages/chat/upload.mp4' && largeBody.reply_to_id === 'reply-id', 'Large upload lost its media path or reply');
          for(const [type,tag] of [['image/png','img'],['video/mp4','video'],['audio/webm','div.voice-player']]) {
            const local = beginPendingMessage('chat',user,{file:new File(['media'],'sample',{type})});
            check(local.row.querySelector(tag), 'Missing pending attachment preview: '+type);
            check(local.row.querySelector('.message-status').textContent === 'Sending...', 'Attachment incorrectly marked sent');
            endPendingMessage(local);
          }
          let resolveOlder, resolveNewer;
          delayed = new Promise(done => {resolveOlder = done;});
          const older = refreshCurrentConversation();
          delayed = new Promise(done => {resolveNewer = done;});
          const newer = refreshCurrentConversation();
          const updated = messages.map(message => message.id === 'text' ? {...message,content:'Latest update'} : message);
          resolveNewer({messages:updated,members:[]});
          await newer;
          resolveOlder({messages,members:[]});
          await older;
          check(row('text').querySelector('.message-content').textContent === 'Latest update', 'Older response overwrote newer messages');
          let resolveBeforeAppend;
          delayed = new Promise(done => {resolveBeforeAppend = done;});
          const beforeAppend = refreshCurrentConversation();
          appendMessage(container,message('realtime','New realtime message'),user);
          resolveBeforeAppend({messages,members:[]});
          await beforeAppend;
          check(container.querySelector('[data-message-id="realtime"]'), 'Older poll removed a realtime message');
          let resolve;
          delayed = new Promise(done => {resolve = done;});
          const pending = refreshCurrentConversation();
          const replacement = document.createElement('div');
          replacement.id = 'chat-messages-container';
          replacement.textContent = 'Different conversation';
          container.replaceWith(replacement);
          resolve({messages:[],members:[]});
          await pending;
          check(replacement.textContent === 'Different conversation', 'Stale response overwrote switched chat');
          document.body.dataset.result = JSON.stringify({passed:true});
        })().catch(error => {document.body.dataset.result = JSON.stringify({error:error.stack});});
      </script>`);
    const result = spawnSync(chrome, [
      '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${directory}`,
      '--dump-dom', pathToFileURL(fixture).href
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match, 'Browser did not finish messaging checks.');
    const actual = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.deepEqual(actual, { passed: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
