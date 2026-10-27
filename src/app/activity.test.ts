import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, AWAY_IDLE_SEC, describeActivity, durationText } from './activity.ts';

const MIN = 60_000;

test('first sample only sets the baseline; idle away is backdated to when input stopped', () => {
  const t = new ActivityTracker();
  assert.deepEqual(t.update({ now: 0, idleSec: 0, locked: false, frontApp: 'Ghostty' }), []);
  assert.deepEqual(t.snapshot(), {
    present: true,
    frontApp: 'Ghostty',
    frontSince: 0,
    activeSince: 0,
    awaySince: null,
  });
  const now = 20 * MIN;
  assert.deepEqual(t.update({ now, idleSec: AWAY_IDLE_SEC, locked: false, frontApp: 'Ghostty' }), [{ type: 'leave' }]);
  assert.equal(t.snapshot()?.awaySince, now - AWAY_IDLE_SEC * 1000);
  assert.deepEqual(t.update({ now: now + 10 * MIN, idleSec: 0, locked: false, frontApp: 'Ghostty' }), [
    { type: 'return', awayMs: 10 * MIN + AWAY_IDLE_SEC * 1000 },
  ]);
  assert.equal(t.snapshot()?.activeSince, now + 10 * MIN);
});

test('short pauses keep the active streak; lock leaves immediately; switches only while present', () => {
  const t = new ActivityTracker();
  t.update({ now: 0, idleSec: 0, locked: false, frontApp: 'A' });
  assert.deepEqual(t.update({ now: MIN, idleSec: AWAY_IDLE_SEC - 1, locked: false, frontApp: 'B' }), [
    { type: 'switch', from: 'A', to: 'B' },
  ]);
  assert.equal(t.snapshot()?.activeSince, 0);
  assert.deepEqual(t.update({ now: 2 * MIN, idleSec: 0, locked: true, frontApp: null }), [{ type: 'leave' }]);
  assert.equal(t.snapshot()?.awaySince, 2 * MIN);
  assert.deepEqual(t.update({ now: 3 * MIN, idleSec: 0, locked: true, frontApp: 'C' }), []);
  assert.equal(t.snapshot()?.frontApp, 'B');
  // 回来时前台已换：只出 return，不出 switch（离开期间的切换不算）
  assert.deepEqual(t.update({ now: 4 * MIN, idleSec: 0, locked: false, frontApp: 'C' }), [
    { type: 'return', awayMs: 2 * MIN },
  ]);
  assert.equal(t.snapshot()?.frontApp, 'C');
  // 取不到前台（桌宠自己在前台）沿用上一次
  assert.deepEqual(t.update({ now: 5 * MIN, idleSec: 0, locked: false, frontApp: null }), []);
  assert.equal(t.snapshot()?.frontApp, 'C');
});

test('describeActivity and durationText render the prompt line', () => {
  assert.equal(durationText(30_000), '不到 1 分钟');
  assert.equal(durationText(12 * MIN), '12 分钟');
  assert.equal(durationText(120 * MIN), '2 小时');
  assert.equal(durationText(135 * MIN), '2 小时 15 分钟');
  assert.equal(describeActivity(null, 0), '');
  const t = new ActivityTracker();
  t.update({ now: 0, idleSec: 0, locked: false, frontApp: '飞书' });
  assert.equal(describeActivity(t.snapshot(), 48 * MIN), '【主人此刻】正在用「飞书」48 分钟；已经连续用电脑 48 分钟。');
  t.update({ now: 50 * MIN, idleSec: 0, locked: true, frontApp: null });
  assert.equal(describeActivity(t.snapshot(), 57 * MIN), '【主人此刻】已经离开电脑 7 分钟了。');
});
