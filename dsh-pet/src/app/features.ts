/**
 * 独立应用的扩展功能编排（只在 `src/app/main.ts` 里启动，DSH 内运行时不存在）。
 *
 * 纯逻辑都在旁边的模块里（activity / reminders / claude-hooks / status，各有单测）；这里只做接线：
 *   - 每 TICK_MS 采样一次：系统空闲秒数与锁屏（Electron powerMonitor）+ 前台应用（`lsappinfo`，无需授权）；
 *   - 根据采样推进番茄钟、久坐 / 喝水提醒、回来打招呼、定时看屏幕；
 *   - 把 Claude Code 与番茄钟合成为一个外部工作状态（桌宠只有一个外部槽）；
 *   - 右键「更多」里注册「看看我在干嘛 / 开始·停止番茄钟」并长轮询点击。
 *
 * 驱动桌宠一律走插件自己的 HTTP 路由（/broadcast、/work-status、/menu/*），与第三方调用者同一契约，
 * 不碰插件内部状态——以后合并上游时这里不受插件内部重构影响。
 *
 * 说话的文本由本机模型按人设生成（人设 + 时间 + 「主人此刻」），模型不可用时用固定兜底句；
 * 看屏幕没有兜底句：看不了就明确说看不了（手动触发时）或安静跳过（自动触发时）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findPetInstance, flattenPetList, readAllConfig } from '../host/config';
import type { ConfigPaths } from '../host/config';
import { composeSystemPrompt, petPersona } from '../host/persona';
import type { StandaloneAiService } from '../standalone/ai-provider';
import { ActivityTracker, describeActivity, durationText } from './activity';
import type { ActivitySnapshot } from './activity';
import type { AppConfig } from './app-config';
import { ClaudeSessions } from './claude-hooks';
import type { ClaudeHookPayload } from './claude-hooks';
import { HealthReminders, Pomodoro } from './reminders';
import type { HealthEvent, PomodoroEvent } from './reminders';
import { composeWorkStatus, sameStatus } from './status';
import type { WorkStatus } from './status';

const run = promisify(execFile);

/** 采样间隔 */
const TICK_MS = 5_000;
/** 右键菜单的 owner（插件按它归组、按它投递点击） */
const MENU_OWNER = 'dsh-pet-app';
const MENU_LOOK = '看看我在干嘛';
const MENU_POMODORO_START = '开始番茄钟';
/** 自动看屏幕要求键鼠最近活动过（秒）：人在看视频 / 发呆时不打扰 */
const SCREEN_ACTIVE_IDLE_SEC = 60;
/** 前台是这些应用时视为「取不到」（桌宠自己的窗口被点到前台） */
const SELF_APP_NAMES = new Set(['dsh-pet', 'Electron']);
const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const LINE_RULE = '只说一句话，20 字以内，不加引号，不解释，不提你是 AI。';

/** 本模块用到的 Electron 能力（只声明用到的成员：静态 import 'electron' 会让 tsc 整仓找不到类型） */
export interface FeatureElectron {
  powerMonitor: {
    getSystemIdleTime(): number;
    getSystemIdleState(idleThreshold: number): string;
  };
  desktopCapturer: {
    getSources(options: {
      types: Array<'screen'>;
      thumbnailSize: { width: number; height: number };
    }): Promise<Array<{ display_id: string; thumbnail: { isEmpty(): boolean; toJPEG(quality: number): Buffer } }>>;
  };
  screen: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): { id: number };
  };
  systemPreferences: { getMediaAccessStatus(mediaType: 'screen'): string };
  shell: { openExternal(url: string): Promise<void> };
}

export interface AppFeatures {
  /** 给插件人设拼装用的「主人此刻」一行（ctx.dshPetAppContext） */
  activityContext(): string;
  activity(): ActivitySnapshot | null;
  handleClaudeHook(payload: ClaudeHookPayload): Promise<void>;
  /** 让桌宠直接说一句给定的话 */
  say(text: string): Promise<boolean>;
  /** 按人设碎碎念一句（插件的 /whisper，结果原样返回） */
  whisper(): Promise<Record<string, unknown>>;
  /** 看一眼屏幕并吐槽；返回结果说明（给 HTTP 调用方看） */
  lookAtScreen(manual: boolean): Promise<{ ok: boolean; text?: string; reason?: string }>;
  dispose(): void;
}

export interface FeatureDeps {
  electron: FeatureElectron;
  ai: StandaloneAiService;
  configPaths: ConfigPaths;
  appConfig: () => AppConfig;
  /** 插件路由前缀的完整地址，如 http://127.0.0.1:53624/dsh-pet-7340 */
  petBase: string;
  log: (message: string) => void;
}

export function startAppFeatures(deps: FeatureDeps): AppFeatures {
  const { electron, ai, log } = deps;
  const tracker = new ActivityTracker();
  const claude = new ClaudeSessions();
  const pomodoro = new Pomodoro(() => deps.appConfig().pomodoro);
  const health = new HealthReminders(() => deps.appConfig());
  let disposed = false;
  let lastStatus: WorkStatus | null = null;
  let lastScreenAt = Date.now();
  let menuLabels: string[] = [];
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** 说话串行：上一句发出去再生成下一句，免得两个气泡互相顶掉 */
  let speaking: Promise<unknown> = Promise.resolve();
  let screenBusy = false;

  // ---------- 桌宠路由 ----------

  /** 当前目标宠物：第一只在桌面显示的；配置读不到时按 main */
  function petId(): string {
    try {
      const pets = flattenPetList(readAllConfig(deps.configPaths));
      const desktop = pets.find((pet) => pet.display === 'desktop' || pet.display === 'both') ?? pets[0];
      return desktop ? String(desktop.id) : 'main';
    } catch {
      return 'main';
    }
  }

  async function petRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const url = new URL(deps.petBase + path);
    url.searchParams.set('pet', petId());
    url.searchParams.set('surface', 'any');
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return { ok: true };
    return (await response.json()) as Record<string, unknown>;
  }

  async function say(text: string): Promise<boolean> {
    try {
      const result = await petRequest('POST', '/broadcast', { text, anim: true });
      if (result.ok !== true) log(`说话失败：${JSON.stringify(result)}`);
      return result.ok === true;
    } catch (error) {
      log(`说话失败：${errorText(error)}`);
      return false;
    }
  }

  // ---------- 生成 ----------

  /** 人设 + 名字 + 时间（插件同一套拼装）+ 主人此刻 */
  function systemPrompt(): string {
    const cfg = readAllConfig(deps.configPaths);
    const found = findPetInstance(cfg, petId());
    const base = found
      ? composeSystemPrompt({
          prompt: petPersona(found.conf, found.pet),
          name: String(found.pet.name ?? ''),
          id: String(found.pet.id ?? ''),
          now: new Date(),
        })
      : '';
    const context = activityContext();
    return context ? `${base}\n${context}` : base;
  }

  async function collect(stream: AsyncIterable<{ text: string }>): Promise<string> {
    let text = '';
    for await (const chunk of stream) text += chunk.text;
    return text.trim();
  }

  /** 生成一句；模型没配 / 忙 / 失败时返回 null（忙就等一会儿再试一次：插件的碎碎念可能正占着） */
  async function generate(instruction: string): Promise<string | null> {
    if (!ai.isReady()) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const options = {
          provider: ai.currentSelection().provider,
          model: ai.currentSelection().model,
          system: systemPrompt(),
          messages: [{ role: 'user', content: [{ type: 'text', text: `${instruction}${LINE_RULE}` }] }],
        };
        return (await collect(ai.stream(options))) || null;
      } catch (error) {
        if (attempt === 0 && /busy/i.test(errorText(error))) {
          await delay(4_000);
          continue;
        }
        log(`生成失败：${errorText(error)}`);
        return null;
      }
    }
    return null;
  }

  /** 按指令生成一句并说出来；生成不了就说兜底句 */
  function speak(instruction: string, fallback: string): Promise<void> {
    const next = speaking.then(async () => {
      if (disposed) return;
      await say((await generate(instruction)) ?? fallback);
    });
    speaking = next.catch(() => undefined);
    return next;
  }

  // ---------- 看屏幕 ----------

  async function lookAtScreen(manual: boolean): Promise<{ ok: boolean; text?: string; reason?: string }> {
    if (screenBusy) return { ok: false, reason: 'busy' };
    if (!ai.canSeeLocally()) {
      if (manual) await say('看屏幕要用本机模型哦，先在 AI 设置里填本机地址～');
      return { ok: false, reason: 'not-local' };
    }
    // 自动触发不主动弹系统授权框：没授权就安静跳过；手动触发才去调 getSources（首次会弹授权）
    if (!manual && electron.systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      return { ok: false, reason: 'no-permission' };
    }
    screenBusy = true;
    try {
      // 没授权时 getSources 直接抛「Failed to get sources.」（不是返回空列表），按没授权处理；
      // 授权了还失败才算真错误，交给下面的 catch
      const sources = await electron.desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 1280 } })
        .catch((error: unknown) => {
          if (electron.systemPreferences.getMediaAccessStatus('screen') === 'granted') throw error;
          return [];
        });
      if (electron.systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        if (manual) {
          await say('先在系统设置里给我开「屏幕录制」权限，再重开我哦～');
          void electron.shell.openExternal(SCREEN_SETTINGS_URL);
        }
        return { ok: false, reason: 'no-permission' };
      }
      // 看鼠标所在的那块屏幕
      const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source || source.thumbnail.isEmpty()) return { ok: false, reason: 'capture-failed' };
      const image = 'data:image/jpeg;base64,' + source.thumbnail.toJPEG(70).toString('base64');
      const text = await collect(
        ai.streamVision({
          system: systemPrompt(),
          prompt:
            '这是主人此刻的电脑屏幕截图（画面里那个小女仆就是你自己，别管她）。看看主人在做什么，随口吐槽或关心一句。' +
            '不要复述屏幕上的具体文字、聊天内容、人名、账号或数字，不要描述截图本身。' +
            LINE_RULE,
          image,
        }),
      );
      if (!text) return { ok: false, reason: 'empty' };
      // 宠物被隐藏时插件不让说（pet-not-displayed）：如实报失败，别让调用方以为说出来了
      if (!(await say(text))) return { ok: false, text, reason: 'say-failed' };
      return { ok: true, text };
    } catch (error) {
      log(`看屏幕失败：${errorText(error)}`);
      if (manual) await say('刚才没看清，等会儿再看～');
      return { ok: false, reason: 'error' };
    } finally {
      screenBusy = false;
      lastScreenAt = Date.now();
    }
  }

  // ---------- 采样与定时 ----------

  async function frontApp(): Promise<string | null> {
    try {
      const { stdout: asn } = await run('lsappinfo', ['front'], { timeout: 2_000 });
      const { stdout } = await run('lsappinfo', ['info', '-only', 'name', asn.trim()], { timeout: 2_000 });
      // 输出形如：「"Ghostty" ASN:0x0-0x1234: (in front)」，取第一段引号
      const name = /"([^"]+)"/.exec(stdout)?.[1] ?? null;
      return name && !SELF_APP_NAMES.has(name) ? name : null;
    } catch {
      return null;
    }
  }

  function activityContext(): string {
    return describeActivity(tracker.snapshot(), Date.now());
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    const config = deps.appConfig();
    const events = tracker.update({
      now,
      idleSec: electron.powerMonitor.getSystemIdleTime(),
      locked: electron.powerMonitor.getSystemIdleState(1) === 'locked',
      frontApp: await frontApp(),
    });
    const snap = tracker.snapshot();
    for (const event of events) {
      if (event.type === 'return' && event.awayMs >= config.greetAfterAwayMin * 60_000) {
        void speak(`主人离开电脑 ${durationText(event.awayMs)}，刚刚回来。欢迎主人回来。`, '欢迎回来～');
      }
    }
    const pomodoroEvent = pomodoro.tick(now, snap?.present ?? false);
    if (pomodoroEvent) void announcePomodoro(pomodoroEvent);
    for (const event of health.tick(now, snap, pomodoro.phase() === 'focus')) void announceHealth(event);

    if (
      config.screen.enabled &&
      snap?.present &&
      electron.powerMonitor.getSystemIdleTime() < SCREEN_ACTIVE_IDLE_SEC &&
      pomodoro.phase() !== 'focus' &&
      now - lastScreenAt >= config.screen.intervalMin * 60_000
    ) {
      void lookAtScreen(false);
    }
    await refreshStatus(now);
    await refreshMenu(now);
  }

  function schedule(): void {
    if (disposed) return;
    tickTimer = setTimeout(() => {
      tick()
        .catch((error: unknown) => log(`采样失败：${errorText(error)}`))
        .finally(schedule);
    }, TICK_MS);
  }

  function announcePomodoro(event: PomodoroEvent): Promise<void> {
    const { focusMin, breakMin } = deps.appConfig().pomodoro;
    switch (event) {
      case 'focus-start':
        return speak(`主人开始专注 ${focusMin} 分钟。给主人打打气。`, `专注 ${focusMin} 分钟，加油～`);
      case 'break-start':
        return speak(
          `主人刚专注完一个番茄钟，接下来休息 ${breakMin} 分钟。提醒主人起来活动、喝口水。`,
          `辛苦啦，休息 ${breakMin} 分钟吧～`,
        );
      case 'stopped-away':
        return speak('番茄钟休息结束时主人不在电脑前，番茄钟先停下了。告诉主人一声。', '番茄钟先停下啦～');
    }
  }

  function announceHealth(event: HealthEvent): Promise<void> {
    const snap = tracker.snapshot();
    const sat = snap?.activeSince ? durationText(Date.now() - snap.activeSince) : '很久';
    return event === 'sit'
      ? speak(`主人已经连续坐了 ${sat}。提醒主人站起来活动一下。`, '坐太久啦，起来动一动～')
      : speak('提醒主人喝口水。', '该喝水啦～');
  }

  async function refreshStatus(now: number): Promise<void> {
    const phase = pomodoro.phase();
    const next = composeWorkStatus(
      claude.view(now),
      phase ? { phase, remainingMin: pomodoro.remainingMin(now) } : null,
    );
    if (sameStatus(next, lastStatus)) return;
    try {
      if (next) await petRequest('POST', '/work-status', next);
      else await petRequest('DELETE', '/work-status');
      lastStatus = next;
    } catch (error) {
      log(`写工作状态失败：${errorText(error)}`);
    }
  }

  // ---------- 右键菜单 ----------

  function wantedLabels(now: number): string[] {
    const phase = pomodoro.phase();
    const pomodoroLabel = phase
      ? `停止番茄钟 · ${phase === 'focus' ? '专注' : '休息'}剩 ${pomodoro.remainingMin(now)} 分`
      : MENU_POMODORO_START;
    return [MENU_LOOK, pomodoroLabel];
  }

  async function refreshMenu(now: number, force = false): Promise<void> {
    const labels = wantedLabels(now);
    if (!force && labels.join('\n') === menuLabels.join('\n')) return;
    try {
      const result = await petRequest('POST', '/menu/item', { owner: MENU_OWNER, labels });
      if (result.ok === true) menuLabels = labels;
      else log(`注册菜单失败：${JSON.stringify(result)}`);
    } catch (error) {
      log(`注册菜单失败：${errorText(error)}`);
    }
  }

  async function onMenuClick(label: string): Promise<void> {
    const now = Date.now();
    if (label === MENU_LOOK) {
      await lookAtScreen(true);
    } else if (label === MENU_POMODORO_START) {
      void announcePomodoro(pomodoro.start(now));
    } else if (label.startsWith('停止番茄钟')) {
      pomodoro.stop();
      void say('番茄钟停下啦～');
    }
    await refreshStatus(now);
    await refreshMenu(now);
  }

  /** 长轮询菜单点击（插件单次最多挂 10 秒） */
  async function pollMenu(): Promise<void> {
    while (!disposed) {
      try {
        const url = new URL(deps.petBase + '/menu/events');
        url.searchParams.set('owner', MENU_OWNER);
        url.searchParams.set('wait', '10000');
        const result = (await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()) as {
          ok?: boolean;
          reason?: string;
          events?: Record<string, string | null>;
        };
        if (result.ok !== true) {
          // 宿主重启过 / 被清掉：重新注册
          if (result.reason === 'unknown-owner') await refreshMenu(Date.now(), true);
          else await delay(5_000);
          continue;
        }
        for (const [label, pet] of Object.entries(result.events ?? {})) {
          if (pet !== null) await onMenuClick(label);
        }
      } catch (error) {
        log(`菜单轮询失败：${errorText(error)}`);
        await delay(5_000);
      }
    }
  }

  void refreshMenu(Date.now(), true).then(() => pollMenu());
  void tick()
    .catch((error: unknown) => log(`采样失败：${errorText(error)}`))
    .finally(schedule);

  return {
    activityContext,
    activity: () => tracker.snapshot(),
    async handleClaudeHook(payload) {
      const speech = claude.handle(payload, Date.now());
      await refreshStatus(Date.now());
      if (speech?.kind === 'done') {
        void speak(
          `主人交给 Claude 的活（项目 ${speech.project}）刚刚干完了。叫主人去看看结果。`,
          `${speech.project} 那边干完活啦，去看看吧～`,
        );
      } else if (speech?.kind === 'permission') {
        void speak(`Claude（项目 ${speech.project}）在等主人确认一个操作。提醒主人去确认。`, 'Claude 在等你确认哦～');
      }
    },
    say,
    whisper: () => petRequest('POST', '/whisper'),
    lookAtScreen,
    dispose() {
      disposed = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
