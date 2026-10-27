/**
 * 气泡摆位契约测试 —— 钉住「头顶放不下就翻到脚下」的判据，以及桌面端 CSS 与判据用的尾巴系数同源。
 *
 * 跑法：node --experimental-strip-types --test src/shared/fonts.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BUBBLE_METRICS, bubbleFlipsBelow } from './fonts.ts';

describe('bubbleFlipsBelow —— 气泡放头顶还是脚下', () => {
  test('头顶放得下（含刚好放下）：留在头顶', () => {
    assert.equal(bubbleFlipsBelow(60, 200, 250), false);
    assert.equal(bubbleFlipsBelow(60, 60, 250), false);
  });

  test('回归：宠物贴近屏幕上沿、头顶只剩一点，脚下宽裕 → 翻到脚下，不被菜单栏下沿截掉', () => {
    assert.equal(bubbleFlipsBelow(60, 20, 250), true);
    assert.equal(bubbleFlipsBelow(60, -40, 250), true, '头已经进了菜单栏条带：头顶可用高度为负');
  });

  test('两边都放不下：留在空间多的一边', () => {
    assert.equal(bubbleFlipsBelow(300, 120, 200), true);
    assert.equal(bubbleFlipsBelow(300, 200, 120), false);
  });
});

test('桌面端翻到脚下的样式存在，且盒子离脚底的距离用的是同一个尾巴系数', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../../runtime/electron-helper/index.html', import.meta.url)),
    'utf8',
  );
  const rule = /\.pet-bubble\.is-below \{([^}]*)\}/.exec(html);
  assert.ok(rule, 'index.html 里找不到 .pet-bubble.is-below');
  assert.match(rule[1], new RegExp(`top: calc\\(100% \\+ var\\(--f\\) \\* ${BUBBLE_METRICS.tail}\\)`));
  assert.ok(html.includes(`bottom: calc(var(--f) * -${BUBBLE_METRICS.tail})`), '头顶气泡的尾巴系数变了要同步');
});
