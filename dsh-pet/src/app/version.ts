/**
 * 包版本读取（独立应用写端口发现文件时用）。
 *
 * 原先在 standalone/check.ts 里，和 CLI 体检一起删掉；应用只需要这一个函数，
 * 留在 app 下，避免再依赖独立模式的代码。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 包版本（读不到就 unknown） */
export function packageVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
