import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  followGuest,
  guestBounds,
  guestPage,
  GUEST_BUBBLE_OVERLAP_RATIO,
  guestSide,
  petBoxFrom,
  petHitRect,
  pinkPixels,
} from './visit-windows.ts';
import { BUBBLE_OVERLAP_RATIO } from '../shared/fonts.ts';

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

test('the guest knows which side of the home pet it stands on, and only its body takes clicks', () => {
  const left = guestBounds(home, workArea);
  assert.equal(guestSide(left, home), 'left');
  assert.equal(guestSide(guestBounds({ ...home, left: 0 }, workArea), { ...home, left: 0 }), 'right');
  assert.equal(guestSide(guestBounds(null, workArea), null), 'left');
  // 身体那一块在舞台中间、脚底以上，不含上面留给气泡的空间
  const hit = petHitRect(left);
  assert.ok(hit.x > left.x && hit.x + hit.width < left.x + left.width);
  assert.ok(hit.y > left.y + 96, '不含气泡空间');
  const feet = left.y + 96 + ((350 * 9) / 16) * (330 / 360);
  assert.ok(Math.abs(hit.y + hit.height - feet) <= 1, '到脚底为止');
});

test('客人气泡贴着头顶：底边伸进舞台的比例扣掉脚底垫高，气泡自己不接点击', () => {
  // 自家宠物的气泡伸进的是宠物盒（BUBBLE_OVERLAP_RATIO），舞台在盒里下移了脚底垫高（9/16 × 30/360）
  assert.ok(
    Math.abs(GUEST_BUBBLE_OVERLAP_RATIO - (BUBBLE_OVERLAP_RATIO - (9 / 16) * (30 / 360))) < 1e-9,
    `比例约 0.0611，实际 ${GUEST_BUBBLE_OVERLAP_RATIO}`,
  );
  assert.ok(guestPage.includes(`margin-bottom:calc(-100vw * ${GUEST_BUBBLE_OVERLAP_RATIO})`));
  const rule = /#bubble\{([^}]*)\}/.exec(guestPage);
  assert.ok(rule, 'guestPage 里找不到 #bubble 规则');
  assert.match(rule[1], /position:relative/);
  assert.match(rule[1], /pointer-events:none/);
});

test('followGuest：宠物平移，客人跟着平移；位置没变就不动', () => {
  const current = guestBounds(home, workArea);
  assert.equal(followGuest(current, 'left', home, workArea), null, '没挪动');
  const moved = followGuest(current, 'left', { ...home, left: 1100 }, workArea);
  assert.ok(moved, '要挪');
  assert.equal(moved.side, 'left');
  assert.equal(moved.bounds.x - current.x, 100);
  // 竖着挪也跟
  const up = followGuest(current, 'left', { ...home, top: 300 }, workArea);
  assert.ok(up && Math.abs(up.bounds.y - current.y + 100) <= 1);
});

test('followGuest：左边放不下才换到右边，回到中间后也不来回跳', () => {
  const mid = guestBounds(home, workArea); // 自家宠物在 1000，客人站左边
  assert.equal(followGuest(mid, 'left', home, workArea)?.side ?? 'left', 'left', '放得下就不换边');
  // 宠物被拖到最左边：客人换到右边
  const atLeftEdge = { ...home, left: 0 };
  const moved = followGuest(mid, 'left', atLeftEdge, workArea);
  assert.ok(moved && moved.side === 'right');
  // 宠物回到屏幕中间（两边都放得下）：客人留在右边，不弹回左边
  const center = { ...home, left: 500 };
  const stays = followGuest(moved.bounds, 'right', center, workArea);
  assert.ok(stays && stays.side === 'right');
  assert.ok(stays.bounds.x + stays.bounds.width / 2 > center.left + center.size / 2, '仍在宠物右边');
});

test('followGuest：宠物去了另一块屏，客人跟过去', () => {
  const otherScreen = { x: 1440, y: 25, width: 1440, height: 1200 };
  const current = guestBounds(home, workArea);
  const moved = followGuest(current, 'left', { ...home, left: 2000 }, otherScreen);
  assert.ok(moved, '要挪');
  assert.ok(moved.bounds.x >= otherScreen.x, '落在另一块屏里');
  assert.ok(moved.bounds.x + moved.bounds.width <= otherScreen.x + otherScreen.width);
});

/** RGBA → 色相（度）；灰色返回 null */
function hueOf([r, g, b]: number[]): number | null {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return null;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

test('the guest turns pink: blue hair and dress become pink, skin, white and see-through pixels stay', () => {
  const pixels = {
    hair: [40, 70, 180, 255],
    navy: [30, 35, 80, 255],
    skin: [250, 220, 205, 255],
    white: [245, 245, 245, 255],
    clear: [40, 70, 180, 0],
  };
  const data = new Uint8ClampedArray(Object.values(pixels).flat());
  pinkPixels(data);
  const after = (index: number) => Array.from(data.slice(index * 4, index * 4 + 4));
  for (const index of [0, 1]) {
    const hue = hueOf(after(index));
    assert.ok(hue !== null && hue >= 300 && hue <= 360, `蓝 → 粉：${hue}`);
  }
  assert.deepEqual(after(2), pixels.skin);
  assert.deepEqual(after(3), pixels.white);
  assert.deepEqual(after(4), pixels.clear);
});
