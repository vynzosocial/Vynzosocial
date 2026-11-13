const buttons = document.querySelectorAll('button[data-action], button[data-section]');
const errorMessage = document.getElementById('shell-error');
const updateButton = document.getElementById('desktop-update');

function render(state) {
  document.getElementById('section-title').textContent = state.title;
  document.getElementById('version').textContent = `v${state.version}`;
  document.getElementById('back').disabled = !state.canGoBack;
  document.getElementById('forward').disabled = !state.canGoForward;
  document.getElementById('loading-bar').hidden = !state.loading;
  document.body.dataset.connection = state.offline ? 'offline' : state.loading ? 'loading' : 'ready';
  document.getElementById('connection-label').textContent = state.offline ? 'Offline' : state.loading ? 'Loading' : 'Connected';
  const update = state.update;
  updateButton.hidden = !['downloading', 'downloaded', 'installing', 'error'].includes(update.state);
  updateButton.disabled = ['downloading', 'installing'].includes(update.state);
  updateButton.title = update.detail;
  updateButton.textContent = update.state === 'downloading'
    ? update.progress === null ? 'Downloading...' : `Updating ${update.progress}%`
    : update.state === 'installing' ? 'Installing...'
    : update.state === 'error' ? 'Retry update' : 'Update';
  updateButton.setAttribute('aria-label', updateButton.textContent === 'Update' ? 'Update VynzoSocial' : updateButton.textContent);
  for (const button of document.querySelectorAll('.navigation-rail [data-section]')) {
    if (button.dataset.section === state.section) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    errorMessage.hidden = true;
    const { action, section } = button.dataset;
    window.desktopApp.action(section ? 'navigate' : action, section).catch(error => {
      errorMessage.textContent = `Could not complete the desktop action: ${error.message}`;
      errorMessage.hidden = false;
    });
  });
}

window.desktopApp.onState(render);
window.desktopApp.getState().then(render).catch(error => {
  errorMessage.textContent = `Could not initialize the desktop controls: ${error.message}`;
  errorMessage.hidden = false;
});
