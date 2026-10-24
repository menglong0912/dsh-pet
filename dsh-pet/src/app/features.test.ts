import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StandaloneAiService } from '../standalone/ai-provider.ts';
import { configPathsFor } from '../standalone/options.ts';
import { DEFAULT_APP_CONFIG } from './app-config.ts';
import type { AppConfig } from './app-config.ts';
import { ANNOUNCE_AFTER_MS } from './claude-hooks.ts';
import { diaryDate } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import { startAppFeatures } from './features.ts';
import type { AppFeatures, FeatureElectron } from './features.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 假环境里可调的：键鼠空闲秒数、插件碎碎念间隔、挑表情包时模型的回答、看屏幕时模型磨蹭多久（测试改完要还原） */
const env = { idleSec: 0, whisperSec: 60, memeAnswer: '无', visionDelayMs: 0, visionDone: 0 };

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
  // 这些测试不开串门（默认关），用不到窗口
  BrowserWindow: Object.assign(
    function () {
      throw new Error('测试里不开窗口');
    },
    { getAllWindows: () => [] },
  ) as unknown as FeatureElectron['BrowserWindow'],
  ipcMain: { on: () => undefined, removeListener: () => undefined },
};

/** 看屏幕发给模型的指令、挑表情包时发给模型的话（按调用顺序） */
const visionPrompts: string[] = [];
const memeAsks: string[] = [];

const ai = {
  canSeeLocally: () => true,
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

/** withFeatures 顺带记下来的：最近一次注册的菜单 labels、播过的 /anim 请求体 */
interface FeaturesExtras {
  menus: string[][];
  anims: Array<Record<string, unknown>>;
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
  const features = startAppFeatures({
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
    petBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-pet-7340`,
    log: () => undefined,
  });
  try {
    await fn(features, said, bodies, home, { menus, anims });
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
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((done) => setTimeout(done, 20));
  assert.ok(check(), '等待超时');
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

test('修炼：圆满时菜单有「突破」，点突破进下一个大境界、播突破动画', async () => {
  const clicks: string[] = [];
  await withFeatures(
    { cultivation: cultivationSeed(), clicks },
    async (_features, _said, bodies, home, { menus, anims }) => {
      await until(() =>
        menus.some((labels) => labels.includes('修炼/炼气九层 · 100%') && labels.includes('修炼/突破')),
      );
      clicks.push('修炼/突破');
      await until(() => (cultivationSave(home)?.stage as number | undefined) === 9);
      // 动画请求是异步发出去的：等它到
      await until(() => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-突破'))));
      // 突破那句话的气泡不带说话动画（anim: false），不顶掉正在播的突破动画
      await until(() => bodies.some((body) => body.anim === false));
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(day.events.some((event) => event.kind === 'cultivate' && event.text.startsWith('突破到筑基初期')));
    },
  );
});
