/**
 * 独立应用的扩展功能编排（只在 `src/app/main.ts` 里启动，DSH 内运行时不存在）。
 *
 * 纯逻辑都在旁边的模块里（activity / reminders / claude-hooks / status，各有单测）；这里只做接线：
 *   - 每 TICK_MS 采样一次：系统空闲秒数与锁屏（Electron powerMonitor）+ 前台应用（`lsappinfo`，无需授权）；
 *   - 根据采样推进久坐 / 喝水 / 下班提醒、回来打招呼、定时看屏幕；
 *   - 与插件的自动碎碎念共用一个节拍（takeWhisperTurn）：看屏幕占它的拍，应用说话时它让一让；
 *   - 把 Claude Code 与串门合成为一个外部工作状态（桌宠只有一个外部槽）；
 *   - 把一天里的事记进宠物日记（diary.ts），第二天回到电脑前时补写前一天的日记；
 *   - 局域网串门（visit.ts 管网络、visit-windows.ts 管窗口、visit-talk.ts 管怎么聊）：设置里开了才发信标、开接待端口；
 *     出门时自家宠物变半透明、把别人家的聊天转播回来，客人来了在自家宠物旁边开个小窗（能摸、能一起玩）；
 *     两边接着前文聊、主人家也会起话题；串门的台词只按人设生成，不带「主人此刻」；
 *     开着串门时，用餐时间宠物也分到一份零食（snacks.ts，晚上偶尔有宵夜），家里来客时请它吃；
 *   - 右键菜单根上注册「看看我在干嘛 / 宠物日记」与串门的项（「串门」子菜单列附近的邻居，
 *     有人敲门时的应答项、送客 / 回家项），并长轮询点击。
 *
 * 驱动桌宠一律走插件自己的 HTTP 路由（/broadcast、/work-status、/menu/*），与第三方调用者同一契约，
 * 不碰插件内部状态——以后合并上游时这里不受插件内部重构影响。
 *
 * 说话的文本由本机模型按人设生成（人设 + 时间 + 「主人此刻」），模型不可用时用固定兜底句；
 * 看屏幕没有兜底句：看不了就明确说看不了（手动触发时）或安静跳过（自动触发时）。
 */
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
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
import { HealthReminders, OffWorkReminder } from './reminders';
import { findSnack, SnackPouch } from './snacks';
import type { Snack } from './snacks';
import type { HealthEvent } from './reminders';
import { composeWorkStatus, sameStatus } from './status';
import type { WorkStatus } from './status';
import { cleanText, knockOn, LINE_MAX, NAME_MAX, Neighborhood, PING_MS, tripRequest, VisitHost } from './visit';
import type { HostEvent, HostHandlers, KnockAnswer, KnockFailure, Neighbor, TripReply, Visitor } from './visit';
import { loadVisitIdentity } from './visit-identity';
import {
  findPlayThing,
  GUEST_ANSWERS,
  GUEST_ASK,
  guestPrompt,
  HOST_ASK,
  HOST_OPENERS,
  hostPrompt,
  NUDGE_GAP_MS,
  openerGap,
  PLAY_THINGS,
  QUIET_MS,
  talkGap,
  travelPrompt,
  tripRounds,
} from './visit-talk';
import type { PlayThing } from './visit-talk';
import { AWAY_OPACITY, fadeHome, openGuestWindow, RELAY_OPACITY, watchHomePet } from './visit-windows';
import type { GuestWindow, Rect, WindowElectron } from './visit-windows';

const run = promisify(execFile);

/** 采样间隔 */
const TICK_MS = 5_000;
/** 右键菜单的 owner（插件按它归组、按它投递点击；helper 按它把这组项放根菜单，见 main.ts） */
export const MENU_OWNER = 'dsh-pet-app';
const MENU_LOOK = '看看我在干嘛';
const MENU_DIARY = '宠物日记';
/** 「串门」子菜单：label 带这个前缀加「/」的项，helper 收成根菜单上的一个子菜单（shared/menu 的 buildAppMenuNodes） */
const MENU_VISIT_GROUP = '串门';
/** 插件每个 owner 最多 20 项：根上固定 2 项，邻居最多列这么多（家里有客时换成送客 + 一起玩 + 请吃零食，至多 16 项） */
const MENU_NEIGHBORS_MAX = 15;
/** 做客时转播回自家的气泡显示多久（窗口同时调亮这么久） */
const RELAY_MS = 8_000;
/** 转播的气泡每条至少显示这么久才换下一条：对方回话快时，自己说的那句也看得清 */
const RELAY_MIN_MS = 4_000;
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

/** 自家宠物正在别人家做客 */
interface Trip {
  host: Neighbor;
  token: string;
  /** 进门时验上了主人家的身份（旧对端不带签名时 false：只当串了个门，不当熟人） */
  verified: boolean;
  since: number;
  /** 聊过的话（「你：…」「小鱼：…」「（一起吃西瓜）」），接着聊、回家讲见闻用 */
  lines: string[];
  /** 最近一句（谁说的都算）的时间：刚有人说过话就先不开口 */
  lastLineAt: number;
  /** 自己开口说过几句（送没送到都算） */
  rounds: number;
  /** 回过几次对方捎来的事（GUEST_ANSWERS 封顶） */
  answers: number;
  /** 在对方家吃到的零食（回家记日记） */
  treats: string[];
  /** 说话按趟串行：上一句的回话到了再说下一句 */
  queue: Promise<void>;
  /** 连着几次报平安没送到 */
  failures: number;
  pinging: boolean;
  /** 下一句的定时器 */
  talkTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval>;
}

/** 来自家做客的客人 */
interface Hosting {
  visitor: Visitor;
  window: GuestWindow;
  since: number;
  /** 聊过的话（「你：…」是自家宠物，「小鱼：…」是客人），回话接前文用 */
  lines: string[];
  /** 最近一句（谁说的都算）的时间：刚有人说过话就先不起新话题 */
  lastLineAt: number;
  /** 主动起过几次话题（HOST_OPENERS 封顶） */
  openers: number;
  /** 上次把摸一下 / 一起玩捎给客人的时间（NUDGE_GAP_MS） */
  lastNudgeAt: number;
  openerTimer: ReturnType<typeof setTimeout> | null;
}

/** 回家的原因：到点 / 主人叫回（含家里有话要说、关了串门、退出）/ 被对方请回 / 失联 */
type HomeReason = 'time-up' | 'called' | 'sent-home' | 'lost';
/** 一句没聊上就回家时，回家的经过（照实说：不写清楚小模型会自己编，比如「门锁着」） */
const HOME_WITHOUT_CHAT: Record<HomeReason, string> = {
  'time-up': '待到点就回来了，没聊上话',
  called: '刚进门家里就有事，先回来了',
  'sent-home': '刚进门就被它家主人请回来了',
  lost: '突然连不上它家，只好回来了',
};

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
    getDisplayNearestPoint(point: { x: number; y: number }): { id: number; workArea: Rect };
  };
  systemPreferences: { getMediaAccessStatus(mediaType: 'screen'): string };
  shell: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string> };
  BrowserWindow: WindowElectron['BrowserWindow'];
  ipcMain: WindowElectron['ipcMain'];
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
  /** 零食袋文件（$DSH_HOME/dsh-pet/snacks.json） */
  snackPath: string;
  /** 串门身份文件（$DSH_HOME/dsh-pet/visit-identity.json） */
  identityPath: string;
  /** 插件路由前缀的完整地址，如 http://127.0.0.1:53624/dsh-pet-7340 */
  petBase: string;
  log: (message: string) => void;
}

export function startAppFeatures(deps: FeatureDeps): AppFeatures {
  const { electron, ai, log } = deps;
  const tracker = new ActivityTracker();
  const claude = new ClaudeSessions();
  const health = new HealthReminders(() => deps.appConfig());
  const offWork = new OffWorkReminder(() => deps.appConfig().offWork);
  const diary = new Diary(deps.diaryDir, Date.now(), log);
  const pouch = new SnackPouch(deps.snackPath, log);
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
  /** 串门身份（每台电脑一对密钥，重启不变）：信标 id、敲门签名、应答签名都用它 */
  const visitIdentity = loadVisitIdentity(deps.identityPath, (message) => log(`串门：${message}`));
  /** 串门网络：信标（总开关开着、接待或出门开了任一项时有）与接待端口（允许别人来时有） */
  let neighborhood: Neighborhood | null = null;
  let visitHost: VisitHost | null = null;
  let hostPort = 0;
  /** 串门网络正在开 / 关（异步），这期间不重复开关 */
  let visitSwitching = false;
  /** 开串门网络失败过（端口被占等）：关掉再打开串门之前不再每拍重试、刷日志 */
  let visitBroken = false;
  /** 正在敲谁家的门（等对方主人答复） */
  let knockingOn: Neighbor | null = null;
  /** 自家宠物正在别人家做客 */
  let trip: Trip | null = null;
  /** 来自家做客的客人 */
  let hosting: Hosting | null = null;
  /** 转播结束后把自家宠物调回半透明的定时器 */
  let relayTimer: ReturnType<typeof setTimeout> | null = null;
  /** 下一条转播最早什么时候能顶掉上一条（RELAY_MIN_MS） */
  let relayFreeAt = 0;
  /** 自家宠物在哪（客人站它旁边） */
  const homePet = watchHomePet(electron);

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
    // 出门在外时家里有话要说（提醒、看屏幕、Claude……）：先回家再说
    if (trip) await comeHome('called');
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

  /**
   * 按人设生成一句、不说出来，排进说话队列（与说话串行用模型）；生成不了用兜底句。
   * 串门的台词会发到别人电脑上：只用人设，不带「主人此刻」。
   */
  function compose(instruction: string, fallback: string): Promise<string> {
    const next = speaking.then(async () => {
      generating = true;
      try {
        return (await generate(instruction, LINE_RULE, personaPrompt())) ?? fallback;
      } catch (error) {
        log(`生成失败：${errorText(error)}`);
        return fallback;
      } finally {
        generating = false;
      }
    });
    speaking = next.catch(() => undefined);
    return next;
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
    for (const event of health.tick(now, snap)) {
      diary.note(now, event, event === 'sit' ? '提醒主人起来活动一下' : '提醒主人喝水');
      void announceHealth(event);
    }
    const offWorkLeft = offWork.tick(now, snap?.present ?? false);
    if (offWorkLeft !== null) {
      diary.note(now, 'off-work', offWorkLeft > 0 ? '提醒主人快下班了' : '过了下班时间主人还在电脑前，提醒主人下班');
      void announceOffWork(offWorkLeft);
    }
    // 零食只用来请来串门的客人吃：开着串门才攒；出门在外时悄悄收进袋子，不为这个叫它回家
    const served = config.visit.enabled ? pouch.tick(now, snap?.present ?? false) : null;
    if (served) {
      const { meal, snack } = served;
      diary.note(now, 'snack', `${meal}时间分到一份${snack.label}，收进了零食袋`);
      if (!trip) {
        void speak(
          `到${meal}时间了，你也分到一份${snack.label}，收进零食袋，留着请来串门的小伙伴吃。跟主人说一声。`,
          `${meal}时间～我分到一份${snack.label}，留着请客人吃～`,
        );
      }
    }
    // 新的一天主人回到电脑前：补写前一天的日记
    if (snap?.present && diaryCheckedFor !== diaryDate(now)) {
      diaryCheckedFor = diaryDate(now);
      const date = diary.pending(now);
      if (date) void catchUpDiary(date).catch((error: unknown) => log(`宠物日记：补写失败：${errorText(error)}`));
    }

    // 自动碎碎念在跑时，看屏幕占它让出的那一拍（takeWhisperTurn），不另起一路；没在跑才自己按间隔看
    if (!whisperRunning(now) && screenDue(now)) void lookAtScreen(false);
    await syncVisit();
    await refreshStatus(now);
    await refreshMenu();
  }

  /**
   * 到点该自动看屏幕：开着、没出门、人在且 activeIdleSec 内碰过键鼠、离上次够间隔、能看（本机模型 + 已授权）
   * @param activeIdleSec 「最近碰过键鼠」的窗口（秒）
   */
  function screenDue(now: number, activeIdleSec = SCREEN_ACTIVE_IDLE_SEC): boolean {
    const config = deps.appConfig();
    return (
      config.screen.enabled &&
      trip === null &&
      tracker.snapshot()?.present === true &&
      electron.powerMonitor.getSystemIdleTime() < activeIdleSec &&
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
    // 出门在外：家里只剩个半透明的影子，不碎碎念
    if (trip) return true;
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
    const stayMs = deps.appConfig().visit.stayMin * 60_000;
    const next = composeWorkStatus(
      claude.view(now),
      trip
        ? { owner: trip.host.owner, remainingMin: Math.max(1, Math.ceil((trip.since + stayMs - now) / 60_000)) }
        : null,
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

  // ---------- 串门 ----------

  /** 邻居看到的主人昵称：设置里填的，没填用登录用户名 */
  function nickname(): string {
    let fallback = '';
    try {
      fallback = userInfo().username;
    } catch {
      // 取不到登录用户名（极少见）：下面按「主人」
    }
    return cleanText(deps.appConfig().visit.nickname || fallback, NAME_MAX) || '主人';
  }

  function petName(): string {
    try {
      const found = findPetInstance(readAllConfig(deps.configPaths), petId());
      return cleanText(String(found?.pet.name ?? ''), NAME_MAX) || '桌宠';
    } catch {
      return '桌宠';
    }
  }

  /**
   * 按设置开 / 关串门的两块网络（每拍查一次：设置页改了下一拍生效）：
   * 接待端口跟「允许别人来」走；信标（听邻居；接待时也报自己）在总开关开着、接待或出门开了任一项时开着。
   * 不许出门了，在外的宠物直接回家。
   */
  async function syncVisit(): Promise<void> {
    const { enabled, hosting, visiting } = deps.appConfig().visit;
    if (!enabled) visitBroken = false;
    if (visitSwitching || visitBroken) return;
    const wantHost = enabled && hosting;
    const wantNeighborhood = enabled && (hosting || visiting);
    visitSwitching = true;
    try {
      if (trip && !(enabled && visiting)) await comeHome('called');
      if (wantHost && !visitHost) await openHost();
      if (!wantHost && visitHost) await closeHost();
      if (wantNeighborhood && !neighborhood) await openNeighborhood();
      if (!wantNeighborhood && neighborhood) {
        neighborhood.stop();
        neighborhood = null;
        log('串门：信标关了');
      }
    } finally {
      visitSwitching = false;
    }
  }

  async function openHost(): Promise<void> {
    const host = new VisitHost(hostHandlers, { log, identity: visitIdentity });
    try {
      hostPort = await host.listen();
    } catch (error) {
      visitBroken = true;
      log(`串门：接待端口开不了：${errorText(error)}`);
      return;
    }
    visitHost = host;
    log(`串门：接待开了，端口 ${hostPort}`);
  }

  /** 关接待：家里的客人窗口直接关掉（客人下次报平安时知道自己该回家了） */
  async function closeHost(): Promise<void> {
    if (hosting && hosting.openerTimer !== null) clearTimeout(hosting.openerTimer);
    hosting?.window.close(0);
    hosting = null;
    const host = visitHost;
    visitHost = null;
    await host?.close();
    log('串门：接待关了');
  }

  async function openNeighborhood(): Promise<void> {
    const hood = new Neighborhood({
      id: visitIdentity.id,
      // 不接待客人时只听不发：别人看不到自己，自己照样能出门
      announce: () => (visitHost ? { owner: nickname(), pet: petName(), port: hostPort } : null),
      log,
    });
    try {
      await hood.start();
    } catch (error) {
      visitBroken = true;
      log(`串门：信标端口开不了：${errorText(error)}`);
      return;
    }
    neighborhood = hood;
    log('串门：信标开了');
  }

  /** 串门的一句台词：开了「串门时用模型聊天」就按人设生成，没开用固定句 */
  function visitLine(instruction: string, fallback: string): Promise<string> {
    return deps.appConfig().visit.chat ? compose(instruction, fallback) : Promise.resolve(fallback);
  }

  /** 接待这一侧：VisitHost 收到敲门、说话、告辞时来问这里 */
  const hostHandlers: HostHandlers = {
    canHost: () => trip === null && knockingOn === null,
    knocked(visitor) {
      log(`串门：${visitor.owner}（${visitor.address}）家的 ${visitor.pet} 来敲门`);
      void say(`${visitor.owner} 家的 ${visitor.pet} 来敲门啦，右键点「让 ${visitor.pet} 进来」请它进门～`);
      void refreshMenu();
    },
    knockEnded(visitor, reason) {
      log(`串门：${visitor.owner} 家的 ${visitor.pet} ${reason === 'gone' ? '不等了' : '敲门没等到答复'}`);
      void refreshMenu();
    },
    async line(visitor, text) {
      const current = hosting?.visitor === visitor ? hosting : null;
      current?.window.say(text);
      const lines = current?.lines ?? [];
      lines.push(`${visitor.pet}：${text}`);
      if (current) current.lastLineAt = Date.now();
      const reply = cleanText(
        await visitLine(hostPrompt(visitor.owner, visitor.pet, lines, HOST_ASK.answer), '欢迎来玩呀～'),
        LINE_MAX,
      );
      lines.push(`你：${reply}`);
      if (current) current.lastLineAt = Date.now();
      await say(reply);
      return reply;
    },
    left(visitor, reason, text) {
      seeGuestOff(
        visitor,
        text,
        reason === 'lost' ? `${visitor.pet} 突然不见了，可能回家了～` : `${visitor.pet} 回家啦，下次再来玩～`,
      );
    },
  };

  /** 主人答复敲门 */
  function letIn(accept: boolean): void {
    const visitor = visitHost?.answer(accept);
    if (!visitor) return;
    if (!accept) {
      void say(`好，那就不让 ${visitor.pet} 进来啦～`);
      return;
    }
    log(`串门：${visitor.owner} 家的 ${visitor.pet} 进门了`);
    const now = Date.now();
    const current: Hosting = {
      visitor,
      window: openGuestWindow(
        electron,
        `${new URL(deps.petBase).origin}/app/guest`,
        `${visitor.owner} 家的 ${visitor.pet}`,
        homePet.box,
        () => pokeGuest(current),
      ),
      since: now,
      lines: [],
      lastLineAt: now,
      openers: 0,
      lastNudgeAt: 0,
      openerTimer: null,
    };
    hosting = current;
    if (deps.appConfig().visit.chat) current.openerTimer = setTimeout(() => void openTopic(current), openerGap(true));
  }

  /** 主人家起个新话题：自家宠物说出来，攒着等客人报平安时捎过去，客人那边会回一句 */
  async function openTopic(current: Hosting): Promise<void> {
    current.openerTimer = null;
    if (hosting !== current || !deps.appConfig().visit.chat) return;
    const quiet = Date.now() - current.lastLineAt;
    if (quiet < QUIET_MS) {
      current.openerTimer = setTimeout(() => void openTopic(current), QUIET_MS - quiet);
      return;
    }
    current.openers += 1;
    const { owner, pet } = current.visitor;
    // 生成不了就不起话题（没有兜底句：固定的开场白聊不下去）
    const text = cleanText(await compose(hostPrompt(owner, pet, current.lines, HOST_ASK.opener), ''), LINE_MAX);
    if (hosting !== current || !text) return;
    current.lines.push(`你：${text}`);
    current.lastLineAt = Date.now();
    visitHost?.tell({ type: 'line', text });
    await say(text);
    if (hosting === current && current.openers < HOST_OPENERS) {
      current.openerTimer = setTimeout(() => void openTopic(current), openerGap(false));
    }
  }

  /** 主人摸了客人一下（客人窗口里它自己先笑了）：隔一会儿才捎一次，客人家那边回句话 */
  function pokeGuest(current: Hosting): void {
    if (hosting !== current || Date.now() - current.lastNudgeAt < NUDGE_GAP_MS) return;
    current.lastNudgeAt = Date.now();
    current.lines.push(`（主人摸了摸 ${current.visitor.pet}）`);
    visitHost?.tell({ type: 'poke' });
  }

  /** 和客人一起玩：两只宠物同时播同一段动画（自家宠物转身面朝客人），客人家那边说一句 */
  async function playTogether(thing: PlayThing): Promise<void> {
    const current = hosting;
    if (!current) return;
    current.window.play(thing.anim);
    current.lines.push(`（一起${thing.label}）`);
    if (Date.now() - current.lastNudgeAt >= NUDGE_GAP_MS) {
      current.lastNudgeAt = Date.now();
      visitHost?.tell({ type: 'play', what: thing.label });
    }
    try {
      // 客人站左边就朝左（素材原样朝左），站右边朝右
      const result = await petRequest('POST', '/anim', { name: thing.anim, facing: current.window.side });
      if (result.ok !== true) log(`串门：一起玩没播成：${JSON.stringify(result)}`);
    } catch (error) {
      log(`串门：一起玩没播成：${errorText(error)}`);
    }
  }

  /** 请客人吃零食：从零食袋里拿一份，客人窗口吃起来，客人家那边说一句、记进它的日记 */
  function treatGuest(snack: Snack): void {
    const current = hosting;
    if (!current || !pouch.take(snack.label)) return;
    const { owner, pet } = current.visitor;
    current.window.play(snack.anim);
    current.lines.push(`（请 ${pet} 吃了${snack.label}）`);
    visitHost?.tell({ type: 'gift', what: snack.label });
    diary.note(Date.now(), 'visit', `请 ${owner} 家的 ${pet} 吃了${snack.label}`);
  }

  function sendGuestHome(): void {
    const visitor = visitHost?.sendHome();
    if (visitor) seeGuestOff(visitor, '那我先回家啦～', `${visitor.pet} 回家啦～`);
  }

  /** 送客：客人窗口说完告别的话、挥挥手再关，自家宠物说一句，记进日记 */
  function seeGuestOff(visitor: Visitor, farewell: string, line: string): void {
    const current = hosting;
    hosting = null;
    if (current) {
      if (current.openerTimer !== null) clearTimeout(current.openerTimer);
      if (farewell) current.window.say(farewell);
      current.window.wave();
      current.window.close(5_000);
    }
    log(`串门：${visitor.owner} 家的 ${visitor.pet} 走了`);
    diary.note(
      Date.now(),
      'visit',
      `${visitor.owner} 家的宠物 ${visitor.pet} 来串门，待了 ${durationText(Date.now() - (current?.since ?? Date.now()))}`,
    );
    void say(line);
    void refreshMenu();
  }

  /**
   * 串门相关的右键项（随状态变）：label → 点了做什么。
   * 有人敲门、家里有客、自己在外时放对应的应答项；都没有、又允许出门时放「串门」子菜单列附近的邻居
   * （敲门等答复期间不列，免得一边敲门一边又出门）。
   */
  function visitActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    const knocking = visitHost?.knocking();
    const guest = visitHost?.guest();
    const { enabled, visiting } = deps.appConfig().visit;
    if (knocking) {
      actions.set(`让 ${knocking.pet} 进来`, () => letIn(true));
      actions.set(`不让 ${knocking.pet} 进来`, () => letIn(false));
    } else if (guest) {
      actions.set(`请 ${guest.pet} 回家`, sendGuestHome);
      for (const thing of PLAY_THINGS) actions.set(`和 ${guest.pet} 一起玩/${thing.label}`, () => playTogether(thing));
      for (const snack of pouch.kinds()) actions.set(`请 ${guest.pet} 吃/${snack.label}`, () => treatGuest(snack));
    } else if (trip) {
      actions.set(`从 ${trip.host.owner} 家回来`, () => comeHome('called'));
    } else if (enabled && visiting && knockingOn === null) {
      const neighbors = (neighborhood?.list() ?? []).slice(0, MENU_NEIGHBORS_MAX);
      for (const neighbor of neighbors) {
        let label = `${MENU_VISIT_GROUP}/去 ${neighbor.owner} 家`;
        for (let n = 2; actions.has(label); n += 1) label = `${MENU_VISIT_GROUP}/去 ${neighbor.owner} 家（${n}）`;
        actions.set(label, () => goVisit(neighbor.id));
      }
      // 没有邻居也留个入口：不然开了串门，右键里一点痕迹都没有
      if (neighbors.length === 0) {
        actions.set(`${MENU_VISIT_GROUP}/附近还没有邻居`, () =>
          say('附近还没发现开着串门的桌宠～同一网络里的同事也打开串门就能看到啦'),
        );
      }
    }
    return actions;
  }

  /** 出门：先敲门，对方主人点头了才进门 */
  async function goVisit(id: string): Promise<void> {
    const neighbor = neighborhood?.get(id);
    if (!neighbor) {
      await say('它好像已经不在附近了～');
      return;
    }
    if (trip || knockingOn || visitHost?.guest() || visitHost?.knocking() || !deps.appConfig().visit.visiting) return;
    knockingOn = neighbor;
    void refreshMenu();
    void say(`我去 ${neighbor.owner} 家敲门啦～`);
    let answer: KnockAnswer | null;
    try {
      answer = await knockOn(neighbor, { owner: nickname(), pet: petName() }, visitIdentity, neighbor.id);
    } catch (error) {
      // fetch 只说「fetch failed」，真正的原因（没授权本地网络时是 EHOSTUNREACH）在 cause 里
      const cause = (error as { cause?: unknown }).cause;
      log(
        `串门：敲 ${neighbor.owner}（${neighbor.address}）家的门失败：${errorText(error)}${cause ? `（${errorText(cause)}）` : ''}`,
      );
      answer = null;
    } finally {
      knockingOn = null;
    }
    if (!answer?.ok) {
      await say(knockFailText(neighbor.owner, answer ? answer.reason : 'unreachable'));
      return;
    }
    // 等答复期间关了串门 / 不许出门了 / 退出了：进门就告辞
    const { enabled, visiting } = deps.appConfig().visit;
    if (!enabled || !visiting || disposed) {
      void tripRequest(neighbor, '/v1/leave', { token: answer.token, text: '' }).catch(() => undefined);
      return;
    }
    startTrip(neighbor, answer.token, answer.verified);
  }

  /** @param verified 进门应答的签名验证过了：这一家确实是对着自己信标里那个 id 的门（T4 记邻居、T7 捎话以此为前提） */
  function startTrip(host: Neighbor, token: string, verified: boolean): void {
    const current: Trip = {
      host,
      token,
      verified,
      since: Date.now(),
      lines: [],
      lastLineAt: Date.now(),
      rounds: 0,
      answers: 0,
      treats: [],
      queue: Promise.resolve(),
      failures: 0,
      pinging: false,
      talkTimer: null,
      pingTimer: setInterval(() => void pingTrip(current), PING_MS),
    };
    trip = current;
    fadeHome(electron, AWAY_OPACITY);
    log(`串门：进了 ${host.owner} 家的门`);
    current.talkTimer = setTimeout(() => void talk(current), 3_000);
    void refreshStatus(Date.now());
    void refreshMenu();
  }

  /** 做客时自己开口：头一句打招呼，之后隔 30–90 秒接着聊（刚有人说过话就再等等），说满 tripRounds 句就只回不说 */
  async function talk(current: Trip): Promise<void> {
    current.talkTimer = null;
    if (trip !== current) return;
    const quiet = Date.now() - current.lastLineAt;
    if (current.rounds > 0 && quiet < QUIET_MS) {
      current.talkTimer = setTimeout(() => void talk(current), QUIET_MS - quiet);
      return;
    }
    const first = current.rounds === 0;
    current.rounds += 1;
    await chatTrip(
      current,
      first ? GUEST_ASK.greet : GUEST_ASK.follow,
      first ? `${current.host.pet}，我来串门啦～` : '你家真舒服呀～',
    );
    // 不用模型聊天时只打个招呼
    const { chat, stayMin } = deps.appConfig().visit;
    if (trip === current && current.rounds < (chat ? tripRounds(stayMin) : 1)) {
      current.talkTimer = setTimeout(() => void talk(current), talkGap());
    }
  }

  /** 做客时说一句（按趟串行）：生成、转播回自家、说给对方听，记下对方的回话 */
  function chatTrip(current: Trip, ask: string, fallback: string): Promise<void> {
    const next = current.queue.then(async () => {
      if (trip !== current) return;
      const { owner, pet } = current.host;
      const text = cleanText(await visitLine(guestPrompt(owner, pet, current.lines, ask), fallback), LINE_MAX);
      if (trip !== current) return;
      current.lastLineAt = Date.now();
      relay(`（在 ${owner} 家）${text}`);
      let result: TripReply | null = null;
      try {
        result = await tripRequest(current.host, '/v1/chat', { token: current.token, text });
      } catch (error) {
        // 没送到：不算失联（报平安那条负责判断），下一句照常
        log(`串门：说话没送到：${errorText(error)}`);
      }
      if (trip !== current || !result) return;
      if (!result.ok) {
        await comeHome(result.reason === 'sent-home' ? 'sent-home' : 'lost');
        return;
      }
      current.lines.push(`你：${text}`, `${pet}：${result.reply || '……'}`);
      current.lastLineAt = Date.now();
      if (result.reply) relay(`${pet}：${result.reply}`);
    });
    current.queue = next.catch(() => undefined);
    return next;
  }

  /** 主人家捎来的事：它家宠物起的话题记下、转播；话题、摸一下、一起玩、请吃零食都回一句（一趟最多回 GUEST_ANSWERS 次） */
  function onHostEvent(current: Trip, event: HostEvent): void {
    const { owner, pet } = current.host;
    let ask: string;
    if (event.type === 'line') {
      current.lines.push(`${pet}：${event.text}`);
      current.lastLineAt = Date.now();
      relay(`${pet}：${event.text}`);
      ask = GUEST_ASK.answer;
    } else if (event.type === 'play') {
      // 只认自己也有的项目：对方捎来的名字不进提示词
      const thing = findPlayThing(event.what);
      if (!thing) return;
      current.lines.push(`（一起${thing.label}）`);
      relay(`（在 ${owner} 家和 ${pet} 一起${thing.label}）`);
      ask = GUEST_ASK.play(thing.label);
    } else if (event.type === 'gift') {
      const snack = findSnack(event.what);
      if (!snack) return;
      current.lines.push(`（${pet} 请你吃了${snack.label}）`);
      current.treats.push(snack.label);
      relay(`（在 ${owner} 家吃到了${snack.label}）`);
      ask = GUEST_ASK.treat(snack.label);
    } else {
      ask = GUEST_ASK.poke;
    }
    if (!deps.appConfig().visit.chat || current.answers >= GUEST_ANSWERS) return;
    current.answers += 1;
    void chatTrip(current, ask, '嘿嘿～');
  }

  /**
   * 做客时把聊天转播回自家：自家宠物冒气泡（不走 say：say 会先叫它回家），这几秒窗口调亮看得清。
   * 一条接一条排着放，每条至少 RELAY_MIN_MS；排到时已经回家了就不放。
   */
  function relay(text: string): void {
    const now = Date.now();
    const wait = Math.max(0, relayFreeAt - now);
    relayFreeAt = now + wait + RELAY_MIN_MS;
    setTimeout(() => {
      if (trip) showRelay(text);
    }, wait);
  }

  function showRelay(text: string): void {
    fadeHome(electron, RELAY_OPACITY);
    if (relayTimer !== null) clearTimeout(relayTimer);
    relayTimer = setTimeout(() => {
      relayTimer = null;
      if (trip) fadeHome(electron, AWAY_OPACITY);
    }, RELAY_MS);
    void petRequest('POST', '/broadcast', { text, anim: false, duration: RELAY_MS })
      .then((result) => {
        if (result.ok !== true) log(`串门：转播没显示出来：${JSON.stringify(result)}`);
      })
      .catch((error: unknown) => log(`串门：转播没显示出来：${errorText(error)}`));
  }

  /** 每 PING_MS 报一次平安，顺便看到点没有 */
  async function pingTrip(current: Trip): Promise<void> {
    if (trip !== current || current.pinging) return;
    if (Date.now() - current.since >= deps.appConfig().visit.stayMin * 60_000) {
      await comeHome('time-up');
      return;
    }
    current.pinging = true;
    try {
      const result = await tripRequest(current.host, '/v1/ping', { token: current.token });
      if (trip !== current) return;
      if (!result.ok) {
        await comeHome(result.reason === 'sent-home' ? 'sent-home' : 'lost');
        return;
      }
      current.failures = 0;
      for (const event of result.events) onHostEvent(current, event);
    } catch (error) {
      current.failures += 1;
      if (current.failures >= 3 && trip === current) {
        log(`串门：和 ${current.host.owner} 家连不上了：${errorText(error)}`);
        await comeHome('lost');
      }
    } finally {
      current.pinging = false;
    }
  }

  /**
   * 回家：告辞（被请回、失联时不用）、恢复自家宠物、记日记、跟主人讲讲见闻。
   * 叫回家时**不等说话队列**：它可能正是从说话队列里被叫回来的（speak → say → comeHome），等就死锁了；
   * 只有到点回家（报平安的定时器里，不在队列里）才等模型生成告别的话。
   */
  async function comeHome(reason: HomeReason): Promise<void> {
    const current = trip;
    if (!current) return;
    trip = null;
    clearInterval(current.pingTimer);
    if (current.talkTimer !== null) clearTimeout(current.talkTimer);
    fadeHome(electron, 1);
    const { owner, pet } = current.host;
    log(`串门：从 ${owner} 家回来了（${reason}）`);
    if (reason === 'time-up' || reason === 'called') {
      const farewell =
        reason === 'time-up'
          ? cleanText(
              await visitLine(
                guestPrompt(owner, pet, current.lines, GUEST_ASK.farewell),
                `${pet}，我该回家啦，下次见～`,
              ),
              LINE_MAX,
            )
          : '家里叫我啦，先回去啦～';
      void tripRequest(current.host, '/v1/leave', { token: current.token, text: farewell }).catch((error: unknown) =>
        log(`串门：告辞没送到：${errorText(error)}`),
      );
    }
    const chats = current.lines.filter((line) => line.startsWith('你：')).length;
    const ending = reason === 'sent-home' ? '，被它家主人请回来了' : reason === 'lost' ? '，后来连不上就回来了' : '';
    const treats = current.treats.length > 0 ? `，吃到了${current.treats.join('、')}` : '';
    diary.note(Date.now(), 'visit', `去 ${owner} 家串门，和它家的宠物 ${pet} 聊了 ${chats} 句${treats}${ending}`);
    void refreshStatus(Date.now());
    void refreshMenu();
    const back = `我从 ${owner} 家回来啦～`;
    // 不用模型聊天：回家也只说固定的一句
    if (!deps.appConfig().visit.chat) {
      void say(back);
      return;
    }
    void speak(
      current.lines.length > 0
        ? travelPrompt(owner, pet, current.lines)
        : `你去 ${owner} 家串门，${HOME_WITHOUT_CHAT[reason]}。跟主人说一声。`,
      back,
    );
  }

  // ---------- 右键菜单 ----------

  function wantedLabels(): string[] {
    return [MENU_LOOK, MENU_DIARY, ...visitActions().keys()];
  }

  async function refreshMenu(force = false): Promise<void> {
    const labels = wantedLabels();
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
    } else if (label === MENU_DIARY) {
      await openDiary(now);
    } else {
      const action = visitActions().get(label);
      if (action) await action();
      // 菜单弹出后邻居走了
      else if (label.startsWith(`${MENU_VISIT_GROUP}/去 `)) await say('它好像已经不在附近了～');
    }
    await refreshStatus(now);
    await refreshMenu();
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
          if (result.reason === 'unknown-owner') await refreshMenu(true);
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

  void refreshMenu(true).then(() => pollMenu());
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
      // 在别人家做客：告个辞（不等）；家里的客人窗口关掉
      void comeHome('called');
      if (hosting && hosting.openerTimer !== null) clearTimeout(hosting.openerTimer);
      hosting?.window.close(0);
      neighborhood?.stop();
      void visitHost?.close();
      homePet.dispose();
      diary.flush(Date.now());
    },
  };
}

function knockFailText(owner: string, reason: KnockFailure | 'unreachable'): string {
  switch (reason) {
    case 'busy':
      return `${owner} 家现在不方便，下次再去吧～`;
    case 'too-soon':
      return `刚敲过 ${owner} 家的门，等会儿再去～`;
    case 'declined':
      return `${owner} 家没让我进门，呜～`;
    case 'no-answer':
      return `${owner} 家半天没人应门～`;
    case 'unreachable':
      return `连不上 ${owner} 家，看看系统设置里有没有允许 dsh-pet 访问本地网络～`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
