/**
 * dsh-pet 的 OpenCode 插件（V2 插件 API）—— **完全独立，不改桌宠源码**。
 *
 * 作用：订阅 OpenCode 服务器事件，把「思考 / 工具执行 / 一轮完成」挑出来，直接调用桌宠
 * 已有的两个本机接口：
 *   POST   /dsh-pet-7340/work-status  { state, task }   → 切换头顶状态 + 动画
 *   DELETE /dsh-pet-7340/work-status                    → 回到空闲
 *   POST   /app/say                   { text }          → 完成时冒一句话
 *
 * 桌宠端口每次启动随机，写在 app.json 里（Windows: %APPDATA%\dsh-pet\dsh-pet\app.json，
 * macOS: ~/Library/Application Support/dsh-pet/dsh-pet/app.json）。桌宠没开时静默跳过，
 * 绝不因为桌宠不在而影响 OpenCode。
 *
 * 事件只读元数据（事件名 / session / 项目目录 / 事件 id），不读 prompt 与模型输出。
 *
 * 安装：
 *   1. 把本目录放到 `~/.config/opencode/plugins/dsh-pet/`；
 *   2. 在 `~/.config/opencode/opencode.jsonc` 里加 `"plugins": ["./plugins/dsh-pet"]`。
 *
 * 动画文案来自桌宠配置：`animations.events.workStatus` 的第 0 档（thinking）。
 * 本仓库的 assets/config.jsonc 已把第 0 档配成「写代码」＝敲电脑；如果你用的是作者原版，
 * 在用户配置里把它改成「写代码」即可。
 */
import { Plugin } from '@opencode/plugin';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** 与 scripts/pet-cli.mjs 同一口径：桌宠应用把 app.json 放在 Electron 的 appData 下 */
function appDataDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

const APP_FILE = process.env.DSH_PET_APP_FILE || join(appDataDir(), 'dsh-pet', 'dsh-pet', 'app.json');

/** 旧事件重放保护：插件刚加载 / 服务器重启时可能重放旧事件 */
const REPLAY_WINDOW_MS = 2 * 60_000;
/** 同一事件去重窗口（插件每个 location 一份实例，同一事件会被多份实例各收到一次） */
const SEEN_TTL_MS = 10 * 60_000;
const SEEN_LIMIT = 500;
/** 「完成 / 出错」状态显示多久 */
const DONE_SHOW_MS = 10_000;
/** 思考 / 干活超过这么久没有后续事件，视为会话已被关掉 */
const WORKING_STALE_MS = 60 * 60_000;

/** OpenCode 事件 → 桌宠档位。只挑这几类，文本 / token 增量一律不转发 */
const EVENT_MAP: Record<string, string> = {
  'session.execution.started': 'thinking',
  'session.step.started': 'thinking',
  'session.reasoning.started': 'thinking',
  'session.text.started': 'thinking',
  'session.tool.input.started': 'thinking',
  'session.tool.called': 'working',
  // 工具跑完以后模型要生成下一步：立刻回到「思考（打字）」，别一直停在「忙碌点按」
  'session.tool.success': 'thinking',
  'session.tool.failed': 'thinking',
  'session.execution.succeeded': 'done',
  'session.execution.failed': 'error',
  'session.execution.interrupted': 'interrupted',
  'session.idle': 'idle',
};

/** 事件里只用到这几个字段；其余内容不解析 */
interface PetEvent {
  id?: string;
  created?: number;
  type?: string;
  data?: { sessionID?: string };
  location?: { directory?: string };
}

type SessionState = 'thinking' | 'working' | 'done' | 'error';
interface Session {
  project: string;
  state: SessionState;
  since: number;
}
interface PetStatus {
  state: 'thinking' | 'working' | 'success' | 'error';
  task: string;
}

interface Shared {
  /** 已处理过的事件 id（多份插件实例共享，避免同一事件转发多次） */
  seen: Map<string, number>;
  /** 按 session 记的状态（多份实例共享，谁先收到事件都能看到完整状态） */
  sessions: Map<string, Session>;
  /** 状态写入串行化，避免多份实例并发写乱序 */
  queue: Promise<void>;
  /** 上一次真正写出去的桌宠状态（去重，少刷接口） */
  lastSent: string;
  /** 「完成 / 出错」到点清屏的定时器 */
  timer: ReturnType<typeof setTimeout> | null;
}

/** globalThis 在同一个 OpenCode 服务器进程里是同一份：多份插件实例共享这一份 */
const shared = globalThis as typeof globalThis & { __dshPetOpenCode?: Shared };
const state = (shared.__dshPetOpenCode ??= {
  seen: new Map(),
  sessions: new Map(),
  queue: Promise.resolve(),
  lastSent: '',
  timer: null,
});

/** 读 app.json 拿桌宠端口；桌宠没开（文件不在 / 进程已退）返回 null */
function endpoint(): string | null {
  let info: { port?: unknown; pid?: unknown };
  try {
    info = JSON.parse(readFileSync(APP_FILE, 'utf8')) as { port?: unknown; pid?: unknown };
  } catch {
    return null;
  }
  if (typeof info.port !== 'number') return null;
  if (typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0);
    } catch {
      return null;
    }
  }
  return `http://127.0.0.1:${info.port}`;
}

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const base = endpoint();
  if (!base) return;
  try {
    await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // 桌宠没开 / 正在重启：静默跳过
  }
}

/** 把当前所有 session 合成一个桌宠状态；过期的直接清掉 */
function aggregate(now: number): PetStatus | null {
  for (const [id, s] of state.sessions) {
    if ((s.state === 'thinking' || s.state === 'working') && now - s.since > WORKING_STALE_MS) {
      state.sessions.delete(id);
    } else if ((s.state === 'done' || s.state === 'error') && now - s.since > DONE_SHOW_MS) {
      state.sessions.delete(id);
    }
  }
  // 优先级：出错 > 刚完成 > 干活 > 思考；同档取最近
  for (const wanted of ['error', 'done', 'working', 'thinking'] as const) {
    let best: Session | undefined;
    for (const s of state.sessions.values()) {
      if (s.state === wanted && (!best || s.since > best.since)) best = s;
    }
    if (!best) continue;
    const label =
      best.state === 'done'
        ? '完成啦'
        : best.state === 'error'
          ? '出错了'
          : best.state === 'working'
            ? '正在干活'
            : '正在思考';
    return {
      state: best.state === 'done' ? 'success' : best.state,
      task: `${best.project} · OpenCode ${label}`,
    };
  }
  return null;
}

/** 把当前状态写到桌宠（串行、去重；状态回空闲时 DELETE） */
function publish(): void {
  state.queue = state.queue
    .then(async () => {
      const next = aggregate(Date.now());
      const key = next ? `${next.state}|${next.task}` : '';
      if (key === state.lastSent) return;
      state.lastSent = key;
      if (next) await call('POST', '/dsh-pet-7340/work-status', next);
      else await call('DELETE', '/dsh-pet-7340/work-status');
    })
    .catch(() => undefined);
  scheduleExpiry();
}

/** 「完成 / 出错」显示 10 秒后重算一次：把到期的那条清掉，让别的 session 重新顶上来 */
function scheduleExpiry(): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  let at = Number.POSITIVE_INFINITY;
  for (const s of state.sessions.values()) {
    if (s.state === 'done' || s.state === 'error') at = Math.min(at, s.since + DONE_SHOW_MS);
  }
  if (!Number.isFinite(at)) return;
  state.timer = setTimeout(
    () => {
      state.timer = null;
      publish();
    },
    Math.max(0, at - Date.now()) + 50,
  );
}

function handle(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const event = raw as PetEvent;
  const mapped = typeof event.type === 'string' ? EVENT_MAP[event.type] : undefined;
  if (!mapped) return;

  const now = Date.now();
  if (typeof event.created === 'number' && now - event.created > REPLAY_WINDOW_MS) return;

  if (typeof event.id === 'string' && event.id) {
    const last = state.seen.get(event.id);
    if (last !== undefined && now - last <= SEEN_TTL_MS) return;
    state.seen.set(event.id, now);
    if (state.seen.size > SEEN_LIMIT) {
      for (const [id, at] of state.seen) if (now - at > SEEN_TTL_MS) state.seen.delete(id);
    }
  }

  const id = typeof event.data?.sessionID === 'string' && event.data.sessionID ? event.data.sessionID : 'unknown';
  const dir = typeof event.location?.directory === 'string' ? event.location.directory : '';
  const project = dir ? basename(dir) : (state.sessions.get(id)?.project ?? 'OpenCode');

  if (mapped === 'idle' || mapped === 'interrupted') {
    // 已经成功 / 失败的会话保留「完成 / 出错」的短暂展示；其余（中途断了）清掉
    const prev = state.sessions.get(id);
    if (prev && prev.state !== 'done' && prev.state !== 'error') state.sessions.delete(id);
    publish();
    return;
  }

  state.sessions.set(id, { project, state: mapped as SessionState, since: now });
  publish();

  if (mapped === 'done') {
    void call('POST', '/app/say', { text: `${project} 的 OpenCode 干完啦，去看看吧～` });
  }
}

export default Plugin.define({
  id: 'dsh-pet',
  async setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          handle(event);
        }
      } catch {
        // 事件流断开 / 插件卸载：下一轮 OpenCode 照常，不影响用户
      }
    })();
    return () => controller.abort();
  },
});
