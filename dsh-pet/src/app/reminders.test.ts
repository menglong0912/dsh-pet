import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthReminders, OffWorkReminder, Pomodoro } from './reminders.ts';
import type { HealthConfig, OffWorkConfig } from './reminders.ts';
import type { ActivitySnapshot } from './activity.ts';

const MIN = 60_000;
const present = (activeSince: number): ActivitySnapshot => ({
  present: true,
  frontApp: 'A',
  frontSince: activeSince,
  activeSince,
  awaySince: null,
});
const away: ActivitySnapshot = { present: false, frontApp: 'A', frontSince: 0, activeSince: null, awaySince: 0 };

test('pomodoro cycles focus → break → focus and stops when nobody is there at break end', () => {
  const p = new Pomodoro(() => ({ focusMin: 25, breakMin: 5 }));
  assert.equal(p.phase(), null);
  assert.equal(p.remainingMin(0), 0);
  assert.equal(p.start(0), 'focus-start');
  assert.equal(p.remainingMin(0), 25);
  assert.equal(p.remainingMin(24 * MIN + 1), 1);
  assert.equal(p.tick(24 * MIN, true), null);
  assert.equal(p.tick(25 * MIN, true), 'break-start');
  assert.equal(p.phase(), 'break');
  assert.equal(p.tick(30 * MIN, true), 'focus-start');
  assert.equal(p.phase(), 'focus');
  assert.equal(p.tick(55 * MIN, false), 'break-start');
  assert.equal(p.tick(60 * MIN, false), 'stopped-away');
  assert.equal(p.phase(), null);
  p.start(0);
  p.stop();
  assert.equal(p.tick(99 * MIN, true), null);
});

test('sitting reminds after the streak threshold, repeats, and restarts with a new streak', () => {
  const cfg: HealthConfig = {
    sitting: { enabled: true, afterMin: 50, repeatMin: 20 },
    water: { enabled: false, everyMin: 60 },
  };
  const h = new HealthReminders(() => cfg);
  const fire = (now: number, snap: ActivitySnapshot | null, quiet = false) => h.tick(now, snap, quiet);
  assert.deepEqual(fire(49 * MIN, present(0)), []);
  assert.deepEqual(fire(50 * MIN, present(0)), ['sit']);
  assert.deepEqual(fire(60 * MIN, present(0)), []);
  assert.deepEqual(fire(70 * MIN, present(0)), ['sit']);
  // 专注中只记账；专注结束后的下一拍补上
  assert.deepEqual(fire(95 * MIN, present(0), true), []);
  assert.deepEqual(fire(96 * MIN, present(0)), ['sit']);
  // 离开后回来 = 新一轮
  assert.deepEqual(fire(100 * MIN, away), []);
  assert.deepEqual(fire(130 * MIN, present(110 * MIN)), []);
  assert.deepEqual(fire(160 * MIN, present(110 * MIN)), ['sit']);
});

test('water counts only present time and caps sleep gaps', () => {
  const cfg: HealthConfig = {
    sitting: { enabled: false, afterMin: 50, repeatMin: 20 },
    water: { enabled: true, everyMin: 3 },
  };
  const h = new HealthReminders(() => cfg);
  assert.deepEqual(h.tick(0, present(0), false), []);
  assert.deepEqual(h.tick(MIN, present(0), false), []);
  assert.deepEqual(h.tick(2 * MIN, away, false), []); // 离开这一分钟不算
  assert.deepEqual(h.tick(3 * MIN, present(3 * MIN), false), []); // 回来这一拍：在场 2 分钟
  // 系统睡了 2 小时：只按 1 分钟算
  assert.deepEqual(h.tick(123 * MIN, present(3 * MIN), false), ['water']);
  assert.deepEqual(h.tick(124 * MIN, present(3 * MIN), false), []);
});

test('off-work reminds once a day after the set time, waits for presence and focus, skips weekends', () => {
  const cfg: OffWorkConfig = { enabled: true, time: '18:00', weekdaysOnly: true, leadMin: 0 };
  const r = new OffWorkReminder(() => cfg);
  // 2026-10-23 是周五（Date 按本地时间构造）
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
  assert.equal(r.tick(at(23, 17, 59), true, false), null);
  assert.equal(r.tick(at(23, 18), false, false), null); // 不在电脑前：等回来
  assert.equal(r.tick(at(23, 18, 5), true, true), null); // 专注中：等专注结束
  assert.equal(r.tick(at(23, 18, 30), true, false), -30); // 晚了也提醒，告诉调用方已经过了
  assert.equal(r.tick(at(23, 18, 31), true, false), null); // 当天只提醒一次
  // 当天改晚了时间：按新时间再算一次
  cfg.time = '19:00';
  assert.equal(r.tick(at(23, 18, 40), true, false), null);
  assert.equal(r.tick(at(23, 19), true, false), 0);
  // 周末不提醒；关掉「仅工作日」就提醒
  assert.equal(r.tick(at(24, 20), true, false), null);
  cfg.weekdaysOnly = false;
  assert.equal(r.tick(at(24, 20), true, false), -60);
  // 第二天重新计
  cfg.weekdaysOnly = true;
  assert.equal(r.tick(at(26, 19), true, false), 0);
  cfg.enabled = false;
  assert.equal(r.tick(at(27, 19), true, false), null);
});

test('off-work reminds leadMin minutes early and reports how many minutes are left', () => {
  const cfg: OffWorkConfig = { enabled: true, time: '17:30', weekdaysOnly: true, leadMin: 10 };
  const r = new OffWorkReminder(() => cfg);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
  assert.equal(r.tick(at(23, 17, 19), true, false), null);
  assert.equal(r.tick(at(23, 17, 20), true, false), 10);
  assert.equal(r.tick(at(23, 17, 30), true, false), null); // 提前提醒过了，到点不再说
  // 提前那会儿不在：回来时离下班还剩几分钟就报几分钟
  assert.equal(r.tick(at(26, 17, 20), false, false), null);
  assert.equal(r.tick(at(26, 17, 26), true, false), 4);
});
