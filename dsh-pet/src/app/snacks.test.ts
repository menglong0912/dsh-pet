import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSnack, POUCH_MAX, SNACKS, SnackPouch } from './snacks.ts';

/** 2026-10-24 是周六；Date 按本地时间构造 */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

function withPouch(fn: (path: string, warnings: string[]) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pet-snacks-'));
  try {
    fn(join(dir, 'snacks.json'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('one snack per meal while the owner is at the computer, none between meals', () => {
  withPouch((path) => {
    const pouch = new SnackPouch(
      path,
      () => undefined,
      () => 0,
    );
    assert.equal(pouch.tick(at(24, 10), true), null, '两顿之间');
    assert.equal(pouch.tick(at(24, 12), false), null, '不在电脑前：等回来');
    assert.deepEqual(pouch.tick(at(24, 12, 5), true), { meal: '午饭', snack: findSnack('糖葫芦') });
    assert.equal(pouch.tick(at(24, 12, 30), true), null, '这顿分过了');
    assert.equal(pouch.tick(at(24, 18), true)?.meal, '晚饭');
    assert.equal(pouch.tick(at(25, 8), true)?.meal, '早饭', '第二天重新算');
    assert.deepEqual(
      pouch.kinds().map((snack) => snack.label),
      ['糖葫芦'],
      '同样的只列一次',
    );
  });
});

test('supper only comes now and then, and is decided once a night', () => {
  withPouch((path) => {
    let roll = 0.9;
    const pouch = new SnackPouch(
      path,
      () => undefined,
      () => roll,
    );
    assert.equal(pouch.tick(at(24, 22), true), null, '今晚没有宵夜');
    roll = 0;
    assert.equal(pouch.tick(at(24, 23), true), null, '一晚只掷一次');
    const supper = pouch.tick(at(25, 22), true);
    assert.equal(supper?.meal, '宵夜');
    assert.ok(['饺子', '汤圆', '长寿面'].includes(supper?.snack.label ?? ''));
  });
});

test('a full pouch skips the meal; treating a guest takes one out; the pouch survives a restart', () => {
  withPouch((path, warnings) => {
    const pouch = new SnackPouch(
      path,
      (m) => warnings.push(m),
      () => 0,
    );
    for (let day = 1; day <= 2; day += 1) {
      for (const hour of [8, 12, 18]) pouch.tick(at(day, hour), true);
    }
    assert.equal(pouch.tick(at(3, 8), true), null, `装满 ${POUCH_MAX} 份就不拿`);
    assert.equal(pouch.take('汤圆'), false, '没有的不能拿');
    assert.equal(pouch.take('糖葫芦'), true);
    const again = new SnackPouch(
      path,
      (m) => warnings.push(m),
      () => 0,
    );
    assert.equal(again.tick(at(3, 8), true), null, '重启后还记得这顿处理过了');
    assert.equal(again.tick(at(3, 12), true)?.snack.label, '糖葫芦', '拿出去一份又有空位了');
    assert.deepEqual(warnings, []);
  });
});

test('a broken pouch file is reported and starts empty; unknown snacks are dropped', () => {
  withPouch((path, warnings) => {
    writeFileSync(path, '{ not json');
    const broken = new SnackPouch(
      path,
      (m) => warnings.push(m),
      () => 0,
    );
    assert.deepEqual(broken.kinds(), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /零食袋读不了/);
    writeFileSync(path, JSON.stringify({ items: ['年糕', '炸弹'], served: [] }));
    assert.deepEqual(
      new SnackPouch(path, () => undefined).kinds().map((snack) => snack.label),
      ['年糕'],
    );
  });
});

test('every snack has a built-in eating animation for the guest window, and its menu label fits', () => {
  for (const snack of SNACKS) {
    assert.ok(existsSync(new URL(`../../assets/webm/${snack.anim}.webm`, import.meta.url)), snack.anim);
    // 右键菜单项 ≤ 32 字：「请 <最长 12 字的名字> 吃/<零食>」
    assert.ok(Array.from(`请 ${'名'.repeat(12)} 吃/${snack.label}`).length <= 32, snack.label);
  }
});
