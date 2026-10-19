'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { Scheduler, getOccurrences, dateKeyOf } = require('./scheduler');
const { parseChat } = require('./ai');

let store;
let scheduler;
let mainWindow = null;
let tray = null;
let isQuitting = false;

const GOT_SINGLE_INSTANCE = app.requestSingleInstanceLock();
if (!GOT_SINGLE_INSTANCE) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// 托盘/窗口图标：优先使用生成的 PNG，否则内嵌位图兜底
function buildIcon() {
  try {
    const p = path.join(__dirname, '..', 'assets', 'tray.png');
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  } catch (_) {}
  // 兜底：16x16 蓝色圆点（BGRA 位图）
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const dx = x - 7.5;
    const dy = y - 7.5;
    const inCircle = dx * dx + dy * dy <= 6.5 * 6.5;
    buf[i * 4] = inCircle ? 0x40 : 0; // B
    buf[i * 4 + 1] = inCircle ? 0x8c : 0; // G
    buf[i * 4 + 2] = inCircle ? 0xff : 0; // R
    buf[i * 4 + 3] = inCircle ? 0xff : 0; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'AI计划表',
    autoHideMenuBar: true,
    icon: buildIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 关闭窗口时最小化到托盘（除非正在退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting && store && store.getSettings().closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(buildIcon());
  tray.setToolTip('AI计划表');
  const startupOn = app.getLoginItemSettings().openAtLogin;

  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showWindow() },
    { label: '立即检查提醒', click: () => scheduler && scheduler._tick() },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: startupOn,
      click: (item) => setStartup(item.checked)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function setStartup(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    if (store) store.updateSettings({ launchOnStartup: !!enabled });
    return app.getLoginItemSettings().openAtLogin;
  } catch (err) {
    console.error('[startup] 设置开机自启失败：', err);
    return app.getLoginItemSettings().openAtLogin;
  }
}

function showNotification({ task, missed }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: missed ? '⏰ 补提醒 · 时间点已过' : '⏰ 计划提醒',
    body: missed
      ? `${task.title}\n这个时间点已过，别忘补上！`
      : `${task.title}\n${formatDue(task)}`
  });
  n.on('click', () => showWindow());
  n.show();
}

function notifyTodaySummary() {
  try {
    if (!Notification.isSupported()) return;
    if (!store || !scheduler) return;
    if (store.getSettings().notifyOnStartup === false) return;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + 24 * 60 * 60 * 1000;
    const todayKey = dateKeyOf(Date.now());
    const today = store.listTasks().filter((t) => {
      if (t.completed || !t.dueAt) return false;
      // 持续任务打卡目标已达成则跳过
      if (t.targetCount && store.getDoneCount(t.id) >= t.targetCount) return false;
      // 重复任务今天已完成则跳过
      if (t.repeat && t.repeat !== 'none' && store.isDoneOnDate(t.id, todayKey)) return false;
      // 判断“今天是否有到期/提醒时刻”，而不是“下一次提醒是否在未来”
      return getOccurrences(t, start.getTime(), end).length > 0;
    });
    if (today.length === 0) return;
    const names = today.slice(0, 4).map((t) => t.title).join('、');
    const more = today.length > 4 ? ` 等 ${today.length} 个` : '';
    new Notification({
      title: `📋 今日任务（${today.length}）`,
      body: names + more
    }).show();
  } catch (err) {
    console.error('[startup] 今日任务汇总失败：', err);
  }
}

function formatDue(task) {
  if (!task.dueAt) return '';
  const d = new Date(task.dueAt);
  const s = d.toLocaleString('zh-CN', { hour12: false });
  const repeatText = task.repeat && task.repeat !== 'none' ? ` · 每${repeatLabel(task.repeat)}` : '';
  return `时间：${s}${repeatText}`;
}

function repeatLabel(r) {
  return { daily: '天', weekly: '周', monthly: '月', yearly: '年' }[r] || r;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state:get', () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = start.getTime() + 24 * 60 * 60 * 1000;
    const todayKey = dateKeyOf(Date.now());
    return {
      tasks: store.listTasks().map((t) => {
        const doneCount = store.getDoneCount(t.id);
        let remaining = null;
        let finished = false;
        if (t.targetCount) {
          finished = doneCount >= t.targetCount;
          remaining = Math.max(0, t.targetCount - doneCount);
        } else if (t.dueAt && t.repeatEnds) {
          // 有明确时间段的重复/持续任务：打卡满「今天到截止」的剩余天数 = 完成
          const nowMs = Date.now();
          const startMs = Math.max(nowMs, new Date(t.dueAt).getTime());
          const endMs = new Date(t.repeatEnds).getTime();
          const remainingDays = Math.max(0, Math.floor((endMs - startMs) / 86400000) + 1);
          finished = remainingDays > 0 && doneCount >= remainingDays;
          remaining = Math.max(0, remainingDays - doneCount);
        }
        return {
          ...t,
          nextReminder: scheduler.nextReminder(t),
          isToday: getOccurrences(t, start.getTime(), end).length > 0,
          done: (t.repeat && t.repeat !== 'none') ? store.isDoneOnDate(t.id, todayKey) : !!t.completed,
          doneCount,
          remaining,
          finished
        };
      }),
      settings: store.getSettings(),
      startup: app.getLoginItemSettings().openAtLogin
    };
  });

  ipcMain.handle('task:save', (_e, task) => store.upsertTask(task || {}));
  ipcMain.handle('task:delete', (_e, id) => store.deleteTask(id));
  ipcMain.handle('task:toggle', (_e, id) => {
    const task = store.getTask(id);
    if (!task) return null;
    if (task.repeat && task.repeat !== 'none') {
      // 重复任务：toggle 今天的完成状态，任务本身继续，明天照常提醒
      return store.toggleDoneOnDate(id, dateKeyOf(Date.now()));
    }
    return store.setCompleted(id, !task.completed);
  });

  ipcMain.handle('task:complete', (_e, id) => {
    const task = store.getTask(id);
    if (!task) return null;
    return store.setCompleted(id, !task.completed);
  });

  ipcMain.handle('task:check', (_e, id) => {
    const key = store.nextUndoneDateKey(id);
    if (key) store.toggleDoneOnDate(id, key);
    return key;
  });

  ipcMain.handle('task:uncomplete', (_e, id) => {
    const task = store.getTask(id);
    if (!task) return null;
    store.setCompleted(id, false);
    store.clearCompletion(id);
    return true;
  });

  ipcMain.handle('task:setRemaining', (_e, id, remaining) => {
    const task = store.getTask(id);
    if (!task) return null;
    const r = Math.max(0, parseInt(remaining, 10) || 0);
    let total = task.targetCount;
    if (!total && task.dueAt && task.repeatEnds) {
      total = Math.floor((new Date(task.repeatEnds).getTime() - new Date(task.dueAt).getTime()) / 86400000) + 1;
    }
    const doneTarget = Math.max(0, (total || 0) - r);
    store.setCompletionCount(id, doneTarget);
    store.setCompleted(id, false);
    return doneTarget;
  });

  ipcMain.handle('tasks:complete-many', (_e, { ids, completed }) => {
    const todayKey = dateKeyOf(Date.now());
    for (const id of (Array.isArray(ids) ? ids : [])) {
      const task = store.getTask(id);
      if (!task) continue;
      if (task.repeat && task.repeat !== 'none') {
        // 重复任务：批量设置今天的完成状态
        const isDone = store.isDoneOnDate(id, todayKey);
        if (!!completed !== isDone) store.toggleDoneOnDate(id, todayKey);
      } else {
        store.setCompleted(id, !!completed);
      }
    }
    return true;
  });
  ipcMain.handle('tasks:delete-many', (_e, ids) => store.deleteTasks(ids));

  ipcMain.handle('settings:update', (_e, patch) => store.updateSettings(patch || {}));

  ipcMain.handle('ai:parse', async (_e, { text, settings }) => {
    const merged = {
      apiKey: settings && settings.apiKey ? settings.apiKey : store.getSettings().apiKey,
      apiBase: settings && settings.apiBase ? settings.apiBase : store.getSettings().apiBase,
      model: settings && settings.model ? settings.model : store.getSettings().model
    };
    return await parseChat(text, merged);
  });

  ipcMain.handle('tasks:import', (_e, tasks) => store.importTasks(tasks || []));

  ipcMain.handle('startup:set', (_e, enabled) => setStartup(enabled));

  ipcMain.handle('window:hide', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.handle('test:reminder', () => {
    if (!Notification.isSupported()) return false;
    new Notification({
      title: '✅ 提醒功能正常',
      body: '这是一条测试通知。看到它说明提醒机制工作正常。'
    }).show();
    return true;
  });

  ipcMain.handle('external:open', (_e, url) => {
    if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // 文件读取：渲染进程选择文件后，主进程读文本内容
  ipcMain.handle('file:read', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择聊天记录文件',
      properties: ['openFile'],
      filters: [
        { name: '文本 / Markdown / JSON', extensions: ['txt', 'md', 'markdown', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const fp = res.filePaths[0];
    const content = fs.readFileSync(fp, 'utf8');
    return { name: path.basename(fp), content };
  });
}

// ---------- 应用生命周期 ----------
app.whenReady().then(() => {
  // 固定 userData 为英文目录，避免中文路径在部分环境导致 Chromium 缓存创建失败；
  // 也保证与旧版本数据目录（ai-planer）兼容。
  app.setPath('userData', path.join(app.getPath('appData'), 'ai-planer'));
  store = new Store(app.getPath('userData'));

  // 开机自启：按设置同步注册到系统（首次启动也要注册，否则重启不会自启）
  try {
    if (app.isPackaged && store.getSettings().launchOnStartup !== false) {
      app.setLoginItemSettings({ openAtLogin: true });
    }
  } catch (err) {
    console.error('[startup] 注册开机自启失败：', err);
  }

  scheduler = new Scheduler(store, (payload) => {
    showNotification(payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reminder', payload);
    }
  });

  registerIpc();
  createWindow();
  createTray();
  scheduler.start();
  setTimeout(notifyTodaySummary, 2000);

  // 应用启动时的提示
  const startup = app.getLoginItemSettings().openAtLogin;

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // 保持托盘常驻，不退出（除非用户从托盘选择退出）
});
