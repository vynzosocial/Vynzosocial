const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, WebContentsView, Menu, dialog, session, shell, ipcMain
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { SITE_URL, isTrustedUrl, isExternalUrl } = require('./lib/policy.cjs');
const { configurePermissions } = require('./lib/permissions.cjs');
const { createUpdates } = require('./lib/updates.cjs');
const { ROUTES, TITLE_HEIGHT, sectionForUrl, viewBounds, validateAction, isShellSender } = require('./lib/shell-policy.cjs');
const { productName: APP_NAME, version: APP_VERSION } = require('./package.json');

let mainWindow;
let siteView;
let updates;
let updateStatusItem;
const APP_ID = 'com.vynzosocial.desktop';
const shellPath = path.join(__dirname, 'ui', 'shell.html');
const shellUrl = pathToFileURL(shellPath).href;
const websiteCss = fs.readFileSync(path.join(__dirname, 'ui', 'website.css'), 'utf8');
const state = { section: 'home', title: 'Home', loading: true, offline: false };

app.setName(APP_NAME);

// Keep the original profile when upgrading the app's display name.
if (app.getPath('userData') === path.join(app.getPath('appData'), APP_NAME)
  && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Vynzo'));
}

function siteContents() {
  return siteView?.webContents;
}

function shellState() {
  const contents = siteContents();
  return {
    ...state,
    version: APP_VERSION,
    update: updates.status(),
    canGoBack: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()),
    canGoForward: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward())
  };
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('vynzosocial:shell:changed', shellState());
  }
}

function log(message, error) {
  const line = `${new Date().toISOString()} ${message}${error ? `: ${error.stack || error.message || error}` : ''}`;
  console.error(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${line}\n`);
  } catch (writeError) {
    console.error('Could not write desktop log:', writeError);
  }
}

function message(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function notify(title, detail) {
  void message({ type: 'info', title, message: title, detail }).catch(error => log('Could not show desktop message', error));
}

function openExternal(url) {
  if (!isExternalUrl(url)) {
    log(`Blocked external navigation to ${url}`);
    return;
  }
  void shell.openExternal(url).catch(error => {
    log('Could not open external link', error);
    notify('Could not open link', 'Please check that a default web browser is installed.');
  });
}

function loadWebsite(url = SITE_URL) {
  void siteContents().loadURL(url).catch(error => {
    // did-fail-load presents the recovery page.
    log('Website navigation failed', error);
  });
}

function updateMenu() {
  if (updateStatusItem && updates) updateStatusItem.label = updates.status().detail;
  sendState();
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { label: 'Home', accelerator: 'Alt+Home', click: () => loadWebsite() },
        { label: 'Check for desktop updates', click: () => { void updates.check(true); } },
        { id: 'update-status', label: updates.status().detail, enabled: false },
        { type: 'separator' },
        {
          label: `About ${APP_NAME}`,
          click: () => notify(APP_NAME, `Version ${APP_VERSION}\nYour VynzoSocial website features are delivered live.\nCamera and microphone require your permission.\nNotifications require the app to remain open or minimized.`)
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            reloadWebsite();
          }
        },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Open website in browser', click: () => { void shell.openExternal(SITE_URL).catch(error => log('Could not open website', error)); } },
        {
          label: 'Open desktop logs folder',
          click: () => {
            void shell.openPath(app.getPath('userData')).then(error => {
              if (error) { log('Could not open logs folder', new Error(error)); notify('Could not open logs folder', error); }
            }).catch(error => log('Could not open logs folder', error));
          }
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
  updateStatusItem = menu.getMenuItemById('update-status');
}

function reloadWebsite() {
  const contents = siteContents();
  if (isTrustedUrl(contents.getURL())) contents.reload();
  else loadWebsite();
}

function configureShellIpc() {
  const assertSender = event => {
    if (!mainWindow || !isShellSender(event, mainWindow.webContents, shellUrl)) {
      log('Blocked untrusted desktop shell request');
      throw new Error('Desktop controls are only available to the local application shell.');
    }
  };
  ipcMain.handle('vynzosocial:shell:state', event => {
    assertSender(event);
    return shellState();
  });
  ipcMain.handle('vynzosocial:shell:action', (event, type, section) => {
    assertSender(event);
    const destination = validateAction(type, section);
    const contents = siteContents();
    if (destination) {
      loadWebsite(destination);
    } else if (type === 'back' && contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    } else if (type === 'forward' && contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    } else if (type === 'reload') {
      reloadWebsite();
    } else if (type === 'update') {
      return updates.check(true);
    } else if (type === 'menu') {
      contents.focus();
      Menu.getApplicationMenu().popup({ window: mainWindow, x: Math.max(0, mainWindow.getContentBounds().width - 360), y: TITLE_HEIGHT });
    }
  });
}

function configureSession(browserSession) {
  configurePermissions(browserSession, { message, log });
  browserSession.on('will-download', (event, item) => {
    item.setSaveDialogOptions({ title: 'Save VynzoSocial download' });
    item.on('done', (downloadEvent, state) => {
      if (state === 'interrupted') {
        log('Download interrupted');
        notify('Download failed', 'The download was interrupted. Check your connection and try again.');
      }
    });
  });
}

function createWindow(browserSession) {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1280,
    height: 850,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#11131a',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#11131a', symbolColor: '#edf0f7', height: TITLE_HEIGHT - 1 },
    autoHideMenuBar: true,
    icon: app.isPackaged ? path.join(process.resourcesPath, 'logo.png') : path.join(__dirname, '..', 'frontend', 'assets', 'logo.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('did-finish-load', sendState);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  siteView = new WebContentsView({
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true
    }
  });
  siteView.setBackgroundColor('#08080d');
  mainWindow.contentView.addChildView(siteView);
  const resizeView = () => {
    const { width, height } = mainWindow.getContentBounds();
    siteView.setBounds(viewBounds(width, height));
  };
  mainWindow.on('resize', resizeView);
  resizeView();
  const contents = siteContents();
  contents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) loadWebsite(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      log(`Blocked website redirect to ${url}`);
      notify('Navigation blocked', 'Vynzo attempted to redirect outside its trusted website. Use your browser for external websites.');
    }
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('dom-ready', () => {
    if (isTrustedUrl(contents.getURL())) {
      void contents.insertCSS(websiteCss, { cssOrigin: 'user' }).catch(error => log('Could not apply desktop website layout', error));
    }
  });
  const updateNavigation = () => {
    state.section = sectionForUrl(contents.getURL());
    state.title = state.offline ? 'Connection unavailable'
      : ROUTES[state.section]?.title || 'VynzoSocial';
    sendState();
  };
  contents.on('did-start-loading', () => { state.loading = true; sendState(); });
  contents.on('did-navigate', (event, url) => {
    state.offline = !isTrustedUrl(url);
    updateNavigation();
  });
  contents.on('did-navigate-in-page', updateNavigation);
  contents.on('did-stop-loading', () => {
    state.loading = false;
    updateNavigation();
  });
  contents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log(`Could not load ${url}: ${code} ${description}`);
    if (!isTrustedUrl(url)) {
      notify('VynzoSocial could not load', 'The recovery page is unavailable. Check your internet connection, then use View > Reload.');
      return;
    }
    state.offline = true;
    sendState();
    void contents.loadFile(path.join(__dirname, 'ui', 'offline.html')).catch(error => {
      log('Could not show website recovery page', error);
      notify('VynzoSocial could not load', 'Check your internet connection, then use View > Reload.');
    });
  });
  contents.on('render-process-gone', (event, details) => {
    log(`Website process stopped: ${details.reason}`);
    state.offline = true;
    state.loading = false;
    updateNavigation();
    notify('VynzoSocial stopped responding', 'Use View > Reload to reopen the website. Your saved login is retained.');
  });
  mainWindow.on('closed', () => {
    if (!contents.isDestroyed()) contents.close();
    siteView = null;
    mainWindow = null;
  });
  void mainWindow.loadFile(shellPath).catch(error => {
    log('Could not load desktop controls', error);
    dialog.showErrorBox(`${APP_NAME} could not start`, error.message);
    app.quit();
  });
  loadWebsite();
}

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    const browserSession = session.fromPartition('persist:vynzo-desktop');
    configureSession(browserSession);
    updates = createUpdates({
      updater: autoUpdater,
      enabled: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
      notify,
      confirmRestart: async () => {
        const { response } = await message({
          type: 'info',
          title: 'VynzoSocial update ready',
          message: 'Restart VynzoSocial to install the desktop update?',
          detail: 'Finish any active call, upload, or unsaved work before restarting. Choose Later to keep using this version; the Update button stays available until you install.',
          buttons: ['Restart and install', 'Later'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return response === 0;
      },
      log,
      onChange: updateMenu
    });
    buildMenu();
    configureShellIpc();
    createWindow(browserSession);
    void updates.check();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(browserSession);
    });
  }).catch(error => {
    log('Could not start Vynzo desktop', error);
    dialog.showErrorBox('VynzoSocial could not start', error.message);
    app.exit(1);
  });
}
app.on('window-all-closed', () => app.quit());
