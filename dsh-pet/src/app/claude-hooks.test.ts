import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANNOUNCE_AFTER_MS, ClaudeSessions, DONE_SHOW_MS, WAITING_STALE_MS, WORKING_STALE_MS } from './claude-hooks.ts';
import { composeWorkStatus, sameStatus } from './status.ts';

const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name,
  session_id: 's1',
  cwd: '/Users/me/work/dsh-pet',
  ...extra,
});

test('session lifecycle drives speech and the composed view', () => {
  const c = new ClaudeSessions();
  assert.equal(c.handle(ev('UserPromptSubmit', { prompt: 'secret' }), 0), null);
  assert.deepEqual(c.view(0), { state: 'working', count: 1, project: 'dsh-pet' });
  // 空闲提醒不说话、不改状态；要权限才说
  assert.equal(c.handle(ev('Notification', { notification_type: 'idle_prompt' }), 1), null);
  assert.deepEqual(c.handle(ev('Notification', { message: 'Claude needs your permission to use Bash' }), 2), {
    kind: 'permission',
    project: 'dsh-pet',
  });
  assert.equal(c.view(3)?.state, 'waiting');
  // 给了权限之后没有事件：等确认过期回到干活中
  assert.equal(c.view(2 + WAITING_STALE_MS + 1)?.state, 'working');
  const end = 2 + ANNOUNCE_AFTER_MS;
  assert.deepEqual(c.handle(ev('Stop'), end), { kind: 'done', project: 'dsh-pet' });
  assert.equal(c.view(end)?.state, 'success');
  assert.equal(c.view(end + DONE_SHOW_MS + 1), null);
  // 秒回的一轮：照样显示完成，但不说话；没见过开头的 Stop 也不说
  c.handle(ev('UserPromptSubmit'), 0);
  assert.equal(c.handle(ev('Stop'), ANNOUNCE_AFTER_MS - 1), null);
  assert.equal(c.view(ANNOUNCE_AFTER_MS)?.state, 'success');
  const later = 10 * ANNOUNCE_AFTER_MS;
  c.handle(ev('UserPromptSubmit'), later);
  c.handle(ev('SessionEnd'), later + 1);
  assert.equal(c.view(later + 1), null);
  assert.equal(c.handle({ ...ev('Stop'), session_id: 'fresh' }, later + 2), null);
  assert.equal(c.handle({ hook_event_name: 'PreToolUse' }, 0), null);
});

test('multiple sessions: waiting wins, counts per state, stale working sessions drop', () => {
  const c = new ClaudeSessions();
  c.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/x/alpha' }, 0);
  c.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'b', cwd: '/x/beta' }, 10);
  assert.deepEqual(c.view(20), { state: 'working', count: 2, project: 'beta' });
  c.handle({ hook_event_name: 'Notification', session_id: 'a', notification_type: 'permission_prompt' }, 30);
  assert.deepEqual(c.view(40), { state: 'waiting', count: 1, project: 'alpha' });
  assert.equal(c.view(30 + WORKING_STALE_MS + 1), null);
});

test('composeWorkStatus priority: claude waiting/working > pomodoro > claude done', () => {
  const pomodoro = { phase: 'focus' as const, remainingMin: 12 };
  assert.deepEqual(composeWorkStatus({ state: 'waiting', count: 1, project: 'p' }, pomodoro), {
    state: 'waiting',
    task: 'Claude · p 等你确认',
  });
  assert.deepEqual(composeWorkStatus({ state: 'working', count: 2, project: 'p' }, pomodoro), {
    state: 'working',
    task: 'Claude ×2 · p',
  });
  assert.deepEqual(composeWorkStatus({ state: 'success', count: 1, project: 'p' }, pomodoro), {
    state: 'working',
    task: '番茄钟 · 剩 12 分',
  });
  assert.deepEqual(composeWorkStatus(null, { phase: 'break', remainingMin: 3 }), {
    state: 'result',
    task: '休息中 · 剩 3 分',
  });
  assert.deepEqual(composeWorkStatus({ state: 'success', count: 1, project: 'p' }, null), {
    state: 'success',
    task: 'Claude · p 完成啦',
  });
  assert.equal(composeWorkStatus(null, null), null);
  assert.equal(sameStatus(null, null), true);
  assert.equal(sameStatus({ state: 'working', task: 'a' }, { state: 'working', task: 'a' }), true);
  assert.equal(sameStatus({ state: 'working', task: 'a' }, null), false);
});
