/**
 * 前台应用采样（「知道你在干嘛」的数据源）。
 *
 * 平台差异：
 *   - darwin：`lsappinfo`（features.ts 原来那条路，无需授权）；
 *   - win32：本模块常驻一个 PowerShell 读进程，用 user32 的 GetForegroundWindow +
 *     GetWindowThreadProcessId 拿进程名，每秒输出一行，这边只读最新一行。
 *     为什么不用一次性 `powershell -Command`：采样每 TICK_MS 一拍（默认 5 秒），
 *     每次冷启一个 PowerShell 还要现编译 Add-Type，代价比常驻进程高得多；
 *   - 其它平台：拿不到，恒为 null（活动跟踪沿用上一次值，与原来一致）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 取不到 / 是桌宠自己的窗口时返回 null */
export type FrontNameFilter = (name: string | null) => string | null;

/**
 * 进程名归一：空串与桌宠自己算「取不到」；大小写不敏感（打包后是 `dsh-pet`，开发期是 `electron`）。
 * @param selfNames 视为「桌宠自己」的进程名（小写）
 */
export function makeFrontNameFilter(selfNames: Iterable<string>): FrontNameFilter {
  const self = new Set([...selfNames].map((name) => name.toLowerCase()));
  return (name: string | null): string | null => {
    const trimmed = name?.trim() ?? '';
    if (!trimmed) return null;
    // Windows 的进程名不带扩展名，但仍兜一层，免得将来换成显示名时踩坑
    const base = trimmed.toLowerCase().replace(/\.exe$/, '');
    return self.has(base) ? null : trimmed;
  };
}

/** UTF-16LE base64（`powershell -EncodedCommand` 的口径）：避免命令行引号转义问题 */
export function encodePowerShellScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 常驻读进程的脚本：hwnd 变化时才解析进程名，每秒回报一行 */
export const WINDOWS_PROBE_SCRIPT = [
  '$ErrorActionPreference="SilentlyContinue"',
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'Add-Type -Namespace DshPet -Name Win -MemberDefinition @"',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '"@',
  '$lastHwnd=[IntPtr]::Zero',
  '$lastName=""',
  'while ($true) {',
  '  $hwnd=[DshPet.Win]::GetForegroundWindow()',
  '  if ($hwnd -ne $lastHwnd) {',
  '    $lastHwnd=$hwnd',
  '    $procId=[UInt32]0',
  '    [void][DshPet.Win]::GetWindowThreadProcessId($hwnd,[ref]$procId)',
  '    $proc=$null',
  '    if ($procId -gt 0) { $proc=Get-Process -Id $procId }',
  '    if ($proc) { $lastName=$proc.ProcessName } else { $lastName="" }',
  '  }',
  '  [Console]::Out.WriteLine($lastName)',
  '  [Console]::Out.Flush()',
  '  Start-Sleep -Milliseconds 1000',
  '}',
].join('\r\n');

export interface FrontAppSource {
  /** 最近一次采样到的前台应用名；取不到为 null */
  current(): string | null;
  dispose(): void;
}

/** 读进程用到的那点能力：stdout、exit / error 事件、kill 自己。 */
export interface ProbeProcess {
  stdout: {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): void;
  };
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  kill(): void;
}

export interface WindowsProbeDeps {
  /** PowerShell 可执行文件路径（不存在时不起进程） */
  powershellPath(): string;
  /** 拉起读进程；实现方一般直接透传 node:child_process 的 spawn */
  spawn(command: string, args: string[]): ProbeProcess;
  filter: FrontNameFilter;
  log: (message: string) => void;
}

/** 读进程最多重起的次数（本机 PowerShell 坏了就别每 5 秒试一次） */
const MAX_RESTARTS = 3;
/** 读进程挂掉后多久再试（毫秒） */
const RESTART_MS = 20_000;

/**
 * Windows 前台应用采样源：懒启动（第一次用时才拉起读进程），进程挂了按需重起、有上限。
 */
export function createWindowsFrontSource(deps: WindowsProbeDeps): FrontAppSource {
  let latest: string | null = null;
  let child: ProbeProcess | null = null;
  let restarts = 0;
  let restartAt = 0;
  let disposed = false;
  let buffer = '';

  function onData(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    // 末尾可能是半行，留到下一次
    buffer = lines.pop() ?? '';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const name = deps.filter(lines[i] ?? '');
      if (name !== null) {
        latest = name;
        return;
      }
    }
  }

  function start(): void {
    if (disposed || child) return;
    const exe = deps.powershellPath();
    if (!existsSync(exe)) {
      deps.log(`前台应用采样不可用：找不到 ${exe}`);
      restarts = MAX_RESTARTS;
      return;
    }
    let proc: ProbeProcess;
    try {
      proc = deps.spawn(exe, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellScript(WINDOWS_PROBE_SCRIPT),
      ]);
    } catch (error) {
      deps.log(`前台应用采样起不来：${error instanceof Error ? error.message : String(error)}`);
      restarts += 1;
      return;
    }
    child = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', onData);
    proc.on('exit', () => {
      child = null;
      if (disposed) return;
      restarts += 1;
      if (restarts > MAX_RESTARTS) {
        deps.log(`前台应用采样读进程退了 ${restarts} 次，不再重起（「知道你在干嘛」会没有应用名）`);
        return;
      }
      restartAt = Date.now() + RESTART_MS;
    });
    proc.on('error', (error: unknown) => {
      deps.log(`前台应用采样读进程出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    current(): string | null {
      if (!child) {
        if (restarts > MAX_RESTARTS) return null;
        // 退避窗口内不起新进程
        if (Date.now() < restartAt) return null;
        start();
      }
      return latest;
    },
    dispose(): void {
      disposed = true;
      const running = child;
      child = null;
      if (!running) return;
      try {
        // 只杀这个读进程（我们握着它的引用），不用 taskkill 按名字扫
        running.kill();
      } catch {
        // 已经退出了
      }
    },
  };
}

/** Windows PowerShell 5.1 的固定落点（不依赖 PATH，也不误拿 pwsh 7） */
export function windowsPowerShellPath(systemRoot = process.env.SystemRoot ?? 'C:\\Windows'): string {
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
