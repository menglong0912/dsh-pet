/**
 * AI 设置读写处理器（GET 读 / POST 存）与连通性测试（POST）。
 *
 * 导出给单进程应用入口复用：应用与设置页共用同一份「校验 + 限流 + 原子写」逻辑，不复制。
 * HTTP 监听、安全边界与前缀路由都在 `src/app/main.ts`，这里只处理已鉴权的请求。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { rejectRequest } from './request-security';
import { publicSettings, validateSettings } from './settings';
import type { StandaloneSettingsService } from './settings';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * AI 设置读写处理器（GET 读 / POST 存）。
 */
export function settingsHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!ai) {
      rejectRequest(res, 503, '本机 AI 设置尚未就绪');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, publicSettings(ai.getSettings()));
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET 或 POST');
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    if (count > 20) {
      rejectRequest(res, 429, '保存过于频繁，请稍后再试');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON 保存设置');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const input = validateSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      sendJson(res, 200, publicSettings(await ai.saveSettings(input)));
    } catch {
      rejectRequest(res, 400, '设置未保存：请检查接口地址、模型名称、密钥和数值范围');
    }
  };
}

/** 连通性测试处理器（POST）。 */
export function testHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const input = bodyStr ? JSON.parse(bodyStr) : {};
      if (ai?.testConnection) {
        const result = await ai.testConnection(input);
        sendJson(res, 200, result);
      } else {
        sendJson(res, 200, { ok: false, message: '当前环境未配置测试能力' });
      }
    } catch {
      sendJson(res, 400, { ok: false, message: '请求格式无效' });
    }
  };
}
