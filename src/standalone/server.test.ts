/**
 * AI 设置读写处理器与连通性测试的契约（应用入口直接挂这两个 handler）。
 *
 * HTTP 监听、安全边界（Host / Origin / 令牌）与请求体上限住在 `src/app/main.ts` 与其
 * `request-security`，不在本文件覆盖；这里钉的是处理器自己的校验、限流、脱敏与错误口径。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { settingsHandler, testHandler } from './server.ts';

/** 最小响应桩：记状态码/响应头/正文 */
class FakeRes {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;

  getHeaderNames(): string[] {
    return Object.keys(this.headers);
  }
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  removeHeader(name: string): void {
    delete this.headers[name];
  }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  private readonly chunks: string[] = [];
  end(chunk?: string): void {
    if (typeof chunk === 'string') this.chunks.push(chunk);
  }
  body(): string {
    return this.chunks.join('');
  }
}

/** 用最小 req/res 驱动处理器（不必真的起 socket） */
function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<FakeRes> {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = options.method ?? 'GET';
  (req as { headers: Record<string, string> }).headers = options.headers ?? {};
  const res = new FakeRes();
  const done = handler(req, res as unknown as ServerResponse);
  queueMicrotask(() => {
    if (options.body !== undefined) req.emit('data', Buffer.from(options.body));
    req.emit('end');
  });
  return done.then(() => res);
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function fakeAi() {
  const calls: unknown[] = [];
  return {
    calls,
    getSettings: () => ({ protocol: 'anthropic', model: 'x', hasKey: true, apiKey: 'secret-from-backend' }),
    saveSettings: async (input: unknown) => {
      calls.push(input);
      return { ...(input as object), hasKey: true, apiKey: 'secret-from-backend' };
    },
    testConnection: async (input: unknown) => {
      calls.push(input);
      return { ok: true, message: '连接成功', reply: 'pong' };
    },
  };
}

describe('settingsHandler —— 设置读写', () => {
  test('GET 返回公开设置，后端密钥不出现', async () => {
    const ai = fakeAi();
    const res = await call(settingsHandler(ai));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body()), { protocol: 'anthropic', model: 'x', hasKey: true });
    assert.doesNotMatch(res.body(), /secret-from-backend/);
  });

  test('非法请求体 → 400，且不调用保存', async () => {
    const ai = fakeAi();
    for (const body of ['null', '{broken', '{"timeoutMs":999}']) {
      const res = await call(settingsHandler(ai), { method: 'POST', headers: JSON_HEADERS, body });
      assert.equal(res.status, 400, body);
    }
    assert.equal(ai.calls.length, 0);
  });

  test('非 JSON Content-Type → 415', async () => {
    const ai = fakeAi();
    const res = await call(settingsHandler(ai), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(res.status, 415);
    assert.equal(ai.calls.length, 0);
  });

  test('合法保存 → 200 + 公开设置，保存只发生一次', async () => {
    const ai = fakeAi();
    const res = await call(settingsHandler(ai), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ apiKey: '', enabled: false }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body()), { enabled: false, hasKey: true });
    assert.equal(ai.calls.length, 1);
  });

  test('保存过于频繁 → 429', async () => {
    const ai = fakeAi();
    const handler = settingsHandler(ai);
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      last = (await call(handler, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status;
    }
    assert.equal(last, 429);
  });

  test('没有 AI 服务 → 503（不假装保存成功）', async () => {
    assert.equal((await call(settingsHandler(undefined))).status, 503);
  });
});

describe('testHandler —— 连通性测试', () => {
  test('非 POST → 405', async () => {
    assert.equal((await call(testHandler(fakeAi()))).status, 405);
  });

  test('POST 交给后端并在没有服务时明确回失败', async () => {
    const ai = fakeAi();
    const ok = await call(testHandler(ai), { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body()), { ok: true, message: '连接成功', reply: 'pong' });
    const missing = await call(testHandler(undefined), { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    assert.equal(missing.status, 200);
    assert.deepEqual(JSON.parse(missing.body()), { ok: false, message: '当前环境未配置测试能力' });
  });
});
