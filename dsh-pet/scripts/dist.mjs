#!/usr/bin/env node
/**
 * dist.mjs —— 打包双击可运行的桌宠应用（electron-builder 的薄封装）。
 *
 * 用法：
 *   node scripts/dist.mjs            # 出解包目录 dist-app\win-unpacked（分发时压成 zip 即可）
 *                                    # macOS 上则出 dist-app/mac-arm64/dsh-pet.app
 *   node scripts/dist.mjs dir        # 同上，显式写法
 *
 * 只出「解包目录」这一种形态：
 *   - portable（单文件）是 NSIS 自解压壳，每次启动都要把整个应用目录解压到 %TEMP%
 *     （约 400 MB、几十秒起），对 Electron 这种体量得不偿失；
 *   - nsis（安装包）对自用/绿色分发没有增量价值，配置已移除（要恢复见 electron-builder.yml 注释）。
 *   目录版与 zip 分发都是「摊开」的，启动只要 2–3 秒。
 *
 * 为什么要这层封装：electron-builder 默认从 GitHub 取 Electron 与打包二进制，而本仓库所在的
 * 机器 github.com 不通。这里统一注入三件事：
 *   1. electronDist = 本机已解压的 Electron（默认 $DSH_HOME/electron），完全不下载；
 *   2. ELECTRON_BUILDER_BINARIES_MIRROR = npmmirror（winCodeSign 等打包二进制走镜像）；
 *   3. ELECTRON_SKIP_BINARY_DOWNLOAD = 1（杜绝 postinstall 阶段再拉一次）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Electron 可执行文件相对解压目录的路径（按平台） */
const ELECTRON_REL =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

/**
 * 解析本机 Electron 解压目录。
 *
 * 本机（有 ~/.dsh/electron）走本地目录，一个字节都不下载；CI 上通常没有这份目录，
 * 此时设 `DSH_PET_ALLOW_ELECTRON_DOWNLOAD=1` 让 electron-builder 自己去取（GitHub runner
 * 能访问 github.com / 也可用 ELECTRON_MIRROR 换镜像）。默认仍然**明确失败**，
 * 避免本地开发时被静默拉走 110 MB。
 *
 * @returns 解压目录；允许下载且本机没有时返回 undefined（= 不传 electronDist）
 */
function resolveElectronDist() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const candidates = [
    process.env.DSH_PET_ELECTRON_DIST,
    process.env.DSH_PET_ELECTRON_PATH ? dirname(process.env.DSH_PET_ELECTRON_PATH) : undefined,
    join(dshHome, 'electron'),
  ].filter((value) => Boolean(value));
  for (const dir of candidates) {
    if (existsSync(join(dir, ELECTRON_REL))) return dir;
  }
  if (process.env.DSH_PET_ALLOW_ELECTRON_DOWNLOAD === '1') {
    console.warn('[dist] 本机没有 Electron 解压目录，交给 electron-builder 下载（CI 模式）。');
    return undefined;
  }
  console.error(
    '[dist] 找不到本机 Electron 解压目录。先跑 `npm run ensure:electron`，' +
      '或设置 DSH_PET_ELECTRON_DIST 指向解压目录。',
  );
  process.exit(1);
}

const target = process.argv[2] ?? 'dir';
if (target !== 'dir') {
  console.error(`[dist] 未知目标：${target}（只出解包目录，直接运行 node scripts/dist.mjs）`);
  process.exit(2);
}

assertSelfContained();
const electronDist = resolveElectronDist();
/** mirror 默认 npmmirror：本机 github.com 不通；CI 上可用环境变量覆盖成官方源 */
const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  // 产物里不需要 electron 的 symbols / 调试信息，省 200 MB
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
// 有本地解压目录时才禁止 Electron 下载；CI 的回退路径反过来必须允许下载
if (electronDist) {
  env.DSH_PET_ELECTRON_DIST = electronDist;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';
} else {
  delete env.DSH_PET_ELECTRON_DIST;
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
}

console.log(`[dist] electron dist: ${electronDist ?? '(无 → 由 electron-builder 下载)'}`);
/** 按当前平台出包：Windows → win-unpacked，macOS → mac-arm64/dsh-pet.app */
const platformFlag = process.platform === 'darwin' ? '--mac' : '--win';
console.log(`[dist] target:        ${platformFlag.slice(2)}:${target}`);
// 直接调用 electron-builder 的 CLI 文件而不是 `pnpm exec`：路径里有 `p'c` 这种单引号，
// 走 shell 传参会把参数切碎；node 直接 spawn 没有这层转义问题。
const cli = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const args = [cli, platformFlag, target];
if (electronDist) args.push(`--config.electronDist=${electronDist}`);
if (process.platform === 'darwin') args.push(`--config.mac.icon=${macIcon()}`);
const child = spawn(process.execPath, args, {
  cwd: root,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (code === 0 && process.platform === 'darwin') resignMacDesignatedRequirement();
  process.exit(code ?? 0);
});

/**
 * 把外层 .app 重签成「只认 bundle id」的指定要求（designated requirement）。
 *
 * ad-hoc 签名的默认指定要求是 cdhash，每次打包都不同；屏幕录制等系统授权（TCC）记的正是它，
 * 于是每次重新打包都得去系统设置里重新授权。改成 `identifier "<appId>"` 后授权一次即可跨版本保留。
 * 代价：本机任何同样声明这个 identifier 的未签名程序也能沿用这些授权——自用机器上可以接受。
 * 只重签外层（不加 --deep）：内层 Helper 保留各自的签名；TCC 认的是主应用。
 */
function resignMacDesignatedRequirement() {
  const appId = /^appId:\s*(\S+)/m.exec(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))?.[1];
  // productName 同 electron-builder.yml；arm64 产物目录带架构后缀
  const app = join(root, 'dist-app', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'dsh-pet.app');
  if (!appId || !existsSync(app)) {
    console.error(`[dist] 找不到 appId 或产物，无法重签指定要求：${app}`);
    process.exit(1);
  }
  const requirement = `designated => identifier "${appId}"`;
  execFileSync('codesign', ['--force', '-s', '-', '--preserve-metadata=entitlements,flags', `-r=${requirement}`, app], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`[dist] 已重签指定要求：${requirement}`);
}

/**
 * 产物不带 node_modules，所以 lib/app.js 静态引用的裸包只能是 Electron 自带的那几个。
 * 漏打包的依赖在仓库里跑看不出来（解析会向上找到仓库的 node_modules），装到别处才崩——在这里拦住。
 */
function assertSelfContained() {
  const code = readFileSync(join(root, 'lib', 'app.js'), 'utf8');
  const allowed = /^(?:electron|@electron\/.+|@electron-internal\/.+|node:.+)$/;
  const specifiers = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"'./][^"']*)["']/gm)].map((m) => m[1]);
  const missing = [...new Set(specifiers.filter((s) => !allowed.test(s)))];
  if (missing.length) {
    console.error(
      `[dist] lib/app.js 仍在外部引用 ${missing.join(', ')}：在 tsdown.config.mjs 的 app 入口 noExternal 里加上它们。`,
    );
    process.exit(1);
  }
}

/**
 * macOS 图标：electron-builder 要求 ≥512px，而 assets/logo.png 只有 256px。
 * 用系统自带的 sips 放大到 1024 写进产物目录（已 gitignore），不往仓库里加第二份图标。
 * @returns 放大后的 PNG 路径
 */
function macIcon() {
  const out = join(root, 'dist-app', '.icon', 'icon.png');
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('sips', ['-z', '1024', '1024', join(root, 'assets', 'logo.png'), '--out', out], { stdio: 'ignore' });
  return out;
}
