/**
 * 提醒（纯逻辑）：久坐 / 喝水 / 下班。不读时钟、不碰 Electron，`features.ts` 每拍喂 now 与在场快照。
 *
 * 久坐：本轮连续使用（activity.ts 的 activeSince）达到 afterMin 提醒一次，之后每 repeatMin 再提醒；
 *       离开 ≥ 5 分钟再回来 activeSince 重置，自然重新计时。
 * 喝水：只累计在电脑前的时间，满 everyMin 提醒一次后清零（离开期间不涨，回来不会立刻催）。
 * 下班：每天到「下班时间 - leadMin」后、主人还在电脑前时提醒一次；那会儿不在就等回来再说，当天改了时间按新时间再算一次。
 */
import type { ActivitySnapshot } from './activity';

export interface HealthConfig {
  sitting: { enabled: boolean; afterMin: number; repeatMin: number };
  water: { enabled: boolean; everyMin: number };
}
export interface OffWorkConfig {
  enabled: boolean;
  /** 本地时间 HH:MM */
  time: string;
  weekdaysOnly: boolean;
  /** 提前多少分钟提醒（0 = 到点提醒） */
  leadMin: number;
}

const MIN = 60_000;

export type HealthEvent = 'sit' | 'water';

export class HealthReminders {
  private lastTick: number | null = null;
  private presentMs = 0;
  /** 本轮连续使用中上一次久坐提醒的时刻；activeSince 变了（新的一轮）就作废 */
  private sitRound: { activeSince: number; lastAt: number | null } | null = null;
  private readonly config: () => HealthConfig;

  constructor(config: () => HealthConfig) {
    this.config = config;
  }

  /** @returns 这一拍该说的提醒（至多各一条） */
  tick(now: number, snap: ActivitySnapshot | null): HealthEvent[] {
    const cfg = this.config();
    // 采样间隔被系统睡眠拉长时不把整段睡眠算进在场时间
    const dt = this.lastTick === null ? 0 : Math.min(Math.max(0, now - this.lastTick), MIN);
    this.lastTick = now;
    if (!snap?.present || snap.activeSince === null) return [];
    this.presentMs += dt;
    if (this.sitRound?.activeSince !== snap.activeSince)
      this.sitRound = { activeSince: snap.activeSince, lastAt: null };

    const events: HealthEvent[] = [];
    if (cfg.sitting.enabled && now - snap.activeSince >= cfg.sitting.afterMin * MIN) {
      const lastAt = this.sitRound.lastAt;
      if (lastAt === null || now - lastAt >= cfg.sitting.repeatMin * MIN) {
        this.sitRound.lastAt = now;
        events.push('sit');
      }
    }
    if (cfg.water.enabled && this.presentMs >= cfg.water.everyMin * MIN) {
      this.presentMs = 0;
      events.push('water');
    }
    return events;
  }
}

export class OffWorkReminder {
  /** 已提醒过的「日期 + 下班时间」：同一天同一个时间只提醒一次 */
  private firedKey: string | null = null;
  private readonly config: () => OffWorkConfig;

  constructor(config: () => OffWorkConfig) {
    this.config = config;
  }

  /** @returns 这一拍要提醒时返回离下班还剩几分钟（≤ 0 = 已经过了下班时间），不提醒返回 null */
  tick(now: number, present: boolean): number | null {
    const cfg = this.config();
    if (!cfg.enabled || !present) return null;
    const date = new Date(now);
    if (cfg.weekdaysOnly && (date.getDay() === 0 || date.getDay() === 6)) return null;
    const [hour, minute] = cfg.time.split(':').map(Number);
    const left = hour * 60 + minute - (date.getHours() * 60 + date.getMinutes());
    if (left > cfg.leadMin) return null;
    const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${cfg.time}`;
    if (key === this.firedKey) return null;
    this.firedKey = key;
    return left;
  }
}
