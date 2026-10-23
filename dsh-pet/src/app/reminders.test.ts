import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthReminders, Pomodoro } from './reminders.ts';
import type { HealthConfig } from './reminders.ts';
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
