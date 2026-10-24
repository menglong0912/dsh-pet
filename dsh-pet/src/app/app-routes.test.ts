import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { petSettingsHandler } from './app-routes.ts';

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
