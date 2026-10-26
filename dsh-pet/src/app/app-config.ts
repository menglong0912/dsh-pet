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
import { isPeerAddress, PEER_MAX } from './visit';

const schema = z
  .object({
    /** 离开超过多少分钟、回来时打招呼 */
    greetAfterAwayMin: z.number().min(1).max(1440),
    screen: z.object({
      /** 自动看屏幕（右键手动看不受此开关限制）；模型接口没配好时不生效 */
      enabled: z.boolean(),
      intervalMin: z.number().min(3).max(1440),
    }),
    sitting: z.object({
      enabled: z.boolean(),
      afterMin: z.number().min(5).max(600),
      repeatMin: z.number().min(5).max(600),
    }),
    water: z.object({ enabled: z.boolean(), everyMin: z.number().min(10).max(600) }),
    /** 下班提醒；后加的字段，旧文件里没有时按默认值补上（不让整份配置因缺字段作废） */
    offWork: z
      .object({
        enabled: z.boolean(),
        /** 本地时间 HH:MM */
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        /** 只在周一到周五提醒 */
        weekdaysOnly: z.boolean(),
        /** 提前多少分钟提醒（0 = 到点提醒）；比 offWork 晚加，同样缺了按默认补 */
        leadMin: z.number().min(0).max(120).default(10),
      })
      .default({ enabled: true, time: '18:00', weekdaysOnly: true, leadMin: 10 }),
    /** 局域网串门；后加的字段，旧文件里没有时按默认值补上 */
    visit: z
      .object({
        /** 总开关（默认关）：关着时不发信标、不开端口，局域网里什么都不做 */
        enabled: z.boolean(),
        /** 允许别人来做客：发信标、开接待端口（每次进门仍要主人点头） */
        hosting: z.boolean(),
        /** 允许自家宠物出门：右键「串门」子菜单列出附近的邻居 */
        visiting: z.boolean(),
        /** 串门时用模型聊天；关掉只说固定的招呼和道别 */
        chat: z.boolean(),
        /** 邻居看到的主人昵称；空 = 用这台电脑的登录用户名 */
        nickname: z.string().max(12),
        /** 出门做客待多久（分钟） */
        stayMin: z.number().min(1).max(60),
        /** 熟人来敲门直接请进，不用主人点头；比 stayMin 晚加，同样缺了按默认补 */
        autoAdmitFriends: z.boolean().default(false),
        /** 和熟人互相捎话（主人亲手写的话，只对熟人收发）；比 autoAdmitFriends 晚加，同样缺了按默认补 */
        notes: z.boolean().default(true),
        /** 别的网段里的邻居（对方电脑的 IP）：信标照常广播，另外单播一份过去；后加的字段，同样缺了按默认补 */
        peers: z.array(z.string().refine(isPeerAddress)).max(PEER_MAX).default([]),
      })
      .default({
        enabled: false,
        hosting: true,
        visiting: true,
        chat: true,
        nickname: '',
        stayMin: 10,
        autoAdmitFriends: false,
        notes: true,
        peers: [],
      }),
    /** 修炼；后加的字段，旧文件里没有时按默认值补上（设置页的开关在 X6） */
    cultivation: z
      .object({
        /** 修炼总开关：关着时不建档、不涨修为、菜单里没有「修炼」 */
        enabled: z.boolean().default(true),
      })
      .default({ enabled: true }),
  })
  .strict();

export type AppConfig = z.infer<typeof schema>;

/** 去掉的功能留在旧文件里的字段（番茄钟）：读和存时都先丢掉，不让整份配置因多一个字段作废 */
const RETIRED_KEYS = ['pomodoro'];

function withoutRetired(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rest: Record<string, unknown> = { ...value };
  for (const key of RETIRED_KEYS) delete rest[key];
  return rest;
}

/**
 * 设置页保存（整份配置）：校验后写回文件，返回新配置；输入非法时抛错（调用方回 400）。
 * 先写临时文件再改名：读的一侧按 mtime 重读，不会读到写了一半的文件。
 */
export function saveAppConfig(path: string, input: unknown): AppConfig {
  const next = schema.parse(withoutRetired(input));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return next;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  greetAfterAwayMin: 10,
  screen: { enabled: true, intervalMin: 15 },
  sitting: { enabled: true, afterMin: 50, repeatMin: 20 },
  water: { enabled: true, everyMin: 60 },
  offWork: { enabled: true, time: '18:00', weekdaysOnly: true, leadMin: 10 },
  visit: {
    enabled: false,
    hosting: true,
    visiting: true,
    chat: true,
    nickname: '',
    stayMin: 10,
    autoAdmitFriends: false,
    notes: true,
    peers: [],
  },
  cultivation: { enabled: true },
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
      current = schema.parse(withoutRetired(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (error) {
      warn(`应用配置无效，继续使用上一份：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
    return current;
  };
}
