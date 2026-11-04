(function () {
  function attach(input) {
    if (input.dataset.toggleReady) return;
    input.dataset.toggleReady = '1';
    const label = document.createElement('label');
    label.className = 'show-password-toggle';
    label.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;cursor:pointer;user-select:none';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.style.cssText = 'width:auto;margin:0';
    box.addEventListener('change', () => {
      input.type = box.checked ? 'text' : 'password';
    });
    label.append(box, document.createTextNode('Show password'));
    input.insertAdjacentElement('afterend', label);
  }

  function init() {
    document.querySelectorAll('input[type="password"]').forEach(attach);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.vynzoAttachPasswordToggles = init;
})();
