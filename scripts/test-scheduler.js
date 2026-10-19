'use strict';

// 临时验证脚本：测试 scheduler 的重复规则与补提醒逻辑
const { getOccurrences, reminderTime } = require('../electron/scheduler');

function L(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function t(task, from, to) {
  const occs = getOccurrences(task, from.getTime(), to.getTime());
  return occs.map(L);
}

let pass = 0, fail = 0;
function expect(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n    实际: ' + JSON.stringify(actual) + '\n    期望: ' + JSON.stringify(expected)); }
}

console.log('1. 一次性任务');
{
  const task = { dueAt: '2026-01-01T09:00:00', repeat: 'none', reminderMinutes: 30 };
  expect('区间内返回', t(task, new Date('2025-12-30T00:00:00'), new Date('2026-01-02T00:00:00')),
    ['2026/1/1 09:00:00']);
  expect('区间外为空', t(task, new Date('2026-06-01T00:00:00'), new Date('2026-07-01T00:00:00')), []);
}

console.log('2. 每天重复');
{
  const task = { dueAt: '2025-01-01T09:00:00', repeat: 'daily', repeatInterval: 1, repeatWeekdays: [] };
  const r = t(task, new Date('2025-01-01T00:00:00'), new Date('2025-01-05T23:59:59'));
  expect('连续5天', r.length === 5 && r[0] === '2025/1/1 09:00:00' && r[4] === '2025/1/5 09:00:00', true);
}

console.log('3. 每隔2天');
{
  const task = { dueAt: '2025-01-01T09:00:00', repeat: 'daily', repeatInterval: 2, repeatWeekdays: [] };
  const r = t(task, new Date('2025-01-01T00:00:00'), new Date('2025-01-07T23:59:59'));
  expect('1/3/5/7号', r, ['2025/1/1 09:00:00', '2025/1/3 09:00:00', '2025/1/5 09:00:00', '2025/1/7 09:00:00']);
}

console.log('4. 每周指定星期几（周一三五）');
{
  // 2025-01-01 是周三
  const task = { dueAt: '2025-01-01T09:00:00', repeat: 'weekly', repeatInterval: 1, repeatWeekdays: [1, 3, 5] };
  const r = t(task, new Date('2025-01-01T00:00:00'), new Date('2025-01-10T23:59:59'));
  expect('1/1(三),1/3(五),1/6(一),1/8(三),1/10(五)',
    r, ['2025/1/1 09:00:00', '2025/1/3 09:00:00', '2025/1/6 09:00:00', '2025/1/8 09:00:00', '2025/1/10 09:00:00']);
}

console.log('5. 每周指定星期几（锚点不在列表：锚点周三，只周一）');
{
  const task = { dueAt: '2025-01-01T09:00:00', repeat: 'weekly', repeatInterval: 1, repeatWeekdays: [1] };
  const r = t(task, new Date('2025-01-01T00:00:00'), new Date('2025-01-14T23:59:59'));
  expect('跳过锚点，1/6、1/13', r, ['2025/1/6 09:00:00', '2025/1/13 09:00:00']);
}

console.log('6. 每月重复（31号 clamp 到短月月末）');
{
  const task = { dueAt: '2025-01-31T09:00:00', repeat: 'monthly', repeatInterval: 1, repeatWeekdays: [] };
  const r = t(task, new Date('2025-01-01T00:00:00'), new Date('2025-04-30T23:59:59'));
  expect('1/31,2/28,3/31,4/30', r, ['2025/1/31 09:00:00', '2025/2/28 09:00:00', '2025/3/31 09:00:00', '2025/4/30 09:00:00']);
}

console.log('7. 每年重复（2/29 clamp 到平年 2/28）');
{
  const task = { dueAt: '2024-02-29T09:00:00', repeat: 'yearly', repeatInterval: 1, repeatWeekdays: [] };
  const r = t(task, new Date('2024-01-01T00:00:00'), new Date('2026-12-31T23:59:59'));
  expect('2024/2/29,2025/2/28,2026/2/28', r, ['2024/2/29 09:00:00', '2025/2/28 09:00:00', '2026/2/28 09:00:00']);
}

console.log('8. 提醒时刻（提前30分钟）');
{
  const occ = new Date('2026-01-01T09:00:00').getTime();
  const r = reminderTime({ allDay: false, reminderMinutes: 30 }, occ);
  expect('09:00 - 30min = 08:30', L(r), '2026/1/1 08:30:00');
  const r2 = reminderTime({ allDay: true, reminderMinutes: 30 }, occ);
  expect('全天任务当天 09:00', L(r2), '2026/1/1 09:00:00');
}

console.log('9. 四年长计划（每天重复，共约1460次）');
{
  const task = { dueAt: '2025-01-01T08:00:00', repeat: 'daily', repeatInterval: 1, repeatWeekdays: [] };
  const from = new Date('2025-01-01T00:00:00');
  const to = new Date('2028-12-31T23:59:59');
  const occs = getOccurrences(task, from.getTime(), to.getTime());
  const expectCount = 1461; // 2025~2028 均为平年，共1461天
  expect('四年每天 = ' + expectCount + ' 次', occs.length, expectCount);
}

console.log('10. 周任务（daily + repeatEnds 到周日，共 7 天）');
{
  // 2025-01-06 是周一
  const task = { dueAt: '2025-01-06T09:00:00', repeat: 'daily', repeatInterval: 1, repeatWeekdays: [], repeatEnds: '2025-01-12T23:59:59' };
  const r = t(task, new Date('2025-01-01T00:00:00'), new Date('2025-01-20T23:59:59'));
  expect('一周 7 天（1/6~1/12）',
    r, ['2025/1/6 09:00:00', '2025/1/7 09:00:00', '2025/1/8 09:00:00', '2025/1/9 09:00:00', '2025/1/10 09:00:00', '2025/1/11 09:00:00', '2025/1/12 09:00:00']);
}

console.log('11. 跨周任务（daily + repeatEnds 跨 4 周 = 28 天）');
{
  const task = { dueAt: '2025-01-06T09:00:00', repeat: 'daily', repeatInterval: 1, repeatWeekdays: [], repeatEnds: '2025-02-02T23:59:59' };
  const from = new Date('2025-01-06T00:00:00');
  const to = new Date('2025-02-03T23:59:59');
  const occs = getOccurrences(task, from.getTime(), to.getTime());
  expect('28 天（1/6~2/2）', occs.length, 28);
}

console.log('12. repeatEnds 截止后不再生成');
{
  const task = { dueAt: '2025-01-06T09:00:00', repeat: 'daily', repeatInterval: 1, repeatWeekdays: [], repeatEnds: '2025-01-12T23:59:59' };
  const from = new Date('2025-01-20T00:00:00');
  const to = new Date('2025-02-20T23:59:59');
  const occs = getOccurrences(task, from.getTime(), to.getTime());
  expect('截止后为空', occs.length, 0);
}

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
