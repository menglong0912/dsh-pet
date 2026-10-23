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
import { startAppFeatures } from './features.ts';
import type { FeatureElectron } from './features.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const electron: FeatureElectron = {
  powerMonitor: { getSystemIdleTime: () => 0, getSystemIdleState: () => 'active' },
  desktopCapturer: {
    getSources: () =>
      Promise.resolve([{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') } }]),
  },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1 }) },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  shell: { openExternal: () => Promise.resolve() },
};

const ai = {
  canSeeLocally: () => true,
  isReady: () => false,
  streamVision: async function* () {
    yield { type: 'text', text: '主人在写代码呀' };
  },
} as unknown as StandaloneAiService;

/** 手动看一次屏幕；插件 /broadcast 回 broadcast，其余路由（菜单、工作状态）一律成功 */
async function lookWith(broadcast: Record<string, unknown>) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const reply = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.once('end', () => {
      if (path.endsWith('/broadcast')) reply(broadcast);
      else if (path.endsWith('/menu/events')) setTimeout(() => reply({ ok: true, events: {} }), 50);
      else reply({ ok: true });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-features-'));
  const features = startAppFeatures({
    electron,
    ai,
    configPaths: configPathsFor(packageRoot, home),
    appConfig: () => DEFAULT_APP_CONFIG,
    petBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-pet-7340`,
    log: () => undefined,
  });
  try {
    return await features.lookAtScreen(true);
  } finally {
    features.dispose();
    // 等挂着的菜单长轮询回来、看到 disposed 再关服务，免得它进入失败重试的 5 秒等待
    await new Promise((done) => setTimeout(done, 200));
    server.closeAllConnections();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('看屏幕：说出来了才算成功', async () => {
  assert.deepEqual(await lookWith({ ok: true }), { ok: true, text: '主人在写代码呀' });
});

test('看屏幕：宠物被隐藏、插件拒绝说话时如实报失败', async () => {
  assert.deepEqual(await lookWith({ ok: false, reason: 'pet-not-displayed' }), {
    ok: false,
    text: '主人在写代码呀',
    reason: 'say-failed',
  });
});
