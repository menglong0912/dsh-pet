#!/usr/bin/env node
/**
 * dist.mjs —— 打包双击可运行的桌宠应用（electron-builder 的薄封装）。
 *
 * 用法：
 *   node scripts/dist.mjs            # 出解包目录 dist-app\win-unpacked（分发时压成 zip 即可）
 *                                    # macOS 上则出 dist-app/mac-arm64/dsh-pet.app
 *   node scripts/dist.mjs dir        # 同上，显式写法
 *   node scripts/dist.mjs nsis       # 只在 Windows：解包目录之外再出安装包
 *                                    # dist-app\dsh-pet-win-x64-setup.exe（配置见 electron-builder.yml 的 nsis 段）
 *
 * 默认只出「解包目录」，安装包按需：
 *   - portable（单文件）是 NSIS 自解压壳，每次启动都要把整个应用目录解压到 %TEMP%
 *     （约 400 MB、几十秒起），对 Electron 这种体量得不偿失，不做；
 *   - nsis（安装包）给想要桌面 / 开始菜单快捷方式、在系统里登记卸载的人用；装好后也是「摊开」的目录。
 *   目录版与 zip 分发都是「摊开」的，启动只要 2–3 秒。
 *
 * 为什么要这层封装：
 *   1. 打包前先跑 `npm run bundle` 与 `npm run build:desktop-core`，避免改了 src 忘编译、装上的还是旧代码；
 *   2. electronDist = node_modules/electron/dist（pnpm install 时由 .npmrc 的 electron_mirror 下载），
 *      完全不从 GitHub 取；`DSH_PET_ELECTRON_DIST` 留着覆盖成别的解压目录；
 *   3. ELECTRON_BUILDER_BINARIES_MIRROR = npmmirror（winCodeSign 等打包二进制走镜像）；
 *   4. ELECTRON_SKIP_BINARY_DOWNLOAD = 1（杜绝打包阶段再拉一次）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
 * 解析 Electron 解压目录：默认用 pnpm install 装好的 node_modules/electron/dist。
 *
 * `DSH_PET_ELECTRON_DIST` 留着覆盖成别的解压目录（旧脚本/CI 需要时用）。
 * 两份都没有就**明确失败**，不让 electron-builder 静默去 GitHub 拉 110 MB。
 *
 * @returns 解压目录（含当前平台的 Electron 可执行文件）
 */
function resolveElectronDist() {
  const override = process.env.DSH_PET_ELECTRON_DIST;
  if (override) {
    if (existsSync(join(override, ELECTRON_REL))) return resolve(override);
    console.error(`[dist] DSH_PET_ELECTRON_DIST 指向的目录里没有 ${ELECTRON_REL}：${override}`);
    process.exit(1);
  }
  const bundled = join(root, 'node_modules', 'electron', 'dist');
  if (existsSync(join(bundled, ELECTRON_REL))) return bundled;
  console.error(
    '[dist] 找不到 node_modules/electron/dist。先跑 `pnpm install`' +
      '（Electron 二进制由 .npmrc 的 electron_mirror 下载），或设置 DSH_PET_ELECTRON_DIST。',
  );
  process.exit(1);
}

const target = process.argv[2] ?? 'dir';
/** 安装包只在 Windows 上出；macOS 只有解包目录 */
const targets = process.platform === 'win32' ? ['dir', 'nsis'] : ['dir'];
if (!targets.includes(target)) {
  console.error(`[dist] 未知目标：${target}（本平台可选：${targets.join(' / ')}）`);
  process.exit(2);
}

// 打包前先编译：这里直接跑脚本文件而不是 `npm run`，避免在 Windows 上经 shell 调 .cmd。
console.log('[dist] bundle + build:desktop-core');
execFileSync(process.execPath, [join(root, 'node_modules', 'tsdown', 'bin', 'tsdown.js')], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(process.execPath, [join(root, 'scripts', 'build-desktop-core.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

assertSelfContained();
const electronDist = resolveElectronDist();
/** mirror 默认 npmmirror：本机 github.com 不通；CI 上可用环境变量覆盖成官方源 */
const env = {
  ...process.env,
  DSH_PET_ELECTRON_DIST: electronDist,
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  // 产物里不需要 electron 的 symbols / 调试信息，省 200 MB
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

console.log(`[dist] electron dist: ${electronDist}`);
/** 按当前平台出包：Windows → win-unpacked，macOS → mac-arm64/dsh-pet.app */
const platformFlag = process.platform === 'darwin' ? '--mac' : '--win';
console.log(`[dist] target:        ${platformFlag.slice(2)}:${target}`);
// 直接调用 electron-builder 的 CLI 文件而不是 `pnpm exec`：路径里有 `p'c` 这种单引号，
// 走 shell 传参会把参数切碎；node 直接 spawn 没有这层转义问题。
const cli = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
// --publish never：electron-builder 在 CI 上会对 nsis 目标「隐式发布」到 GitHub，没 token 就整步失败；
// 发 Release 由 release-app.yml 自己 gh release upload，这里只出文件。
const args = [cli, platformFlag, target, `--config.electronDist=${electronDist}`, '--publish', 'never'];
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
 * 产物不带 node_modules，所以 lib/app.js 静态引用的裸包只能是 Electron 自带的那一个。
 * 漏打包的依赖在仓库里跑看不出来（解析会向上找到仓库的 node_modules），装到别处才崩——在这里拦住。
 */
function assertSelfContained() {
  const code = readFileSync(join(root, 'lib', 'app.js'), 'utf8');
  const allowed = /^(?:electron|node:.+)$/;
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
