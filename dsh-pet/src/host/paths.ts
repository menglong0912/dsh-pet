/**
 * 本包在磁盘上的几个路径口径。
 *
 * 独立应用把宿主半边与桌面窗口装进**同一个 Electron 进程**，不再 spawn helper、不再下载
 * Electron；原先管进程的 helper-process.ts 随之删掉，只留下还在用的这几个路径。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 本包目录：构建产物位于 lib/，其上一级即包根。 */
export const packageRoot = resolve(here, '..');

/** $DSH_HOME（默认 ~/.dsh）。显式设了就用它，独立应用会指到自己的数据目录。 */
export function dshHomeDir(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  return process.env.DSH_HOME || join(userProfile, '.dsh');
}

/**
 * 旧版插件运行方式把 Electron 下载到 $DSH_HOME/electron。
 *
 * 独立应用不再走这条下载路径，但设置页「卸载与存储」还要把这个旧目录列出来让用户清理，
 * 所以路径口径留在这里（唯一定义处）。
 */
export function electronLandingDir(): string {
  return join(dshHomeDir(), 'electron');
}
