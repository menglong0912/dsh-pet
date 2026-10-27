#!/usr/bin/env node
/**
 * pet-cli.mjs —— 独立桌宠应用的命令行（打包时随 .app 放进 Contents/Resources，软链到 ~/.local/bin/dsh-pet）。
 *
 * 用法：
 *   dsh-pet say <文本>     让桌宠说一句给定的话
 *   dsh-pet look           看一眼屏幕并吐槽；模型不支持看图时按人设说一句（首次需要给应用开「屏幕录制」权限）
 *   dsh-pet activity       打印「主人此刻」的采样（调试用）
 *   dsh-pet hook           给 Claude Code hook 用：从 stdin 读 hook JSON 转给桌宠；任何失败都静默退出 0，
 *                          绝不因为桌宠没开而打断 Claude Code
 *
 * 找桌宠：读应用写的 app.json（默认 ~/Library/Application Support/dsh-pet/dsh-pet/app.json，
 * 可用 DSH_PET_APP_FILE 覆盖），里面有本次启动的随机端口与 pid。
 * 零依赖、只连 127.0.0.1；请求不带 Origin，与应用 /app/* 接口的安全线一致。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_FILE =
  process.env.DSH_PET_APP_FILE || join(homedir(), 'Library', 'Application Support', 'dsh-pet', 'dsh-pet', 'app.json');

const [command, ...rest] = process.argv.slice(2);
const quiet = command === 'hook';

main().catch((error) => {
  if (!quiet) {
    console.error(`dsh-pet: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});

async function main() {
  switch (command) {
    case 'say': {
      const text = rest.join(' ').trim();
      if (!text) return usage();
      return print(await call('POST', '/app/say', { text }));
    }
    case 'look':
      return print(await call('POST', '/app/look', {}, 90_000));
    case 'activity':
      return print(await call('GET', '/app/activity'));
    case 'hook': {
      const raw = await readStdin();
      const payload = raw.trim() ? JSON.parse(raw) : {};
      await call('POST', '/app/claude-hook', payload, 3_000);
      return;
    }
    default:
      return usage();
  }
}

/** 读 app.json 拿端口；pid 不在了说明是上次没清掉的旧文件 */
function endpoint() {
  let info;
  try {
    info = JSON.parse(readFileSync(APP_FILE, 'utf8'));
  } catch {
    throw new Error('桌宠没有在运行（找不到 ' + APP_FILE + '）');
  }
  try {
    process.kill(info.pid, 0);
  } catch {
    throw new Error('桌宠没有在运行（app.json 里的进程已退出）');
  }
  return `http://127.0.0.1:${info.port}`;
}

async function call(method, path, body, timeoutMs = 30_000) {
  const response = await fetch(endpoint() + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.once('end', () => resolve(data));
    process.stdin.once('error', reject);
  });
}

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}

function usage() {
  console.error('用法：dsh-pet say <文本> | look | activity | hook');
  process.exitCode = 2;
}
