/**
 * host 侧工作状态存储（自包含，不 import src/shared —— 构建产物单文件加载）。
 *
 * 独立应用没有 DSH 会话事件：工作状态只由 `POST/DELETE /dsh-pet-7340/work-status` 写入
 * （Claude Code hook 经 src/app/features.ts 调用），index.ts 再把它写进 S 的 sections.workStatus，
 * 桌面端统一轮询 /state 后按 counter 变化渲染。只做聚合与去重：状态无变化不产生新输出。
 *
 * 档位与 animations.events.workStatus 数组索引严格一致（顺序勿在中间插入）：
 *   0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error
 */

/** 工作状态档位（数组索引 = events.workStatus 档位；顺序与 shared/work-status.ts 一致） */
export const HOST_WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type HostWorkStatusState = (typeof HOST_WORK_STATUS_STATES)[number];

/**
 * 任务详情文案长度上限（按**码点**计，超出截断加省略号）：气泡最大宽度只有 0.5×宠物宽
 * （默认 size 462 时约 231px、字号 21px ≈ 一行 11 个汉字），而外部写入的任务原文动辄几十字，
 * 不截断会把气泡撑成好几行、盖住宠物。
 */
export const TASK_TEXT_MAX = 40;

/** 工作状态快照（/work-status 端点响应体）：state 为主状态；task 为任务详情（可 null） */
export interface WorkStatusSnapshot {
  state: HostWorkStatusState | null; // null = 尚无外部写入（空闲）
  task: string | null; // 当前任务详情（可 null）
  ts: number; // 最近一次变化的时间戳（轮询侧检测变化用）
}

/** 每会话聚合条目：state（档位）+ seq（该会话最近事件的序号，同档位按它取最近）+ task（任务详情文案） */
export interface SessionWorkEntry {
  state: HostWorkStatusState;
  seq: number;
  task: string | null;
}

/** 展示优先级：waiting > error > working > thinking > result > success
 *  （result 高于 success：任何会话的进行中过渡态都不被别处已完成态压过，防中途庆祝；同档按最近更新优先） */
export const WORK_STATUS_PRIORITY: Record<HostWorkStatusState, number> = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};

/** 展示用条目：所有会话里优先级最高者（同优先级取 seq 更大者）；无会话 → undefined */
export function pickDisplayed(entries: Iterable<SessionWorkEntry>): SessionWorkEntry | undefined {
  let best: SessionWorkEntry | undefined;
  for (const entry of entries) {
    if (
      !best ||
      WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] ||
      (WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq)
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * 工作状态聚合（纯逻辑，可单测）：按写入者维护 state/task，对外只暴露一个展示快照。
 *
 * 独立应用只有一个外部写入槽（`api`），按会话存仍然保留：task 与它的条目同生共死，
 * 条目被清 → 文案随之消失；展示时 state 与 task 取自**同一个** best 条目，
 * 不会出现"A 的状态配 B 的文案"。
 */
export class WorkStatusStore {
  // 类字段一律 `declare` + 构造器赋值（与 PollStateStore 同一约定）：带初始化器的类字段在 target
  // es2020 下要被降级，rolldown 会为此产出
  // `import _defineProperty from "@oxc-project/runtime/helpers/defineProperty"`——该包不在本包
  // dependencies 里，漏打会 ERR_MODULE_NOT_FOUND。构建目标已提到 es2022，保留这个写法。
  declare private readonly sessions: Map<string, SessionWorkEntry>;
  declare private readonly snap: WorkStatusSnapshot;

  constructor() {
    this.sessions = new Map();
    this.snap = { state: null, task: null, ts: 0 };
  }

  /** 该会话当前档位（无条目 / 已清 → undefined） */
  stateOf(sessionId: string): HostWorkStatusState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** 该会话当前任务详情（无条目 → null） */
  taskOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.task ?? null;
  }

  /** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新 → 无变化返回 false（防刷屏） */
  setState(sessionId: string, state: HostWorkStatusState, seq = 0): boolean {
    const prev = this.sessions.get(sessionId);
    if (prev?.state === state && prev.seq >= seq) return false;
    this.sessions.set(sessionId, { state, seq, task: prev?.task ?? null });
    this.refresh();
    return true;
  }

  /** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示） */
  setTask(sessionId: string, task: string | null): boolean {
    const prev = this.sessions.get(sessionId);
    if (!prev || prev.task === task) return false;
    this.sessions.set(sessionId, { ...prev, task });
    this.refresh();
    return true;
  }

  /** 清掉某会话：它的 task 一并消失，不会残留到后续活动里 */
  clear(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false;
    this.refresh();
    return true;
  }

  /** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
  snapshot(): WorkStatusSnapshot {
    return this.snap;
  }

  /** 重算展示：state 与 task **任一**变化才更新 ts（轮询侧据此触发，两端都靠它刷新） */
  private refresh(): void {
    const best = pickDisplayed(this.sessions.values());
    const nextState = best?.state ?? null;
    const nextTask = best?.task ?? null;
    if (nextState === this.snap.state && nextTask === this.snap.task) return;
    this.snap.state = nextState;
    this.snap.task = nextTask;
    this.snap.ts = Date.now();
  }
}
