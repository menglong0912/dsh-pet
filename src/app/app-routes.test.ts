import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appCultivationHandler, appNeighborsHandler, createAppRoutes, petSettingsHandler } from './app-routes.ts';
import type { AppFeatures } from './features.ts';

/** 起一个 HTTP 服务，跑完 fn 关掉 */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const file = '/data/dsh-pet/main-config.jsonc';

test('pet settings are read from and saved through the plugin config route, never written here', async () => {
  const seen: Array<{ method: string; body: string; origin?: string }> = [];
  let status = 200;
  // 假的插件 /config：GET 回成品配置，PUT 记下请求体
  const plugin = (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', body, origin: req.headers.origin });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ main: { pets: [{ id: 'main' }] } }));
    });
  };
  await serve(plugin, async (pluginBase) => {
    const handler = petSettingsHandler(() => `${pluginBase}/dsh-pet-7340/config`, file);
    await serve(
      (req, res) => void handler(req, res),
      async (base) => {
        const read = await fetch(base);
        assert.equal(read.status, 200);
        assert.deepEqual(await read.json(), { config: { main: { pets: [{ id: 'main' }] } }, file });

        const body = { pets: [{ id: 'main', name: '小鱼' }], chatMemoryRounds: 3 };
        const saved = await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(saved.status, 200);
        assert.deepEqual(seen[seen.length - 1], { method: 'PUT', body: JSON.stringify(body), origin: undefined });

        // 插件说不合法 / 配置文件坏了：如实告诉设置页，不重试、不强写
        status = 400;
        const bad = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(bad.status, 400);
        status = 409;
        const broken = await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(broken.status, 409);
        assert.match(((await broken.json()) as { error: string }).error, /main-config\.jsonc/);

        // 方法、格式不对：不转给插件
        const before = seen.length;
        assert.equal((await fetch(base, { method: 'PUT', body: '{}' })).status, 405);
        assert.equal((await fetch(base, { method: 'POST', body: '{}' })).status, 415);
        const notObject = await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '[1]',
        });
        assert.equal(notObject.status, 400);
        assert.equal(seen.length, before);
      },
    );
  });
});

test('app neighbors route serves the book, applies each action, and guards identity resets', async () => {
  const record = {
    id: 'a'.repeat(32),
    owner: '小李',
    pet: '阿花',
    friend: true,
    hosted: 2,
    visited: 1,
    firstMet: 0,
    lastMet: 3_000,
    summary: '聊了放风筝',
  };
  const calls: string[] = [];
  let resettingAllowed = true;
  const fake = {
    neighbors: {
      identityId: () => 'b'.repeat(32),
      list: () => [record],
      setFriend: (id: string, friend: boolean) => calls.push(`friend ${id} ${friend}`),
      forget: (id: string) => calls.push(`forget ${id}`),
      clear: () => calls.push('clear'),
      resetIdentity: () => {
        if (!resettingAllowed) return false;
        calls.push('reset');
        return true;
      },
    },
  };
  let current: unknown = fake;
  const handler = appNeighborsHandler(() => current as AppFeatures | null);
  await serve(
    (req, res) => void handler(req, res),
    async (base) => {
      // GET：身份 id 只回前 8 位，邻居簿原样列出
      const read = await fetch(base);
      assert.equal(read.status, 200);
      assert.deepEqual(await read.json(), { id: 'b'.repeat(8), neighbors: [record] });

      const post = (body: string) =>
        fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      for (const [body, expected] of [
        [`{"action":"friend","id":"${'a'.repeat(32)}","friend":false}`, `friend ${'a'.repeat(32)} false`],
        [`{"action":"forget","id":"${'a'.repeat(32)}"}`, `forget ${'a'.repeat(32)}`],
        ['{"action":"clear"}', 'clear'],
        ['{"action":"reset-identity"}', 'reset'],
      ] as const) {
        assert.equal((await post(body)).status, 200);
        assert.equal(calls[calls.length - 1], expected);
      }

      // 非法参数：不落到邻居簿上
      const before = calls.length;
      for (const bad of ['{}', '{"action":"nope"}', `{"action":"friend","id":"short"}`, '{"action":"forget"}', '[1]']) {
        assert.equal((await post(bad)).status, 400, bad);
      }
      assert.equal(calls.length, before);
      assert.equal((await fetch(base, { method: 'PUT', body: '{}' })).status, 405);

      // 串门进行中不让重置身份
      resettingAllowed = false;
      const busy = await post('{"action":"reset-identity"}');
      assert.equal(busy.status, 409);
      assert.match(((await busy.json()) as { error: string }).error, /串门进行中/);

      // 功能还没起来（app ready 之前）：503
      current = null;
      assert.equal((await fetch(base)).status, 503);
    },
  );
});

test('app cultivation route serves the read-only view, 200s null while off, and 503s before the app is up', async () => {
  const view = {
    stage: 4,
    label: '炼气五层',
    percent: 63,
    full: false,
    stats: { hp: 74, power: 8, agility: 6, speed: 5 },
    weapons: ['水枪', '毽子'],
    skills: [],
    pills: 2,
    offer: null,
    record: { wins: 3, losses: 1 },
  };
  let current: unknown = { cultivation: { view: () => view } };
  const handler = appCultivationHandler(() => current as AppFeatures | null);
  await serve(
    (req, res) => void handler(req, res),
    async (base) => {
      // GET：view() 原样回（设置页「修炼」一节的全部数据）
      const read = await fetch(base);
      assert.equal(read.status, 200);
      assert.deepEqual(await read.json(), view);

      // 开关关着（还没建档）：view() 是 null，照样 200——设置页只显示开关、不显示状态
      current = { cultivation: { view: () => null } };
      const off = await fetch(base);
      assert.equal(off.status, 200);
      assert.equal(await off.json(), null);

      // 只读：不发明的写端点
      assert.equal(
        (await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
        405,
      );

      // 功能还没起来（app ready 之前）：503
      current = null;
      assert.equal((await fetch(base)).status, 503);
    },
  );
});

test('/app/arena 回擂台页面（X3）、/app/fx 回特效层页面（X7）：与 /app/guest、/app/note 同一口径', async () => {
  const handler = createAppRoutes(
    () => ({ say: async () => true }) as unknown as AppFeatures,
    () => undefined,
  );
  await serve(
    (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!handler(req, res, pathname)) {
        res.writeHead(404);
        res.end();
      }
    },
    async (base) => {
      for (const page of ['/app/guest', '/app/foe', '/app/note', '/app/arena', '/app/fx', '/app/panel']) {
        const got = await fetch(base + page);
        assert.equal(got.status, 200, page);
        assert.match(got.headers.get('content-type') ?? '', /text\/html/, page);
        assert.equal(got.headers.get('cache-control'), 'no-store', page);
        assert.match(await got.text(), /^<!doctype html>/, page);
        // 非 GET 不发明新的读端点
        assert.equal((await fetch(base + page, { method: 'POST' })).status, 405, page);
      }
      // /app/fx 回的就是特效窗口的页面（fx-window.ts 的 fxPage）
      assert.match(await (await fetch(`${base}/app/fx`)).text(), /window\.fx = \{/);
      // /app/foe 回的就是对手窗口的页面（foe-window.ts 的 foePage）
      assert.match(await (await fetch(`${base}/app/foe`)).text(), /window\.foe = \{/);
      // /app/panel 回的就是出招面板的页面（action-panel-window.ts 的 panelPage）
      assert.match(await (await fetch(`${base}/app/panel`)).text(), /window\.panel = \{/);
      // 网页来源照旧拒绝（这几个页面都不例外）
      const web = await fetch(`${base}/app/arena`, { headers: { origin: 'https://evil.example' } });
      assert.equal(web.status, 403);
      // 功能还没起来：/app/* 一律 503（包括擂台页）
      let ready = false;
      const later = createAppRoutes(
        () => (ready ? ({ say: async () => true } as unknown as AppFeatures) : null),
        () => undefined,
      );
      assert.equal(ready, false);
      await serve(
        (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
          if (!later(req, res, pathname)) {
            res.writeHead(404);
            res.end();
          }
        },
        async (other) => {
          assert.equal((await fetch(`${other}/app/arena`)).status, 503);
          ready = true;
          assert.equal((await fetch(`${other}/app/arena`)).status, 200);
        },
      );
    },
  );
});

test('X17 出招面板：GET /app/battle 看等什么，POST /app/battle/choose 选方式 / 点招（curl 与页面同源共用）', async () => {
  const picks: number[] = [];
  let question: unknown = {
    kind: 'mode',
    title: '这一场怎么出招？',
    seconds: 10,
    options: [
      { pick: 1, label: '自动' },
      { pick: 2, label: 'AI 出招' },
      { pick: 3, label: '手动' },
    ],
  };
  const fake = {
    battle: {
      state: () => question,
      choose: (pick: number) => {
        picks.push(pick);
        if (pick !== 1) return false;
        question = null;
        return true;
      },
    },
    say: async () => true,
  } as unknown as AppFeatures;
  const handler = createAppRoutes(
    () => fake,
    () => undefined,
  );
  await serve(
    (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!handler(req, res, pathname)) {
        res.writeHead(404);
        res.end();
      }
    },
    async (base) => {
      const state = await fetch(`${base}/app/battle`);
      assert.equal(state.status, 200);
      assert.deepEqual(await state.json(), { question });
      // 非 GET / POST 不发明新方法
      assert.equal((await fetch(`${base}/app/battle`, { method: 'POST', body: '{}' })).status, 405);
      // 面板自己的按钮从同一来源 POST：放行同源
      const page = await fetch(`${base}/app/battle/choose`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ pick: 1 }),
      });
      assert.equal(page.status, 200);
      assert.deepEqual(picks, [1]);
      // curl 不带 Origin 照旧能调
      const curl = await fetch(`${base}/app/battle/choose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pick: 3 }),
      });
      assert.equal(curl.status, 409, '现在没有等待的选择');
      // 网页来源照旧拒绝
      const evil = await fetch(`${base}/app/battle/choose`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ pick: 1 }),
      });
      assert.equal(evil.status, 403);
      // DNS 重绑定：Origin 和 Host 一致，但 Host 不是本机地址 → 照旧拒绝（fetch 改不了 Host，用 node:http 发）
      const rebound = await new Promise<number>((done, fail) => {
        const target = new URL(`${base}/app/battle/choose`);
        const req = request(
          {
            host: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            headers: {
              host: `evil.example:${target.port}`,
              origin: `http://evil.example:${target.port}`,
              'content-type': 'application/json',
            },
          },
          (res) => {
            res.resume();
            done(res.statusCode ?? 0);
          },
        );
        req.on('error', fail);
        req.end(JSON.stringify({ pick: 1 }));
      });
      assert.equal(rebound, 403);
      // 参数不对
      const bad = await fetch(`${base}/app/battle/choose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pick: 0 }),
      });
      assert.equal(bad.status, 400);
    },
  );
});
