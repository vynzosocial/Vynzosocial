const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const decoration = home.match(/<div class="home-gold-decoration"[\s\S]*?<\/div>/)[0];
const css = [...home.matchAll(/<link rel="stylesheet" href="\.\/([^"?]+)(?:\?[^"]*)?">/g)]
  .map(match => fs.readFileSync(path.join(root, ...match[1].split('/')), 'utf8')).join('\n');
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

test('Home gold decorations fit phone and desktop without blocking controls or leaking onto other pages', { skip: !chrome }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-home-gold-'));
  try {
    for (const [width, page, reduced] of [[320, 'home-page', false], [1280, 'home-page', false], [360, 'home-page', true], [360, 'messages-page', false]]) {
      const content = `<!doctype html><style>
        html,body{margin:0}body{height:100vh}#probe{position:fixed;left:25%;top:50%;width:120px;height:44px}
        ${css}</style><body class="${page}">${decoration}<button id="probe" class="home-user-chip">Your username</button>
        <div style="position:absolute;top:800px;left:0;width:200px">
          <div class="home-main-column">
            <section class="home-stories-section">Stories</section>
            <section class="home-feed-section">Photos and videos</section>
          </div>
          <div class="stories-carousel-container"><span class="story-preview-ring">Story</span></div>
          <div class="feed-container reel-feed"><article class="post-card insta-card">Photo or video</article></div>
        </div>`;
      const escaped = content.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const fixture = path.join(directory, 'fixture.html');
      fs.writeFileSync(fixture, `<!doctype html><iframe style="border:0;width:${width}px;height:640px" srcdoc="${escaped}"></iframe>
        <script>
        document.querySelector('iframe').addEventListener('load',event=>{
          const frame=event.target.contentWindow,doc=frame.document;
          const decoration=doc.querySelector('.home-gold-decoration'),rect=decoration.getBoundingClientRect();
          const button=doc.getElementById('probe'),target=button.getBoundingClientRect();
          let clicked=false;button.onclick=()=>{clicked=true;};
          const hit=doc.elementFromPoint(target.left+target.width/2,target.top+target.height/2);
          hit.click();
          document.body.dataset.result=JSON.stringify({
            display:frame.getComputedStyle(decoration).display,
            pointerEvents:frame.getComputedStyle(decoration).pointerEvents,
            hiddenFromAccessibility:decoration.getAttribute('aria-hidden')==='true'&&decoration.inert,
            fits:rect.width===doc.documentElement.clientWidth&&rect.height===doc.documentElement.clientHeight,
            noOverflow:doc.documentElement.scrollWidth<=doc.documentElement.clientWidth,
            clicked:hit===button&&clicked,
            frames:[...doc.querySelectorAll('.home-stories-section,.home-feed-section,.home-user-chip,.story-preview-ring,.post-card')].map(node=>{
              const style=frame.getComputedStyle(node,'::after');
              return {content:style.content,animation:style.animationName,pointerEvents:style.pointerEvents,border:style.borderLeftWidth};
            }),
            animations:[...decoration.children].map(node=>frame.getComputedStyle(node).animationName),
            reduced:frame.matchMedia('(prefers-reduced-motion: reduce)').matches
          });
        });
        </script>`);
      const result = spawnSync(chrome, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${directory}`,
        ...(reduced ? ['--force-prefers-reduced-motion'] : []),
        '--virtual-time-budget=1000', '--dump-dom', pathToFileURL(fixture).href
      ], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      const match = result.stdout.match(/data-result="([^"]+)"/);
      assert.ok(match, `Missing browser result for ${page} at ${width}`);
      const actual = JSON.parse(match[1].replace(/&quot;/g, '"'));
      assert.equal(actual.clicked, true);
      assert.equal(actual.noOverflow, true);
      if (page === 'home-page') {
        assert.equal(actual.display, 'block');
        assert.equal(actual.pointerEvents, 'none');
        assert.equal(actual.hiddenFromAccessibility, true);
        assert.equal(actual.fits, true);
        assert.equal(actual.animations.every(name => name === 'none'), actual.reduced);
        assert.equal(actual.frames.length, 5);
        for (const border of actual.frames) {
          assert.equal(border.content, '""');
          assert.equal(border.pointerEvents, 'none');
          assert.equal(border.border, '1px');
          assert.equal(border.animation, actual.reduced ? 'none' : 'home-gold-frame-pulse');
        }
        if (reduced) assert.equal(actual.reduced, true);
      } else {
        assert.equal(actual.display, 'none');
        assert.equal(actual.frames.every(border => border.content === 'none'), true);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
