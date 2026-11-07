(function () {
  'use strict';

  const login = document.getElementById('login-form');
  const register = document.getElementById('register-form');
  const form = login || register;
  const viewport = window.visualViewport;
  if (!form || !viewport) return;

  const first = document.getElementById(login ? 'email' : 'username');
  const second = document.getElementById(login ? 'password' : 'first_name');
  const lastName = register && document.getElementById('last_name');
  if (!first || !second || (register && !lastName)) return;

  function keepFieldsVisible() {
    const active = document.activeElement;
    const compact = login ? active === first || active === second : active === second || active === lastName;
    if (!compact || viewport.height > 500) return;

    const start = first.closest('.form-group').getBoundingClientRect();
    const end = second.closest('.form-group').getBoundingClientRect();
    const top = viewport.offsetTop;
    const bottom = top + viewport.height;
    if (end.bottom - start.top > viewport.height - 16) {
      active.scrollIntoView({ block: 'nearest' });
    } else if (start.top < top || end.bottom > bottom) {
      window.scrollBy(0, start.top - top - 8);
    }
  }

  function scheduleAdjustment() {
    requestAnimationFrame(() => requestAnimationFrame(keepFieldsVisible));
  }

  form.addEventListener('focusin', scheduleAdjustment);
  viewport.addEventListener('resize', scheduleAdjustment);
})();
