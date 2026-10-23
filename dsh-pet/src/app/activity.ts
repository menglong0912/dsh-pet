/**
 * 主人在不在、在干什么（纯逻辑）——由采样驱动的小状态机，不碰 Electron、不读时钟。
 *
 * 平台采样（系统空闲秒数 / 锁屏 / 前台应用）在 `features.ts` 里每隔几秒喂一次 `update()`；
 * 这里只负责把采样折算成「在电脑前 / 离开」两态、当前前台应用与本轮连续使用时长，并吐出边沿事件。
 *
 * 判定口径：
 *   - 离开 = 锁屏，或键鼠空闲 ≥ AWAY_IDLE_SEC。空闲离开的起点按 `now - idleSec` 回推（人是那时走的）；
 *   - 连续使用从「回到电脑前」那一刻起算，短于 AWAY_IDLE_SEC 的停顿不打断它（久坐提醒据此计时）；
 *   - 前台应用只在电脑前时跟踪：离开期间切换不算。
 */

/** 键鼠空闲多久算离开（秒） */
export const AWAY_IDLE_SEC = 300;

/** 一次平台采样 */
export interface ActivitySample {
  now: number;
  /** 系统键鼠空闲秒数 */
  idleSec: number;
  locked: boolean;
  /** 前台应用显示名；取不到（或是桌宠自己）时为 null，沿用上一次的值 */
  frontApp: string | null;
}

/** 当前快照 */
export interface ActivitySnapshot {
  present: boolean;
  frontApp: string | null;
  /** 切到当前前台应用的时刻 */
  frontSince: number | null;
  /** 本轮连续使用的起点（present 时有值） */
  activeSince: number | null;
  /** 离开的起点（!present 时有值） */
  awaySince: number | null;
}

export type ActivityEvent =
  { type: 'leave' } | { type: 'return'; awayMs: number } | { type: 'switch'; from: string | null; to: string };

export class ActivityTracker {
  private snap: ActivitySnapshot | null = null;

  /** 喂一次采样，返回这一拍产生的边沿事件（首拍只建立基线，不出事件） */
  update(sample: ActivitySample): ActivityEvent[] {
    const present = !sample.locked && sample.idleSec < AWAY_IDLE_SEC;
    const prev = this.snap;
    if (!prev) {
      this.snap = {
        present,
        frontApp: present ? sample.frontApp : null,
        frontSince: present && sample.frontApp ? sample.now : null,
        activeSince: present ? sample.now : null,
        awaySince: present ? null : leftAt(sample),
      };
      return [];
    }
    const events: ActivityEvent[] = [];
    const next: ActivitySnapshot = { ...prev, present };
    if (prev.present && !present) {
      next.awaySince = leftAt(sample);
      next.activeSince = null;
      events.push({ type: 'leave' });
    } else if (!prev.present && present) {
      events.push({ type: 'return', awayMs: Math.max(0, sample.now - (prev.awaySince ?? sample.now)) });
      next.awaySince = null;
      next.activeSince = sample.now;
    }
    if (present && sample.frontApp && sample.frontApp !== prev.frontApp) {
      if (prev.present) events.push({ type: 'switch', from: prev.frontApp, to: sample.frontApp });
      next.frontApp = sample.frontApp;
      next.frontSince = sample.now;
    }
    this.snap = next;
    return events;
  }

  /** 当前快照（尚未采样时为 null） */
  snapshot(): ActivitySnapshot | null {
    return this.snap;
  }
}

/** 离开的起点：锁屏按当下，空闲按回推 */
function leftAt(sample: ActivitySample): number {
  return sample.locked ? sample.now : sample.now - sample.idleSec * 1000;
}

/** 时长文案：不到 1 分钟 / N 分钟 / H 小时 M 分钟 */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/**
 * 给模型看的一行「主人此刻」背景，拼在人设后面（碎碎念、对话、提醒、看屏幕共用）。
 * @returns 一行中文；还没采样时为空串（调用方据此整行不加）
 */
export function describeActivity(snap: ActivitySnapshot | null, now: number): string {
  if (!snap) return '';
  if (!snap.present) {
    return snap.awaySince === null ? '' : `【主人此刻】已经离开电脑 ${durationText(now - snap.awaySince)}了。`;
  }
  const parts: string[] = [];
  if (snap.frontApp && snap.frontSince !== null) {
    parts.push(`正在用「${snap.frontApp}」${durationText(now - snap.frontSince)}`);
  }
  if (snap.activeSince !== null) parts.push(`已经连续用电脑 ${durationText(now - snap.activeSince)}`);
  return parts.length ? `【主人此刻】${parts.join('；')}。` : '';
}
