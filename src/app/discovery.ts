/**
 * 端口发现文件：应用每次启动监听随机端口，把它写进 `$DSH_HOME/dsh-pet/app.json`，
 * 命令行（scripts/pet-cli.mjs）与 Claude Code hook 读它找到桌宠。退出时删掉（只删自己写的那份）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DiscoveryInfo {
  port: number;
  pid: number;
  version: string;
}

export function discoveryPath(home: string): string {
  return join(home, 'dsh-pet', 'app.json');
}

export function writeDiscovery(home: string, info: DiscoveryInfo): void {
  writeFileSync(discoveryPath(home), JSON.stringify(info) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** 只删 pid 是自己的那份：新实例已经启动并覆盖过时，旧实例退出不能把它删掉 */
export function removeDiscovery(home: string, pid: number): void {
  const path = discoveryPath(home);
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as Partial<DiscoveryInfo>).pid === pid) rmSync(path);
  } catch {
    // 文件不在或已损坏：没有需要清理的
  }
}
