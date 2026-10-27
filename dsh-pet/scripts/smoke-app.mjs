#!/usr/bin/env node
/**
 * smoke-app.mjs —— 启动打好的应用，确认真能起来、本机服务能应答、宠物窗口能截到图，然后退出。
 *
 * 用途：Windows CI（.github/workflows/windows-check.yml）里唯一一次「真启动」验证；
 * macOS 上也可以手工跑（Claude 核验时用）。
 *
 * 流程：
 *   1. 新建临时目录当 DSH_HOME（不碰用户数据），启动 dist-app 里的应用；
 *   2. 等 `$DSH_HOME/dsh-pet/app.json` 出现，读出本机服务端口；
 *   3. `GET http://127.0.0.1:<port>/health`，确认 200、`name` / `port` 对得上；
 *   4. 借 helper 现成的冒烟模式（`DSH_PET_SMOKE=1`，见 runtime/electron-helper/main.js）：
 *      延时截图到 `DSH_PET_SMOKE_OUT`，然后自己 `app.quit()`；
 *   5. 等截图落盘、进程自己退出，打印结果。
 *
 * 为什么应用模式下也能用 `DSH_PET_SMOKE`：那段代码在 helper 的 `app.whenReady()` 末尾，
 * 不经过 bridge；`window.petBridge` 由 preload 无条件暴露；`app.quit()` 会正常触发 main.ts
 * 的 will-quit 清理。截图取的是宠物窗口（capturePage），不是整屏——CI 没有真实桌面，
 * 整屏截图只会是黑的，窗口截图才能看到宠物。
 *
 * 用法：
 *   node scripts/smoke-app.mjs                    # 用本平台的默认产物路径
 *   node scripts/smoke-app.mjs --app <可执行文件>  # 指定别的 exe / .app 内可执行文件
 *   node scripts/smoke-app.mjs --out <png>         # 截图输出（默认 dist-app/smoke.png）
 *   DSH_PET_SMOKE_AFTER_MS=20000 node scripts/smoke-app.mjs   # 机器慢时放宽截图延时
 *
 * 注意：应用模式共用 userData 的单实例锁（helper 里设成 appData/dsh-pet）。本机已经开着
 * 每天用的 dsh-pet 时，冒烟实例会立刻退出——先退出那个应用再跑。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 默认产物：electron-builder 只出解包目录，mac / Windows 的路径不同 */
function defaultAppCandidates() {
  if (process.platform === 'win32') return [join(root, 'dist-app', 'win-unpacked', 'dsh-pet.exe')];
  if (process.platform === 'darwin') {
    return [
      join(root, 'dist-app', 'mac-arm64', 'dsh-pet.app', 'Contents', 'MacOS', 'dsh-pet'),
      join(root, 'dist-app', 'mac', 'dsh-pet.app', 'Contents', 'MacOS', 'dsh-pet'),
      join(root, 'dist-app', 'mac-universal', 'dsh-pet.app', 'Contents', 'MacOS', 'dsh-pet'),
    ];
  }
  return [join(root, 'dist-app', 'linux-unpacked', 'dsh-pet')];
}

/** 简单取 `--key value`，不认识/缺值就报错，避免 CI 里悄悄用了默认路径 */
function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return '';
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`[smoke] --${name} 缺值`);
    process.exit(2);
  }
  return value;
}

const appArg = option('app') || defaultAppCandidates().find((candidate) => existsSync(candidate));
if (!appArg || !existsSync(appArg)) {
  console.error('[smoke] 找不到打好的应用，先跑 `npm run dist`。尝试过：');
  for (const candidate of defaultAppCandidates()) console.error(`  ${candidate}`);
  process.exit(2);
}
const appExe = resolve(appArg);

const outPng = resolve(option('out') || join(root, 'dist-app', 'smoke.png'));
const logPath = join(root, 'dist-app', 'smoke-app.log');
mkdirSync(dirname(outPng), { recursive: true });

const home = mkdtempSync(join(tmpdir(), 'dsh-pet-smoke-'));
const appJson = join(home, 'dsh-pet', 'app.json');
// 上一次跑剩的截图不能拿来冒充这一次：先删掉，只认本次运行写出来的文件
rmSync(outPng, { force: true });
const requestedAfterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS);
const afterMs = Number.isFinite(requestedAfterMs) && requestedAfterMs > 0 ? requestedAfterMs : 15000;

const logStream = createWriteStream(logPath, { flags: 'w' });
let logOpen = true;
const log = (message) => {
  const line = `[smoke] ${message}`;
  console.log(line);
  if (logOpen) logStream.write(line + '\n');
};

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 子进程输出原样转发（CI 日志）并留一份给 artifact */
const childEnv = { ...process.env };
// 宿主环境里可能带着它：会让 Electron 以纯 Node 模式启动，应用直接起不来
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  DSH_HOME: home,
  DSH_PET_SMOKE: '1',
  DSH_PET_SMOKE_OUT: outPng,
  DSH_PET_SMOKE_AFTER_MS: String(afterMs),
});

log(`应用：${appExe}`);
log(`DSH_HOME：${home}`);
log(`截图：${outPng}`);

const child = spawn(appExe, [], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    target.write(chunk);
    if (logOpen) logStream.write(chunk);
  });
}

let exited = false;
/** 进程退出且 stdout/stderr 都关闭：此时再把日志流收尾才不会丢最后几行 */
let closed = false;
let exitCode = null;
let exitSignal = null;
let spawnError = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitCode = code;
  exitSignal = signal;
});
child.on('close', () => {
  closed = true;
});
child.on('error', (error) => {
  exited = true;
  spawnError = error;
});

/** 超时收尾：Windows 用 taskkill /T 连子进程一起收，macOS 单进程直接 SIGKILL */
function killChild() {
  if (exited || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
}

/** 轮询直到 fn 返回真值；子进程提前退出就立刻失败，不干等超时 */
async function waitFor(label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    if (exited) {
      const hint = exitCode === 0 ? '（若本机已经开着 dsh-pet，先退出它：应用共用 userData 与单实例锁）' : '';
      throw new Error(`等${label}时应用已退出（code=${exitCode} signal=${exitSignal}）${hint}：${spawnError ?? ''}`);
    }
    await sleep(250);
  }
  return null;
}

async function readAppJson() {
  try {
    const info = JSON.parse(await readFile(appJson, 'utf8'));
    if (Number.isInteger(info.port) && info.port > 0 && info.port < 65536) return info;
  } catch {
    // 还没写完 / 还没出现：继续等
  }
  return null;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function screenshotReady() {
  try {
    if (statSync(outPng).size < 100) return false;
    // PNG 头：确认不是空文件或半截文本
    const fd = openSync(outPng, 'r');
    try {
      const header = Buffer.alloc(8);
      readSync(fd, header, 0, header.length, 0);
      return header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 失败时把日志末尾贴回 CI 输出（artifact 里还有完整一份） */
function printLogTail(lines = 60) {
  try {
    const all = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    console.error(`[smoke] ---- ${logPath} 末尾 ${Math.min(lines, all.length)} 行 ----`);
    console.error(all.slice(-lines).join('\n'));
  } catch {
    /* 日志还没写出来 */
  }
}

let failure = null;
try {
  const info = await waitFor('app.json', 60_000, readAppJson);
  if (!info) throw new Error('60 秒内没等到 app.json');
  log(`app.json 就绪：pid=${info.pid} port=${info.port} version=${info.version}`);

  const status = await waitFor('/health', 60_000, async () => {
    const body = await health(info.port);
    return body && body.name === 'dsh-pet-app' && body.port === info.port ? body : null;
  });
  if (!status) throw new Error('/health 在 60 秒内没有返回本应用的状态');
  log(`/health 正常：${JSON.stringify({ name: status.name, version: status.version, pets: status.pets?.length })}`);

  // 截图由应用自己在 afterMs 后写；dump 里还有拖拽/菜单/点击穿透自检，可能再慢几秒
  const captured = await waitFor('冒烟截图', afterMs + 60_000, screenshotReady);
  if (!captured) throw new Error(`${afterMs + 60_000} 毫秒内没等到截图`);
  log(`截图就绪：${statSync(outPng).size} 字节`);

  // 截图后 helper 会 setTimeout(app.quit, 500)；给它 30 秒走完 will-quit 清理
  // 只认 exit：Windows 上 GPU 等子进程可能还拿着管道，close 会晚于 exit，不能当失败
  const done = await waitFor('应用退出', 30_000, async () => exited);
  if (!done) throw new Error('截图后 30 秒应用还没退出（DSH_PET_SMOKE 的 app.quit() 没生效？）');
  for (let i = 0; i < 50 && !closed; i += 1) await sleep(100);
  if (spawnError) throw spawnError;
  if (exitCode !== 0) throw new Error(`应用退出码 ${exitCode}（signal=${exitSignal}）`);
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  console.error(`[smoke] 失败：${failure.message}`);
  killChild();
  for (let i = 0; i < 50 && !closed; i += 1) await sleep(100);
  printLogTail();
}

if (failure) {
  log(`临时 DSH_HOME 留作排查：${home}`);
} else {
  log('冒烟通过：应用启动了、/health 正常、宠物窗口截图成功、自己退出了');
  rmSync(home, { recursive: true, force: true });
}
logOpen = false;
await new Promise((resolvePromise) => logStream.end(resolvePromise));
process.exit(failure ? 1 : 0);
