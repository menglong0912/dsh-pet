import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StandaloneAiService } from '../standalone/ai-provider.ts';
import { configPathsFor } from '../standalone/options.ts';
import { DEFAULT_APP_CONFIG } from './app-config.ts';
import type { AppConfig } from './app-config.ts';
import { ANNOUNCE_AFTER_MS } from './claude-hooks.ts';
import { SKILLS, type Fighter, type SkillId } from './battle.ts';
import { diaryDate } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import { startAppFeatures } from './features.ts';
import type { AppFeatures, FeatureDeps, FeatureElectron } from './features.ts';
import {
  cardFighter,
  encodeBeacon,
  knockOn,
  randomSparNonce,
  sendReveal,
  sendSpar,
  sparCardOf,
  sparCommit,
  sparFight,
  SPAR_MODE,
  tripRequest,
  VisitHost,
} from './visit.ts';
import type { SparCard } from './visit.ts';
import { generateVisitIdentity, loadVisitIdentity } from './visit-identity.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 假环境里可调的：键鼠空闲秒数、插件碎碎念间隔、挑表情包时模型的回答、看屏幕时模型磨蹭多久（测试改完要还原） */
const env = { idleSec: 0, whisperSec: 60, memeAnswer: '无', visionDelayMs: 0, visionDone: 0 };

/** 假窗口（客人 / 心魔 / 擂台）：记下页面调用与销毁 */
interface FakeWin {
  isDestroyed(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(rect: { x: number; y: number; width: number; height: number }): void;
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean, level: 'floating'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean }): void;
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  show(): void;
  focus(): void;
  once(event: 'closed', listener: () => void): void;
  destroy(): void;
  webContents: { getURL(): string; executeJavaScript(code: string): Promise<unknown> };
  url: string;
  calls: string[];
  destroyed: boolean;
}

/** 建窗与页面调用记录（心魔试炼那场用；其他测试不开窗口，看到的一直是空） */
const windows: FakeWin[] = [];

function fakeWindow(url: string): FakeWin {
  const win: FakeWin = {
    calls: [],
    destroyed: false,
    url,
    isDestroyed: () => win.destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    setBounds: () => undefined,
    setOpacity: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: (target) => {
      win.url = target;
      return Promise.resolve();
    },
    showInactive: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: () => undefined,
    destroy: () => {
      win.destroyed = true;
    },
    webContents: {
      getURL: () => win.url,
      executeJavaScript: (code) => {
        win.calls.push(code);
        return Promise.resolve(undefined);
      },
    },
  };
  windows.push(win);
  return win;
}

const electron: FeatureElectron = {
  powerMonitor: { getSystemIdleTime: () => env.idleSec, getSystemIdleState: () => 'active' },
  desktopCapturer: {
    getSources: () =>
      Promise.resolve([{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') } }]),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
  // 只有心魔试炼那几项会开窗口（客人、擂台），其余测试一个都不建
  BrowserWindow: Object.assign(
    function () {
      return fakeWindow('');
    },
    { getAllWindows: () => [] },
  ) as unknown as FeatureElectron['BrowserWindow'],
  ipcMain: { on: () => undefined, removeListener: () => undefined },
};

/** 看屏幕发给模型的指令、挑表情包时发给模型的话（按调用顺序） */
const visionPrompts: string[] = [];
const memeAsks: string[] = [];

const ai = {
  canSeeScreen: () => true,
  isReady: () => true,
  currentSelection: () => ({ provider: 'local', model: 'qwen' }),
  stream: async function* (options: { messages: Array<{ content: Array<{ text: string }> }> }) {
    memeAsks.push(options.messages[0].content[0].text);
    yield { type: 'text', text: env.memeAnswer };
  },
  getSettings: () => ({ whisperIntervalSec: env.whisperSec }),
  streamVision: async function* (input: { prompt: string }) {
    visionPrompts.push(input.prompt);
    if (env.visionDelayMs > 0) await new Promise((done) => setTimeout(done, env.visionDelayMs));
    yield { type: 'text', text: '主人在写代码呀' };
    env.visionDone += 1;
  },
} as unknown as StandaloneAiService;

/** 修炼存档里能用的最小一份（炼气九层修满 = 圆满，等突破） */
function cultivationSeed(): Record<string, unknown> {
  return {
    version: 1,
    stage: 8,
    progress: 150,
    stats: { hp: 104, power: 8, agility: 8, speed: 8 },
    weapons: ['water-gun'],
    skills: [],
    pills: 0,
    offer: null,
    today: { date: '2000-01-01', presence: 0, presenceMs: 0, rests: 0, pills: 0, trial: 0, spars: [] },
    record: { wins: 0, losses: 0 },
  };
}

/** withFeatures 顺带记下来的：最近一次注册的菜单 labels、播过的 /anim 请求体、应用的日志 */
interface FeaturesExtras {
  menus: string[][];
  anims: Array<Record<string, unknown>>;
  logs: string[];
}

/**
 * 起一套功能编排跑 fn：插件路由由假服务应答（/broadcast 回 broadcast 并记下说的话与整个请求体，
 * /memes 回 memes 池，其余一律成功），应用配置取 config 的当前值（测试里可以改）。
 * fn 的 home 是这套编排的临时数据目录（宠物日记在 home/diary）。
 */
async function withFeatures(
  options: {
    broadcast?: Record<string, unknown>;
    config?: AppConfig;
    memes?: Array<{ name: string; desc: string }>;
    /** 依次吐给 /menu/events 的菜单点击（label 一项；用完照旧回空） */
    clicks?: string[];
    /** 修炼用注入的随机数（丹药等） */
    rng?: () => number;
    /** 启动前写进 cultivation.json 的存档（比如造一个快圆满的） */
    cultivation?: Record<string, unknown>;
    /** 切磋等应战 / 亮随机数的时限（默认 30 秒；测试调短） */
    sparWaitMs?: number;
    /** 信标的端口与发往地址（测试注入：绑随机端口、不往真实广播地址发） */
    beacon?: { port?: number; targets?: () => Array<{ address: string; port: number }> };
  },
  fn: (
    features: AppFeatures,
    said: string[],
    bodies: Array<Record<string, unknown>>,
    home: string,
    extras: FeaturesExtras,
  ) => Promise<void>,
): Promise<void> {
  const said: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const menus: string[][] = [];
  const anims: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const reply = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.once('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (path.endsWith('/broadcast')) {
        bodies.push(body);
        said.push(String(body.text));
        reply(options.broadcast ?? { ok: true });
      } else if (path.endsWith('/memes')) reply({ ok: true, memes: options.memes ?? [] });
      else if (path.endsWith('/anim')) {
        anims.push(body);
        reply({ ok: true });
      } else if (path.endsWith('/menu/item')) {
        if (Array.isArray(body.labels)) menus.push(body.labels as string[]);
        reply({ ok: true });
      } else if (path.endsWith('/menu/events')) {
        const click = options.clicks?.shift();
        if (click) reply({ ok: true, events: { [click]: 'main' } });
        else setTimeout(() => reply({ ok: true, events: {} }), 50);
      } else reply({ ok: true });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-features-'));
  if (options.cultivation) writeFileSync(join(home, 'cultivation.json'), JSON.stringify(options.cultivation));
  const config = options.config ?? DEFAULT_APP_CONFIG;
  const deps: FeatureDeps = {
    electron,
    ai,
    configPaths: configPathsFor(packageRoot, home),
    appConfig: () => config,
    diaryDir: join(home, 'diary'),
    snackPath: join(home, 'snacks.json'),
    identityPath: join(home, 'visit-identity.json'),
    neighborsPath: join(home, 'neighbors.json'),
    cultivationPath: join(home, 'cultivation.json'),
    cultivationRng: options.rng,
    sparWaitMs: options.sparWaitMs,
    beacon: options.beacon,
    petBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-pet-7340`,
    log: (message) => logs.push(message),
  };
  const features = startAppFeatures(deps);
  try {
    await fn(features, said, bodies, home, { menus, anims, logs });
  } finally {
    features.dispose();
    // 等挂着的菜单长轮询回来、看到 disposed 再关服务，免得它进入失败重试的 5 秒等待
    await new Promise((done) => setTimeout(done, 200));
    server.closeAllConnections();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** 数组最后一项（tsconfig 的 lib 不含 Array.prototype.at） */
const last = <T>(list: T[]): T | undefined => list[list.length - 1];

/** 等条件成立（首拍采样是异步的：要先跑完 lsappinfo） */
/** 等条件成立（首拍采样是异步的；演出的台词按时间线走，第一条在 2.4 秒那一刻，tries 要给够） */
async function until(check: () => boolean, what = '', tries = 100): Promise<void> {
  for (let i = 0; i < tries && !check(); i += 1) await new Promise((done) => setTimeout(done, 20));
  assert.ok(check(), `等待超时 ${what}`);
}

test('看屏幕：说出来了才算成功', async () => {
  await withFeatures({}, async (features) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀' });
  });
});

test('看屏幕：说出来的话记进今天的宠物日记，没说出来的不记', async () => {
  const screenEvents = (home: string) => {
    const path = join(home, 'diary', `${diaryDate(Date.now())}.json`);
    if (!existsSync(path)) return [];
    const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
    return day.events.filter((event) => event.kind === 'screen').map((event) => event.text);
  };
  await withFeatures({}, async (features, _said, _bodies, home) => {
    await features.lookAtScreen(true);
    assert.deepEqual(screenEvents(home), ['看了一眼主人的屏幕，说：「主人在写代码呀」']);
  });
  await withFeatures(
    { broadcast: { ok: false, reason: 'pet-not-displayed' } },
    async (features, _said, _bodies, home) => {
      await features.lookAtScreen(true);
      assert.deepEqual(screenEvents(home), []);
    },
  );
});

test('看屏幕：宠物被隐藏、插件拒绝说话时如实报失败', async () => {
  await withFeatures({ broadcast: { ok: false, reason: 'pet-not-displayed' } }, async (features) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: false, text: '主人在写代码呀', reason: 'say-failed' });
  });
});

test('看屏幕：先说话，再按说出来的话从表情包池挑最搭的一张（看屏幕指令里不提表情包）', async () => {
  const memes = [
    { name: '就一碗', desc: '捧着一只碗' },
    { name: '大的', desc: '比划一个大' },
    { name: '大的要来啦', desc: '举着大喇叭喊' },
  ];
  env.memeAnswer = '「大的要来啦」。'; // 带引号句号、且包含短名「大的」：取完整的那张
  try {
    await withFeatures({ memes }, async (features, _said, bodies) => {
      assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀', image: '大的要来啦' });
      assert.equal(last(bodies)?.image, '大的要来啦');
      assert.match(last(memeAsks) ?? '', /这句话：主人在写代码呀/);
      assert.match(last(memeAsks) ?? '', /就一碗：捧着一只碗/);
      // 回归：图写进看屏幕指令时小模型会顺着表情包名字发挥，看屏幕就不说屏幕了
      assert.doesNotMatch(last(visionPrompts) ?? '', /就一碗|大的要来啦|表情包/);
    });
  } finally {
    env.memeAnswer = '无';
  }
});

test('看屏幕：模型说都不搭、或答的不在池里 → 随机配一张', async () => {
  const memes = [{ name: '就一碗', desc: '捧着一只碗' }];
  try {
    for (const answer of ['无', '我觉得哪张都行']) {
      env.memeAnswer = answer;
      await withFeatures({ memes }, async (features) => {
        assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀', image: '就一碗' });
      });
    }
  } finally {
    env.memeAnswer = '无';
  }
});

test('看屏幕：表情包池为空就不配图', async () => {
  await withFeatures({ memes: [] }, async (features, _said, bodies) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀' });
    assert.equal('image' in (last(bodies) ?? {}), false);
    assert.doesNotMatch(last(visionPrompts) ?? '', /表情包/);
  });
});

test('右键菜单：耗时的动作不堵后面的点击（看屏幕还没看完，日记那项就先处理了）', async () => {
  // 让看屏幕的模型磨蹭 3 秒：比 until 的等待上限（2 秒）长，旧代码上第二项等不到
  Object.assign(env, { visionDelayMs: 3_000, visionDone: 0 });
  const clicks: string[] = [];
  try {
    await withFeatures({ clicks }, async (_features, said) => {
      clicks.push('看看我在干嘛', '宠物日记');
      // 「宠物日记」先说「等我写写今天的日记～」；这时看屏幕还在等模型，不许被它堵住
      await until(() => said.includes('等我写写今天的日记～'));
      assert.equal(env.visionDone, 0);
      // 看屏幕自己慢慢做完（要等满 3 秒的模型磨蹭，比 until 的上限长，单独等）
      for (let i = 0; i < 250 && !said.includes('主人在写代码呀'); i += 1)
        await new Promise((done) => setTimeout(done, 20));
      assert.ok(said.includes('主人在写代码呀'));
    });
  } finally {
    Object.assign(env, { visionDelayMs: 0, visionDone: 0 });
  }
});

test('碎碎念这一拍：到点看屏幕就占这一拍（这一拍以来碰过键鼠就算），刚说完话碎碎念让一让', async () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.screen.intervalMin = 0; // 一采到「人在」就到点
  // 停手 90 秒：应用自己每 5 秒的检查（要求 60 秒内动过）不会看，只有碎碎念这一拍（180 秒内动过）会看
  Object.assign(env, { idleSec: 90, whisperSec: 180 });
  try {
    await withFeatures({ config }, async (features, said) => {
      await until(() => features.activity()?.present === true);
      // 每 5 秒的检查没看（用 length 断言：deepEqual 会把 said 收窄成空数组类型）
      assert.equal(said.length, 0);
      // 别的宠物的拍不管
      assert.equal(features.takeWhisperTurn('someone-else'), false);
      assert.equal(features.takeWhisperTurn('main'), true);
      await until(() => said.includes('主人在写代码呀'));
      // 看屏幕没到点了，但刚说完话：这一拍仍然拿走，碎碎念不顶掉刚冒出来的气泡
      config.screen.intervalMin = 60;
      assert.equal(features.takeWhisperTurn('main'), true);
      assert.deepEqual(said, ['主人在写代码呀']);
    });
  } finally {
    Object.assign(env, { idleSec: 0, whisperSec: 60 });
  }
});

test('碎碎念这一拍：一整拍没碰键鼠（看视频 / 发呆）不看屏幕，照常碎碎念', async () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.screen.intervalMin = 0;
  Object.assign(env, { idleSec: 200, whisperSec: 180 });
  try {
    await withFeatures({ config }, async (features, said) => {
      await until(() => features.activity()?.present === true);
      assert.equal(features.takeWhisperTurn('main'), false);
      assert.deepEqual(said, []);
    });
  } finally {
    Object.assign(env, { idleSec: 0, whisperSec: 60 });
  }
});

test('碎碎念这一拍：看屏幕没到点、应用也没在说话时照常碎碎念', async () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.screen.enabled = false;
  await withFeatures({ config }, async (features, said) => {
    await until(() => features.activity()?.present === true);
    assert.equal(features.takeWhisperTurn('main'), false);
    assert.deepEqual(said, []);
  });
});

/** 读修炼存档（后面几个修炼的测试用） */
function cultivationSave(home: string): Record<string, unknown> | null {
  const path = join(home, 'cultivation.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
}

test('修炼：开关关着不建档，也没有修炼的菜单项', async () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.cultivation.enabled = false;
  await withFeatures({ config }, async (features, _said, _bodies, home, { menus }) => {
    await until(() => features.activity()?.present === true);
    await new Promise((done) => setTimeout(done, 300)); // 多跑几拍：不许中途偷偷建档
    assert.equal(cultivationSave(home), null);
    assert.equal(features.cultivation.view(), null);
    assert.ok(menus.every((labels) => labels.every((label) => !label.startsWith('修炼/'))));
  });
});

test('修炼：开着就建档，菜单里有「修炼」信息项', async () => {
  await withFeatures({}, async (features, _said, _bodies, home, { menus }) => {
    await until(() => features.activity()?.present === true);
    // 建了档（在电脑前的修为怎么攒、怎么封顶，数值口径见 cultivation.test.ts；这里只看接线）
    await until(() => cultivationSave(home) !== null);
    const save = cultivationSave(home)!;
    assert.equal(save.version, 1);
    assert.equal(save.stage, 0);
    const view = features.cultivation.view();
    assert.equal(view?.label, '炼气一层');
    assert.ok(menus.some((labels) => labels.some((label) => /^修炼\/炼气一层 · \d+%$/.test(label))));
  });
});

test('修炼：Claude 干完一轮 ≥ 30 秒的活能拿到丹（注入的随机数），冒泡记日记', async (t) => {
  // 建档先消耗三个随机数（灵力、身法、法宝），第 4 个是丹的概率（0.05 < 0.2，必成）
  const draws = [0.5, 0.5, 0.5, 0.05];
  await withFeatures({ rng: () => draws.shift() ?? 0.5 }, async (features, said, bodies, home) => {
    await until(() => features.activity()?.present === true);
    // 不真等 31 秒：只接管 Date（setTimeout 照常走真的，采样的拍子不受影响），
    // 把时钟拨过「干满 30 秒才算一轮活干完」的口径（claude-hooks 的 ANNOUNCE_AFTER_MS）
    const realNow = Date.now();
    try {
      t.mock.timers.enable({ apis: ['Date'] });
      t.mock.timers.setTime(realNow);
      await features.handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/x/dsh-pet' });
      t.mock.timers.setTime(realNow + ANNOUNCE_AFTER_MS + 1_000);
      await features.handleClaudeHook({ hook_event_name: 'Stop', session_id: 's1' });
    } finally {
      t.mock.timers.reset();
    }
    await until(() => (cultivationSave(home)?.pills as number | undefined) === 1);
    // 冒泡排进了说话队列：等它真说出来；平常的气泡照旧联动说话动画
    await until(() => said.includes('炼成一颗破境丹～'));
    assert.equal(bodies.find((body) => body.text === '炼成一颗破境丹～')?.anim, true);
    const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
    assert.ok(day.events.some((event) => event.kind === 'cultivate' && event.text === '炼成一颗破境丹'));
  });
});

/** 招式编号 → 中文名（菜单「领悟：X」的标签用它拼，测试不重复一份表） */
const SKILL_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(SKILLS).map((def) => [def.id as SkillId, def.name]),
);

/** 圆满档（炼气九层修满）：X4 换成渡劫，这一档加丹数与属性，造必赢 / 必输两种局面用 */
function cultivationFull(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...cultivationSeed(), ...over };
}

test('修炼：圆满时菜单是「渡劫」（不再是「突破」），有丹再多一项「服丹后渡劫」', async () => {
  await withFeatures(
    { cultivation: cultivationFull({ pills: 0 }) },
    async (_features, _said, _bodies, _home, { menus }) => {
      await until(() =>
        menus.some((labels) => labels.includes('修炼/炼气九层 · 100%') && labels.includes('修炼/渡劫')),
      );
      assert.ok(
        menus.every((labels) => !labels.includes('修炼/突破')),
        '「突破」已经被渡劫替换',
      );
      assert.ok(
        menus.every((labels) => !labels.includes('修炼/服丹后渡劫')),
        '没丹就没有服丹那一项',
      );
    },
  );
  await withFeatures(
    { cultivation: cultivationFull({ pills: 2 }) },
    async (_features, _said, _bodies, _home, { menus }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/服丹后渡劫')), '有丹时的服丹项');
    },
  );
});

test('渡劫成功：扛雷演出（无对手窗口）→ 进大境界 → 挂出两项「领悟」→ 点一个招式到手', async () => {
  const clicks: string[] = [];
  // 气血给到 10 万：天雷怎么劈都劈不死，这一场必赢（雷数、动画、二选一都要看得清）
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationFull({ pills: 2, stats: { hp: 100_000, power: 8, agility: 8, speed: 8 } }), clicks },
    async (_features, _said, bodies, home, { menus, anims }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/服丹后渡劫')), '服丹后渡劫可点');
      const before = menus.length;
      clicks.push('修炼/服丹后渡劫');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '开打后菜单换成快进');
      // 吃了丹：开场先播 修炼-服丹（url 形态）；渡劫没有对手，不开任何窗口
      await until(
        () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-服丹'))),
        '服丹动画',
        400,
      );
      assert.equal(windowOn('/app/guest'), undefined, '渡劫不该开心魔 / 客人窗口');
      assert.equal(windowOn('/app/arena'), undefined, '只有一只挨雷，没有擂台血条');
      // 台词报第几道雷，走 anim: false + 一步长（带 anim 的气泡会顶掉正在播的动画）
      clicks.push('修炼/快进');
      await until(() => (cultivationSave(home)?.stage as number | undefined) === 9, '进了筑基');
      const save = cultivationSave(home)!;
      assert.equal(save.pills, 1, '丹扣了一颗（2 → 1）');
      assert.equal((save.stats as { hp: number }).hp, 100_020, '大境界加成 +20 气血');
      assert.ok((save.offer as Record<string, unknown> | null) !== null, '二选一挂出来了');
      // 挨雷的动画（快进只播收场，前面那几步不一定发得出去，这里核收场的 修炼-突破）
      await until(
        () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-突破'))),
        '突破动画',
        400,
      );
      // 结果感言走 compose（只带人设）
      await until(() => memeAsks.some((ask) => /渡劫|天雷/.test(ask)), '结果感言的指令', 400);
      // 菜单：两项「领悟：X」，不再有两个渡劫项
      const offer = save.offer as { a: string; b: string };
      const names = [offer.a, offer.b].map((id) => SKILL_NAMES[id]);
      await until(
        () =>
          menus.some(
            (labels) => labels.includes(`修炼/领悟：${names[0]}`) && labels.includes(`修炼/领悟：${names[1]}`),
          ),
        `领悟两项（一共 ${before} 次注册）`,
        400,
      );
      const tail = last(menus)!;
      assert.ok(
        tail.filter((label) => label.startsWith('修炼/')).length <= 4,
        `修炼子菜单不超名额：${JSON.stringify(tail)}`,
      );
      clicks.push(`修炼/领悟：${names[0]}`);
      await until(() => {
        const now = cultivationSave(home)!;
        return (now.skills as string[]).includes(offer.a) && now.offer === null;
      }, '点了领悟：招式到手、二选一收走');
      await until(
        () => menus.some((labels) => !labels.some((label) => label.startsWith('修炼/领悟：'))),
        '菜单收回领悟两项',
      );
      assert.ok(
        bodies.some((body) => body.anim === false),
        '演出台词不联动动画',
      );
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(
        day.events.some((event) => event.kind === 'cultivate' && /突破到筑基初期/.test(event.text)),
        '记了渡劫成功',
      );
    },
  );
});

test('渡劫失败：扣 20% 修为、境界不掉、不再是圆满（不设冷却），播池内的垂头叹气', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  // 气血 1：三道雷只要有一道没躲开就倒下（全躲开的概率约 3e-6）
  await withFeatures(
    { cultivation: cultivationFull({ stats: { hp: 1, power: 8, agility: 8, speed: 8 }, pills: 0 }), clicks },
    async (_features, _said, _bodies, home, { menus, anims }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/渡劫')), '渡劫可点');
      clicks.push('修炼/渡劫');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '开打');
      // 快进前该已经挨上雷了（X7：乌云聚起、闪电劈中那一刻触电，第一道约在 3.1 秒；
      // 第一道被躲开的话要等下一道，再晚两秒左右）
      await until(
        () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-触电'))),
        '触电动画',
        800,
      );
      clicks.push('修炼/快进');
      await until(() => (cultivationSave(home)?.progress as number | undefined) === 120, '扣了 30 修为');
      const save = cultivationSave(home)!;
      assert.equal(save.stage, 8, '不掉境界');
      assert.equal(save.offer, null, '失败不挂二选一');
      // 不再是圆满：菜单里渡劫那项没了，攒回 100% 才会再出现
      await until(() => menus.some((labels) => labels.includes('修炼/炼气九层 · 80%')), '菜单跟着改');
      assert.ok(last(menus)!.every((label) => label !== '修炼/渡劫' && label !== '修炼/服丹后渡劫'));
      // 失败收场是池里的现有素材（名字形态，不是 url）
      await until(() => anims.some((body) => body.name === '工作状态-垂头叹气冒汗'), '垂头叹气冒汗走名字形态播', 400);
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(day.events.some((event) => event.kind === 'cultivate' && /渡劫没扛住，修为退了 30/.test(event.text)));
    },
  );
});

test('二选一过期没人挑：下一拍随机定一个（拨 Date，不真等 10 分钟）', async (t) => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationFull({ pills: 0, stats: { hp: 100_000, power: 8, agility: 8, speed: 8 } }), clicks },
    async (_features, _said, _bodies, home, { menus }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/渡劫')), '渡劫可点');
      const realNow = Date.now();
      clicks.push('修炼/渡劫');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '开打');
      clicks.push('修炼/快进');
      await until(() => cultivationSave(home)?.offer !== null, '二选一挂出来');
      const offer = cultivationSave(home)!.offer as { a: string; b: string };
      await until(
        () => menus.some((labels) => labels.includes(`修炼/领悟：${SKILL_NAMES[offer.a]}`)),
        '菜单有领悟两项',
      );
      try {
        // 只接管 Date（拍子照走真的），把时钟拨过 10 分钟：tick 那一拍该随机定一个
        t.mock.timers.enable({ apis: ['Date'] });
        t.mock.timers.setTime(realNow + 11 * 60_000);
        // 拨完表要等下一拍（TICK_MS = 5 秒，真的）：tries 给够
        await until(() => cultivationSave(home)?.offer === null, '过期自动定', 800);
      } finally {
        t.mock.timers.reset();
      }
      const save = cultivationSave(home)!;
      const skills = save.skills as string[];
      assert.equal(skills.length, 1);
      assert.ok(skills[0] === offer.a || skills[0] === offer.b, `定的是两个里的一个：${skills[0]}`);
      await until(() => menus.some((labels) => !labels.some((label) => label.startsWith('修炼/领悟：'))), '菜单收回');
    },
  );
});

/** 找某一页的假窗口（按 URL 结尾） */
const windowOn = (page: string): FakeWin | undefined => windows.find((win) => win.url.endsWith(page));

/** 一层炼气的存档（心魔试炼 / 切磋那几项用：从第一层开始，进账看得清）；属性照建档口径（气血 50、三维合计 11），不能越 statCap(0) */
function cultivationEarly(): Record<string, unknown> {
  return { ...cultivationSeed(), stage: 0, progress: 0, stats: { hp: 50, power: 4, agility: 4, speed: 3 } };
}

test('心魔试炼：菜单里有该项；窗口与动画、血条按时间线走；打的时候碎碎念让路；快进后奖励进存档', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, _said, bodies, home, extras) => {
    const { menus, anims } = extras;
    await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), 'trial menu');
    clicks.push('修炼/心魔试炼');
    // 心魔窗口（暗色）与擂台窗口都开了
    await until(() => windowOn('/app/guest') !== undefined && windowOn('/app/arena') !== undefined, 'windows');
    const guest = windowOn('/app/guest')!;
    const arena = windowOn('/app/arena')!;
    assert.ok(
      guest.calls.some((code) => code.includes('"shadow"')),
      '心魔窗口是 shadow 配色',
    );
    // 开场那一步（t=0）：自家宠物走 /anim 的 url 形态，带朝向（面朝对手）与倍速（正好占满一步）
    await until(
      () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('战斗-起手'))),
      'opening anim',
    );
    const opening = anims.find((body) => String(body.url ?? '').includes(encodeURIComponent('战斗-起手')))!;
    assert.equal(opening.facing, 'left');
    assert.equal(typeof opening.rate, 'number');
    assert.ok(
      Number(opening.rate) >= 0.5 && Number(opening.rate) <= 3,
      `倍速在 /anim 允许的区间：${String(opening.rate)}`,
    );
    // 心魔窗口那边同样按时间线播动画（带倍速）
    await until(
      () => guest.calls.some((code) => code.startsWith('guest.play(') && !code.endsWith(', 1)')),
      'guest play rate',
    );
    // 擂台按引擎的事件刷血，两条分别是我与心魔
    await until(() => arena.calls.some((code) => code.startsWith('arena.update(')), 'arena update');
    assert.ok(
      arena.calls.some((code) => code.includes('"label":"心魔"')),
      `对手那条是心魔：${last(arena.calls)}`,
    );
    // 演出台词：anim 一律 false，时长跟着时间线的一步（下一句自然顶替上一句）——带 anim 的气泡会顶掉正在播的动画
    await until(
      () => bodies.some((body) => body.anim === false && body.duration === 2400),
      'show line anim:false + duration',
      400,
    );
    // 打的时候：菜单换成快进、没有「心魔试炼」，碎碎念让路
    await until(() => menus.some((labels) => labels.includes('修炼/快进')), 'fast-forward menu');
    assert.equal(features.takeWhisperTurn('main'), true, '演出台词按时间线走，碎碎念别来抢');
    // 快进看结果
    clicks.push('修炼/快进');
    await until(() => (cultivationSave(home)?.today as { trial: number }).trial === 1, 'trial counted');
    const save = cultivationSave(home)!;
    const record = save.record as { wins: number; losses: number };
    assert.equal(record.wins + record.losses, 1, '一场的心魔战绩记上了');
    assert.ok((save.progress as number) > 0, '修为进了账（赢 +30 / 输 +10）');
    // 赛后感言走 compose（只带人设），指令里说清了对手与胜负
    await until(() => memeAsks.some((ask) => /心魔/.test(ask)), 'postgame compose');
    const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
    assert.ok(
      day.events.some((event) => event.kind === 'cultivate' && /心魔试炼/.test(event.text)),
      '记了日记',
    );
    // 演完收回菜单：又有「心魔试炼」、没有「快进」
    await until(
      () => menus.some((labels) => labels.includes('修炼/心魔试炼') && !labels.includes('修炼/快进')),
      'menu back',
    );
  });
});

test('修炼：演完一场再点第二场，只有第一场加修为（当天只算一场收益）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const record = (home: string) => cultivationSave(home)?.record as { wins: number; losses: number };
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (_features, _said, _bodies, home, extras) => {
    const { menus } = extras;
    let firstRound = -1;
    for (const round of [1, 2]) {
      await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), `第 ${round} 场可点`);
      clicks.push('修炼/心魔试炼');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), `第 ${round} 场开打`);
      clicks.push('修炼/快进');
      await until(() => record(home).wins + record(home).losses >= round, `第 ${round} 场记账`);
      if (round === 1) firstRound = (cultivationSave(home)?.progress as number) ?? 0;
    }
    const save = cultivationSave(home)!;
    assert.equal((save.today as { trial: number }).trial, 1, '当天只算一场收益');
    assert.equal(record(home).wins + record(home).losses, 2, '两场战绩都记');
    assert.equal(save.progress, firstRound, '第二场一点修为都没进账');
  });
});

test('修炼关掉时没有「心魔试炼」这一项', async () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.cultivation.enabled = false;
  await withFeatures({ config }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => menus.length > 0);
    assert.ok(menus.every((labels) => !labels.includes('修炼/心魔试炼')));
  });
});

// ---------- 切磋（X5） ----------

/** 空着的 UDP 端口（先占住再让出来：信标要用它，不能碰真 app 的 47340，也不能往真实广播地址发） */
async function freeUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}

/** 开着接待的 features 里，替一位带身份的客人敲门、点菜单让进；返回接待端口与令牌 */
async function knockIn(
  home: string,
  clicks: string[],
  extras: FeaturesExtras,
): Promise<{ port: number; token: string }> {
  const { menus, logs } = extras;
  await until(() => logs.some((line) => /接待开了，端口 (\d+)/.test(line)), '接待开了');
  const port = Number(/接待开了，端口 (\d+)/.exec(logs.find((line) => /接待开了，端口/.test(line))!)![1]);
  // 身份文件里只有私钥：id 要真的把它加载出来（照 visit-identity 的口径）
  const hostId = loadVisitIdentity(join(home, 'visit-identity.json'), () => undefined).id;
  const knocking = knockOn(
    { address: '127.0.0.1', port },
    { owner: '小李', pet: '阿花' },
    generateVisitIdentity(),
    hostId,
  );
  await until(() => menus.some((labels) => labels.includes('让 阿花 进来')), '敲门进了菜单');
  clicks.push('让 阿花 进来');
  const answer = await knocking;
  assert.ok(answer.ok, '敲开了门');
  assert.ok(answer.ok && answer.verified, '主人家的签名对上了');
  return { port, token: answer.ok ? answer.token : '' };
}

/** 客人（阿花）的名帖：炼气二层、扑克牌、化鸽遁（都在 statCap(1) 之内） */
function guestCard(): SparCard {
  return sparCardOf({ name: '阿花', hp: 56, power: 5, agility: 5, speed: 5, weapons: ['poker'], skills: ['dove'] }, 1);
}

/** 主人家这边的战斗档案：照 cultivationEarly 的档造的（气血 50、灵力 4 / 身法 4 / 遁速 3、一件水枪、没有招式） */
const hostFighter: Fighter = {
  name: '桌宠',
  hp: 50,
  power: 4,
  agility: 4,
  speed: 3,
  weapons: ['water-gun'],
  skills: [],
};

/** 开接待那套配置（信标绑测试自己的端口、哪儿都不发） */
function visitConfig(): AppConfig {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.visit.enabled = true;
  config.visit.hosting = true;
  return config;
}

test('切磋（主人家）：邀约 → 应战 → 亮随机数 → 演出与擂台 → 修为、战绩、邻居簿、日记都记上', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  await withFeatures(
    { config: visitConfig(), cultivation: cultivationEarly(), clicks, beacon: { port: beaconPort, targets: () => [] } },
    async (_features, said, _bodies, home, extras) => {
      const { menus } = extras;
      const { port, token } = await knockIn(home, clicks, extras);
      // 切磋的菜单项有了（开着修炼、客人在、验证过身份、没在打）
      await until(() => menus.some((labels) => labels.includes('串门/和客人切磋')), '切磋菜单项');
      const target = { address: '127.0.0.1', port };
      clicks.push('串门/和客人切磋');
      // 邀约捎到客人那边：开场那句说出口 = inviteSpar 跑完（邀约已攒进出风箱），下一次报平安就带上了
      await until(() => said.some((text) => text.includes('过两招')), '开场那句');
      const ping = await tripRequest(target, '/v1/ping', { token });
      assert.ok(ping.ok && ping.events.some((event) => event.type === 'spar-invite'), '邀约上了 ping');
      // 应战：主人家的随机数到了；正在打时再来一发是 busy
      const ownNonce = randomSparNonce();
      const ask = () =>
        sendSpar(
          { address: '127.0.0.1', port },
          { token, mode: SPAR_MODE, card: guestCard(), commit: sparCommit(ownNonce) },
        );
      const reply = await ask();
      assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
      const hostNonce = reply.ok ? reply.nonce : '';
      assert.deepEqual(await ask(), { ok: false, reason: 'busy' });
      // 亮随机数 → 开打（两边各自算同一场，赢家照这边自己的口径复核）
      assert.deepEqual(
        await sendReveal({ address: '127.0.0.1', port }, { token, nonce: ownNonce, line: '承让承让～' }),
        { ok: true },
      );
      const fightEvents = sparFight(hostFighter, cardFighter('阿花', guestCard()), ownNonce, hostNonce);
      const fightEnd = fightEvents[fightEvents.length - 1]!;
      const won = fightEnd.kind === 'end' && fightEnd.winner === 0;
      // 这边的账：战绩 +1、修为进账（anim:false 的冒泡）、邻居簿、日记
      await until(() => {
        const record = cultivationSave(home)?.record as { wins: number; losses: number } | undefined;
        return record !== undefined && record.wins + record.losses === 1;
      }, '战绩记上了');
      const record = cultivationSave(home)!.record as { wins: number; losses: number };
      assert.equal(won ? record.wins : record.losses, 1, '输赢跟两边各自算的那场一致');
      assert.ok((cultivationSave(home)!.progress as number) > 0, '修为进了账');
      const book = JSON.parse(readFileSync(join(home, 'neighbors.json'), 'utf8')) as {
        neighbors: Array<Record<string, unknown>>;
      };
      assert.equal(book.neighbors.length, 1);
      assert.equal(book.neighbors[0][won ? 'sparWins' : 'sparLosses'], 1, '邻居簿记了切磋账');
      assert.equal(book.neighbors[0].lastSparWon, won, '上次切磋的输赢留给见面提');
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(
        day.events.some((event) => event.kind === 'cultivate' && /切磋/.test(event.text)),
        '记了日记',
      );
      // 演出：擂台开了、客人窗口照旧粉色、打的时候菜单换成快进
      await until(() => windowOn('/app/arena') !== undefined, '擂台开了', 400);
      const guest = windowOn('/app/guest');
      assert.ok(guest, '客人窗口在');
      assert.ok(!guest!.calls.some((code) => code.includes('"shadow"')), '切磋的客人窗口不是心魔配色');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '打的时候换成快进');
      // 快进收场：客人的感言（跟着 reveal 带来的）上了客人窗口、自家感言走 compose
      clicks.push('修炼/快进');
      await until(
        () => guest!.calls.some((code) => code.startsWith('guest.say(') && code.includes('承让承让')),
        '客人的感言上了客人窗口',
        400,
      );
      await until(() => memeAsks.some((ask) => /切磋/.test(ask)), '自家感言走 compose', 400);
      await until(() => said.some((text) => text.includes('过两招')), '开场说了一句');
      // 打完菜单收回来——必须看**最新**一帧（some 扫历史会被开打前的快照满足，真机 battle
      // 残留的 bug 就是从这漏过去的）：快进消失、切磋项回来了
      await until(
        () => {
          const latest = menus[menus.length - 1] ?? [];
          return latest.includes('串门/和客人切磋') && !latest.includes('修炼/快进');
        },
        '打完菜单收回来（battle 清零、快进消失）',
        400,
      );
    },
  );
});

test('切磋：随机数对不上、超时没亮、邀约没人接，各按各的口径收场（不开打、没有擂台）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      clicks,
      sparWaitMs: 300,
      beacon: { port: beaconPort, targets: () => [] },
    },
    async (_features, said, _bodies, home, extras) => {
      const { menus } = extras;
      const { port, token } = await knockIn(home, clicks, extras);
      const target = { address: '127.0.0.1', port };
      // 邀约没人接：过了时限收摊，说一句没接招
      await until(() => menus.some((labels) => labels.includes('串门/和客人切磋')));
      clicks.push('串门/和客人切磋');
      await until(() => said.some((text) => text.includes('过两招')), '开场那句');
      await until(() => said.some((text) => text.includes('没接招')), '邀约超时收摊');
      // 应战 → 亮的随机数对不上：按客人认输记（这边的战绩是赢），应答如实说 mismatch
      const reply = await sendSpar(target, {
        token,
        mode: SPAR_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
      assert.deepEqual(await sendReveal(target, { token, nonce: 'd'.repeat(64), line: '胡说的' }), {
        ok: false,
        reason: 'mismatch',
      });
      await until(() => (cultivationSave(home)?.record as { wins: number }).wins === 1, '认输记成赢');
      // 没开打：没有擂台、没有快进、客人那句「感言」也没上屏
      await new Promise((done) => setTimeout(done, 200));
      assert.equal(windowOn('/app/arena'), undefined, '没开擂台');
      assert.ok(
        menus.every((labels) => !labels.includes('修炼/快进')),
        '没开打',
      );
      assert.ok(!windowOn('/app/guest')!.calls.some((code) => code.includes('胡说的')), '没核上承诺的感言不上屏');
      await until(() => said.some((text) => text.includes('算它认输')), '说了认输');
      // 再来一场，超时才亮：同样按认输记
      const again = await sendSpar(target, {
        token,
        mode: SPAR_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(again.ok);
      await new Promise((done) => setTimeout(done, 500));
      assert.deepEqual(await sendReveal(target, { token, nonce: 'c'.repeat(64), line: '迟到的' }), {
        ok: false,
        reason: 'late',
      });
      await until(() => (cultivationSave(home)?.record as { wins: number }).wins === 2, '超时也是认输');
    },
  );
});

test('切磋（客人）：找主人家的宠物切磋 → 应战、亮随机数 → 台词转播回来、账记上、没被叫回家', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.visit.enabled = true;
  config.visit.visiting = true;
  // 假主人家（跟 dev/visit-peer.mjs 的 host 模式同一套）：应战用一份假名帖，随机数是固定的
  const HOST_NONCE = 'b'.repeat(64);
  const fakeCard = sparCardOf(
    { name: '大个', hp: 70, power: 8, agility: 6, speed: 6, weapons: ['top'], skills: ['shadow-fists'] },
    3,
  );
  const fakeId = 'f'.repeat(32);
  const saw: { card: SparCard | null; commit: string | null; nonce: string | null; line: string | null } = {
    card: null,
    commit: null,
    nonce: null,
    line: null,
  };
  const fake = new VisitHost(
    {
      canHost: () => true,
      knocked: (visitor) => {
        setTimeout(() => fake.answer(true), 50);
        assert.ok(visitor);
      },
      knockEnded: () => undefined,
      line: () => Promise.resolve('欢迎欢迎，随便玩呀～'),
      note: () => false,
      async spar(_visitor, card, commit) {
        saw.card = card;
        saw.commit = commit;
        return { ok: true, card: fakeCard, nonce: HOST_NONCE };
      },
      async reveal(_visitor, nonce, line) {
        saw.nonce = nonce;
        saw.line = line;
        return sparCommit(nonce) === saw.commit ? { ok: true } : { ok: false, reason: 'mismatch' };
      },
      left: () => undefined,
    },
    { log: () => undefined },
  );
  const fakePort = await fake.listen('127.0.0.1');
  const beaconPort = await freeUdpPort();
  // 信标：让 features 听见这位邻居（beacon 旋钮把 features 的信标绑到测试自己的端口）
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const beaconPayload = encodeBeacon({ id: fakeId, owner: '测试邻居', pet: '大个', port: fakePort });
  const sendBeacon = () => beacon.send(beaconPayload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const beaconTimer = setInterval(sendBeacon, 500);
  try {
    await withFeatures(
      { config, cultivation: cultivationEarly(), clicks, beacon: { port: beaconPort, targets: () => [] } },
      async (_features, said, bodies, home, extras) => {
        const { menus } = extras;
        await until(
          () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居（菜单要等下一拍才重注册）',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => menus.some((labels) => labels.includes('串门/找主人家的宠物切磋')), '进了门、切磋项出现');
        clicks.push('串门/找主人家的宠物切磋');
        // 客人发来名帖与承诺，接着亮随机数（带一句按人设编的感言）
        await until(() => saw.card !== null, '切磋请求送到了主人家');
        await until(() => saw.nonce !== null, '亮了随机数');
        assert.equal(saw.line, env.memeAnswer, '感言走 compose（假模型的回答，不是兜底模板）');
        // 账：测试拿同一对随机数复核这场谁赢，客人的记录必须一致
        const expected = sparFight(cardFighter('大个', fakeCard), hostFighter, saw.nonce!, HOST_NONCE);
        const expectedEnd = expected[expected.length - 1]!;
        const won = expectedEnd.kind === 'end' && expectedEnd.winner === 1;
        await until(() => {
          const record = cultivationSave(home)?.record as { wins: number; losses: number } | undefined;
          return record !== undefined && record.wins + record.losses === 1;
        }, '客人这边记了账');
        const record = cultivationSave(home)!.record as { wins: number; losses: number };
        assert.equal(won ? record.wins : record.losses, 1, '输赢跟两边各自算的那场一致');
        assert.ok((cultivationSave(home)!.progress as number) > 0, '修为进了账（relay，不叫回家）');
        const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
        assert.ok(
          day.events.some((event) => event.kind === 'cultivate' && /切磋/.test(event.text)),
          '记了日记',
        );
        // 转播：开场那句、台词、结果都是 anim:false 的气泡
        await until(
          () => bodies.some((body) => body.anim === false && String(body.text).includes('过两招')),
          '开场那句转播了',
        );
        await until(() => menus.some((labels) => labels.includes('修炼/快进')), '转播中可快进');
        clicks.push('修炼/快进');
        await until(
          () => bodies.some((body) => body.anim === false && String(body.text).startsWith('（切磋）这场')),
          '结果转播了',
          400,
        );
        assert.ok(
          bodies.some(
            (body) =>
              body.anim === false &&
              typeof body.text === 'string' &&
              !String(body.text).startsWith('（切磋）') &&
              !String(body.text).startsWith('（在 '),
          ),
          '战斗台词也转播回来了',
        );
        // 没被叫回家：还在别人家
        await until(() => menus.some((labels) => labels.includes('从 测试邻居 家回来')), '还在别人家做客');
        assert.ok(
          said.every((text) => !text.includes('我从 测试邻居 家回来')),
          '转播不走 say',
        );
      },
    );
  } finally {
    clearInterval(beaconTimer);
    beacon.close();
    await fake.close();
  }
});
