// 系统通知：事件帧 → toast 文案映射（src/shared 单一来源）。
// 独立应用没有 DSH 会话事件，不会产出这些帧；映射仍随共享产物（window.PetShared）发布，
// 供其他消费端按同一形状解析。
// 纯函数无副作用；帧形状不匹配/不认识的类型一律返回 null（不弹、不报错）。

/** 通知图标文件名（不含扩展名；浏览器半侧拼完整 URL：/dsh-pet-7340/pic/<name>.png） */
export const NOTIFY_ICONS = {
  done: 'notify-done',
  error: 'notify-error',
  truncated: 'notify-truncated',
  approval: 'notify-approval',
  question: 'notify-question',
  test: 'notify-test',
} as const;

export const MAX_BODY = 80;

/** 文案截断（与弹窗一致：超长只留前 80 字符） */
export function truncate(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
}

/** 通知帧（浏览器 mux/host 流的帧形状） */
export interface NotifyFrame {
  type: string;
  /** 发出这条通知的会话 id（host 侧 sessionIdOf 填）。点击通知时据此跳到那条会话；
   *  没有会话位置的事件（host/agent-error）不带这个字段，消费端把缺失一律当成"只叫窗口"。 */
  sessionId?: string;
  [key: string]: unknown;
}

/** session/event 帧里的 turn/end 事件形状 */
interface TurnEndEvent {
  type?: string;
  data?: {
    reason?: { kind?: string; error?: { message?: string } };
  };
}

/** 帧 → toast 文案；不认识的类型 / turn/end 的非弹分支（aborted 等）返回 null */
export function frameToToast(frame: NotifyFrame): { title: string; body: string; icon: string } | null {
  switch (frame.type) {
    case 'session/event': {
      const ev = (frame.event ?? {}) as TurnEndEvent;
      if (ev.type !== 'turn/end') return null;
      const kind = ev.data?.reason?.kind;
      if (kind === 'completed') return { title: '对话完成', body: '', icon: NOTIFY_ICONS.done };
      if (kind === 'error')
        return { title: '生成失败', body: ev.data?.reason?.error?.message ?? '', icon: NOTIFY_ICONS.error };
      if (kind === 'max-tokens')
        return { title: '输出被截断', body: '已达到输出 token 上限', icon: NOTIFY_ICONS.truncated };
      // aborted（用户/父代理取消）、interrupted（崩溃恢复）等：不弹
      return null;
    }
    case 'approval/requested': {
      const toolName = typeof frame.toolName === 'string' ? frame.toolName : '';
      const reason = typeof frame.reason === 'string' && frame.reason ? frame.reason : '';
      return {
        title: '正在申请权限',
        body: (toolName ? '工具「' + toolName + '」' : '') + (reason ? '：' + reason : ''),
        icon: NOTIFY_ICONS.approval,
      };
    }
    case 'question/requested': {
      const q =
        (Array.isArray(frame.questions) && (frame.questions as Array<{ question?: string }>)[0]?.question) || '';
      return { title: '模型在等你回答', body: q, icon: NOTIFY_ICONS.question };
    }
    case 'host/agent-error': {
      return {
        title: '生成失败',
        body: typeof frame.message === 'string' ? (frame.message as string) : '',
        icon: NOTIFY_ICONS.error,
      };
    }
    default:
      return null;
  }
}
