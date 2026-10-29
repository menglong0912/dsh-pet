import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppMenuNodes, buildMenuPanel, buildMenuTree, buildMoreBranch, type MenuNode } from './menu.ts';

const app = (label: string) => ({ owner: 'dsh-pet-app', label });

test('app menu items with a "group/" prefix become one root submenu that still reports the full label', () => {
  assert.deepEqual(
    buildAppMenuNodes([
      app('看看我在干嘛'),
      app('串门/去 小王 家'),
      app('宠物日记'),
      app('串门/去 小李 家'),
      app('/开头的斜杠'),
    ]),
    [
      { label: '看看我在干嘛', action: 'third-party', owner: 'dsh-pet-app' },
      {
        label: '串门',
        children: [
          { label: '去 小王 家', action: 'third-party', owner: 'dsh-pet-app', reportLabel: '串门/去 小王 家' },
          { label: '去 小李 家', action: 'third-party', owner: 'dsh-pet-app', reportLabel: '串门/去 小李 家' },
        ],
      },
      { label: '宠物日记', action: 'third-party', owner: 'dsh-pet-app' },
      { label: '/开头的斜杠', action: 'third-party', owner: 'dsh-pet-app' },
    ],
  );
  assert.deepEqual(buildAppMenuNodes([]), []);
});

test('buildMenuPanel splits a realistic tree into quick items, flat sections, tools, and retained cascades', () => {
  const quick = [
    { label: '看看我在干嘛', action: 'third-party' as const, owner: 'dsh-pet-app' },
    { label: '宠物日记', action: 'third-party' as const, owner: 'dsh-pet-app' },
  ];
  const meditate = { label: '打坐', anim: '打坐' };
  const sparLeaves = [
    {
      label: '切磋 小王',
      action: 'third-party' as const,
      owner: 'dsh-pet-app',
      reportLabel: '修炼/切磋/切磋 小王',
    },
    {
      label: '切磋 小李',
      action: 'third-party' as const,
      owner: 'dsh-pet-app',
      reportLabel: '修炼/切磋/切磋 小李',
    },
  ];
  const neighbors = Array.from({ length: 13 }, (_, index) => ({
    label: `去 邻居${index + 1} 家`,
    action: 'third-party' as const,
    owner: 'dsh-pet-app',
    reportLabel: `串门/去 邻居${index + 1} 家`,
  }));
  const tree: MenuNode[] = [
    { label: '设置', action: 'open-site' },
    { label: '对话', action: 'chat' },
    ...quick,
    { label: '回到初始位置', action: 'home' },
    { label: '重载配置', action: 'reload' },
    { label: '修炼', children: [meditate, { label: '切磋', children: sparLeaves }] },
    { label: '串门', children: neighbors },
    { label: '动作', cascade: true, children: [{ label: '待机', children: [{ label: '呼吸', anim: '呼吸' }] }] },
    { label: '更多', cascade: true, children: [{ label: '弹弓', action: 'third-party', owner: '插件' }] },
  ];

  const panel = buildMenuPanel(tree);
  assert.deepEqual(panel.quick, quick);
  assert.deepEqual(
    panel.footer.map((node) => node.label),
    ['设置', '对话', '回到初始位置', '重载配置'],
  );
  assert.deepEqual(
    panel.sections.map((section) => section.title),
    ['修炼', '串门'],
  );
  assert.deepEqual(panel.sections[0], {
    title: '修炼',
    leaves: [meditate],
    subsections: [{ title: '切磋', leaves: sparLeaves }],
  });
  assert.deepEqual(panel.sections[1].leaves, neighbors);
  assert.deepEqual(panel.sections[1].subsections, []);
  assert.deepEqual(panel.cascades, [tree[8], tree[9]]);
  assert.equal(
    panel.sections.some((section) => section.title === '动作' || section.title === '更多'),
    false,
  );
});

test('animation and third-party roots are marked to retain cascading submenus', () => {
  assert.deepEqual(
    buildMenuTree({
      idle: ['呼吸'],
      turn: [],
      drag: [],
      clicks: [],
      moves: { default: {}, actions: [] },
      categories: [],
      events: {},
    }),
    [{ label: '动作', cascade: true, children: [{ label: '待机', children: [{ label: '呼吸', anim: '呼吸' }] }] }],
  );
  assert.deepEqual(buildMoreBranch([{ owner: '插件', label: '弹弓' }]), {
    label: '更多',
    cascade: true,
    children: [{ label: '弹弓', action: 'third-party', owner: '插件' }],
  });
});
