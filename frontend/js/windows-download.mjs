export function initWindowsDownload(doc) {
  const button = doc.getElementById('windows-download-button');
  const dialog = doc.getElementById('windows-download-dialog');
  const confirm = doc.getElementById('windows-download-confirm');
  const status = doc.getElementById('windows-download-status');
  const cancel = dialog?.querySelector('.windows-download-cancel');
  const label = button?.querySelector('.windows-download-label');
  if (!button || !dialog || !confirm || !status || !cancel || !label) return;

  button.disabled = true;
  confirm.removeAttribute('href');
  confirm.setAttribute('aria-disabled', 'true');
  confirm.tabIndex = -1;
  if (doc.documentElement.classList.contains('vynzo-android-app')
    || /\bVynzoSocialDesktop\//.test(doc.defaultView.navigator.userAgent)) {
    doc.querySelector('.windows-download-card').hidden = true;
    return;
  }

  const downloadUrl = button.dataset.downloadUrl;
  const translate = text => doc.defaultView.VynzoI18n?.tr(text) || text;
  if (!downloadUrl) {
    status.textContent = translate('Windows download coming soon.');
    label.textContent = status.textContent;
    return;
  }
  let url;
  try {
    url = new URL(downloadUrl);
    if (url.origin !== 'https://vynzo-app-download.vynzolive.workers.dev'
      || !/^\/windows\/VynzoSocial-Setup-\d+\.\d+\.\d+-x64\.exe$/.test(url.pathname)
      || url.search || url.hash || url.username || url.password) {
      throw new Error('The Windows installer URL is not an approved release URL.');
    }
  } catch (error) {
    console.error('Windows download configuration failed:', error);
    status.textContent = translate('Windows download is temporarily unavailable.');
    label.textContent = status.textContent;
    return;
  }

  confirm.href = url.href;
  confirm.removeAttribute('aria-disabled');
  confirm.removeAttribute('tabindex');
  button.disabled = false;
  button.addEventListener('click', () => {
    status.textContent = '';
    confirm.textContent = translate('Yes, download');
    cancel.textContent = translate('Not now');
    dialog.showModal();
  });
  confirm.addEventListener('click', () => {
    status.textContent = translate('Download requested. When it finishes, open the installer from Downloads.');
    cancel.textContent = translate('Close');
    confirm.textContent = translate('Download again');
  });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom)) {
      dialog.close();
    }
  });
}

if (typeof document !== 'undefined') initWindowsDownload(document);
