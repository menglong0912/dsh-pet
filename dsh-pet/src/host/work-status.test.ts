/**
 * host 工作状态存储单元测试 —— 钉住按写入者聚合与展示快照：
 *  - state 变化才更新 ts；同状态同 seq 不重复更新（防刷屏）；
 *  - task 挂在条目上，展示时与 state 同源同会话；
 *  - 条目一清文案就消失（不会残留到后续活动）；
 *  - 多会话展示取优先级最高者（waiting > error > working > thinking > result > success）。
 *
 * 跑法：node --experimental-strip-types --test src/host/work-status.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { WorkStatusStore, type HostWorkStatusState } from './work-status.ts';

describe('WorkStatusStore —— 按写入者聚合与展示', () => {
  test('state 变化才更新 ts；同状态同 seq 不重复更新（防刷屏）', () => {
    const s = new WorkStatusStore();
    assert.equal(s.setState('a', 'thinking', 1), true);
    const ts1 = s.snapshot().ts;
    assert.equal(s.setState('a', 'thinking', 1), false, '同状态同 seq → 无变化');
    assert.equal(s.snapshot().ts, ts1);
    assert.equal(s.setState('a', 'working', 2), true);
    assert.equal(s.snapshot().state, 'working');
  });

  test('task 随条目存取，且与 state 同源取同一个条目', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    assert.equal(s.setTask('a', '正在执行 phase1'), true);
    assert.deepEqual(
      { state: s.snapshot().state, task: s.snapshot().task },
      { state: 'working', task: '正在执行 phase1' },
    );
  });

  test('无活动条目的会话写 task 不生效（不会制造幽灵文案）', () => {
    const s = new WorkStatusStore();
    assert.equal(s.setTask('ghost', '不该出现'), false);
    assert.equal(s.snapshot().task, null);
  });

  test('多会话：展示取优先级最高者，task 跟着它走（不串会话）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'thinking', 1);
    s.setTask('a', 'A 的任务');
    s.setState('b', 'working', 2); // working(40) > thinking(30) → 展示 b
    assert.equal(s.snapshot().state, 'working');
    assert.equal(s.snapshot().task, null, 'b 没有任务详情 → 不显示 a 的文案');
    s.setTask('b', 'B 的任务');
    assert.equal(s.snapshot().task, 'B 的任务');
    // a 仍在活动：b 掉出去后展示回 a 的 state 与 a 的文案
    s.clear('b');
    assert.equal(s.snapshot().state, 'thinking');
    assert.equal(s.snapshot().task, 'A 的任务');
  });

  test('同档位取 seq 更大者（最近事件优先）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    s.setTask('a', 'A');
    s.setState('b', 'working', 2);
    s.setTask('b', 'B');
    assert.equal(s.snapshot().task, 'B');
  });

  test('条目被清 → 文案一并消失（任务结束后永久残留的根治点）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'success', 1);
    s.setTask('a', '已经做完的旧任务');
    assert.equal(s.clear('a'), true);
    assert.equal(s.snapshot().state, null);
    assert.equal(s.snapshot().task, null, '旧文案不得残留到后续活动');
  });

  test('setTask(null) 清空文案：回落档位文案的那条路', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    s.setTask('a', 'phase1');
    s.setTask('a', null);
    assert.equal(s.snapshot().task, null);
  });

  test('展示优先级表：waiting > error > working > thinking > result > success', () => {
    const order: HostWorkStatusState[] = ['waiting', 'error', 'working', 'thinking', 'result', 'success'];
    for (let i = 0; i < order.length - 1; i += 1) {
      const s = new WorkStatusStore();
      s.setState('low', order[i + 1], 10); // 序号更大：只有优先级能决定胜负
      s.setState('high', order[i], 1);
      assert.equal(s.snapshot().state, order[i], `${order[i]} 应压过 ${order[i + 1]}`);
    }
  });
});
