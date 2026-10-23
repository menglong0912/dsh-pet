import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StandaloneAiService } from '../standalone/ai-provider.ts';
import { configPathsFor } from '../standalone/options.ts';
import { DEFAULT_APP_CONFIG } from './app-config.ts';
import type { AppConfig } from './app-config.ts';
import { startAppFeatures } from './features.ts';
import type { AppFeatures, FeatureElectron } from './features.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 假环境里可调的两样：键鼠空闲秒数、插件碎碎念间隔（测试改完要还原） */
const env = { idleSec: 0, whisperSec: 60 };

const electron: FeatureElectron = {
  powerMonitor: { getSystemIdleTime: () => env.idleSec, getSystemIdleState: () => 'active' },
  desktopCapturer: {
    getSources: () =>
      Promise.resolve([{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') } }]),
  },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1 }) },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  shell: { openExternal: () => Promise.resolve() },
};

/** 看屏幕发给模型的指令（按调用顺序） */
const visionPrompts: string[] = [];

const ai = {
  canSeeLocally: () => true,
  isReady: () => false,
  getSettings: () => ({ whisperIntervalSec: env.whisperSec }),
  streamVision: async function* (input: { prompt: string }) {
    visionPrompts.push(input.prompt);
    yield { type: 'text', text: '主人在写代码呀' };
  },
} as unknown as StandaloneAiService;

/**
 * 起一套功能编排跑 fn：插件路由由假服务应答（/broadcast 回 broadcast 并记下说的话与整个请求体，
 * /memes 回 memes 池，其余一律成功），应用配置取 config 的当前值（测试里可以改）。
 */
async function withFeatures(
  options: { broadcast?: Record<string, unknown>; config?: AppConfig; memes?: Array<{ name: string; desc: string }> },
  fn: (features: AppFeatures, said: string[], bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const said: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const reply = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.once('end', () => {
      if (path.endsWith('/broadcast')) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        said.push(String(body.text));
        reply(options.broadcast ?? { ok: true });
      } else if (path.endsWith('/memes')) reply({ ok: true, memes: options.memes ?? [] });
      else if (path.endsWith('/menu/events')) setTimeout(() => reply({ ok: true, events: {} }), 50);
      else reply({ ok: true });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-features-'));
  const config = options.config ?? DEFAULT_APP_CONFIG;
  const features = startAppFeatures({
    electron,
    ai,
    configPaths: configPathsFor(packageRoot, home),
    appConfig: () => config,
    petBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-pet-7340`,
    log: () => undefined,
  });
  try {
    await fn(features, said, bodies);
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

test('看屏幕：宠物被隐藏、插件拒绝说话时如实报失败', async () => {
  await withFeatures({ broadcast: { ok: false, reason: 'pet-not-displayed' } }, async (features) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: false, text: '主人在写代码呀', reason: 'say-failed' });
  });
});

test('看屏幕：开着碎碎念配图就从表情包池随机抽一张，话按图写、图随气泡显示', async () => {
  // 包内默认配置 whisperImageEnabled = true（与碎碎念配图同一个开关）
  await withFeatures({ memes: [{ name: '就一碗', desc: '捧着一只碗' }] }, async (features, _said, bodies) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀', image: '就一碗' });
    assert.equal(last(bodies)?.image, '就一碗');
    assert.match(last(visionPrompts) ?? '', /就一碗（捧着一只碗）/);
  });
});

test('看屏幕：表情包池为空就不配图', async () => {
  await withFeatures({ memes: [] }, async (features, _said, bodies) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀' });
    assert.equal('image' in (last(bodies) ?? {}), false);
    assert.doesNotMatch(last(visionPrompts) ?? '', /表情包/);
  });
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
