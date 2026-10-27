/**
 * Claude Code hook 事件 → 桌宠状态（纯逻辑）。
 *
 * 由 `~/.claude/settings.json` 里的 hook 调 `dsh-pet hook`（scripts/pet-cli.mjs），把 hook 的 stdin JSON
 * 原样 POST 到 `/app/claude-hook`。这里按 session 记账，供状态合成（status.ts）与说话决策使用：
 *   UserPromptSubmit → 干活中（只记账、不显示：开工不用提醒，指令是主人自己刚发的）；
 *   Notification（要权限）→ 等主人确认，并说一句；
 *   Stop → 干完了，短暂显示「完成」；这一轮干了 ≥ ANNOUNCE_AFTER_MS 才说一句（秒回的问答不打扰）；
 *   SessionEnd → 移除。
 *
 * 只读 hook 里的元数据（事件名 / session / cwd / 通知类型），**不读 prompt 正文**：桌宠只需要知道
 * 「哪个项目的 Claude 在干嘛」。
 */
import { basename } from 'node:path';

/** 一轮至少干了这么久，完成时才说话 */
export const ANNOUNCE_AFTER_MS = 30_000;
/** 「完成」状态显示多久 */
export const DONE_SHOW_MS = 10_000;
/** 等确认超过这么久没有后续事件，按回到干活中处理（权限给了以后到 Stop 之前不会再有事件） */
export const WAITING_STALE_MS = 90_000;
/** 干活中 / 等确认超过这么久没有任何事件，视为会话已被关掉 */
export const WORKING_STALE_MS = 60 * 60_000;

export interface ClaudeHookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  message?: unknown;
  notification_type?: unknown;
}

type SessionState = 'working' | 'waiting' | 'done';
interface Session {
  project: string;
  state: SessionState;
  since: number;
}

/** handle 的结论：这次事件要不要让桌宠说话 */
export type ClaudeSpeech = { kind: 'done' | 'permission'; project: string } | null;

/** 状态合成要的视图：只给「此刻值得显示」的那一种（干活中不显示） */
export type ClaudeView = { state: 'waiting' | 'success'; count: number; project: string } | null;

export class ClaudeSessions {
  private readonly sessions = new Map<string, Session>();

  handle(payload: ClaudeHookPayload, now: number): ClaudeSpeech {
    const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
    const id = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown';
    // 个别事件不带 cwd：沿用这个会话已知的项目名
    const project =
      typeof payload.cwd === 'string' && payload.cwd
        ? basename(payload.cwd)
        : (this.sessions.get(id)?.project ?? 'Claude');
    switch (event) {
      case 'UserPromptSubmit':
        this.sessions.set(id, { project, state: 'working', since: now });
        return null;
      case 'Notification':
        if (!isPermissionNotification(payload)) return null;
        this.sessions.set(id, { project, state: 'waiting', since: now });
        return { kind: 'permission', project };
      case 'Stop': {
        const prev = this.sessions.get(id);
        this.sessions.set(id, { project, state: 'done', since: now });
        const long = prev !== undefined && prev.state !== 'done' && now - prev.since >= ANNOUNCE_AFTER_MS;
        return long ? { kind: 'done', project } : null;
      }
      case 'SessionEnd':
        this.sessions.delete(id);
        return null;
      default:
        return null;
    }
  }

  /** 此刻的合成视图：等确认 > 刚完成；干活中只记账不显示 */
  view(now: number): ClaudeView {
    const live: Array<Session & { effective: SessionState }> = [];
    for (const [id, s] of this.sessions) {
      if (s.state !== 'done' && now - s.since > WORKING_STALE_MS) {
        this.sessions.delete(id);
        continue;
      }
      const effective = s.state === 'waiting' && now - s.since > WAITING_STALE_MS ? 'working' : s.state;
      if (effective === 'done' && now - s.since > DONE_SHOW_MS) continue;
      if (effective === 'working') continue;
      live.push({ ...s, effective });
    }
    for (const state of ['waiting', 'done'] as const) {
      const hits = live.filter((s) => s.effective === state).sort((a, b) => b.since - a.since);
      if (hits.length) {
        return { state: state === 'done' ? 'success' : state, count: hits.length, project: hits[0].project };
      }
    }
    return null;
  }
}

/** 要权限的通知才算「等主人确认」；空闲 60 秒的「在等你输入」已经由 Stop 说过一次 */
function isPermissionNotification(payload: ClaudeHookPayload): boolean {
  if (typeof payload.notification_type === 'string') return payload.notification_type === 'permission_prompt';
  return typeof payload.message === 'string' && /permission/i.test(payload.message);
}
