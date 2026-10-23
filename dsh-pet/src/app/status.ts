/**
 * 工作状态合成（纯逻辑）：桌宠只有一个外部工作状态槽（`POST /dsh-pet-7340/work-status`，最后写入者生效），
 * Claude Code、番茄钟与串门都想用它，所以统一在这里排优先级，`features.ts` 只在结果变了时写一次。
 *
 * 优先级：Claude 等确认 > 出门做客 > 番茄钟倒计时 > Claude 刚完成 > 空闲（Claude 干活中不显示）。
 * 文案上限 40 字（宿主 TASK_TEXT_MAX），这里的文案都远小于它。
 */
import type { ClaudeView } from './claude-hooks';
import type { PomodoroPhase } from './reminders';

export interface WorkStatus {
  state: 'waiting' | 'working' | 'result' | 'success';
  task: string;
}

export function composeWorkStatus(
  claude: ClaudeView,
  pomodoro: { phase: PomodoroPhase; remainingMin: number } | null,
  away: { owner: string; remainingMin: number } | null = null,
): WorkStatus | null {
  if (claude?.state === 'waiting') {
    const who = claude.count > 1 ? `Claude ×${claude.count}` : 'Claude';
    return { state: 'waiting', task: `${who} · ${claude.project} 等你确认` };
  }
  if (away) return { state: 'working', task: `在 ${away.owner} 家做客 · 剩 ${away.remainingMin} 分` };
  if (pomodoro) {
    return pomodoro.phase === 'focus'
      ? { state: 'working', task: `番茄钟 · 剩 ${pomodoro.remainingMin} 分` }
      : { state: 'result', task: `休息中 · 剩 ${pomodoro.remainingMin} 分` };
  }
  if (claude) return { state: 'success', task: `Claude · ${claude.project} 完成啦` };
  return null;
}

/** 两次合成结果是否相同（决定要不要再写一次槽位） */
export function sameStatus(a: WorkStatus | null, b: WorkStatus | null): boolean {
  return a === b || (a !== null && b !== null && a.state === b.state && a.task === b.task);
}
