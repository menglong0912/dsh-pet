import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestBounds, guestHue, petBoxFrom } from './visit-windows.ts';

const workArea = { x: 0, y: 25, width: 1440, height: 1200 };
/** 500 宽的宠物：舞台 500 × 281.25，脚底垫高 = 舞台高 × 30/360 */
const home = { left: 1000, top: 400, size: 500, bottomPad: (500 * 9) / 16 / 12 };
const feetOf = (top: number, bottomPad: number, stageHeight: number) => top + bottomPad + (stageHeight * 330) / 360;

test('petBoxFrom reads the helper bounds report: window corner plus margins is the pet box', () => {
  const payload = { x: 750, y: 200, width: 1000, height: 900, marginL: 250, marginT: 200, size: 500, bottomPad: 23 };
  assert.deepEqual(petBoxFrom(payload), { left: 1000, top: 400, size: 500, bottomPad: 23 });
  assert.equal(petBoxFrom({ ...payload, marginL: undefined }), null); // 旧版渲染端不带余量
  assert.equal(petBoxFrom(null), null);
});

test('the guest stands left of the home pet, a size smaller, feet on the same line', () => {
  const bounds = guestBounds(home, workArea);
  assert.equal(bounds.width, 350); // 500 × 0.7
  assert.equal(bounds.height, 197 + 96 + 26); // 舞台 16:9 + 气泡 + 名牌
  const guestCenter = bounds.x + bounds.width / 2;
  assert.ok(Math.abs(1250 - guestCenter - 372.5) <= 1, '站在左边，隔开半只宠物多一点');
  const homeFeet = feetOf(home.top, home.bottomPad, (500 * 9) / 16);
  const guestFeet = bounds.y + 96 + ((350 * 9) / 16) * (330 / 360);
  assert.ok(Math.abs(guestFeet - homeFeet) <= 1, `脚底对齐 ${guestFeet} vs ${homeFeet}`);
});

test('the guest moves to the right when there is no room on the left, and stays on screen', () => {
  const bounds = guestBounds({ ...home, left: 0 }, workArea);
  assert.ok(bounds.x + bounds.width / 2 > 250, '换到自家宠物右边');
  assert.ok(bounds.x >= workArea.x && bounds.x + bounds.width <= workArea.x + workArea.width);
  // 太小 / 太大的宠物：客人窗口宽度夹在 200–400
  assert.equal(guestBounds({ ...home, size: 100 }, workArea).width, 200);
  assert.equal(guestBounds({ ...home, size: 1000 }, workArea).width, 400);
});

test('without a home pet window the guest sits in the bottom-left corner of the screen', () => {
  const bounds = guestBounds(null, workArea);
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y + bounds.height, 25 + 1200);
});

test('each guest gets a stable tint from the range that keeps the skin pink', () => {
  assert.equal(guestHue('小王 家的 小鱼'), guestHue('小王 家的 小鱼'));
  for (const name of ['a', '小王 家的 小鱼', '小李 家的 阿花', 'x'.repeat(50)]) {
    const hue = guestHue(name);
    assert.ok(hue >= 240 && hue <= 300, `${name} → ${hue}`);
  }
});
