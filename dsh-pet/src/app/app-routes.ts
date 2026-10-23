/**
 * 独立应用自己的本机接口（`/app/*`），给 `dsh-pet` 命令行（scripts/pet-cli.mjs）与 Claude Code hook 用：
 *   GET  /app/activity      主人此刻的采样快照与给模型的那行背景（调试用）
 *   POST /app/say           { text }：让桌宠说一句给定的话
 *   POST /app/whisper       让桌宠按人设碎碎念一句（转调插件的 /whisper）
 *   POST /app/look          看一眼屏幕并吐槽（等同右键「看看我在干嘛」）
 *   POST /app/claude-hook   Claude Code hook 的 stdin JSON 原样转进来
 *   GET  /app/guest         串门客人窗口的页面（visit-windows.ts 开的窗口加载它）
 *
 * 与插件路由同一条安全线：拒绝网页来源（带 Origin 且不是 null 的请求），本机程序直接调用。
 * 端口每次启动随机，写在 `$DSH_HOME/dsh-pet/app.json`（见 discovery.ts）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveAppConfig } from './app-config';
import type { AppConfig } from './app-config';
import type { AppFeatures } from './features';
import { guestPage } from './visit-windows';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SAY_CHARS = 200;

/**
 * @param features 功能编排（app ready 之前为 null：此时一律 503）
 * @returns 处理函数：不是 /app/ 开头的路径返回 false，交回给调用方
 */
export function createAppRoutes(
  features: () => AppFeatures | null,
  log: (message: string) => void,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
  return (req, res, pathname) => {
    if (!pathname.startsWith('/app/')) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      send(res, 403, { error: '不允许网页来源访问' });
      return true;
    }
    const current = features();
    if (!current) {
      send(res, 503, { error: '桌宠还在启动' });
      return true;
    }
    void handle(current, req, res, pathname).catch((error: unknown) => {
      log(`接口失败 ${pathname}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, { error: '内部错误' });
      else res.end();
    });
    return true;
  };
}

async function handle(
  features: AppFeatures,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (pathname === '/app/activity') {
    if (method !== 'GET') return send(res, 405, { error: '仅支持 GET' });
    return send(res, 200, { snapshot: features.activity(), context: features.activityContext() });
  }
  if (pathname === '/app/guest') {
    if (method !== 'GET') return send(res, 405, { error: '仅支持 GET' });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(guestPage),
      'cache-control': 'no-store',
    });
    res.end(guestPage);
    return;
  }
  if (method !== 'POST') return send(res, 405, { error: '仅支持 POST' });
  const body = await readJson(req);
  if (body === undefined) return send(res, 400, { error: '请求体必须是 JSON 对象（≤64KB）' });
  switch (pathname) {
    case '/app/say': {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_SAY_CHARS) return send(res, 400, { error: `text 必填，≤${MAX_SAY_CHARS} 字` });
      return send(res, 200, { ok: await features.say(text) });
    }
    case '/app/whisper':
      return send(res, 200, await features.whisper());
    case '/app/look':
      return send(res, 200, await features.lookAtScreen(true));
    case '/app/claude-hook':
      await features.handleClaudeHook(body);
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: 'not found' });
  }
}

/**
 * 设置页「陪伴与提醒」一节的读写（`/standalone-ai/app-settings`，即整份 app-config.json）。挂在配置页那组下，走令牌与同源校验
 * （调用方先过 security.authorize），不走上面 /app/* 的「拒绝网页来源」——设置页本身就是网页。
 * 只有独立应用注册这条路由；CLI 里它是 404，设置页据此不显示这一节。
 */
export function appSettingsHandler(
  path: string,
  appConfig: () => AppConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method === 'GET') return send(res, 200, appConfig());
    if (req.method !== 'POST') return send(res, 405, { error: '仅支持 GET 或 POST' });
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(res, 415, { error: '请使用 JSON 保存设置' });
    }
    const body = await readJson(req);
    let next: AppConfig;
    try {
      next = saveAppConfig(path, body);
    } catch {
      return send(res, 400, { error: '陪伴与提醒的设置不在允许范围内' });
    }
    send(res, 200, next);
  };
}

/** 读 JSON 对象体；空体按 {}；超限 / 非对象 → undefined */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  // 事件式读取（与 standalone/server.ts 同法）：tsconfig 的 lib 不认 Readable 的 async iterator
  const chunks: Buffer[] = [];
  let size = 0;
  const complete = await new Promise<boolean>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(false);
      } else chunks.push(Buffer.from(chunk));
    });
    req.once('end', () => resolve(true));
    req.once('error', reject);
  });
  if (!complete) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
