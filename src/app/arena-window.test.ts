/**
 * 擂台小窗的单测（X3）：位置算法、血条百分比、页面契约（只用 textContent / style.width，
 * 数据经 JSON.stringify 成字面量）与窗口的显示属性（透明、置顶、不可聚焦、鼠标穿透）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_HEIGHT,
  arenaBounds,
  arenaPage,
  arenaUpdate,
  arenaUpdateCode,
  hpPercent,
  openArenaWindow,
} from './arena-window.ts';
import type { Rect, WindowElectron, WindowLike } from './visit-windows.ts';

const workArea = { x: 0, y: 25, width: 1440, height: 1200 };
/** 500 宽的宠物：舞台 500 × 281.25 */
const home = { left: 1000, top: 400, size: 500, bottomPad: 23 };
const foeWindow = { x: 500, y: 420, width: 350, height: 220 };

test('arenaBounds：居中在两只宠物中间，落在它们头顶，宽度夹在 200–520', () => {
  const bounds = arenaBounds(home, foeWindow, workArea);
  // 两只的外沿跨 488–1512（约 1024），夹到上限 520 并居中在中间
  assert.equal(bounds.width, 520);
  assert.equal(bounds.height, ARENA_HEIGHT);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 1000) <= 1, `居中在两只中间：x=${bounds.x}`);
  assert.ok(bounds.y + bounds.height <= home.top, '整窗在两只宠物头顶上方');
  assert.ok(bounds.y >= workArea.y && bounds.y + bounds.height <= workArea.y + workArea.height, '留在屏内');
  // 只有自家宠物（对手窗口还没开）：居中在它上方（放不下就夹回屏内）
  const alone = arenaBounds({ ...home, left: 500 }, null, workArea);
  assert.ok(Math.abs(alone.x + alone.width / 2 - 750) <= 1, `居中在宠物上方：x=${alone.x}`);
  const atRight = arenaBounds({ ...home, left: 1200 }, null, workArea);
  assert.ok(atRight.x + atRight.width <= workArea.x + workArea.width, '放不下就夹回屏内');
  // 挨得很近的两只：不小于 200
  const near = arenaBounds({ ...home, left: 500 }, { x: 600, y: 0, width: 100, height: 100 }, workArea);
  assert.ok(near.width >= 200, `至少 200 宽：${near.width}`);
  // 宠物贴着屏幕左边、对手在屏外：夹回屏内
  const atEdge = arenaBounds({ ...home, left: 0 }, { x: -300, y: 0, width: 400, height: 200 }, workArea);
  assert.ok(atEdge.x >= workArea.x, `不越出屏幕左沿：x=${atEdge.x}`);
  assert.ok(atEdge.x + atEdge.width <= workArea.x + workArea.width);
  // 谁都不知道在哪：屏幕上方中间
  const blind = arenaBounds(null, null, workArea);
  assert.equal(blind.width, 324, '假定 300 宽的一侧 + 两边让开 12');
  assert.ok(Math.abs(blind.x + blind.width / 2 - (workArea.x + workArea.width / 2)) <= 1);
});

test('hpPercent：四舍五入、夹在 0–100，非法值当空血（绝不画成满的）', () => {
  assert.equal(hpPercent(90, 100), 90);
  assert.equal(hpPercent(1, 100), 1);
  assert.equal(hpPercent(0, 100), 0);
  assert.equal(hpPercent(-5, 100), 0);
  assert.equal(hpPercent(150, 100), 100);
  assert.equal(hpPercent(50, 0), 0, '上限 0');
  assert.equal(hpPercent(Number.NaN, 100), 0);
  assert.equal(hpPercent(10, Number.NaN), 0);
});

test('arenaUpdate：把两条血算成百分比再送进页面（页面不重复一套数学）', () => {
  const update = arenaUpdate({ label: '小鱼 · 筑基初期', hp: 124, maxHp: 124 }, { label: '心魔', hp: 31, maxHp: 112 });
  assert.deepEqual(update, {
    left: { label: '小鱼 · 筑基初期', percent: 100 },
    right: { label: '心魔', percent: 28 },
  });
});

test('arenaUpdateCode：数据经 JSON.stringify 成字面量，字符串里的括号引号都当数据', () => {
  const code = arenaUpdateCode(
    arenaUpdate({ label: `'); alert(1); //`, hp: 1, maxHp: 2 }, { label: 'x', hp: 1, maxHp: 2 }),
  );
  assert.ok(code.startsWith('arena.update({'), code);
  // 恶意文本被引号包成字符串字面量，页面里再走 textContent
  assert.ok(code.includes('"label":"\'); alert(1); //"') || code.includes('\\'), '引号被转义');
  assert.equal(code.includes('alert(1); //"),'), false, '不会被截成一段可执行代码');
});

test('arenaPage 页面契约：只用 textContent 与 style.width，没有 innerHTML / 拼接 HTML', () => {
  assert.match(arenaPage, /'use strict';/);
  assert.ok(arenaPage.includes("document.getElementById('l' + i).textContent = String(side.label);"));
  assert.ok(arenaPage.includes('fill.style.width = percent + '));
  // 一条都不能有：把送进来的名字当 HTML 拼
  assert.equal(arenaPage.includes('innerHTML'), false);
  assert.equal(arenaPage.includes('insertAdjacentHTML'), false);
  assert.equal(arenaPage.includes('outerHTML'), false);
  // 页面里没有别的通道（没开 preload、不开 IPC）
  assert.equal(arenaPage.includes('require('), false);
  assert.equal(arenaPage.includes('ipcRenderer'), false);
  // 挂出 window.arena，主进程只调 update
  assert.ok(arenaPage.includes('window.arena = {'));
  // 两条血一条在左一条在右（右边那条从右边涨）
  assert.match(arenaPage, /\.row\.right\{align-items:flex-end\}/);
  assert.match(arenaPage, /\.row\.right \.fill\{margin-left:auto\}/);
  // 血少于两成变红
  assert.match(arenaPage, /\.fill\.low\{/);
  assert.ok(arenaPage.includes('percent < 20'));
});

/** 假窗口：记录构造参数与调用 */
function fakeElectron() {
  const created: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const bounds: Rect[] = [];
  let destroyed = false;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: (rect) => void bounds.push(rect),
    setOpacity: () => undefined,
    setIgnoreMouseEvents: (ignore) => void created.push({ ignoreMouseEvents: ignore }),
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
        return Promise.resolve(undefined);
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
        getCursorScreenPoint: () => ({ x: 100, y: 100 }),
        getDisplayNearestPoint: () => ({ workArea }),
      },
    } as unknown as WindowElectron,
    created,
    executed,
    bounds,
    get destroyed() {
      return destroyed;
    },
  };
}

test('openArenaWindow：透明 / 置顶 / 不可聚焦 / 整窗穿透，加载前的调用排队补发', async () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  const options = fake.created[0];
  assert.equal(options.transparent, true);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.focusable, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.frame, false);
  assert.equal(options.show, false, '加载完再 showInactive，不抢焦点');
  assert.equal((options.webPreferences as Record<string, unknown>).sandbox, true);
  assert.equal((options.webPreferences as Record<string, unknown>).nodeIntegration, false);
  assert.equal((options.webPreferences as Record<string, unknown>).backgroundThrottling, false);
  // 初位置按两只宠物算好塞进构造参数
  assert.equal(options.width, 520);
  assert.equal(options.height, ARENA_HEIGHT);
  // 整窗鼠标穿透（没有 hover 检查去解禁它）
  assert.ok(fake.created.some((entry) => entry.ignoreMouseEvents === true));

  // 还没 ready：update 排队，加载完按顺序补上
  arena.update(arenaUpdate({ label: '小鱼', hp: 10, maxHp: 10 }, { label: '心魔', hp: 0, maxHp: 10 }));
  assert.equal(fake.executed.length, 0);
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.executed.length, 1);
  assert.match(fake.executed[0], /^arena\.update\(\{.*"percent":100/);
  assert.equal(fake.executed[0].includes('innerHTML'), false);
});

test('place：宠物挪了跟着挪，位置没变一个字都不发', () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  arena.place(home, foeWindow);
  assert.equal(fake.bounds.length, 0, '没变就不挪窗口');
  arena.place({ ...home, left: 200 }, foeWindow);
  assert.equal(fake.bounds.length, 1);
  assert.ok(fake.bounds[0].x >= workArea.x, '挪完仍在屏内');
  assert.equal(arena.bounds().x, fake.bounds[0].x);
});

test('close(afterMs)：先让结果那几步放完，到点才销毁窗口', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => null,
    () => null,
  );
  arena.close(3_000);
  t.mock.timers.tick(2_999);
  assert.equal(fake.destroyed, false, '还没到点');
  t.mock.timers.tick(1);
  assert.equal(fake.destroyed, true);
});

test('pin（X16 冲刺）：钉住时按开场站位摆，不跟着两只的实时位置走；放开后照旧', () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  const opening = arena.bounds();
  arena.pin(true);
  arena.place({ ...home, left: 200 }, { ...foeWindow, x: 100 });
  assert.deepEqual(arena.bounds(), opening, '钉住时一步都不挪');
  assert.equal(fake.bounds.length, 0);
  arena.pin(false);
  arena.place({ ...home, left: 200 }, { ...foeWindow, x: 100 });
  assert.equal(fake.bounds.length, 1, '放开后恢复跟随');
});
