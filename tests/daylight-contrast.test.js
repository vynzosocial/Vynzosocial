const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

function inspectPage(doc, kind, mode) {
  const win = doc.defaultView;
  doc.documentElement.dataset.theme = mode;
  const targets = {
    home: ['.tab-btn:not(.active)', '.home-user-name'],
    people: ['.people-tab', '.account-search-identity strong', '.account-follow-button.is-friend'],
    live: ['.live-audience-choice-copy strong', '.live-audience-choice-copy small', '.live-audience-option-copy strong', '.live-audience-option-copy small', '#live-streams-list > p'],
    messages: ['.message-content', '.message-sender-name', '.chat-input', '.chat-header-subtitle', '.conversation-item > div > div']
  };
  if (kind === 'home') {
    doc.querySelector('.welcome-page').hidden = true;
    doc.getElementById('feed-app').hidden = false;
    doc.body.dataset.feedScope = 'me';
    doc.querySelector('.home-user-name').textContent = 'Your username';
    doc.querySelector('#add-video-post-btn .create-hint').textContent = 'Record a video or edit with CapCut';
    const actions = `<div class="post-actions">
      <button class="post-action like-btn">Like <span class="action-count">999</span></button>
      <button class="post-action comment-count">Comments <span class="action-count">999</span></button>
      <select class="post-privacy-select" aria-label="Who can see this post"><option>&#127757; Everyone</option><option>&#128101; Friends</option><option>&#128274; Only me</option></select>
      <label class="protect-option"><input type="checkbox">Do not allow reposting</label>
      <button class="post-action">Download original</button><button class="post-action post-delete-btn">Delete</button>
    </div>`;
    doc.getElementById('feed-container').innerHTML = `<div style="width:177px"><article class="post-card">${actions}</article></div>
      <div class="feed-container reel-feed" style="width:177px;max-width:177px!important"><article class="post-card insta-card"><button class="post-thumbnail-button"></button>${actions}</article></div>`;
    const grid = doc.createElement('div');
    grid.id = 'compact-fixture';
    grid.className = 'feed-container';
    grid.innerHTML = Array.from({ length: 6 }, (_, index) => {
      const media = index % 2 ? '<img class="post-media" width="1920" height="1080" alt="Photo">' : '<video class="post-media" width="720" height="1280"></video>';
      const caption = ['', 'Amman', 'A longer caption that wraps over more than two lines without changing the card size.'][index % 3];
      return `<article class="post-card"><button class="post-thumbnail-button">${media}</button><div class="post-details">
        <div class="post-author-row"><span class="post-author-avatar">V</span><span class="post-author">example_username</span><span class="post-time">8 days ago</span></div>
        ${caption ? `<p class="post-caption">${caption}</p>` : ''}</div>
        <div class="post-actions"><button class="post-action like-btn">&#9829; <span class="action-count">6</span></button>
        <button class="post-action comment-count">&#128172; <span class="action-count">3</span></button>
        <select class="post-privacy-select"><option>&#127757; Everyone</option></select>
        <label class="protect-option"><input type="checkbox">Do not allow reposting</label>
        ${index % 2 ? '' : '<button class="post-action">Download original</button>'}
        <button class="post-action post-delete-btn">Delete</button></div></article>`;
    }).join('') + '<button class="feed-more">Load more</button>';
    doc.querySelector('.home-feed-section').appendChild(grid);
  } else if (kind === 'people') {
    doc.getElementById('connections-list').innerHTML = `<div class="account-search-result">
      <span class="account-search-avatar">V</span><div class="account-search-identity"><strong>Example person</strong><small>@example</small></div>
      <button class="account-follow-button is-following is-friend">Friends</button></div>`;
  } else if (kind === 'live') {
    doc.getElementById('live-streams-list').innerHTML = '<p>None of your friends are live right now.</p><p>No active livestreams right now. Start one!</p>';
    doc.getElementById('live-audience-menu').hidden = false;
  } else {
    doc.getElementById('conversations-list').innerHTML = `<div class="conversation-item"><span class="author-avatar">V</span><div>
      <div style="font-weight:600">Conversation name</div><div style="color:var(--text-muted)">Last message</div></div></div>`;
    doc.getElementById('chat-area').innerHTML = `<div class="chat-header"><strong>Conversation</strong><span class="chat-header-subtitle">Friends</span></div>
      <div class="chat-messages">${['incoming', 'outgoing'].map(direction => `<div class="message-row ${direction}">
        <span class="message-sender"><span class="message-sender-name">Sender</span></span>
        <div class="message-bubble ${direction}"><span class="message-content">A readable message</span></div></div>`).join('')}</div>
      <form class="chat-input-form"><textarea class="chat-input">Typing a message</textarea></form>`;
  }

  function rgb(value) {
    const channels = value.match(/[\d.]+/g).map(Number);
    return [...channels.slice(0, 3), channels[3] ?? 1];
  }
  function blend(front, back) {
    return front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
  }
  function layers(image) {
    let depth = 0, start = 0;
    const result = [];
    for (let i = 0; i < image.length; i++) {
      if (image[i] === '(') depth++;
      if (image[i] === ')') depth--;
      if (image[i] === ',' && !depth) { result.push(image.slice(start, i)); start = i + 1; }
    }
    return [...result, image.slice(start)];
  }
  const cache = new Map();
  function backgrounds(node) {
    if (!node) return [[255, 255, 255]];
    if (cache.has(node)) return cache.get(node);
    const style = win.getComputedStyle(node);
    let colors = backgrounds(node.parentElement).map(back => blend(rgb(style.backgroundColor), back));
    for (const layer of layers(style.backgroundImage).reverse()) {
      const stops = [...layer.matchAll(/rgba?\([^)]+\)/g)].map(match => rgb(match[0]));
      if (stops.length) colors = stops.flatMap(front => colors.map(back => blend(front, back)));
      colors = [...new Map(colors.map(color => [color.map(Math.round).join(','), color])).values()];
    }
    cache.set(node, colors);
    return colors;
  }
  function luminance(color) {
    return color.slice(0, 3).map(value => value / 255).map(value =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  }
  const text = targets[kind].flatMap(selector => [...doc.querySelectorAll(selector)].map(node => {
    const color = rgb(win.getComputedStyle(node).color);
    const contrast = Math.min(...backgrounds(node).map(back => {
      const light = luminance(blend(color, back)), background = luminance(back);
      return (Math.max(light, background) + 0.05) / (Math.min(light, background) + 0.05);
    }));
    return { selector, contrast, luminance: luminance(color), color: color.slice(0, 3) };
  }));
  const controls = [...doc.querySelectorAll('.post-actions > *')].map(node => {
    const rect = node.getBoundingClientRect(), card = node.closest('.post-card').getBoundingClientRect();
    return { label: node.textContent, fits: rect.left >= card.left && rect.right <= card.right && rect.bottom <= card.bottom };
  });
  const privacy = [...doc.querySelectorAll('#feed-container .post-privacy-select')].map(node => {
    const intrinsic = node.cloneNode(true);
    intrinsic.style.cssText = 'position:absolute;visibility:hidden;max-width:none;min-width:0;width:max-content';
    node.parentElement.appendChild(intrinsic);
    const required = intrinsic.getBoundingClientRect().width;
    intrinsic.remove();
    return { width: node.getBoundingClientRect().width, required };
  });
  const layout = kind === 'home' ? {
    composer: [...doc.querySelectorAll('.home-post-composer, .home-post-actions, .home-post-actions .home-create-button')].map(node => {
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      return { selector: node.className, width: rect.width, fits: rect.left >= parent.left - 1 && rect.right <= parent.right + 1
        && rect.left >= -1 && rect.right <= doc.documentElement.clientWidth + 1,
        noOverflow: node.scrollWidth <= node.clientWidth + 1 };
    }),
    cards: [...doc.querySelectorAll('#compact-fixture > .post-card')].map(node => {
      const card = node.getBoundingClientRect(), media = node.querySelector('.post-thumbnail-button').getBoundingClientRect();
      const footer = node.querySelector('.post-actions').getBoundingClientRect();
      const content = node.querySelector('.post-media'), style = win.getComputedStyle(content);
      return { width: card.width, height: card.height, mediaRatio: media.width / media.height, footer: footer.top - card.top,
        fit: style.objectFit, transform: style.transform };
    }),
    moreHeight: doc.querySelector('#compact-fixture > .feed-more').getBoundingClientRect().height,
    reelRatio: (() => {
      const rect = doc.querySelector('.reel-feed .post-thumbnail-button').getBoundingClientRect();
      return rect.width / rect.height;
    })()
  } : null;
  return { kind, mode, text, controls, privacy, layout };
}

test('daylight text has readable contrast and narrow post cards expose all privacy controls', { skip: !chrome }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-daylight-'));
  try {
    const pages = [['home', 'index.html'], ['people', path.join('pages', 'users.html')],
      ['live', path.join('pages', 'live.html')], ['messages', path.join('pages', 'messages.html')]]
      .map(([kind, file]) => {
        const absolute = path.join(root, file);
        const html = fs.readFileSync(absolute, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/\s(?:src|poster)="[^"]*"/g, '')
          .replace('<head>', `<head><base href="${pathToFileURL(absolute).href}">`);
        return { kind, html };
      });
    pages.push({ kind: 'home', html: pages[0].html
      .replace('<html lang="en" dir="ltr">', '<html class="vynzo-android-app" lang="en" dir="ltr">')
      .replace('</head>', `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'css', 'tablet-app.css')).href}"></head>`) });
    for (const width of [320, 768, 1280]) {
      for (const mode of ['daylight', 'dark']) {
        const fixture = path.join(directory, 'fixture.html');
        fs.writeFileSync(fixture, `<!doctype html><body><script>
          const inspect=${inspectPage.toString()}, results=[];
          for(const input of ${JSON.stringify(pages).replace(/</g, '\\u003c')}) {
            const iframe=document.createElement('iframe');
            iframe.style.cssText='border:0;width:${width}px;height:800px';
            iframe.onload=()=>{try { results.push(inspect(iframe.contentDocument,input.kind,'${mode}')); }
              catch(error) { results.push({error:error.stack}); }
              if(results.length===${pages.length})document.body.dataset.result=JSON.stringify(results);
            };
            iframe.srcdoc=input.html;document.body.appendChild(iframe);
          }
        </script>`);
        const result = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run',
          `--user-data-dir=${directory}`, '--virtual-time-budget=1500', '--dump-dom', pathToFileURL(fixture).href
        ], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(result.status, 0, result.stderr);
        const match = result.stdout.match(/data-result="([^"]+)"/);
        assert.ok(match, 'Missing browser results');
        const actual = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
        for (const page of actual) {
          assert.ok(!page.error, page.error);
          assert.ok(page.text.length > 0, page.kind);
          if (mode === 'daylight') {
            for (const text of page.text) assert.ok(text.contrast >= 4.5,
              `${page.kind} ${text.selector} at ${width}px: ${text.contrast.toFixed(2)} contrast`);
            if (page.kind === 'messages') for (const text of page.text.filter(text => text.selector === '.message-content')) {
              assert.ok(text.luminance > 0.025 && text.luminance < 0.2, 'Message text should be dark, not black or white');
            }
          } else if (page.kind === 'messages') {
            assert.deepEqual(page.text.find(text => text.selector === '.message-content').color, [242, 234, 255]);
            assert.deepEqual(page.text.filter(text => text.selector === '.message-content')[1].color, [255, 255, 255]);
          }
          if (page.kind === 'home') {
            for (const control of page.layout.composer) {
              assert.ok(control.fits && control.noOverflow, `Overflowing upload control at ${width}px: ${JSON.stringify(control)}`);
            }
            const uploads = page.layout.composer.filter(control => control.selector.includes('home-create-button'));
            assert.equal(uploads.length, 2);
            assert.ok(Math.abs(uploads[0].width - uploads[1].width) < 1, 'Image and Video must share the available width');
            assert.equal(page.privacy.length, 2);
            for (const control of page.controls) assert.ok(control.fits, `Clipped ${control.label}`);
            for (const control of page.privacy) assert.ok(control.width >= control.required, 'Selected privacy label is truncated');
            assert.equal(page.layout.cards.length, 6);
            const first = page.layout.cards[0];
            for (const card of page.layout.cards) {
              assert.ok(Math.abs(card.width - first.width) < 1, 'Home card widths should match');
              assert.ok(Math.abs(card.height - first.height) < 1,
                `Captions and optional downloads must not change card heights at ${width}px: ${JSON.stringify(page.layout.cards)}`);
              assert.ok(Math.abs(card.footer - first.footer) < 1, 'Home controls should align');
              assert.ok(Math.abs(card.mediaRatio - 16 / 9) < 0.01, 'Photo and video previews must have the same landscape frame');
              assert.equal(card.fit, 'contain', 'The complete photo or video must be visible, not cropped');
              assert.equal(card.transform, 'none', 'Preview scaling must not crop the media');
              assert.ok(card.height <= (width < 600 ? 420 : 380), `Oversized Home card: ${card.height}px`);
            }
            assert.ok(page.layout.moreHeight < 60, 'Loading more posts must not reserve a full card-height row');
            assert.ok(Math.abs(page.layout.reelRatio - 4 / 5) < 0.01, 'Following and For You must keep their existing media layout');
          }
        }
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
