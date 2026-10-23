/**
 * 提醒（纯逻辑）：番茄钟 + 久坐 / 喝水。不读时钟、不碰 Electron，`features.ts` 每拍喂 now 与在场快照。
 *
 * 番茄钟：专注 → 休息 → 专注……循环；休息结束时主人不在电脑前就自动停（免得没人看着空转）。
 * 久坐：本轮连续使用（activity.ts 的 activeSince）达到 afterMin 提醒一次，之后每 repeatMin 再提醒；
 *       离开 ≥ 5 分钟再回来 activeSince 重置，自然重新计时。
 * 喝水：只累计在电脑前的时间，满 everyMin 提醒一次后清零（离开期间不涨，回来不会立刻催）。
 * 专注期间（quiet）久坐 / 喝水只记账不出声，到休息或停掉番茄钟后的下一拍再补上。
 */
import type { ActivitySnapshot } from './activity';

export interface PomodoroConfig {
  focusMin: number;
  breakMin: number;
}
export interface HealthConfig {
  sitting: { enabled: boolean; afterMin: number; repeatMin: number };
  water: { enabled: boolean; everyMin: number };
}

export type PomodoroPhase = 'focus' | 'break';
export type PomodoroEvent = 'focus-start' | 'break-start' | 'stopped-away';

const MIN = 60_000;

export class Pomodoro {
  private current: { phase: PomodoroPhase; endsAt: number } | null = null;
  // 不用参数属性：测试走 node 的 strip-only TS，不支持那种写法
  private readonly config: () => PomodoroConfig;

  constructor(config: () => PomodoroConfig) {
    this.config = config;
  }

  start(now: number): PomodoroEvent {
    this.current = { phase: 'focus', endsAt: now + this.config().focusMin * MIN };
    return 'focus-start';
  }

  stop(): void {
    this.current = null;
  }

  /** 推进一拍：阶段到点时切换并返回对应事件 */
  tick(now: number, present: boolean): PomodoroEvent | null {
    if (!this.current || now < this.current.endsAt) return null;
    if (this.current.phase === 'focus') {
      this.current = { phase: 'break', endsAt: now + this.config().breakMin * MIN };
      return 'break-start';
    }
    if (!present) {
      this.current = null;
      return 'stopped-away';
    }
    return this.start(now);
  }

  phase(): PomodoroPhase | null {
    return this.current?.phase ?? null;
  }

  /** 剩余整分钟（向上取整，至少 1；未运行为 0） */
  remainingMin(now: number): number {
    if (!this.current) return 0;
    return Math.max(1, Math.ceil((this.current.endsAt - now) / MIN));
  }
}

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

  /**
   * @param quiet 为 true 时只记账不出声（番茄钟专注中）
   * @returns 这一拍该说的提醒（至多各一条）
   */
  tick(now: number, snap: ActivitySnapshot | null, quiet: boolean): HealthEvent[] {
    const cfg = this.config();
    // 采样间隔被系统睡眠拉长时不把整段睡眠算进在场时间
    const dt = this.lastTick === null ? 0 : Math.min(Math.max(0, now - this.lastTick), MIN);
    this.lastTick = now;
    if (!snap?.present || snap.activeSince === null) return [];
    this.presentMs += dt;
    if (this.sitRound?.activeSince !== snap.activeSince)
      this.sitRound = { activeSince: snap.activeSince, lastAt: null };
    if (quiet) return [];

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
