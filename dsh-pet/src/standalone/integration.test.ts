/**
 * 端到端契约：**真实 createPetHost** + 真实 `node:http` 服务。
 *
 * 这一层回答"独立模式到底有没有把宿主半边跑起来"，并钉住三件事：
 *   1. 宿主自己的路由前缀经真实 HTTP 可用，前缀之外 404 —— 只有一份路由表；
 *   2. 不依赖包内素材的端点与 DSH 内同形（`/state`、`/models`、`/config/meta` 的路径口径）；
 *   3. 路径安全与"配置不可达"的口径经**真实 HTTP** 仍然成立（服务不重写 URL、不吞异常）。
 *
 * 覆盖范围的限制与 `routes.test.ts` 相同：源码形态下包根解析成 `<pkg>/src`，
 * 包内 `assets/config.jsonc` 不可达 → `readAllConfig` 必抛。因此这里不断言"成品配置"。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageRoot } from '../host/paths.ts';
import { createPetHost, ROUTE_PREFIX } from '../host/index.ts';
import type { PetHost, PetHostAi } from '../host/index.ts';
import type { StandaloneLogger } from './logger.ts';
import { configPathsFor } from './options.ts';

/** 静默日志器（宿主仍会往 console 打少量 warn，那是它自己的诊断，这里不拦） */
const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 未配置的独立 AI：模型清单为空（与真实应用未配模型时同形） */
const ai: PetHostAi = {
  currentSelection: () => ({ provider: 'standalone', model: '' }),
  listProviders: () => [],
  listModels: async () => [],
  resolveModelInfo: async () => undefined,
  // 未配置模型时不会走到 stream；给一个形状正确的空流即可
  stream: () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true as const, value: undefined }) };
    },
  }),
};

let home = '';
let base = '';
let server: Server | undefined;
let host: PetHost | undefined;
let savedHome: string | undefined;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-standalone-'));
  savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  host = createPetHost({ logger: silent, ai });
  server = createServer((req, res) => {
    void host?.handler(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((accept) => server?.listen(0, '127.0.0.1', () => accept()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await host?.dispose().catch(() => {});
  await new Promise<void>((accept) => server?.close(() => accept()));
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

/** 取一条宿主路由的响应 */
async function get(path: string): Promise<{ status: number; text: string; json: () => unknown }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

describe('宿主半边在独立模式下跑起来了', () => {
  test('`/dsh-pet-7340` 前缀交给宿主，前缀之外 404（不自己写第二套路由表）', async () => {
    assert.equal((await get(`${ROUTE_PREFIX}/state`)).status, 200);
    assert.equal((await get('/nope')).status, 404);
  });

  test('/state 与 DSH 内同形（独立模式没有会话事件 → 叶子保持初始值）', async () => {
    const response = await get(`${ROUTE_PREFIX}/state`);
    assert.equal(response.status, 200);
    const body = response.json() as {
      sections: Record<string, { counter: number; data: unknown }>;
      pets: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(body.sections).sort(), ['menu', 'notify', 'workStatus']);
    for (const leaf of Object.values(body.sections)) assert.equal(leaf.counter, 0, '没人写过时 counter=0');
    assert.deepEqual(body.pets, {});
  });

  test('/models 是空清单（未配置模型，但不报错、不静默失败）', async () => {
    const response = await get(`${ROUTE_PREFIX}/models`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { providers: [] });
  });

  test('/config/meta 的路径口径与 options.configPathsFor 完全一致（镜像不得漂移）', async () => {
    const response = await get(`${ROUTE_PREFIX}/config/meta`);
    assert.equal(response.status, 200);
    const meta = response.json() as { user: string; default: string; animations: string };
    const paths = configPathsFor(packageRoot, home);
    // 这三条就是独立模式所依赖的推导；宿主改了路径而 options.ts 没跟，这里会红
    assert.equal(meta.user, paths.userFile);
    assert.equal(meta.default, paths.defaultFile);
    assert.equal(meta.animations, join(home, 'dsh-pet', 'main-animation'));
  });
});

describe('配置与素材不可达时的口径 —— 显式失败，不静默兜底', () => {
  test('包内默认配置读不到（源码形态）→ /config 500 + 错误正文', async () => {
    const response = await get(`${ROUTE_PREFIX}/config`);
    assert.equal(response.status, 500, '读不到配置必须显式失败：静默返回空配置会让桌宠"看起来正常但什么都没有"');
    const body = response.json() as { error?: string };
    assert.equal(typeof body.error, 'string');
    assert.ok((body.error ?? '').length > 0, '错误正文必须可读');
  });

  test('thumb 的路由安全口径经真实 HTTP 仍然成立', async () => {
    // 反斜杠不被 URL 的 pathname 拆段，会作为 petId 直接进路径拼接 —— 必须 400
    assert.equal((await get(`${ROUTE_PREFIX}/thumb/..%5C..%5Coutside/leak.webm`)).status, 400);
    // 扩展名白名单
    assert.equal((await get(`${ROUTE_PREFIX}/thumb/main/x.txt`)).status, 400);
    // 不存在的素材（主素材链与独占目录都查不到）
    assert.equal((await get(`${ROUTE_PREFIX}/thumb/main/${encodeURIComponent('不存在.webm')}`)).status, 404);
  });

  test('pic/memes 的素材根同样不得当路径片段', async () => {
    assert.equal((await get(`${ROUTE_PREFIX}/pic/memes/..%5C..%5Coutside-memes/leak.png`)).status, 400);
    assert.equal((await get(`${ROUTE_PREFIX}/pic/memes/main/nope.png`)).status, 404);
  });
});
