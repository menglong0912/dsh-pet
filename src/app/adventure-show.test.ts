import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdventureShows } from './adventure-show.ts';
import { fight as battleFight } from './battle.ts';
import type { Fighter } from './battle.ts';
import type { BattleShow } from './battle-show.ts';
import type { LiveBattle } from './battle-live.ts';
import type { FightResult } from './dungeon.ts';
import { openFxWindow } from './fx-window.ts';
import type { WindowElectron, WindowLike } from './visit-windows.ts';

const home = { left: 900, top: 400, size: 300, bottomPad: 18 };
const workArea = { x: 0, y: 25, width: 1440, height: 1200 };

/** 假 electron：只记开出来的窗口、加载的地址和 executeJavaScript 的调用 */
function fakeElectron() {
  const created: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const executed: string[] = [];
  let destroyed = false;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 300, height: 168 }),
    setBounds: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: (url) => {
      urls.push(url);
      return Promise.resolve();
    },
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
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ workArea }),
      },
    } as unknown as WindowElectron,
    created,
    urls,
    executed,
    get destroyed() {
      return destroyed;
    },
  };
}

test('Y5 客串：只开对手窗口、冒三句、淡出关掉，不开擂台和特效层', async () => {
  const fake = fakeElectron();
  let fxOpened = 0;
  const shows = createAdventureShows({
    electron: fake.electron,
    petBase: 'http://127.0.0.1:1/dsh-pet-7340',
    home: () => home,
    openFx: () => {
      fxOpened += 1;
      throw new Error('客串不该开特效层');
    },
    holdPet: async () => {
      throw new Error('客串不该占住宠物');
    },
    releasePet: () => {
      throw new Error('客串不该收宠物的摊');
    },
    setBattle: () => {
      throw new Error('客串不该开擂台');
    },
    setLiveBattle: () => {
      throw new Error('客串不该开逐手局');
    },
    refreshMenu: () => undefined,
    playExtra: () => undefined,
    movePet: () => undefined,
    say: () => undefined,
    stageLabel: () => '',
    disposed: () => false,
    closeHoldMs: 0,
    cameoLineMs: 1,
  });
  await shows.cameo({
    foe: 'feng-tianyu',
    lines: ['这不可能！', '他用了宙道蛊虫来加速？', '定仙游！他真的在炼制定仙游蛊吗？'],
  });
  await new Promise((done) => setTimeout(done, 20));

  assert.equal(fake.created.length, 1, '只开一扇对手窗口');
  assert.deepEqual(fake.urls, ['http://127.0.0.1:1/app/foe'], '不开擂台（/app/arena）也不开特效层');
  assert.equal(fxOpened, 0);
  const setup = fake.executed.find((code) => code.startsWith('foe.setup('));
  assert.ok(setup, fake.executed.join('\n'));
  const payload = JSON.parse(setup.slice('foe.setup('.length, -1)) as Record<string, unknown>;
  assert.equal(payload.name, '风天语');
  assert.equal(payload.prefix, '对手-风天语');
  assert.ok(String(payload.portrait).includes(encodeURIComponent('对手-风天语.png')));
  assert.ok(fake.executed.includes('foe.play("起手", 1)'), '只露立绘，CSS 轻跳一下');
  const said = fake.executed.filter((code) => code.startsWith('foe.say('));
  assert.equal(said.length, 3, '三句台词各冒一次');
  assert.ok(said[0].includes('这不可能'));
  assert.ok(said[2].includes('定仙游'));
  assert.ok(fake.executed.includes('foe.fade()'), '说完淡出');
  assert.equal(fake.destroyed, true, '淡出后关窗');
});

interface FakeSceneWin extends WindowLike {
  destroyedNow: boolean;
  url: string;
}

/** 假 electron：每开一扇窗都建一个新的假窗口，收窗时能一扇一扇数（一场三扇共用 destroyed 看不出漏关）；failAt 让第几扇开窗直接抛错 */
function fakeSceneElectron(failAt = 0) {
  const created: FakeSceneWin[] = [];
  const electron = {
    BrowserWindow: function FakeBrowserWindow() {
      if (failAt > 0 && created.length + 1 === failAt) throw new Error('窗口开不出');
      const win: FakeSceneWin = {
        destroyedNow: false,
        url: '',
        isDestroyed: () => win.destroyedNow,
        getBounds: () => ({ x: 0, y: 0, width: 300, height: 168 }),
        setBounds: () => undefined,
        setIgnoreMouseEvents: () => undefined,
        setAlwaysOnTop: () => undefined,
        setVisibleOnAllWorkspaces: () => undefined,
        loadURL: (url) => {
          win.url = url;
          return Promise.resolve();
        },
        showInactive: () => undefined,
        show: () => undefined,
        focus: () => undefined,
        once: () => undefined,
        destroy: () => {
          win.destroyedNow = true;
        },
        webContents: {
          getURL: () => win.url,
          executeJavaScript: () => Promise.resolve(0),
        },
      };
      created.push(win);
      return win;
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea }),
    },
  } as unknown as WindowElectron;
  return { electron, created };
}

const YOU: Fighter = {
  name: '破伤风菜刀',
  hp: 120,
  power: 30,
  agility: 20,
  speed: 20,
  weapons: ['water-gun'],
  skills: [],
};
const FOE: Fighter = { name: '铁若男', hp: 80, power: 5, agility: 5, speed: 5, weapons: [], skills: [] };

/** 一场现成的战斗结果（守护：铁若男） */
function fightResult(): FightResult {
  const events = battleFight(YOU, FOE, '收窗回归');
  const last = events[events.length - 1];
  return {
    kind: 'fight',
    foe: 'tie-ruonan',
    tier: 'boss',
    seed: '收窗回归',
    fighters: [YOU, FOE],
    events,
    won: last.kind === 'end' && last.winner === 0,
    hp: last.kind === 'end' ? last.hp : [YOU.hp, FOE.hp],
    reward: { xp: 0, pills: 0, weapons: [], scrolls: 0, titles: [] },
    foeActions: [],
  };
}

/** 一次演的依赖：三扇窗都走真实现，只把 electron 换成假窗口 */
function sceneShows(
  fake: ReturnType<typeof fakeSceneElectron>,
  options: {
    setBattle?: (show: BattleShow | null) => void;
    setLiveBattle?: (live: LiveBattle | null) => void;
    holdPet?: () => Promise<void>;
  } = {},
) {
  return createAdventureShows({
    electron: fake.electron,
    petBase: 'http://127.0.0.1:1/dsh-pet-7340',
    home: () => home,
    openFx: () =>
      openFxWindow(
        fake.electron,
        'http://127.0.0.1:1/app/fx',
        { base: 'http://127.0.0.1:1/pic/fx/', names: [] },
        () => [{ x: 0, y: 0, width: 300, height: 168, facing: 'left' }, null],
        () => workArea,
        () => undefined,
      ),
    holdPet: options.holdPet ?? (async () => undefined),
    releasePet: () => undefined,
    setBattle: options.setBattle ?? (() => undefined),
    setLiveBattle: options.setLiveBattle ?? (() => undefined),
    refreshMenu: () => undefined,
    playExtra: () => undefined,
    movePet: () => undefined,
    say: () => undefined,
    stageLabel: () => '大乘圆满',
    disposed: () => false,
    closeHoldMs: 0,
  });
}

/** 等 closeOne / 各窗口自己那个 0ms 的关窗定时器跑完 */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 20));

test('历练收窗：一场演完，对手、擂台、特效层三扇窗都关掉', async () => {
  const fake = fakeSceneElectron();
  let battle: BattleShow | null = null;
  const shows = sceneShows(fake, {
    setBattle: (show) => {
      battle = show;
      show?.skip();
    },
  });
  try {
    await shows.fight({ result: fightResult(), full: false });
    await settle();
    assert.equal(fake.created.length, 3, '对手、擂台、特效层各一扇');
    assert.ok(
      fake.created.every((win) => win.destroyedNow),
      `三扇窗都销毁：${fake.created.map((win) => win.destroyedNow).join(' / ')}`,
    );
    assert.equal(battle, null, '演出状态收掉');
  } finally {
    // 修好以前窗口会漏关、对手窗口的跟随定时器还挂着：测试清理掉，别把测试进程拖住
    shows.closeAll(0);
    await settle();
  }
});

test('历练收窗：守护逐手局演完，对手、擂台、特效层都关掉', async () => {
  const fake = fakeSceneElectron();
  let live: LiveBattle | null = null;
  const shows = sceneShows(fake, {
    setLiveBattle: (value) => {
      live = value;
      value?.skip();
    },
  });
  try {
    const events = await shows.liveFight({
      a: YOU,
      b: FOE,
      seed: '逐手收窗',
      foe: 'tie-ruonan',
      mode: 'ai',
      initialActions: [],
      decide: async () => null,
      onDecision: () => undefined,
      think: () => undefined,
      log: () => undefined,
    });
    await settle();
    assert.ok(events && events.length > 0, '逐手局打完了');
    assert.equal(fake.created.length, 3, '对手、擂台、特效层各一扇');
    assert.ok(
      fake.created.every((win) => win.destroyedNow),
      `三扇窗都销毁：${fake.created.map((win) => win.destroyedNow).join(' / ')}`,
    );
    assert.equal(live, null, '逐手局状态收掉');
  } finally {
    shows.closeAll(0);
    await settle();
  }
});

test('历练收窗：演出报错也收窗，错误原样抛出来', async () => {
  const fake = fakeSceneElectron();
  let battle: BattleShow | null = null;
  const shows = sceneShows(fake, {
    setBattle: (show) => {
      battle = show;
    },
    holdPet: async () => {
      throw new Error('占不住宠物');
    },
  });
  try {
    await assert.rejects(shows.fight({ result: fightResult(), full: false }), /占不住宠物/);
    await settle();
    assert.equal(fake.created.length, 3);
    assert.ok(
      fake.created.every((win) => win.destroyedNow),
      `出错也把三扇窗收掉：${fake.created.map((win) => win.destroyedNow).join(' / ')}`,
    );
    assert.equal(battle, null, '演出状态收掉');
  } finally {
    shows.closeAll(0);
    await settle();
  }
});

test('历练收窗：逐手局报错也收窗，错误原样抛出来', async () => {
  const fake = fakeSceneElectron();
  let live: LiveBattle | null = null;
  const shows = sceneShows(fake, {
    setLiveBattle: (value) => {
      live = value;
      value?.skip();
    },
    holdPet: async () => {
      throw new Error('占不住宠物');
    },
  });
  try {
    await assert.rejects(
      shows.liveFight({
        a: YOU,
        b: FOE,
        seed: '逐手出错',
        foe: 'tie-ruonan',
        mode: 'ai',
        initialActions: [],
        decide: async () => null,
        onDecision: () => undefined,
        think: () => undefined,
        log: () => undefined,
      }),
      /占不住宠物/,
    );
    await settle();
    assert.equal(fake.created.length, 3);
    assert.ok(
      fake.created.every((win) => win.destroyedNow),
      `出错也把三扇窗收掉：${fake.created.map((win) => win.destroyedNow).join(' / ')}`,
    );
    assert.equal(live, null, '逐手局状态收掉');
  } finally {
    shows.closeAll(0);
    await settle();
  }
});

test('历练开窗：半路开不出下一扇，已经开出的先关掉、错误照抛', async () => {
  for (const failAt of [2, 3]) {
    const fake = fakeSceneElectron(failAt);
    const shows = sceneShows(fake);
    try {
      await assert.rejects(shows.fight({ result: fightResult(), full: false }), /窗口开不出/);
      await settle();
      assert.equal(fake.created.length, failAt - 1, `开到第 ${failAt} 扇失败：只开成前 ${failAt - 1} 扇`);
      assert.ok(
        fake.created.every((win) => win.destroyedNow),
        `已经开出的都关掉（第 ${failAt} 扇失败）：${fake.created.map((win) => win.destroyedNow).join(' / ')}`,
      );
    } finally {
      shows.closeAll(0);
      await settle();
    }
  }
});

test('历练逐手局：先占住宠物再起演', async () => {
  const fake = fakeSceneElectron();
  const order: string[] = [];
  const shows = sceneShows(fake, {
    holdPet: async () => {
      order.push('holdPet');
    },
    setLiveBattle: (value) => {
      if (value) order.push('setLiveBattle');
      value?.skip();
    },
  });
  try {
    const events = await shows.liveFight({
      a: YOU,
      b: FOE,
      seed: '逐手先占锁',
      foe: 'tie-ruonan',
      mode: 'ai',
      initialActions: [],
      decide: async () => null,
      onDecision: () => undefined,
      think: () => undefined,
      log: () => undefined,
    });
    await settle();
    assert.ok(events && events.length > 0, '逐手局打完了');
    assert.deepEqual(order, ['holdPet', 'setLiveBattle'], '占锁在逐手局创建之前');
  } finally {
    shows.closeAll(0);
    await settle();
  }
});
