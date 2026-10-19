'use strict';

/**
 * 提醒调度器：负责计算任务的每次到期时刻（occurrence），
 * 支持 none / daily / weekly / monthly / yearly 重复规则，
 * 并在错过时（如关机期间）进行补提醒。
 *
 * 时间约定：repeatWeekdays 采用 JS Date.getDay() —— 0=周日, 1=周一 … 6=周六。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SCAN_INTERVAL_MS = 30 * 1000; // 每 30 秒扫描一次

function daysInMonth(year, month) {
  // month: 0-11
  return new Date(year, month + 1, 0).getDate();
}

function dateKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 计算严格大于 cur 的下一个 occurrence（Date 对象，保留 dueAt 的时分秒） */
function nextOccurrence(task, cur) {
  const a = new Date(task.dueAt);
  const d = new Date(cur);
  const interval = Math.max(1, Number(task.repeatInterval) || 1);
  const wd = Array.isArray(task.repeatWeekdays) ? task.repeatWeekdays : [];

  switch (task.repeat) {
    case 'daily':
      d.setDate(d.getDate() + interval);
      d.setHours(a.getHours(), a.getMinutes(), 0, 0);
      return d;

    case 'weekly': {
      if (wd.length > 0) {
        do {
          d.setDate(d.getDate() + 1);
        } while (!wd.includes(d.getDay()));
      } else {
        d.setDate(d.getDate() + 7 * interval);
      }
      d.setHours(a.getHours(), a.getMinutes(), 0, 0);
      return d;
    }

    case 'monthly': {
      d.setDate(1); // 先归到 1 号，避免 31 号 + 短月溢出
      d.setMonth(d.getMonth() + interval);
      const last = daysInMonth(d.getFullYear(), d.getMonth());
      d.setDate(Math.min(a.getDate(), last)); // 31 号在短月 clamp 到月末
      d.setHours(a.getHours(), a.getMinutes(), 0, 0);
      return d;
    }

    case 'yearly': {
      d.setMonth(0);
      d.setDate(1);
      d.setFullYear(d.getFullYear() + interval);
      d.setMonth(a.getMonth());
      const last = daysInMonth(d.getFullYear(), a.getMonth());
      d.setDate(Math.min(a.getDate(), last)); // 2/29 在平年 clamp 到 2/28
      d.setHours(a.getHours(), a.getMinutes(), 0, 0);
      return d;
    }

    default:
      return d;
  }
}

/** 返回任务在 [fromMs, toMs] 区间内的所有 occurrence（毫秒时间戳数组） */
function getOccurrences(task, fromMs, toMs) {
  if (!task.dueAt) return [];
  const anchor = new Date(task.dueAt);
  if (Number.isNaN(anchor.getTime())) return [];

  // 重复截止时间：超过该时刻不再生成 occurrence（用于跨周/周内追责式提醒）
  let repeatEndsMs = null;
  if (task.repeatEnds) {
    const re = new Date(task.repeatEnds);
    if (!Number.isNaN(re.getTime())) repeatEndsMs = re.getTime();
  }

  if (task.repeat === 'none' || task.repeat == null) {
    const t = anchor.getTime();
    return t >= fromMs && t <= toMs ? [t] : [];
  }

  let cur = new Date(anchor);
  // weekly + 指定星期几：若锚点当天不在列表中，先跳到下一个匹配日
  const wd = Array.isArray(task.repeatWeekdays) ? task.repeatWeekdays : [];
  if (task.repeat === 'weekly' && wd.length > 0 && !wd.includes(cur.getDay())) {
    cur = nextOccurrence(task, cur);
  }

  const out = [];
  let guard = 0;
  // 前移直到进入区间（或超出截止）
  while (cur.getTime() < fromMs && guard < 200000) {
    if (repeatEndsMs != null && cur.getTime() > repeatEndsMs) return out;
    cur = nextOccurrence(task, cur);
    guard++;
  }
  guard = 0;
  while (cur.getTime() <= toMs && guard < 200000) {
    if (repeatEndsMs != null && cur.getTime() > repeatEndsMs) break;
    out.push(cur.getTime());
    cur = nextOccurrence(task, cur);
    guard++;
  }
  return out;
}

/** 该 occurrence 对应的提醒时刻（毫秒） */
function reminderTime(task, occMs) {
  if (task.allDay) {
    const d = new Date(occMs);
    d.setHours(9, 0, 0, 0); // 全天任务默认当天上午 9 点提醒
    return d.getTime();
  }
  const lead = Number.isFinite(task.reminderMinutes) ? task.reminderMinutes : 0;
  return occMs - lead * MINUTE_MS;
}

class Scheduler {
  /**
   * @param {import('./store').Store} store
   * @param {(payload: {task: object, remindAt: number, occurredAt: number, missed: boolean}) => void} onRemind
   */
  constructor(store, onRemind) {
    this.store = store;
    this.onRemind = onRemind;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this._tick(); // 启动立即补扫一次（覆盖关机期间错过的提醒）
    this.timer = setInterval(() => this._tick(), SCAN_INTERVAL_MS);
    this.timer.unref && this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _tick() {
    try {
      const now = Date.now();
      const settings = this.store.getSettings();
      const lookback = Math.max(1, Number(settings.catchUpWindowDays) || 7) * DAY_MS;
      const from = now - lookback;
      const to = now + lookback; // 向前覆盖到最大提前提醒量

      const tasks = this.store.listTasks().filter((t) => {
        if (t.completed || !t.dueAt) return false;
        if (t.targetCount && this.store.getDoneCount(t.id) >= t.targetCount) return false; // 持续任务打卡目标已达成
        return true;
      });
      for (const task of tasks) {
        const occs = getOccurrences(task, from, to);
        for (const occMs of occs) {
          const remindAt = reminderTime(task, occMs);
          if (remindAt > now) continue; // 提醒时刻还没到
          if (occMs < from) continue; // 太久远，不补
          // 重复任务：该 occurrence 当天已完成则跳过
          if (task.repeat && task.repeat !== 'none' && this.store.isDoneOnDate(task.id, dateKeyOf(occMs))) {
            continue;
          }
          const key = new Date(occMs).toISOString();
          if (this.store.markReminded(task.id, key)) {
            this.onRemind({
              task,
              remindAt,
              occurredAt: occMs,
              missed: occMs < now
            });
          }
        }
      }
    } catch (err) {
      console.error('[scheduler] 扫描失败：', err);
    }
  }

  /** 供 UI 展示：任务下一次提醒时刻（毫秒），无则 null */
  nextReminder(task) {
    if (!task.dueAt) return null;
    if (task.targetCount && this.store.getDoneCount(task.id) >= task.targetCount) return null; // 持续任务打卡目标已达成
    const now = Date.now();
    const settings = this.store.getSettings();
    const lookback = Math.max(1, Number(settings.catchUpWindowDays) || 7) * DAY_MS;
    const occs = getOccurrences(task, now - lookback, now + 400 * DAY_MS); // 向前看约一年
    for (const occMs of occs) {
      if (task.repeat && task.repeat !== 'none' && this.store.isDoneOnDate(task.id, dateKeyOf(occMs))) {
        continue; // 已完成，跳到下一个
      }
      const remindAt = reminderTime(task, occMs);
      if (remindAt >= now - 60 * 1000) return remindAt;
    }
    return null;
  }
}

module.exports = { Scheduler, getOccurrences, reminderTime, nextOccurrence, dateKeyOf, DAY_MS, MINUTE_MS };
