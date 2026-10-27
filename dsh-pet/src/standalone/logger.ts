/**
 * 独立应用的日志接口与默认实现。
 *
 * 与宿主对 `ctx.logger` 的使用面一致（info / warn / error / debug），但不再依赖任何插件上下文。
 */

export interface StandaloneLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** 默认日志器：直接写控制台，格式与宿主自身的 `[dsh-pet]` 前缀区分开 */
export function createStandaloneLogger(): StandaloneLogger {
  const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const write = (level: string, message: string): void => {
    console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
  };
  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === '1') write('DEBUG', message);
    },
  };
}
