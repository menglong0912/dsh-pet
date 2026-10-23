/**
 * 独立应用自己的功能开关（`$DSH_HOME/dsh-pet/app-config.json`）。
 *
 * 不塞进插件的 main-config.jsonc：那份由插件的合并器管（整段替换语义、设置页会整包回写），
 * 应用专属的字段放进去既可能被设置页冲掉，也会让以后合并上游时多一处冲突。
 *
 * 文件不存在时写一份默认值，方便直接改；改完即时生效（按 mtime 重读，不用重启）。
 * 文件写坏时**明确报错**并沿用上一份好的配置，不静默改回默认。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const schema = z
  .object({
    /** 离开超过多少分钟、回来时打招呼 */
    greetAfterAwayMin: z.number().min(1).max(1440),
    screen: z.object({
      /** 自动看屏幕（右键手动看不受此开关限制）；只在模型接口是本机地址时生效 */
      enabled: z.boolean(),
      intervalMin: z.number().min(3).max(1440),
    }),
    pomodoro: z.object({ focusMin: z.number().min(1).max(180), breakMin: z.number().min(1).max(60) }),
    sitting: z.object({
      enabled: z.boolean(),
      afterMin: z.number().min(5).max(600),
      repeatMin: z.number().min(5).max(600),
    }),
    water: z.object({ enabled: z.boolean(), everyMin: z.number().min(10).max(600) }),
  })
  .strict();

export type AppConfig = z.infer<typeof schema>;

/**
 * 设置页保存（整份配置）：校验后写回文件，返回新配置；输入非法时抛错（调用方回 400）。
 * 先写临时文件再改名：读的一侧按 mtime 重读，不会读到写了一半的文件。
 */
export function saveAppConfig(path: string, input: unknown): AppConfig {
  const next = schema.parse(input);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return next;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  greetAfterAwayMin: 10,
  screen: { enabled: true, intervalMin: 15 },
  pomodoro: { focusMin: 25, breakMin: 5 },
  sitting: { enabled: true, afterMin: 50, repeatMin: 20 },
  water: { enabled: true, everyMin: 60 },
};

/**
 * @param path 配置文件路径
 * @param warn 配置写坏时的告警出口
 * @returns 取当前配置的函数（每次调用按 mtime 判断是否需要重读）
 */
export function createAppConfig(path: string, warn: (message: string) => void): () => AppConfig {
  if (!existsSync(path)) {
    // 首次启动时数据目录可能还没建（本函数在插件 apply 之前调用）
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_APP_CONFIG, null, 2) + '\n', 'utf8');
  }
  let current = DEFAULT_APP_CONFIG;
  let loadedMtime = -1;
  return () => {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return current; // 被删了：沿用当前，下次启动会重新写默认值
    }
    if (mtime === loadedMtime) return current;
    loadedMtime = mtime;
    try {
      current = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      warn(`应用配置无效，继续使用上一份：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
    return current;
  };
}
