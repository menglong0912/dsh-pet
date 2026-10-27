import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVENTURE_BAR_HEIGHT,
  ADVENTURE_BAR_MIN_WIDTH,
  ADVENTURE_COMPACT_HEIGHT,
  ADVENTURE_COMPACT_WIDTH,
  ADVENTURE_HEIGHT,
  ADVENTURE_WIDTH,
  adventureAssetUrl,
  adventureBounds,
  adventureCompactBounds,
  adventurePage,
  adventureViewWithUrls,
  clampAdventureBounds,
  openAdventureWindow,
} from './adventure-window.ts';
import type { AdventureAnswer, AdventureView } from './adventure-window.ts';
import type { WindowElectron, WindowLike } from './visit-windows.ts';

const workArea = { x: 0, y: 25, width: 1440, height: 1200 };
const home = { left: 900, top: 400, size: 300, bottomPad: 18 };

const entryView: AdventureView = {
  kind: 'entry',
  title: '三王传承',
  subtitle: '「三王传承，今日开启，正魔不论，留待有缘。」',
  entry: {
    cover: '三王传承/封面.png',
    opening: ['三道彩色光柱'],
    sealed: false,
    best: '还没走过这一趟',
    endings: [{ name: '第二空窍', seen: false }],
    suppressed: false,
  },
};

test('小窗位置：在宠物旁边、优先和对手相反的一边；放不下换另一边；打起来缩成屏顶一条', () => {
  const middle = { ...home, left: 500 };
  const left = adventureBounds(middle, workArea, 'left');
  assert.equal(left.width, ADVENTURE_WIDTH);
  assert.equal(left.height, ADVENTURE_HEIGHT);
  assert.equal(left.x + left.width, middle.left - 12, '放在宠物左边');
  const right = adventureBounds(middle, workArea, 'right');
  assert.equal(right.x, middle.left + middle.size + 12, '放在宠物右边');
  // 宠物贴着左边：prefer left 放不下，换右边
  const edge = adventureBounds({ ...home, left: 0 }, workArea, 'left');
  assert.ok(edge.x >= 0 && edge.x + edge.width <= workArea.width);
  // 不知道宠物在哪：右侧靠上
  const unknown = adventureBounds(null, workArea, 'right');
  assert.equal(unknown.width, ADVENTURE_WIDTH);
  assert.ok(unknown.x + unknown.width <= workArea.x + workArea.width);
  // 打起来那一条：屏顶、和对手相反的一侧
  const compact = adventureCompactBounds(workArea, 'left');
  assert.equal(compact.width, ADVENTURE_COMPACT_WIDTH);
  assert.equal(compact.height, ADVENTURE_COMPACT_HEIGHT);
  assert.equal(compact.x, workArea.x + 12);
  assert.equal(compact.y, workArea.y + 12);
});

test('素材地址逐段编码；图片、场景、地图、加持卡面都由主进程拼好再进页面', () => {
  assert.equal(
    adventureAssetUrl('http://127.0.0.1:1/dsh-pet-7340', '三王传承/对手-白凝冰.png'),
    'http://127.0.0.1:1/dsh-pet-7340/pic/adventure/%E4%B8%89%E7%8E%8B%E4%BC%A0%E6%89%BF/%E5%AF%B9%E6%89%8B-%E7%99%BD%E5%87%9D%E5%86%B0.png',
  );
  const run: AdventureView = {
    kind: 'run',
    title: '三王传承',
    run: {
      scene: { art: '三王传承/节点-野狗群.png', text: ['土丘后面钻出野狗'] },
      hp: { now: 80, max: 120 },
      map: {
        current: 2,
        layers: [
          {
            index: 2,
            name: '犬王传承',
            state: 'current',
            nodes: [{ id: 'dog-pack', name: '野狗群', icon: '通用/图标-妖兽.png', state: 'now' }],
          },
        ],
        travel: { from: 1, to: 2, ms: 15_000 },
      },
      mapArt: '三王传承/地图.png',
      avatar: '通用/头像.png',
      blessings: [{ name: '妖丹', card: '通用/加持-妖丹.png' }],
      loot: [],
      gu: '驭犬蛊 · 2 只',
      cicada: '春秋蝉 · 还在',
      day: { label: '福地内第 2 天', cracks: 2 },
      text: ['土丘后面钻出野狗'],
      choices: [{ kind: 'node', id: 'dog-pack', label: '野狗群', icon: '通用/图标-妖兽.png' }],
      loadout: null,
      fullShow: false,
      fullToggle: true,
      compact: false,
      canSkip: false,
    },
  };
  const full = adventureViewWithUrls(run, 'http://127.0.0.1:1/dsh-pet-7340');
  assert.equal(
    full.run?.avatar,
    'http://127.0.0.1:1/dsh-pet-7340/pic/adventure/%E9%80%9A%E7%94%A8/%E5%A4%B4%E5%83%8F.png',
  );
  assert.ok(full.run?.scene.art?.includes('%E8%8A%82%E7%82%B9-%E9%87%8E%E7%8B%97%E7%BE%A4.png'));
  assert.ok(full.run?.map.layers[0].nodes[0].icon.includes('%E5%9B%BE%E6%A0%87-%E5%A6%96%E5%85%BD.png'));
  assert.ok(full.run?.blessings[0].card.includes('%E5%8A%A0%E6%8C%81-%E5%A6%96%E4%B8%B9.png'));
  assert.ok(full.run?.choices[0].icon?.includes('%E5%9B%BE%E6%A0%87-%E5%A6%96%E5%85%BD.png'));
});

test('adventurePage：只用 textContent，数据经 JSON 字面量；adv.wait 的约定与快进 / 展开', () => {
  assert.equal(adventurePage.includes('innerHTML'), false, '页面里不拼 HTML');
  assert.ok(adventurePage.includes('window.adv = {'));
  assert.ok(adventurePage.includes('wait: function(){ return new Promise(function(resolve){ settle = resolve; }); }'));
  assert.ok(adventurePage.includes('cancel: function(){ settle = null; }'));
  assert.ok(adventurePage.includes("compact: function(on){ document.body.classList.toggle('compact', !!on); }"));
  assert.ok(adventurePage.includes("setText('opening', entry.opening.join('\\n'));"));
  assert.ok(adventurePage.includes("answer({ kind: 'skip' })"));
  assert.ok(adventurePage.includes("answer({ kind: 'enter', suppressed: byId('suppressed').checked })"));
  assert.ok(adventurePage.includes("answer({ kind: 'again' })"));
  // 收起、自动走、拖动标题栏（Y4）
  assert.ok(adventurePage.includes("answer({ kind: 'hide' })"));
  assert.ok(adventurePage.includes("answer({ kind: 'toggle-auto', on: this.checked })"));
  assert.ok(adventurePage.includes("byId('autoRow').hidden = view.kind === 'ending';"));
  assert.ok(adventurePage.includes("byId('autoWalk').checked = view.auto === true;"));
  assert.ok(adventurePage.includes('body.compact #bar,body.compact #autoRow'));
  assert.ok(/-webkit-app-region:drag/.test(adventurePage), '标题栏可拖动');
  assert.ok(/#bar button\{-webkit-app-region:no-drag\}/.test(adventurePage), '标题栏里的按钮不跟着拖');
  assert.equal(adventurePage.includes('require('), false);
  assert.equal(adventurePage.includes('ipcRenderer'), false);
});

/** 假窗口：记录构造参数与 executeJavaScript；wait 的结果、位置、收起由测试控制 */
function fakeWindows() {
  const created: Record<string, unknown>[] = [];
  const executed: string[] = [];
  let destroyed = false;
  let waiter: ((value: unknown) => void) | null = null;
  let onClosed: (() => void) | null = null;
  let onMoved: (() => void) | null = null;
  let hidden = false;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const win = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ ...bounds }),
    setBounds: (rect: { x: number; y: number; width: number; height: number }) => {
      bounds = { ...rect };
      // Electron 挪完窗口会发 moved：自己挪的也要走一遍，才能确认没被当成主人拖的
      onMoved?.();
    },
    setOpacity: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => undefined,
    show: () => {
      hidden = false;
    },
    focus: () => undefined,
    hide: () => {
      hidden = true;
    },
    on: (event: 'moved', listener: () => void) => {
      if (event === 'moved') onMoved = listener;
    },
    once: (_event: 'closed', listener: () => void) => {
      onClosed = listener;
    },
    destroy: () => {
      destroyed = true;
      onClosed?.();
    },
    webContents: {
      getURL: () => '',
      executeJavaScript: (code: string) => {
        executed.push(code);
        if (code === 'adv.wait()') return new Promise((resolve) => (waiter = resolve));
        return Promise.resolve(undefined);
      },
    },
  } as WindowLike & { hide(): void; on(event: 'moved', listener: () => void): void };
  return {
    electron: {
      BrowserWindow: function FakeBrowserWindow(options: Record<string, unknown>) {
        created.push(options);
        // 构造参数里的位置就是初始位置
        bounds = {
          x: Number(options.x ?? 0),
          y: Number(options.y ?? 0),
          width: Number(options.width ?? 0),
          height: Number(options.height ?? 0),
        };
        return win;
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ workArea }),
      },
    } as unknown as WindowElectron,
    created,
    executed,
    /** 模拟主人拖动：改位置并触发 moved */
    moveTo: (x: number, y: number) => {
      bounds = { ...bounds, x, y };
      onMoved?.();
    },
    answer: (value: unknown) => {
      const done = waiter;
      waiter = null;
      done?.(value);
    },
    get destroyed() {
      return destroyed;
    },
    get hidden() {
      return hidden;
    },
  };
}

test('openAdventureWindow：能拿焦点、不鼠标穿透；render 走 JSON 字面量，等主人点、关窗当没选', async () => {
  const fake = fakeWindows();
  const win = openAdventureWindow(
    fake.electron,
    'http://127.0.0.1:1/app/adventure',
    'http://127.0.0.1:1/dsh-pet-7340',
    () => home,
    { prefer: 'right' },
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.created[0].focusable, true);
  assert.equal(fake.created[0].transparent, undefined, '小窗不透明：主人要看地图和选项');
  assert.equal(fake.created[0].width, ADVENTURE_WIDTH);
  assert.equal(fake.created[0].height, ADVENTURE_HEIGHT);
  win.render(entryView);
  await new Promise((done) => setImmediate(done));
  const code = fake.executed.find((item) => item.startsWith('adv.render('));
  assert.ok(code, fake.executed.join('\n'));
  const payload = JSON.parse(code.slice('adv.render('.length, -1)) as AdventureView;
  assert.equal(payload.kind, 'entry');
  assert.ok(payload.entry?.cover.startsWith('http://127.0.0.1:1/dsh-pet-7340/pic/adventure/'));

  const answer: AdventureAnswer = { kind: 'enter', suppressed: true };
  const waiting = win.wait();
  await new Promise((done) => setImmediate(done));
  fake.answer(answer);
  assert.deepEqual(await waiting, answer);

  // 取消一次等待（开打时的快进监听）：页面那边也把 settle 清掉，下一次 wait 照常
  const cancelled = win.wait();
  await new Promise((done) => setImmediate(done));
  win.cancelWait();
  await new Promise((done) => setImmediate(done));
  assert.ok(fake.executed.includes('adv.cancel()'));
  fake.answer({ kind: 'close' });
  await new Promise((done) => setImmediate(done));
  const next = win.wait();
  await new Promise((done) => setImmediate(done));
  fake.answer({ kind: 'skip' });
  assert.deepEqual(await next, { kind: 'skip' });
  void cancelled;

  // 关窗：等着的这一下当没选
  const closedWait = win.wait();
  await new Promise((done) => setImmediate(done));
  win.close(0);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(await closedWait, null);
  assert.equal(fake.destroyed, true);
});

test('openAdventureWindow：缩起来时窗口挪到屏顶、展开回宠物旁边', async () => {
  const fake = fakeWindows();
  const win = openAdventureWindow(
    fake.electron,
    'http://127.0.0.1:1/app/adventure',
    'http://127.0.0.1:1/dsh-pet-7340',
    () => home,
    { prefer: 'left' },
  );
  await new Promise((done) => setImmediate(done));
  const normal = { ...win.bounds() };
  win.setCompact(true);
  await new Promise((done) => setImmediate(done));
  assert.equal(win.bounds().height, ADVENTURE_COMPACT_HEIGHT);
  assert.equal(win.bounds().y, workArea.y + 12);
  assert.ok(fake.executed.includes('adv.compact(true)'));
  win.setCompact(false);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(win.bounds(), normal);
  assert.equal(win.position(), null, '自己缩起来再展开不算主人拖过');
  assert.ok(fake.executed.includes('adv.compact(false)'));
});

test('拖动：至少留标题栏在可见范围里', () => {
  const normal = adventureBounds(home, workArea, 'right');
  const dragged = clampAdventureBounds({ ...normal, x: -500, y: -200 }, workArea);
  assert.equal(dragged.y, workArea.y, '不能拖出上边');
  assert.ok(dragged.x >= workArea.x - normal.width + ADVENTURE_BAR_MIN_WIDTH, '左边至少留一段');
  assert.ok(dragged.x + normal.width >= workArea.x + ADVENTURE_BAR_MIN_WIDTH);
  const far = clampAdventureBounds({ ...normal, x: 5_000, y: 5_000 }, workArea);
  assert.equal(far.x, workArea.x + workArea.width - ADVENTURE_BAR_MIN_WIDTH, '右边至少留一段');
  assert.ok(far.y + ADVENTURE_BAR_HEIGHT <= workArea.y + workArea.height, '标题栏留在屏幕里');
});

test('openAdventureWindow：拖过以后重新渲染、展开都回到拖到的位置；再开窗也停在那儿', async () => {
  const fake = fakeWindows();
  const win = openAdventureWindow(
    fake.electron,
    'http://127.0.0.1:1/app/adventure',
    'http://127.0.0.1:1/dsh-pet-7340',
    () => home,
    { prefer: 'right' },
  );
  await new Promise((done) => setImmediate(done));
  const normal = { ...win.bounds() };
  fake.moveTo(normal.x - 40, normal.y + 30);
  await new Promise((done) => setImmediate(done));
  const dragged = { ...win.bounds() };
  assert.deepEqual(dragged, { ...normal, x: normal.x - 40, y: normal.y + 30 });
  assert.deepEqual(win.position(), dragged, '记住了拖到的位置');

  win.render(entryView);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(win.bounds(), dragged, '重新渲染不回宠物旁边');

  win.setCompact(true);
  await new Promise((done) => setImmediate(done));
  assert.equal(win.bounds().height, ADVENTURE_COMPACT_HEIGHT);
  win.setCompact(false);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(win.bounds(), dragged, '打完从顶上展开回拖到的位置');

  // 拖出屏幕：moved 里夹回来
  fake.moveTo(-2_000, -2_000);
  await new Promise((done) => setImmediate(done));
  assert.equal(win.bounds().y, workArea.y);
  assert.ok(win.bounds().x + win.bounds().width >= workArea.x + ADVENTURE_BAR_MIN_WIDTH);

  // 收起 / 叫回来
  win.hide();
  assert.equal(fake.hidden, true);
  win.show();
  assert.equal(fake.hidden, false);

  // 关掉再开：这次打开 app 期间停在拖到的位置
  const parked = win.position();
  win.close(0);
  await new Promise((done) => setTimeout(done, 10));
  const fake2 = fakeWindows();
  const again = openAdventureWindow(
    fake2.electron,
    'http://127.0.0.1:1/app/adventure',
    'http://127.0.0.1:1/dsh-pet-7340',
    () => home,
    { prefer: 'left', bounds: parked },
  );
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(again.position(), parked);
});
