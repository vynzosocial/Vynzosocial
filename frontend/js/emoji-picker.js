const CATEGORIES = [
  ['😀', 'Smileys', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾'],
  ['👋', 'People', '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 👃 🧠 🫀 🫁 🦷 👀 👁️ 👅 👄 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 💂 🥷 👷 🤴 👸 👳 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💃 🕺 👯 🧘'],
  ['❤️', 'Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💋 💌 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ ⭐ 🌟 💎 🔥 🎉 🎊 🎈 🎁 🏆 🥇 🥈 🥉 🏅'],
  ['🐶', 'Animals', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🐪 🐕 🐈 🐓 🦚 🦜 🕊️ 🐇 🦔 🐉 🌵 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🌹 🌺 🌻 🌼 🌷 🍁 🍄'],
  ['🍕', 'Food', '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥔 🍞 🥐 🧀 🍗 🍖 🥩 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍙 🍚 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍮 🍯 ☕ 🍵 🥛 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧃 🥤'],
  ['⚽', 'Activity', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 ⛳ 🎣 🎽 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 🤺 🏇 🧗 🚴 🏊 🎮 🕹️ 🎲 🎯 🎳 🎰 🧩 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎭'],
  ['🚗', 'Travel', '🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🏍️ 🚲 ✈️ 🚀 🛸 🚁 ⛵ 🚤 🚢 🚂 🚉 🏠 🏡 🏢 🏰 🗼 🗽 ⛪ 🕌 🏖️ 🏝️ 🏔️ ⛰️ 🌋 🗻 🌅 🌄 🌃 🌉 🌈 ☀️ 🌤️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌙 🌍 🌎 🌏'],
  ['💡', 'Objects', '⌚ 📱 💻 ⌨️ 🖥️ 📷 📸 📹 🎥 📞 ☎️ 📺 📻 ⏰ 💡 🔦 📚 📖 📝 ✏️ 🖊️ 📌 📎 ✂️ 🔒 🔑 🔨 ⚙️ 💰 💳 🛒 🎀 🔔 🔊 📢 🚨 ✅ ❌ ❓ ❗ ⚡ ☮️ ☯️ ♾️ 🔞 🏳️ 🏴 🏁 🚩 🏳️‍🌈']
];

export function attachEmojiPicker(form, input) {
  if (!form || !input || form.dataset.emojiReady) return;
  form.dataset.emojiReady = 'true';
  form.classList.add('has-emoji-picker');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'emoji-toggle';
  toggle.textContent = '😊';
  toggle.setAttribute('aria-label', 'Add emoji');
  toggle.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'emoji-panel';
  panel.hidden = true;
  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  panel.append(tabs, grid);

  function showCategory(index) {
    tabs.querySelectorAll('button').forEach((tab, tabIndex) => tab.classList.toggle('active', tabIndex === index));
    grid.replaceChildren();
    CATEGORIES[index][2].split(' ').forEach(emoji => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = emoji;
      button.dataset.emoji = emoji;
      grid.appendChild(button);
    });
    grid.scrollTop = 0;
  }

  CATEGORIES.forEach(([icon, label], index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = icon;
    tab.title = label;
    tab.setAttribute('aria-label', label);
    tab.addEventListener('click', () => showCategory(index));
    tabs.appendChild(tab);
  });
  showCategory(0);

  grid.addEventListener('click', event => {
    const emoji = event.target.dataset?.emoji;
    if (!emoji || input.disabled) return;
    const max = Number(input.maxLength) > 0 ? input.maxLength : Infinity;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const next = input.value.slice(0, start) + emoji + input.value.slice(end);
    if (next.length > max) return;
    input.value = next;
    input.focus();
    const caret = start + emoji.length;
    input.setSelectionRange(caret, caret);
  });

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  form.addEventListener('submit', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });

  input.before(toggle);
  form.appendChild(panel);
}
