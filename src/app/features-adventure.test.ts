import { SANWANG } from './dungeon-sanwang.ts';
import { startRun } from './dungeon.ts';
import { withFeatures, cultivationEarly, until, last, windows, cultivationSeed, windowOn } from './features-testkit.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('历练：菜单里有「修炼/历练」，多了这一项总数仍不超过 20', async () => {
  await withFeatures({ cultivation: cultivationEarly() }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => menus.some((labels) => labels.includes('修炼/历练')), '历练菜单');
    assert.ok((last(menus)?.length ?? 0) <= 20, '菜单项不超过宿主上限');
  });
});

test('历练：小窗开着时菜单里没有心魔试炼和渡劫，关了小窗再出现', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationSeed(), clicks },
    async (_features, _said, _bodies, _home, { menus }) => {
      await until(() => (last(menus) ?? []).includes('修炼/渡劫'), '渡劫菜单');
      await until(() => (last(menus) ?? []).includes('修炼/心魔试炼'), '心魔菜单');
      clicks.push('修炼/历练');
      await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
      const win = windowOn('/app/adventure')!;
      await until(
        () => win.calls.some((code) => code.startsWith('adv.render(') && code.includes('"kind":"entry"')),
        '入口页',
      );
      await until(() => {
        const latest = last(menus) ?? [];
        return latest.includes('修炼/历练') && !latest.includes('修炼/心魔试炼') && !latest.includes('修炼/渡劫');
      }, '小窗开着时藏起心魔与渡劫');
      win.answerAdv({ kind: 'close' });
      await until(() => win.destroyed, '小窗关掉');
      await until(() => {
        const latest = last(menus) ?? [];
        return latest.includes('修炼/心魔试炼') && latest.includes('修炼/渡劫');
      }, '关了小窗，菜单项回来');
    },
  );
});

test('历练：存档里有没走完的一趟，菜单写「修炼/历练（第 N 层）」，点开直接接着走', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const run = startRun(SANWANG, {
    pet: { name: '阿鱼', hp: 100, power: 10, agility: 10, speed: 10, weapons: [], skills: [] },
    stage: 8,
    suppressed: false,
    nonce: 'resume',
    now: Date.now(),
  });
  run.readyAt = Date.now() - 1;
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures({ cultivation: seed, clicks }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '带层数的菜单');
    clicks.push('修炼/历练（第 1 层）');
    await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
    const win = windowOn('/app/adventure')!;
    await until(
      () => win.calls.some((code) => code.startsWith('adv.render(') && code.includes('"kind":"run"')),
      '接着走的一趟',
    );
    win.answerAdv({ kind: 'close' });
    await until(() => win.destroyed, '关掉');
  });
});

test('历练：这一趟在走时菜单多「自动走：开 / 关」，切了标签跟着变，修炼还是最多 5 项', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const run = startRun(SANWANG, {
    pet: { name: '阿鱼', hp: 100, power: 10, agility: 10, speed: 10, weapons: [], skills: [] },
    stage: 8,
    suppressed: false,
    nonce: 'auto',
    now: Date.now(),
  });
  run.readyAt = Date.now() - 1;
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures({ cultivation: seed, clicks }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '带层数的菜单');
    assert.ok(!(last(menus) ?? []).some((label) => label.startsWith('修炼/自动走：')), '没开小窗时没有自动走');
    clicks.push('修炼/历练（第 1 层）');
    await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
    const win = windowOn('/app/adventure')!;
    await until(() => (last(menus) ?? []).includes('修炼/自动走：关'), '默认关着的自动走');
    const own = (last(menus) ?? []).filter((label) => label.startsWith('修炼/'));
    assert.ok(own.length <= 5, `修炼最多 5 项，实际 ${own.join('、')}`);
    assert.ok(!(last(menus) ?? []).includes('修炼/心魔试炼'), '这一趟在走时藏起来');
    assert.ok(!(last(menus) ?? []).includes('修炼/渡劫'));
    clicks.push('修炼/自动走：关');
    await until(() => (last(menus) ?? []).includes('修炼/自动走：开'), '切成开');
    clicks.push('修炼/自动走：开');
    await until(() => (last(menus) ?? []).includes('修炼/自动走：关'), '切回关');
    win.answerAdv({ kind: 'close' });
    await until(() => win.destroyed, '关掉');
  });
});

test('历练：收起来以后从菜单能叫回来，心魔试炼和渡劫照旧藏着', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const run = startRun(SANWANG, {
    pet: { name: '阿鱼', hp: 100, power: 10, agility: 10, speed: 10, weapons: [], skills: [] },
    stage: 8,
    suppressed: false,
    nonce: 'hide',
    now: Date.now(),
  });
  run.readyAt = Date.now() - 1;
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures({ cultivation: seed, clicks }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '带层数的菜单');
    clicks.push('修炼/历练（第 1 层）');
    await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
    const win = windowOn('/app/adventure')!;
    await until(
      () => win.calls.some((code) => code.startsWith('adv.render(') && code.includes('"kind":"run"')),
      '接着走的一趟',
    );
    win.answerAdv({ kind: 'hide' });
    await until(() => win.hidden, '收起来了');
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '菜单还在');
    assert.ok(!(last(menus) ?? []).includes('修炼/心魔试炼'), '宠物还在秘境里');
    assert.ok(!(last(menus) ?? []).includes('修炼/渡劫'));
    clicks.push('修炼/历练（第 1 层）');
    await until(() => !win.hidden, '从菜单叫回来');
    win.answerAdv({ kind: 'close' });
    await until(() => win.destroyed, '关掉');
  });
});
