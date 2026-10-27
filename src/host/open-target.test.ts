/**
 * 右键「设置」的契约测试：独立应用只有「打开本机设置页」这一条路。
 *
 * 原先按宿主形态分派（desktop → 唤起 DSH 桌面应用，site → 打开站点）；D6 删掉 DSH 宿主以后
 * 桌面端只剩独立应用，`dsh://open` 那一支与 OPEN_TARGET 注入一起删掉。两半各自构建、
 * 无法互相 import，所以按本仓库既有做法读源码断言。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const main = readSource('../../runtime/electron-helper/main.js');
const constants = readSource('../../runtime/electron-helper/constants.js');
const sprite = readSource('../../runtime/electron-helper/sprite.js');

describe('「设置」只打开本机设置页', () => {
  test('宿主不再注入「打开去向」', () => {
    assert.ok(
      !/DSH_PET_OPEN_TARGET|OPEN_TARGET/.test(host),
      '独立应用没有第二种宿主形态，index.ts 不应再注入 OPEN_TARGET',
    );
  });

  test('helper 主进程：只保留打开站点，不再走 dsh://', () => {
    assert.ok(!/dsh:\/\/open/.test(main), 'dsh://open 是 DSH 桌面宿主的路径，必须删掉');
    assert.ok(!/OPEN_TARGET/.test(main), 'main.js 不应再读 OPEN_TARGET');
    assert.ok(
      /const openSite = \(url\) => \{[\s\S]*?shell\.openExternal\(target\)/.test(main),
      '打开站点的实现必须保留',
    );
    assert.ok(
      /ipcMain\.on\('pet:open-site'[\s\S]*?openSite\(url\);\s*\}\);/.test(main),
      '右键「设置」必须无条件打开本机站点',
    );
  });

  test('helper 渲染端：右键第一项叫「设置」，动作名不变', () => {
    assert.ok(!/OPEN_TARGET/.test(constants), 'constants.js 不应再读 openTarget query');
    assert.ok(
      /label: '设置',\s*action: 'open-site'/.test(sprite),
      '右键第一项叫「设置」，action 仍是 open-site（主进程只认这个动作名）',
    );
  });
});
