/**
 * 出招面板（X17）的窗口单测：位置、送进页面的 JSON、三种方式的按钮与超时。
 * 不真开 Electron 窗口：假 BrowserWindow 记下 executeJavaScript 的代码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_HEIGHT, PANEL_MAX_HEIGHT, openActionPanel, panelBounds, panelHeight } from './action-panel-window.ts';
import type { PanelView } from './action-panel-window.ts';
import type { Rect, WindowElectron, WindowLike } from './visit-windows.ts';

function fakeWindow(): WindowLike & { calls: string[]; destroyed: boolean; hidden: boolean } {
  const win = {
    calls: [] as string[],
    destroyed: false,
    hidden: false,
    isDestroyed: () => win.destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    setBounds: () => undefined,
    setOpacity: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => {
      win.hidden = false;
    },
    show: () => undefined,
    focus: () => undefined,
    hide: () => {
      win.hidden = true;
    },
    once: () => undefined,
    destroy: () => {
      win.destroyed = true;
    },
    webContents: {
      getURL: () => 'http://127.0.0.1:1/app/panel',
      executeJavaScript: (code: string) => {
        win.calls.push(code);
        return Promise.resolve(undefined);
      },
    },
  };
  return win;
}

function fakeElectron(win: WindowLike): WindowElectron {
  return {
    BrowserWindow: Object.assign(
      function () {
        return win;
      },
      { getAllWindows: () => [] },
    ) as unknown as WindowElectron['BrowserWindow'],
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    ipcMain: { on: () => undefined, removeListener: () => undefined },
  };
}

const arena: Rect = { x: 100, y: 200, width: 300, height: 62 };

test('X17 出招面板：挂在擂台下面，下面放不下就夹在工作区里', () => {
  assert.deepEqual(panelBounds(arena, { x: 0, y: 0, width: 1440, height: 900 }), {
    x: 100,
    y: 266,
    width: 300,
    height: PANEL_HEIGHT,
  });
  // 擂台贴着屏幕底：面板被夹在工作区底边，不飞出去
  const bottom = panelBounds({ x: 100, y: 830, width: 300, height: 62 }, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(bottom.y, 900 - PANEL_HEIGHT);
  // 没有擂台：工作区上方居中
  const alone = panelBounds(null, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(alone.width, 320);
  assert.equal(alone.x, (1440 - 320) / 2);
});

test('X17 出招面板：高度跟着按钮数走——三选一一行，21 招排成几行全露出来，再多才在窗内滚动', () => {
  const view = (labels: string[]): PanelView => ({
    kind: 'action',
    title: '轮到你了，出一手',
    seconds: 20,
    options: labels.map((label, index) => ({ pick: index + 1, label })),
  });
  assert.equal(panelHeight(null, 519), PANEL_HEIGHT);
  assert.equal(panelHeight(view(['自动', 'AI 出招', '手动']), 324), PANEL_HEIGHT);
  // 真机那一手：21 招在 519 宽的面板里（原来固定一行高，只露出两行 16 个）
  const many = [
    '毽子',
    '扑克牌',
    '水枪',
    '雪球',
    '三球',
    '鲸尾',
    '烟花',
    '鸡毛掸子',
    '银托盘',
    '陀螺',
    '弹弓',
    '空手',
    '凭空生花',
    '狮子吼',
    '蓝鲸现世',
    '鲸歌',
    '墨汁喷射',
    '鲸吞',
    '万我',
    '魂牵梦绕',
    '五指拳心剑',
  ];
  const tall = panelHeight(view(many), 519);
  assert.ok(tall >= PANEL_HEIGHT + 2 * 35, `至少三行：${tall}`);
  assert.ok(tall <= PANEL_MAX_HEIGHT);
  // 窄一点就得更多行
  assert.ok(panelHeight(view(many), 324) > tall);
  // 再多也不超过上限（剩下的在窗内滚动）
  assert.equal(panelHeight(view([...many, ...many, ...many, ...many]), 324), PANEL_MAX_HEIGHT);
});

test('X17 出招面板：挂在擂台下面会压到宠物时，挪到两只宠物下面；那里也放不下就放擂台上面', () => {
  const work = { x: 0, y: 33, width: 1470, height: 923 };
  // 宠物在屏幕顶上（真机：擂台也只能贴顶，面板正好盖住两只）
  const top = { x: 12, y: 33, width: 519, height: 62 };
  const pets = [
    { x: 120, y: 80, width: 300, height: 300 },
    { x: 330, y: 60, width: 150, height: 200 },
  ];
  const moved = panelBounds(top, work, 150, pets);
  assert.equal(moved.y, 380 + 4, '放到两只宠物的下沿下面');
  assert.equal(moved.height, 150);
  // 不压宠物时照旧挂在擂台下面
  assert.equal(panelBounds(top, work, 150, [{ x: 900, y: 500, width: 100, height: 100 }]).y, 33 + 62 + 4);
  // 宠物在屏幕底：下面放不下，擂台在宠物上方 → 放擂台上面
  const low = { x: 12, y: 600, width: 519, height: 62 };
  const lowPets = [{ x: 120, y: 660, width: 300, height: 290 }];
  assert.equal(panelBounds(low, work, 150, lowPets).y, 600 - 4 - 150);
});

test('X17 出招面板：亮出来以后按页面量到的实际高度校正窗口（字号以页面为准，估算只当初值）', async () => {
  const win = fakeWindow();
  const sizes: Rect[] = [];
  win.setBounds = (rect: Rect) => void sizes.push(rect);
  win.webContents.executeJavaScript = (code: string) => {
    win.calls.push(code);
    return Promise.resolve(code.startsWith('panel.contentHeight(') ? 151.4 : undefined);
  };
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  const picking = panel.chooseAction(
    ['毽子', '扑克牌', '水枪'].map((label) => ({ label })),
    1_000,
  );
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.ok(win.calls.includes(`panel.contentHeight(${arena.width})`), '亮出来以后按面板的宽度量了一次');
  assert.equal(sizes[sizes.length - 1]?.height, 152, '按量到的高度（向上取整）校正');
  assert.equal(panel.choose(1), true);
  assert.equal(await picking, 0);
  panel.close();
});

test('X17 出招面板：三选一送成 JSON 字面量，模型没配好时 AI 灰掉，点了回方式', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  const deciding = panel.chooseMode(false, 1_000);
  // loadURL 是异步的：等它 resolve 后 queued 的 panel.show 才执行
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(panel.state()?.kind, 'mode');
  const shown = win.calls.find((code) => code.startsWith('panel.show('))!;
  assert.match(shown, /^panel\.show\(\{"kind":"mode"/);
  assert.match(shown, /"disabled":true/);
  assert.equal(panel.choose(2), false, 'AI 灰掉：点不上');
  assert.equal(panel.choose(1), true, '自动可选');
  assert.equal(await deciding, 'auto');
  assert.equal(panel.state(), null);
  assert.equal(win.hidden, true, '选完面板收起');
  panel.close();
  assert.ok(win.destroyed);
});

test('X17 出招面板：手动出招的按钮带剩余次数，点了回 0 起的下标；超时回 null', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  const deciding = panel.chooseAction([{ label: '水枪' }, { label: '陀螺', note: '剩 2 次' }], 1_000);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(panel.state()?.kind, 'action');
  assert.deepEqual(panel.state()?.options[1], { pick: 2, label: '陀螺', note: '剩 2 次' });
  assert.equal(panel.choose(2), true);
  assert.equal(await deciding, 1, 'pick 2 → 下标 1');
  // 超时：回 null（外层按后备挑法出）
  assert.equal(await panel.chooseAction([{ label: '空手' }], 20), null);
  assert.equal(panel.state(), null);
  panel.close();
});
