'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveTask: (task) => ipcRenderer.invoke('task:save', task),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  toggleTask: (id) => ipcRenderer.invoke('task:toggle', id),
  completeTask: (id) => ipcRenderer.invoke('task:complete', id),
  checkTask: (id) => ipcRenderer.invoke('task:check', id),
  uncompleteTask: (id) => ipcRenderer.invoke('task:uncomplete', id),
  setRemaining: (id, remaining) => ipcRenderer.invoke('task:setRemaining', id, remaining),
  completeTasks: (ids, completed) => ipcRenderer.invoke('tasks:complete-many', { ids, completed }),
  deleteTasks: (ids) => ipcRenderer.invoke('tasks:delete-many', ids),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  parseChat: (text, settings) => ipcRenderer.invoke('ai:parse', { text, settings }),
  importTasks: (tasks) => ipcRenderer.invoke('tasks:import', tasks),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  readFile: () => ipcRenderer.invoke('file:read'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  testReminder: () => ipcRenderer.invoke('test:reminder'),
  onReminder: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('reminder', listener);
    return () => ipcRenderer.removeListener('reminder', listener);
  }
});
