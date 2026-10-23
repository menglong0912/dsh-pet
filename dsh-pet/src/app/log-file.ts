/**
 * 双击 / 开机自启时应用没有终端，console 输出直接丢掉，出了问题无从查起。
 * 这时把 stdout / stderr 同时追加进一个日志文件（终端里启动时不动，照常只打到终端）。
 * 启动时超过 MAX_BYTES 就把旧文件挪成 `.1`，只留一代。
 */
import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

export function teeOutputToFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // 文件还不存在
  }
  const file = createWriteStream(path, { flags: 'a' });
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      file.write(typeof chunk === 'string' ? `[${new Date().toISOString()}] ${chunk}` : (chunk as Buffer));
      return original(chunk, ...rest);
    }) as typeof stream.write;
  }
}
