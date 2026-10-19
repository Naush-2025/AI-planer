'use strict';

/**
 * AI 解析模块：调用 DeepSeek API（OpenAI 兼容）从聊天记录中提取计划任务。
 * 特别支持「周计划」：把“第 N 周 / 第 N~M 周做某事”解析成贯穿整周（或整段）的
 * 追责式任务 —— repeat=daily + repeatEnds，配合“完成即停止”实现“周一启动、未完成每天追”。
 */

const SYSTEM_PROMPT = `你是一个“长期计划提取助手”。用户会把与 AI 规划未来计划时的聊天记录粘贴给你，你要从中提取出所有可执行的任务/计划条目，输出为严格的 JSON 数组。

【输出格式】只输出一个 JSON 数组，不要任何解释、不要 Markdown 代码块。每个元素结构如下：
{
  "title": "任务标题（简短）",
  "description": "补充说明或原始上下文，可为空字符串",
  "startAt": "开始时间，格式 YYYY-MM-DDTHH:mm:ss，未知则为 null",
  "dueAt": "首次到期/提醒时间，格式 YYYY-MM-DDTHH:mm:ss，未知则为 null",
  "repeatEnds": "重复截止时间，格式 YYYY-MM-DDTHH:mm:ss，无截止则为 null",
  "allDay": false,
  "repeat": "none | daily | weekly | monthly | yearly",
  "repeatInterval": 1,
  "repeatWeekdays": [],
  "targetCount": null,
  "isOngoing": false,
  "reminderMinutes": 30
}

【字段规则】
- repeat 只能是这五个值之一；repeatInterval 为正整数（每 N 天/周/月/年）。
- repeatWeekdays 是数组，元素为 0-6（0=周日,1=周一,…6=周六）；仅当 repeat=weekly 且指定了星期几时填写，否则为空数组。
- repeatEnds 表示重复的截止时间：超过该时间就不再重复。只有 repeat 不是 none 时才可能用到。
- targetCount 为“目标打卡次数”（正整数或 null），是独立机制：表示在这段时间内总共打卡 N 次即可，不要求每天，打满 N 次自动完成。任务没有“总量÷每天进度”时为 null。
- isOngoing 为“持续任务”标记（true/false）：任务有明确的时间段（截止时间），期间每天提醒，可用“已完成”按钮提前结束。有明确截止时间且跨多天的任务（如“X月X号前完成”“第 N 周任务”）应为 true。
- reminderMinutes 为提前多少分钟提醒，默认 30。

【当前时间基准（均为本地时间）】
- 当前日期时间：{{NOW}}
- 当前所在周的周一：{{MONDAY}}
- 计算“第 N 周”时，以“第 1 周”的周一为起点，第 N 周的周一 = 起点周一 + (N-1)*7 天。

【时间推断规则（务必严格遵守）】
1. 【截止时间 + 频率组合，最高优先级】若任务同时包含「截止时间」和「频率」，必须解析成重复任务，绝不能当一次性任务：截止信号（"X月X日前/之前/截止/Deadline" + 日期时间）→ 填 repeatEnds；频率信号（"每天/每日/每周/每月/每年"）→ 填 repeat；dueAt = 今天（立即开始）；isOngoing = true（这是持续任务）。若任务还给出「总量」和「每天进度」，计算目标打卡次数 targetCount = 总量 ÷ 每天进度（例：刷1000题、每天100题 → targetCount=10，表示总共打卡10次即可，不必每天都打，打满10次自动完成）。例："10月22号晚上8点前刷完1000题，每天100题" → dueAt=今天、repeat="daily"、repeatEnds="10月22日20:00"、isOngoing=true、targetCount=10。仅当任务只有明确日期、且无任何频率信号时，才作为一次性任务（repeat="none"、isOngoing=false）的 dueAt。
2. 「第 N 周做某事」这类周计划，是贯穿一整周的任务，必须输出：
   - dueAt = 该周周一 09:00:00
   - repeat = "daily"
   - repeatEnds = 该周周日 23:59:59
   - isOngoing = true（持续任务）
   含义：这一周内每天都提醒打卡，打满这一周的天数即自动完成，也可用“已完成”按钮提前结束。不要只给一个周一的时间点。
3. 「第 N~M 周做某事」这类跨多周任务，输出：
   - dueAt = 第 N 周周一 09:00:00
   - repeat = "daily"
   - repeatEnds = 第 M 周周日 23:59:59
   - isOngoing = true（持续任务）
4. 「第 1 周」的起点：聊天里明确了计划起始日期时，以它所在周的周一为起点；否则以“当前所在周的周一”为起点。
5. 「每周/每周几/每隔几周」是周期性任务：repeat = "weekly"（指定星期几时填 repeatWeekdays）。
6. 「每月/每年」等周期性表述，用对应 repeat。
7. 「第一年/第二年/第 N 天/第 N 个月」等相对时间，以当前日期为起点推算合理日期；完全无法确定的，dueAt 为 null，但标题仍要提取。

【要求】
- 忠实于原文，不臆造原文没有的任务；不遗漏任何明确时间节点。
- 凡是出现“每天/每周/每月”等频率词的任务，一律是重复任务，禁止输出 repeat="none"。
- 「持续任务」和「打卡次数」是两个独立概念：有明确时间段（截止时间）的任务 → isOngoing=true + repeat + repeatEnds；有“总量÷每天进度” → 额外输出 targetCount（打卡满 N 次自动完成）。两者可同时存在，也可只有其一。
- 周计划一律用上面的“daily + repeatEnds + isOngoing=true”规则表达。`;

/**
 * 从模型返回文本中稳健地提取 JSON 数组。
 */
function extractJsonArray(text) {
  if (!text) return [];
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
  } catch (_) {}

  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(t.slice(start, end + 1));
      if (Array.isArray(v)) return v;
    } catch (_) {}
  }
  return [];
}

function pad(n) { return String(n).padStart(2, '0'); }

/** 本地时间格式化：YYYY-MM-DDTHH:mm:ss */
function localIso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** 当前所在周的周一 00:00 */
function mondayOfCurrentWeek() {
  const d = new Date();
  const diff = (d.getDay() + 6) % 7; // 距周一的天数（0=周日）
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 解析聊天记录为任务数组。
 * @param {string} chatText 聊天记录文本
 * @param {object} settings { apiKey, apiBase, model }
 * @returns {Promise<Array<object>>}
 */
async function parseChat(chatText, settings) {
  if (!chatText || !chatText.trim()) {
    throw new Error('聊天记录内容为空，请先粘贴或导入内容。');
  }
  if (!settings || !settings.apiKey) {
    throw new Error('尚未配置 DeepSeek API Key，请先在“设置”中填写。');
  }

  const base = (settings.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const model = settings.model || 'deepseek-chat';

  const system = SYSTEM_PROMPT
    .replace('{{NOW}}', localIso(new Date()))
    .replace('{{MONDAY}}', localIso(mondayOfCurrentWeek()));

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + settings.apiKey
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            '请从下面这段聊天记录中提取所有计划任务，严格按格式输出 JSON 数组：\n\n' +
            chatText.slice(0, 60000)
        }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error && j.error.message ? j.error.message : JSON.stringify(j);
    } catch (_) {}
    throw new Error(`DeepSeek API 请求失败（HTTP ${resp.status}）：${detail || resp.statusText}`);
  }

  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!content) throw new Error('API 返回为空，未解析到内容。');

  const arr = extractJsonArray(content);

  const tasks = arr
    .filter((x) => x && (x.title || x.dueAt))
    .map((x) => {
      const repeat = ['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(x.repeat)
        ? x.repeat
        : 'none';
      const weekdays = Array.isArray(x.repeatWeekdays)
        ? x.repeatWeekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        : [];
      const repeatEnds = repeat === 'none' ? null : normalizeIso(x.repeatEnds);
      const targetCount = repeat === 'none' ? null : (Number.isInteger(x.targetCount) && x.targetCount > 0 ? x.targetCount : null);
      const isOngoing = repeat !== 'none' && !!x.isOngoing;
      return {
        title: String(x.title || '').trim() || '未命名任务',
        description: String(x.description || ''),
        startAt: normalizeIso(x.startAt),
        dueAt: normalizeIso(x.dueAt),
        repeatEnds,
        targetCount,
        isOngoing,
        allDay: !!x.allDay,
        repeat,
        repeatInterval: Number.isInteger(x.repeatInterval) && x.repeatInterval > 0 ? x.repeatInterval : 1,
        repeatWeekdays: repeat === 'weekly' ? weekdays : [],
        reminderMinutes: Number.isFinite(x.reminderMinutes) ? Math.round(x.reminderMinutes) : 30
      };
    });

  if (tasks.length === 0) {
    throw new Error('未能从内容中识别出计划任务，请确认聊天记录里包含明确的时间计划，或手动创建任务。');
  }
  return tasks;
}

function normalizeIso(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { parseChat, extractJsonArray };
