import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  followGuest,
  guestBounds,
  guestPage,
  GUEST_BUBBLE_OVERLAP_RATIO,
  guestSide,
  openGuestWindow,
  petBoxFrom,
  petHitRect,
  pinkPixels,
  shadowPixels,
} from './visit-windows.ts';
import type { WindowElectron, WindowLike } from './visit-windows.ts';
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

/** RGBA → 饱和度（0–1）与色相（度）；灰色色相为 null */
function hsvOf([r, g, b]: number[]): { sat: number; hue: number | null; value: number } {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const hue =
    delta === 0
      ? null
      : ((max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return { sat: max === 0 ? 0 : delta / max, hue, value: max / 255 };
}

test('心魔是暗色影子：压暗、去饱和、偏紫；透明像素照原样留着', () => {
  const pixels = {
    hair: [40, 70, 180, 255],
    skin: [250, 220, 205, 255],
    white: [245, 245, 245, 255],
    clear: [40, 70, 180, 0],
  };
  const data = new Uint8ClampedArray(Object.values(pixels).flat());
  shadowPixels(data);
  const after = (index: number) => Array.from(data.slice(index * 4, index * 4 + 4));
  const source = [pixels.hair, pixels.skin, pixels.white];
  const tinted = [after(0), after(1), after(2)];
  for (let i = 0; i < tinted.length; i++) {
    const rgb = tinted[i];
    const { sat, hue, value } = hsvOf(rgb);
    const bright = Math.max(...source[i].slice(0, 3)) / 255;
    assert.ok(value < bright * 0.7, `压暗：${value.toFixed(3)} < 原来 ${bright.toFixed(3)} 的七折`);
    assert.ok(sat < 0.45, `去饱和：饱和度 ${sat.toFixed(3)}`);
    assert.ok(hue !== null && hue >= 240 && hue <= 320, `偏紫：色相 ${hue}`);
    assert.ok(rgb[2] > rgb[1], `蓝高于绿才是紫：${rgb}`);
  }
  // 透明像素一个字节都不动（抠像的边缘不能变成实心紫块）
  assert.deepEqual(after(3), pixels.clear);
});

test('配色函数是自包含的：toString 内联进 guest 页面后没有模块作用域可依赖（真机踩过 SHADOW_LEVEL is not defined）', () => {
  // guest 页面里只有这些全局（没有本模块的任何常量）：在同样贫瘠的沙箱里跑内联源码，
  // 函数体引用了模块级常量就会在这里 ReferenceError，而不是到真机上每帧炸一遍
  const sandbox = { Math, Number, Uint8ClampedArray };
  for (const fn of [pinkPixels, shadowPixels]) {
    const inPage = runInNewContext(`(${fn.toString()})`, sandbox) as (data: Uint8ClampedArray) => void;
    const data = new Uint8ClampedArray([40, 70, 180, 255, 40, 70, 180, 0]);
    inPage(data); // 不抛 = 自包含
    assert.equal(data[7], 0, '透明像素原样留着');
  }
});

test('shadow 不影响 pink：客人照旧是蓝转粉、皮肤与白色不动', () => {
  const pixels = { hair: [40, 70, 180, 255], skin: [250, 220, 205, 255], white: [245, 245, 245, 255] };
  const data = new Uint8ClampedArray(Object.values(pixels).flat());
  pinkPixels(data);
  const after = (index: number) => Array.from(data.slice(index * 4, index * 4 + 4));
  const hue = hsvOf(after(0)).hue;
  assert.ok(hue !== null && hue >= 300 && hue <= 360, `蓝 → 粉：${hue}`);
  assert.deepEqual(after(1), pixels.skin);
  assert.deepEqual(after(2), pixels.white);
});

test('guestPage：两种色都在页面里，arrive 的 tint 决定用哪一套；play 支持倍速并回常速', () => {
  assert.ok(guestPage.includes(`const pink = ${pinkPixels.toString()};`), '粉色函数原样嵌进页面');
  assert.ok(guestPage.includes(`const shadow = ${shadowPixels.toString()};`), '影子函数同样');
  assert.ok(guestPage.includes("paint = tint === 'shadow' ? shadow : pink;"), '默认粉色，心魔才换');
  assert.ok(guestPage.includes('paint(frame.data);'), '逐帧用当前这一套色');
  // 倍速：每次 play 都写一遍 playbackRate（接回待机时自动常速），而且必须**换源之后**写——
  // 改 src 会走一遍媒体的 load 算法，它把 playbackRate 打回默认值（写在前面等于没写）
  const srcAt = guestPage.indexOf("video.src = ANIM + encodeURIComponent(name) + '.webm';");
  const rateAt = guestPage.indexOf('video.playbackRate = Number.isFinite(Number(rate))');
  const playAt = guestPage.indexOf('video.play().catch');
  assert.ok(srcAt > 0 && rateAt > srcAt && playAt > rateAt, '顺序：换源 → 写倍速 → play');
  assert.ok(guestPage.includes("video.addEventListener('ended', () => play(IDLE, true));"), '回待机不带倍速');
  // 名字 / 台词 / tint 都只当数据：一律 JSON 字面量进来、textContent 显示，没有 innerHTML
  assert.ok(guestPage.includes("document.getElementById('tag').textContent = tag;"));
  assert.equal(guestPage.includes('innerHTML'), false);
});

/** 假客人窗口：记录构造参数与 executeJavaScript 的调用 */
function fakeWindows() {
  const created: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const ignore: boolean[] = [];
  const cursors: { x: number; y: number }[] = [];
  let destroyed = false;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: () => undefined,
    setOpacity: () => undefined,
    setIgnoreMouseEvents: (value) => void ignore.push(value),
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      getURL: () => '',
      executeJavaScript: (code) => {
        executed.push(code);
        return Promise.resolve(0);
      },
    },
  };
  return {
    electron: {
      BrowserWindow: function FakeBrowserWindow(options: Record<string, unknown>) {
        created.push(options);
        return win;
      },
      screen: {
        getCursorScreenPoint: () => {
          const next = cursors.shift() ?? { x: 0, y: 0 };
          return next;
        },
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 1200 } }),
      },
    } as unknown as WindowElectron,
    created,
    executed,
    ignore,
    cursors,
    get destroyed() {
      return destroyed;
    },
  };
}

test('openGuestWindow：tint 透给页面；心魔窗口整窗穿透、不去取点击次数', async () => {
  const fake = fakeWindows();
  const guest = openGuestWindow(
    fake.electron,
    'http://127.0.0.1:1/app/guest',
    '心魔',
    () => home,
    () => undefined,
    {
      tint: 'shadow',
    },
  );
  // 加载完补发的 arrive 带上 tint
  await new Promise((done) => setImmediate(done));
  assert.ok(
    fake.executed.some((code) => code.includes('"shadow"')),
    fake.executed.join('\n'),
  );
  assert.equal(fake.created[0].focusable, false);
  assert.equal(fake.created[0].transparent, true);
  // 光标正好压在客人身上（默认 pink 的窗口这时会解禁点击）
  const hit = petHitRect(guestBounds(home, { x: 0, y: 25, width: 1440, height: 1200 }));
  fake.cursors.push({ x: hit.x + 1, y: hit.y + 1 });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(fake.ignore.includes(false), false, 'shadow 窗口从不解禁点击');
  assert.equal(
    fake.executed.some((code) => code.includes('takePokes')),
    false,
    '也不去取点击次数',
  );
  guest.close(0);
});

test('openGuestWindow：默认还是 pink，点击解禁与取次数照旧（客人的老行为一个字不变）', async () => {
  const fake = fakeWindows();
  const guest = openGuestWindow(
    fake.electron,
    'http://127.0.0.1:1/app/guest',
    '小鱼',
    () => home,
    () => undefined,
  );
  await new Promise((done) => setImmediate(done));
  assert.ok(fake.executed.some((code) => code.includes('"pink"')));
  const hit = petHitRect(guestBounds(home, { x: 0, y: 25, width: 1440, height: 1200 }));
  fake.cursors.push({ x: hit.x + 1, y: hit.y + 1 });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(fake.ignore.includes(false), true, '光标在身上时解禁点击');
  assert.equal(
    fake.executed.some((code) => code.includes('takePokes')),
    true,
  );
  guest.close(0);
});

test('GuestWindow.play 带倍速：rate 送进页面，不给就是 1', async () => {
  const fake = fakeWindows();
  const guest = openGuestWindow(
    fake.electron,
    'http://127.0.0.1:1/app/guest',
    '心魔',
    () => home,
    () => undefined,
    {
      tint: 'shadow',
    },
  );
  await new Promise((done) => setImmediate(done));
  guest.play('战斗-受击', 2.5);
  guest.play('战斗-闪避');
  assert.ok(
    fake.executed.some((code) => code === 'guest.play("战斗-受击", 2.5)'),
    fake.executed.join('\n'),
  );
  assert.ok(fake.executed.some((code) => code === 'guest.play("战斗-闪避", 1)'));
  // 非法倍速不送进页面（夹在调用方，页面只收数字）
  guest.play('战斗-倒地', Number.NaN);
  assert.ok(fake.executed.some((code) => code === 'guest.play("战斗-倒地", 1)'));
  guest.close(0);
});
