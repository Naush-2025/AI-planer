'use strict';

/**
 * 数据持久化层：使用 JSON 文件原子写入，承载四年长计划的数据可靠性。
 * 数据保存在 Electron userData 目录（Windows 下为 %APPDATA%/AI计划表/data.json）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

class Store {
  constructor(userDataDir) {
    this.dataDir = userDataDir;
    this.dataFile = path.join(userDataDir, 'data.json');
    this.data = null;
    this._load();
  }

  _defaultData() {
    return {
      version: SCHEMA_VERSION,
      settings: {
        apiKey: '',
        apiBase: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        defaultReminderMinutes: 30,
        launchOnStartup: true,
        notifyOnStartup: true,
        catchUpWindowDays: 7,
        closeToTray: true,
        panes: [
          { type: 'today', days: 7 },
          { type: 'all', days: 7 },
          { type: 'upcoming', days: 7 },
          { type: 'overdue', days: 7 }
        ]
      },
      tasks: [],
      reminderLog: [],
      completionLog: []
    };
  }

  _load() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        // 合并默认值，防止版本升级后缺少字段
        const def = this._defaultData();
        this.data = {
          ...def,
          ...parsed,
          settings: { ...def.settings, ...(parsed.settings || {}) }
        };
        // 迁移：旧数据的「已完成」区域类型已移除，改成「已过期」
        if (Array.isArray(this.data.settings.panes)) {
          this.data.settings.panes = this.data.settings.panes.map((p) => {
            if (p && p.type === 'completed') return { ...p, type: 'overdue' };
            return p;
          });
        }
      } else {
        this.data = this._defaultData();
        this._persist();
      }
    } catch (err) {
      console.error('[store] 读取数据失败，回退到空数据：', err);
      this.data = this._defaultData();
      // 备份损坏文件，避免覆盖
      try {
        if (fs.existsSync(this.dataFile)) {
          fs.copyFileSync(this.dataFile, this.dataFile + '.corrupt-' + Date.now());
        }
      } catch (_) {}
    }
  }

  _persist() {
    // 原子写：先写临时文件，再 rename 覆盖，防止中途断电损坏四年数据
    const tmp = this.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.dataFile);
  }

  save() {
    this._persist();
  }

  // ---- settings ----
  getSettings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this._persist();
    return this.data.settings;
  }

  // ---- tasks ----
  listTasks() {
    return this.data.tasks;
  }

  getTask(id) {
    return this.data.tasks.find((t) => t.id === id) || null;
  }

  upsertTask(task) {
    const list = this.data.tasks;
    const idx = list.findIndex((t) => t.id === task.id);
    const record = {
      id: task.id || uid(),
      title: String(task.title || '未命名任务').trim(),
      description: String(task.description || ''),
      startAt: task.startAt || null,
      dueAt: task.dueAt || null,
      allDay: !!task.allDay,
      repeat: task.repeat || 'none',
      repeatInterval: Number(task.repeatInterval) || 1,
      repeatWeekdays: Array.isArray(task.repeatWeekdays) ? task.repeatWeekdays : [],
      repeatEnds: task.repeatEnds || null,
      targetCount: Number.isFinite(task.targetCount) && task.targetCount > 0 ? Math.round(task.targetCount) : null,
      isOngoing: !!task.isOngoing,
      reminderMinutes: Number.isFinite(task.reminderMinutes) ? task.reminderMinutes : this.data.settings.defaultReminderMinutes,
      completed: !!task.completed,
      createdAt: task.createdAt || nowIso(),
      updatedAt: nowIso()
    };
    if (idx >= 0) {
      record.createdAt = list[idx].createdAt || record.createdAt;
      list[idx] = record;
    } else {
      list.push(record);
    }
    this._persist();
    return record;
  }

  deleteTask(id) {
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
    this.data.reminderLog = this.data.reminderLog.filter((r) => r.taskId !== id);
    this.data.completionLog = this.data.completionLog.filter((r) => r.taskId !== id);
    this._persist();
  }

  setCompleted(id, completed) {
    const t = this.getTask(id);
    if (t) {
      t.completed = completed;
      t.updatedAt = nowIso();
      this._persist();
    }
    return t;
  }

  // 重复任务按天完成：记录某任务在某天（YYYY-MM-DD）已完成
  isDoneOnDate(taskId, dateKey) {
    return this.data.completionLog.some((r) => r.taskId === taskId && r.dateKey === dateKey);
  }

  toggleDoneOnDate(taskId, dateKey) {
    const idx = this.data.completionLog.findIndex((r) => r.taskId === taskId && r.dateKey === dateKey);
    if (idx >= 0) {
      this.data.completionLog.splice(idx, 1);
    } else {
      this.data.completionLog.push({ taskId, dateKey });
    }
    if (this.data.completionLog.length > 50000) {
      this.data.completionLog = this.data.completionLog.slice(-50000);
    }
    this._persist();
    return this.isDoneOnDate(taskId, dateKey);
  }

  // 已打卡次数（completionLog 里该任务的记录数）
  getDoneCount(taskId) {
    return this.data.completionLog.filter((r) => r.taskId === taskId).length;
  }

  // 清空某任务的所有打卡记录（撤销完成用）
  clearCompletion(taskId) {
    this.data.completionLog = this.data.completionLog.filter((r) => r.taskId !== taskId);
    this._persist();
  }

  // 设置某任务的打卡数量为 count（部分撤销用），日期从 dueAt 起连续分配
  setCompletionCount(taskId, count) {
    this.data.completionLog = this.data.completionLog.filter((r) => r.taskId !== taskId);
    const task = this.getTask(taskId);
    if (task && task.dueAt && count > 0) {
      const start = new Date(task.dueAt);
      for (let i = 0; i < count; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        this.data.completionLog.push({ taskId, dateKey: dateKeyOf(d.getTime()) });
      }
    }
    this._persist();
  }

  // 找下一个未打卡的日期（从今天起，在时间段内）
  nextUndoneDateKey(taskId) {
    const task = this.getTask(taskId);
    if (!task || !task.dueAt) return null;
    const doneCount = this.getDoneCount(taskId);
    // 打满目标次数后不再打卡
    if (task.targetCount && doneCount >= task.targetCount) return null;
    // 有明确时间段的持续任务：打卡满「今天到截止」的剩余天数后不再打卡
    if (!task.targetCount && task.repeatEnds) {
      const nowMs = Date.now();
      const startMs = Math.max(nowMs, new Date(task.dueAt).getTime());
      const endMs = new Date(task.repeatEnds).getTime();
      const remainingDays = Math.max(0, Math.floor((endMs - startMs) / 86400000) + 1);
      if (remainingDays > 0 && doneCount >= remainingDays) return null;
    }
    const doneDates = new Set(this.data.completionLog.filter((r) => r.taskId === taskId).map((r) => r.dateKey));
    const start = new Date(task.dueAt);
    const end = task.repeatEnds ? new Date(task.repeatEnds) : new Date(Date.now() + 365 * 86400000);
    let cur = new Date();
    cur.setHours(0, 0, 0, 0);
    if (cur.getTime() < start.getTime()) cur = new Date(start);
    for (let i = 0; i < 3660; i++) {
      if (cur.getTime() > end.getTime()) break; // 先检查截止时间
      const key = dateKeyOf(cur.getTime());
      if (!doneDates.has(key)) return key;
      cur.setDate(cur.getDate() + 1);
    }
    return null;
  }

  // 批量设置完成状态，返回实际变更数量
  setCompletedMany(ids, completed) {
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    let changed = 0;
    for (const t of this.data.tasks) {
      if (idSet.has(t.id) && !!t.completed !== !!completed) {
        t.completed = !!completed;
        t.updatedAt = nowIso();
        changed++;
      }
    }
    if (changed) this._persist();
    return changed;
  }

  // 批量删除任务，同时清理对应提醒日志，返回剩余任务数
  deleteTasks(ids) {
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    this.data.tasks = this.data.tasks.filter((t) => !idSet.has(t.id));
    this.data.reminderLog = this.data.reminderLog.filter((r) => !idSet.has(r.taskId));
    this.data.completionLog = this.data.completionLog.filter((r) => !idSet.has(r.taskId));
    this._persist();
    return this.data.tasks.length;
  }

  importTasks(tasks) {
    let added = 0;
    for (const raw of tasks) {
      if (!raw || !raw.title) continue;
      this.upsertTask(raw);
      added++;
    }
    return added;
  }

  // ---- reminder log ----
  hasReminded(taskId, scheduledAtIso) {
    return this.data.reminderLog.some(
      (r) => r.taskId === taskId && r.scheduledAt === scheduledAtIso
    );
  }

  markReminded(taskId, scheduledAtIso) {
    if (this.hasReminded(taskId, scheduledAtIso)) return false;
    this.data.reminderLog.push({
      taskId,
      scheduledAt: scheduledAtIso,
      triggeredAt: nowIso()
    });
    // 防止日志无限增长，最多保留 20000 条
    if (this.data.reminderLog.length > 20000) {
      this.data.reminderLog = this.data.reminderLog.slice(-20000);
    }
    this._persist();
    return true;
  }
}

function dateKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { Store, uid, dateKeyOf };
