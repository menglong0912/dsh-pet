/**
 * 独立应用的扩展功能编排（只在 `src/app/main.ts` 里启动，DSH 内运行时不存在）。
 *
 * 纯逻辑都在旁边的模块里（activity / reminders / claude-hooks / status，各有单测）；这里只做接线：
 *   - 每 TICK_MS 采样一次：系统空闲秒数与锁屏（Electron powerMonitor）+ 前台应用（`lsappinfo`，无需授权）；
 *   - 根据采样推进番茄钟、久坐 / 喝水 / 下班提醒、回来打招呼、定时看屏幕；
 *   - 与插件的自动碎碎念共用一个节拍（takeWhisperTurn）：看屏幕占它的拍，应用说话时它让一让；
 *   - 把 Claude Code 与番茄钟合成为一个外部工作状态（桌宠只有一个外部槽）；
 *   - 把一天里的事记进宠物日记（diary.ts），第二天回到电脑前时补写前一天的日记；
 *   - 右键「更多」里注册「看看我在干嘛 / 开始·停止番茄钟 / 宠物日记」并长轮询点击。
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
import { dateLabel, Diary, diaryDate } from './diary';
import type { ClaudeHookPayload } from './claude-hooks';
import { HealthReminders, OffWorkReminder, Pomodoro } from './reminders';
import type { HealthEvent, PomodoroEvent } from './reminders';
import { composeWorkStatus, sameStatus } from './status';
import type { WorkStatus } from './status';

const run = promisify(execFile);

/** 采样间隔 */
const TICK_MS = 5_000;
/** 右键菜单的 owner（插件按它归组、按它投递点击；helper 按它把这组项放根菜单，见 main.ts） */
export const MENU_OWNER = 'dsh-pet-app';
const MENU_LOOK = '看看我在干嘛';
const MENU_POMODORO_START = '开始番茄钟';
const MENU_DIARY = '宠物日记';
/** 自动看屏幕要求键鼠最近活动过（秒）：人在看视频 / 发呆时不打扰 */
const SCREEN_ACTIVE_IDLE_SEC = 60;
/** 应用刚说过话这么久内，自动碎碎念让一让（气泡默认显示 10 秒） */
const SPOKE_HOLD_MS = 15_000;
/** 前台是这些应用时视为「取不到」（桌宠自己的窗口被点到前台） */
const SELF_APP_NAMES = new Set(['dsh-pet', 'Electron']);
const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const LINE_RULE = '只说一句话，20 字以内，不加引号，不解释，不提你是 AI。';

/** 表情包池里的一张（插件 GET /memes 的条目） */
interface Meme {
  name: string;
  desc: string;
}

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
  shell: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string> };
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
  /** 看一眼屏幕并吐槽；返回结果说明（给 HTTP 调用方看；image = 配的表情包名） */
  lookAtScreen(manual: boolean): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }>;
  /**
   * 插件自动碎碎念到点时先问这里（ctx.dshPetAppWhisperTurn）：返回 true = 这一拍归应用，插件不说。
   * 到点该看屏幕就用看屏幕代替这句；应用正在 / 刚刚说话就让一让——两种气泡不互相顶掉、不同时抢模型。
   */
  takeWhisperTurn(petId: string): boolean;
  dispose(): void;
}

export interface FeatureDeps {
  electron: FeatureElectron;
  ai: StandaloneAiService;
  configPaths: ConfigPaths;
  appConfig: () => AppConfig;
  /** 宠物日记目录（$DSH_HOME/dsh-pet/diary） */
  diaryDir: string;
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
  const offWork = new OffWorkReminder(() => deps.appConfig().offWork);
  const diary = new Diary(deps.diaryDir, Date.now(), log);
  /** 这一天（日记口径）已经查过要不要补写日记：一天只查一次，补写失败也不每拍重试 */
  let diaryCheckedFor: string | null = null;
  let disposed = false;
  let lastStatus: WorkStatus | null = null;
  let lastScreenAt = Date.now();
  let menuLabels: string[] = [];
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** 说话串行：上一句发出去再生成下一句，免得两个气泡互相顶掉 */
  let speaking: Promise<unknown> = Promise.resolve();
  /** 正在生成要说的话（speak 里），此时碎碎念会撞上模型单飞 */
  let generating = false;
  let screenBusy = false;
  /** 上次成功说话的时间（SPOKE_HOLD_MS 用） */
  let lastSpokeAt = 0;
  /** 插件上次来问碎碎念这一拍的时间：判断自动碎碎念在不在跑 */
  let lastWhisperTurnAt = 0;

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

  /** @param image 配图：表情包池里的名称（插件按池校验） */
  async function say(text: string, image?: string): Promise<boolean> {
    try {
      const result = await petRequest('POST', '/broadcast', { text, anim: true, ...(image ? { image } : {}) });
      if (result.ok !== true) log(`说话失败：${JSON.stringify(result)}`);
      else lastSpokeAt = Date.now();
      return result.ok === true;
    } catch (error) {
      log(`说话失败：${errorText(error)}`);
      return false;
    }
  }

  // ---------- 生成 ----------

  /** 人设 + 名字 + 时间（插件同一套拼装） */
  function personaPrompt(): string {
    const cfg = readAllConfig(deps.configPaths);
    const found = findPetInstance(cfg, petId());
    return found
      ? composeSystemPrompt({
          prompt: petPersona(found.conf, found.pet),
          name: String(found.pet.name ?? ''),
          id: String(found.pet.id ?? ''),
          now: new Date(),
        })
      : '';
  }

  /** 人设 + 主人此刻 */
  function systemPrompt(): string {
    const base = personaPrompt();
    const context = activityContext();
    return context ? `${base}\n${context}` : base;
  }

  async function collect(stream: AsyncIterable<{ text: string }>): Promise<string> {
    let text = '';
    for await (const chunk of stream) text += chunk.text;
    return text.trim();
  }

  /**
   * 生成一句；模型没配 / 忙 / 失败时返回 null（忙就等一会儿再试一次：插件的碎碎念可能正占着）
   * @param rule 接在指令后的写法要求（默认「只说一句话」）
   * @param system 系统提示词（默认人设 + 主人此刻）
   */
  async function generate(instruction: string, rule = LINE_RULE, system?: string): Promise<string | null> {
    if (!ai.isReady()) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const options = {
          provider: ai.currentSelection().provider,
          model: ai.currentSelection().model,
          system: system ?? systemPrompt(),
          messages: [{ role: 'user', content: [{ type: 'text', text: `${instruction}${rule}` }] }],
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
      generating = true;
      let text: string | null;
      try {
        text = await generate(instruction);
      } finally {
        generating = false;
      }
      await say(text ?? fallback);
    });
    speaking = next.catch(() => undefined);
    return next;
  }

  // ---------- 看屏幕 ----------

  /** 看屏幕配图用的表情包池：与碎碎念同一个开关（whisperImageEnabled）、同一个池（插件的 GET /memes）；没开 / 取不到 → 空 */
  async function memePool(): Promise<Meme[]> {
    try {
      const found = findPetInstance(readAllConfig(deps.configPaths), petId());
      if (found?.conf.whisperImageEnabled !== true) return [];
      const result = await petRequest('GET', '/memes');
      if (result.ok !== true || !Array.isArray(result.memes)) {
        log(`取表情包失败：${JSON.stringify(result)}`);
        return [];
      }
      return result.memes as Meme[];
    } catch (error) {
      log(`取表情包失败：${errorText(error)}`);
      return [];
    }
  }

  /** 让模型按这句话从池里挑最搭的一张；它说都不搭、答的不在池里或调用失败 → null */
  async function chooseMeme(text: string, pool: Meme[]): Promise<Meme | null> {
    if (!ai.isReady()) return null;
    try {
      const list = pool.map((meme) => `${meme.name}：${meme.desc}`).join('\n');
      const answer = await collect(
        ai.stream({
          provider: ai.currentSelection().provider,
          model: ai.currentSelection().model,
          system: '你在给一句话挑一张配图的表情包。只回答表情包的名称，不加任何别的字；都不搭就回答：无',
          messages: [
            { role: 'user', content: [{ type: 'text', text: `这句话：${text}\n\n表情包（名称：描述）：\n${list}` }] },
          ],
        }),
      );
      // 模型常会带上引号 / 句号或多说几个字：精确命中优先，否则取答案里出现的最长名称（防「大的要来啦」误中短名）
      const exact = pool.find((meme) => meme.name === answer.replace(/[「」『』"'“”‘’。.\s]/g, ''));
      if (exact) return exact;
      const hits = pool.filter((meme) => answer.includes(meme.name)).sort((a, b) => b.name.length - a.name.length);
      return hits[0] ?? null;
    } catch (error) {
      log(`挑表情包失败：${errorText(error)}`);
      return null;
    }
  }

  /**
   * 给看屏幕说的话配图：先按话挑最搭的一张，挑不出就随机一张；池为空（含没开配图）不配。
   * 话先说、图后配：试过先抽图再把图的描述写进看屏幕指令，本机小模型会顺着表情包名字发挥
   * （「大的要来啦」→「大事要来啦，主人快躲开」），看屏幕就成了看表情包。
   */
  async function memeFor(text: string): Promise<Meme | null> {
    const pool = await memePool();
    if (pool.length === 0) return null;
    const chosen = await chooseMeme(text, pool);
    const meme = chosen ?? pool[Math.floor(Math.random() * pool.length)];
    log(`看屏幕配图：${meme.name}（${chosen ? '按话挑' : '随机'}）`);
    return meme;
  }

  async function lookAtScreen(
    manual: boolean,
  ): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }> {
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
      const meme = await memeFor(text);
      // 宠物被隐藏时插件不让说（pet-not-displayed）：如实报失败，别让调用方以为说出来了
      if (!(await say(text, meme?.name))) return { ok: false, text, reason: 'say-failed' };
      diary.note(Date.now(), 'screen', `看了一眼主人的屏幕，说：「${text}」`);
      return { ok: true, text, ...(meme ? { image: meme.name } : {}) };
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
    diary.tick(now, snap);
    for (const event of events) {
      if (event.type === 'return' && event.awayMs >= config.greetAfterAwayMin * 60_000) {
        diary.note(now, 'return', `主人离开电脑 ${durationText(event.awayMs)}后回来了`);
        void speak(`主人离开电脑 ${durationText(event.awayMs)}，刚刚回来。欢迎主人回来。`, '欢迎回来～');
      }
    }
    const pomodoroEvent = pomodoro.tick(now, snap?.present ?? false);
    if (pomodoroEvent === 'break-start') {
      diary.note(now, 'pomodoro', `主人专注完一个 ${config.pomodoro.focusMin} 分钟的番茄钟`);
    }
    if (pomodoroEvent) void announcePomodoro(pomodoroEvent);
    for (const event of health.tick(now, snap, pomodoro.phase() === 'focus')) {
      diary.note(now, event, event === 'sit' ? '提醒主人起来活动一下' : '提醒主人喝水');
      void announceHealth(event);
    }
    const offWorkLeft = offWork.tick(now, snap?.present ?? false, pomodoro.phase() === 'focus');
    if (offWorkLeft !== null) {
      diary.note(now, 'off-work', offWorkLeft > 0 ? '提醒主人快下班了' : '过了下班时间主人还在电脑前，提醒主人下班');
      void announceOffWork(offWorkLeft);
    }
    // 新的一天主人回到电脑前（专注时不打扰）：补写前一天的日记
    if (snap?.present && pomodoro.phase() !== 'focus' && diaryCheckedFor !== diaryDate(now)) {
      diaryCheckedFor = diaryDate(now);
      const date = diary.pending(now);
      if (date) void catchUpDiary(date).catch((error: unknown) => log(`宠物日记：补写失败：${errorText(error)}`));
    }

    // 自动碎碎念在跑时，看屏幕占它让出的那一拍（takeWhisperTurn），不另起一路；没在跑才自己按间隔看
    if (!whisperRunning(now) && screenDue(now)) void lookAtScreen(false);
    await refreshStatus(now);
    await refreshMenu(now);
  }

  /**
   * 到点该自动看屏幕：开着、人在且 activeIdleSec 内碰过键鼠、不在专注、离上次够间隔、能看（本机模型 + 已授权）
   * @param activeIdleSec 「最近碰过键鼠」的窗口（秒）
   */
  function screenDue(now: number, activeIdleSec = SCREEN_ACTIVE_IDLE_SEC): boolean {
    const config = deps.appConfig();
    return (
      config.screen.enabled &&
      tracker.snapshot()?.present === true &&
      electron.powerMonitor.getSystemIdleTime() < activeIdleSec &&
      pomodoro.phase() !== 'focus' &&
      now - lastScreenAt >= config.screen.intervalMin * 60_000 &&
      !screenBusy &&
      ai.canSeeLocally() &&
      electron.systemPreferences.getMediaAccessStatus('screen') === 'granted'
    );
  }

  /** 插件的自动碎碎念周期（秒，与插件同口径：至少 60 秒） */
  function whisperPeriodSec(): number {
    return Math.max(60, ai.getSettings().whisperIntervalSec);
  }

  /** 插件的自动碎碎念在跑：最近两个周期内来问过拍 */
  function whisperRunning(now: number): boolean {
    return now - lastWhisperTurnAt <= 2 * whisperPeriodSec() * 1000;
  }

  function takeWhisperTurn(id: string): boolean {
    if (id !== petId()) return false;
    const now = Date.now();
    lastWhisperTurnAt = now;
    // 拍与拍之间可能隔好几分钟，「碰过键鼠」放宽到这一拍以来：看视频 / 发呆一整拍仍然不看，
    // 但不会因为恰好在这一拍的瞬间停手了一分钟就错过（只按 60 秒卡，长间隔下几乎轮不到看屏幕）
    if (screenDue(now, Math.max(SCREEN_ACTIVE_IDLE_SEC, whisperPeriodSec()))) {
      void lookAtScreen(false);
      return true;
    }
    return screenBusy || generating || now - lastSpokeAt < SPOKE_HOLD_MS;
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

  /** @param left 离下班还剩几分钟（≤ 0 = 已经过了） */
  function announceOffWork(left: number): Promise<void> {
    const { time } = deps.appConfig().offWork;
    return left > 0
      ? speak(
          `再过 ${left} 分钟就到主人的下班时间 ${time} 了。提醒主人收拾收拾，准备下班。`,
          `还有 ${left} 分钟下班啦～`,
        )
      : speak(`已经过了主人的下班时间 ${time}，主人还在电脑前。提醒主人收拾一下准备下班。`, '到点啦，该下班啦～');
  }

  // ---------- 宠物日记 ----------

  /**
   * 写某一天的日记并存下（排进说话队列：与说话串行用模型，生成期间碎碎念让一让）
   * @returns written = 写好了；too-short = 这一天在电脑前太短不写；failed = 模型没配 / 失败
   */
  function writeDiary(date: string): Promise<'written' | 'too-short' | 'failed'> {
    const next = speaking.then(async () => {
      const instruction = diary.instruction(date);
      if (!instruction) return 'too-short' as const;
      generating = true;
      let text: string | null;
      try {
        // 日记写的是一整天：不带「主人此刻」
        text = await generate(instruction, '', personaPrompt());
      } finally {
        generating = false;
      }
      if (!text) return 'failed' as const;
      diary.write(date, text, Date.now());
      log(`宠物日记：写好了 ${date}`);
      return 'written' as const;
    });
    speaking = next.catch(() => undefined);
    return next;
  }

  async function catchUpDiary(date: string): Promise<void> {
    if ((await writeDiary(date)) !== 'written') {
      log(`宠物日记：补写 ${date} 没写成`);
      return;
    }
    const label = dateLabel(date);
    await speak(
      `你把${label}的日记写好了。告诉主人一声，让主人右键「宠物日记」翻翻看。`,
      `${label}的日记写好啦，右键「宠物日记」翻翻看～`,
    );
  }

  /** 右键「宠物日记」：先写一篇今天到目前为止的，再打开日记本 */
  async function openDiary(now: number): Promise<void> {
    void say('等我写写今天的日记～');
    const result = await writeDiary(diaryDate(now));
    if (result === 'failed') await say('今天的日记没写成，等会儿再试试～');
    if (!diary.hasIndex()) {
      if (result === 'too-short') await say('今天还没陪主人多久，没什么可写的～');
      return;
    }
    const error = await electron.shell.openPath(diary.indexPath());
    if (error) log(`打开日记失败：${error}`);
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
    return [MENU_LOOK, pomodoroLabel, MENU_DIARY];
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
    } else if (label === MENU_DIARY) {
      await openDiary(now);
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
        diary.note(Date.now(), 'claude', `主人交给 Claude 的活（项目 ${speech.project}）干完了`);
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
    takeWhisperTurn,
    dispose() {
      disposed = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
      diary.flush(Date.now());
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
