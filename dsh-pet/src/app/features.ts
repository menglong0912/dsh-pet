/**
 * 独立应用的扩展功能编排（只在 `src/app/main.ts` 里启动，DSH 内运行时不存在）。
 *
 * 纯逻辑都在旁边的模块里（activity / reminders / claude-hooks / status，各有单测）；这里只做接线：
 *   - 每 TICK_MS 采样一次：系统空闲秒数与锁屏（Electron powerMonitor）+ 前台应用（`lsappinfo`，无需授权）；
 *   - 根据采样推进久坐 / 喝水 / 下班提醒、回来打招呼、定时看屏幕；
 *   - 与插件的自动碎碎念共用一个节拍（takeWhisperTurn）：看屏幕占它的拍，应用说话时它让一让；
 *   - 把 Claude Code 与串门合成为一个外部工作状态（桌宠只有一个外部槽）；
 *   - 把一天里的事记进宠物日记（diary.ts），第二天回到电脑前时补写前一天的日记；
 *   - 修炼（cultivation.ts）：在电脑前就涨修为，久坐提醒后离开会「调息」，Claude 干完活偶尔炼出破境丹；
 *     升级冒泡、记日记，右键「修炼」看境界和进度，圆满时点「渡劫」：扛天雷（X4）——成功进下一个大境界、
 *     挂 10 分钟两项「领悟」二选一（没人挑就随机定一个），失败只扣修为（封顶 300，不设冷却）；有丹能先吃一颗；
 *     右键「心魔试炼」打一场：心魔是暗色的客人窗口（visit-windows.ts），两边按引擎事件依次出招、
 *     挨打、闪避（battle-show.ts 排时间线与执行器），头顶两条气血条（arena-window.ts），
 *     演完照结果拿奖励、说一句赛后感言；渡劫复用同一套演出，只是没有对手窗口；
 *   - 局域网串门（visit.ts 管网络、visit-windows.ts 管窗口、visit-talk.ts 管怎么聊）：设置里开了才发信标、开接待端口；
 *     出门时自家宠物变半透明、把别人家的聊天转播回来，客人来了在自家宠物旁边开个小窗（能摸、能一起玩）；
 *     两边接着前文聊、主人家也会起话题；串门的台词只按人设生成，不带「主人此刻」；
 *     串门进行中两边都能发起切磋（X5，visit.ts 的先承诺后揭示协议）：两边的屏幕上都演全套——主人家对客人窗口、
 *     客人对主人家的窗口（复用 X3 的演出执行器、擂台与特效层）；解说台词用同一对随机数排，动作、飞行物、
 *     气血两边一致；奖励与战绩各记各的；
 *     开着串门时，用餐时间宠物也分到一份零食（snacks.ts，晚上偶尔有宵夜），家里来客时请它吃；
 *     熟人之间还能捎话（note-window.ts 的小输入窗）：主人的话经宠物带给对方主人，原文不进提示词与日记；
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
import { LOCK_MAX_TTL_MS } from '../host/lock';
import { composeSystemPrompt, petPersona } from '../host/persona';
import type { StandaloneAiService } from '../standalone/ai-provider';
import { ActivityTracker, describeActivity, durationText } from './activity';
import type { ActivitySnapshot } from './activity';
import type { AppConfig } from './app-config';
import { SKILLS, WEAPONS, fight, shadowOf, tribulate } from './battle';
import { BattleShow, FX_ASSETS, LINE_MS, SHOW_ANIMS, swapSides, timeline } from './battle-show';
import type { Shot, Step } from './battle-show';
import { arenaScoreboard, openArenaWindow } from './arena-window';
import { foeStage, homeStage, openFxWindow } from './fx-window';
import type { FxWindow, Stage } from './fx-window';
import { AdventureFlow } from './adventure-flow';
import { createAdventureShows } from './adventure-show';
import { openAdventureWindow } from './adventure-window';
import { SANWANG } from './dungeon-sanwang';
import { ClaudeSessions } from './claude-hooks';
import { Cultivation, stageLabel } from './cultivation';
import type { CultivationEvent, CultivationView } from './cultivation';
import { dateLabel, Diary, diaryDate } from './diary';
import type { ClaudeHookPayload } from './claude-hooks';
import { HealthReminders, OffWorkReminder } from './reminders';
import { findSnack, SnackPouch } from './snacks';
import type { Snack } from './snacks';
import type { HealthEvent } from './reminders';
import { NeighborBook, notesAllowed, orderNeighbors, shouldAutoAdmit } from './neighbors';
import type { LastGuest, NeighborRecord } from './neighbors';
import { createNoteOpener } from './note-window';
import { composeWorkStatus, sameStatus } from './status';
import type { WorkStatus } from './status';
import {
  BEACON_PORT,
  cleanText,
  cardFighter,
  knockOn,
  LINE_MAX,
  NAME_MAX,
  Neighborhood,
  NOTE_GAP_MS,
  NOTE_MAX,
  PING_MS,
  randomSparNonce,
  sendNote,
  sendReveal,
  sendSpar,
  sparCardOf,
  sparCommit,
  sparFight,
  sparLineRng,
  SPAR_MODE,
  tripRequest,
  VisitHost,
} from './visit';
import type {
  HostEvent,
  HostHandlers,
  KnockAnswer,
  KnockFailure,
  Neighbor,
  NoteReply,
  SparCard,
  SparFailure,
  SparReply,
  SparRevealReply,
  TripReply,
  Visitor,
} from './visit';
import { loadVisitIdentity, resetVisitIdentity } from './visit-identity';
import {
  findPlayThing,
  GUEST_ANSWERS,
  GUEST_ASK,
  guestPrompt,
  HOST_ASK,
  HOST_OPENERS,
  hostPrompt,
  memoPrompt,
  MEMORY_HINT,
  NUDGE_GAP_MS,
  openerGap,
  PLAY_THINGS,
  QUIET_MS,
  talkGap,
  travelPrompt,
  tripRounds,
} from './visit-talk';
import type { PlayThing } from './visit-talk';
import {
  AWAY_OPACITY,
  fadeHome,
  guestBounds,
  guestSide,
  openGuestWindow,
  RELAY_OPACITY,
  watchHomePet,
} from './visit-windows';
import type { ArenaWindow } from './arena-window';
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
/** 「修炼」子菜单：和「串门」一样按前缀收成子菜单 */
const MENU_CULTIVATION_GROUP = '修炼';
/** 平时打坐的间隔：40–60 分钟随机一次（在电脑前、没出门、没在说话时） */
const MEDITATE_GAP_MIN = 40;
const MEDITATE_JITTER_MIN = 20;
/** 插件每个 owner 最多 20 项（`>` 就整份拒掉、菜单从此不再更新）：根上固定 2 项，修炼最多 5 项
 * （信息 + 历练 + 渡劫 + 服丹后渡劫 + 心魔试炼／快进；待选二选一那两项只在没圆满时出现），邻居最多列这么多
 * （回访占名额）= 恰好 20。家里有客时换成送客 + 切磋 + 一起玩 + 请吃零食 + 熟人 + 捎话，至多 17 项，
 * 加上修炼的项会超 20：wantedLabels 按优先级兜底截断，先少的是尾巴上的零食和捎话。 */
const MENU_NEIGHBORS_MAX = 13;
/** 宿主每个 owner 的菜单项上限（src/host/menu.ts 的 ITEMS_MAX，`>` 才拒） */
const MENU_ITEMS_MAX = 20;
/** 做客时转播回自家的气泡显示多久（窗口同时调亮这么久） */
const RELAY_MS = 8_000;
/** 转播的气泡每条至少显示这么久才换下一条：对方回话快时，自己说的那句也看得清 */
const RELAY_MIN_MS = 4_000;
/** 捎到的话在客人窗口的气泡里显示多久（比聊天的话久：主人要读自己写的那句到了没） */
const NOTE_BUBBLE_MS = 20_000;
/** 捎到的话转播回自家显示多久 */
const NOTE_RELAY_MS = 15_000;
/** 自动看屏幕要求键鼠最近活动过（秒）：人在看视频 / 发呆时不打扰 */
const SCREEN_ACTIVE_IDLE_SEC = 60;
/** 应用刚说过话这么久内，自动碎碎念让一让（气泡默认显示 10 秒） */
const SPOKE_HOLD_MS = 15_000;
/** 打完到关掉心魔窗口 / 擂台之间的停顿（§X14：1 秒——run() 结束时收场动作只剩约 0.6 秒，停这么久正好播完） */
const CLOSE_HOLD_MS = 1_000;
/** 演出占着宠物的锁比时间线多留这么久：演完还要停 CLOSE_HOLD_MS 才放，定时器也会有点漂 */
const SHOW_LOCK_SPARE_MS = 30_000;
/** 切磋等客人应战 / 亮随机数的时限（§X5：对不上或 30 秒没来，按客人认输记） */
const SPAR_WAIT_MS = 30_000;
/** 客人的赛后感言最多编这么久（跟着 reveal 带过去；模型磨蹭就退回模板，别把 reveal 拖过时限） */
const SPAR_REMARK_CAP_MS = 10_000;
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
  /** 这趟已经捎了几句话给对方主人、上一条是什么时候（NOTE_MAX / NOTE_GAP_MS 限额） */
  notesSent: number;
  lastNoteAt: number;
  /** 进门时记好的上次见面备忘（neighbors.meet；整趟用它，不每句现读记录）；没记录 null */
  memory: string | null;
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
  /** 进门时记好的上次见面备忘（neighbors.meet；整趟用它，不每句现读记录）；没记录 null */
  memory: string | null;
  /** 上次把摸一下 / 一起玩捎给客人的时间（NUDGE_GAP_MS） */
  lastNudgeAt: number;
  /** 这趟已经托客人捎了几句话给它主人、上一条是什么时候（NOTE_MAX / NOTE_GAP_MS 限额） */
  notesSent: number;
  lastNoteAt: number;
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
  /** 邻居簿与串门身份（设置页「邻居」一节用，见 app-routes.ts 的 appNeighborsHandler） */
  neighbors: {
    /** 本机身份 id（GET 时只回前 8 位） */
    identityId(): string;
    list(): NeighborRecord[];
    setFriend(id: string, friend: boolean): void;
    forget(id: string): void;
    clear(): void;
    /** 重置串门身份：串门进行中（家里有客、自己在外、正在敲门）时不重置、返回 false（接口回 409） */
    resetIdentity(): boolean;
  };
  /** 修炼的只读视图（设置页「修炼」一节用，X6）；开关关着时 null */
  cultivation: { view(): CultivationView | null };
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
  /** 邻居簿文件（$DSH_HOME/dsh-pet/neighbors.json） */
  neighborsPath: string;
  /** 修炼存档（$DSH_HOME/dsh-pet/cultivation.json）；开关关着时不碰它 */
  cultivationPath: string;
  /** 修炼用的随机数（丹药、成长随机项）；只给测试注入固定序列用，平时不传 */
  cultivationRng?: () => number;
  /** 切磋等客人应战 / 亮随机数的时限（默认 30 秒，超时按客人认输）；只给测试调短用 */
  sparWaitMs?: number;
  /** 信标的端口与发往地址（默认 BEACON_PORT + 每块网卡的广播地址）；只给测试注入用，不往真实网络发 */
  beacon?: {
    port?: number;
    targets?: () => Array<{ address: string; port: number }>;
    /** 手动填的邻居发往哪个端口（默认 BEACON_PORT）；只给测试用 */
    peerPort?: number;
  };
  /** 插件路由前缀的完整地址，如 http://127.0.0.1:53624/dsh-pet-7340 */
  petBase: string;
  log: (message: string) => void;
}

export function startAppFeatures(deps: FeatureDeps): AppFeatures {
  const { electron, ai, log } = deps;
  /** 切磋等客人应战 / 亮随机数的时限（§X5：30 秒没来按客人认输；测试里调短） */
  const sparWaitMs = deps.sparWaitMs ?? SPAR_WAIT_MS;
  const tracker = new ActivityTracker();
  const claude = new ClaudeSessions();
  const health = new HealthReminders(() => deps.appConfig());
  const offWork = new OffWorkReminder(() => deps.appConfig().offWork);
  const diary = new Diary(deps.diaryDir, Date.now(), log);
  const pouch = new SnackPouch(deps.snackPath, log);
  /** 邻居簿：只记验证过身份的（记录只存本机） */
  const neighbors = new NeighborBook(deps.neighborsPath, (message) => log(`串门：${message}`));
  /** 这一天（日记口径）已经查过要不要补写日记：一天只查一次，补写失败也不每拍重试 */
  let diaryCheckedFor: string | null = null;
  let disposed = false;
  let lastStatus: WorkStatus | null = null;
  /** 历练小窗与流程（Y3）：修炼开着才有；菜单、敲门、出门、退出都看它 */
  let adventure: AdventureFlow | null = null;
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
  /** 串门身份（每台电脑一对密钥，重启不变）：信标 id、敲门签名、应答签名都用它；设置页可以重置成新的一对 */
  let visitIdentity = loadVisitIdentity(deps.identityPath, (message) => log(`串门：${message}`));
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
  /** 最近一位来家里做过客的客人（只记验证过身份的）：走了 2 小时内「串门」子菜单里放一项「回访」 */
  let lastGuest: LastGuest | null = null;
  /** 转播结束后把自家宠物调回半透明的定时器 */
  let relayTimer: ReturnType<typeof setTimeout> | null = null;
  /** 下一条转播最早什么时候能顶掉上一条（RELAY_MIN_MS） */
  let relayFreeAt = 0;
  /** 自家宠物在哪（客人站它旁边） */
  const homePet = watchHomePet(electron);
  /** 捎话的小输入窗（同一时间只开一个） */
  const noteOpener = createNoteOpener(electron, `${new URL(deps.petBase).origin}/app/note`, () => homePet.box());

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

  /**
   * 演出期间占着自家宠物的占用锁（`/lock` 的 lockId）：持锁时渲染端的随机链（堆雪人这类随机活动、
   * 自己走开、转身）和自动来源的工作状态 / 余额表现都停下，两段演出动画之间宠物停在站姿上。
   * 应用自己的请求统一带着它（petRequest），所以提醒、串门这些照常能说话、播动画。
   */
  let showLock: string | null = null;
  /** 演完挂着的放锁定时器（下一场赶在放锁前开演就取消它、续上同一把锁） */
  let showLockRelease: ReturnType<typeof setTimeout> | null = null;

  /** 发一个插件请求；演出占着宠物时带上那把锁（见 holdPet），锁没了就不带它重发一次 */
  async function petRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const lockId = showLock;
    const result = await petFetch(method, path, body, lockId);
    if (lockId === null || result.reason !== 'lock-lost') return result;
    // 演出的锁没了（用户点了 / 拖了宠物，或者到期了）：接下来照没锁的老样子演，这一下不带锁重发
    if (showLock === lockId) showLock = null;
    log(`演出的占用锁没了（${String(result.cause)}），接着不占着宠物演`);
    return petFetch(method, path, body, null);
  }

  async function petFetch(
    method: string,
    path: string,
    body: unknown,
    lockId: string | null,
  ): Promise<Record<string, unknown>> {
    const url = new URL(deps.petBase + path);
    url.searchParams.set('pet', petId());
    url.searchParams.set('surface', 'any');
    if (lockId !== null) url.searchParams.set('lock', lockId);
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return { ok: true };
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * 开演前占住自家宠物（见 showLock）：锁的时长按这一场的时间线算，再留出收场的余量。
   * 上一场刚演完、锁还没放：续上同一把（续不上就重新拿）。拿不到只记一行，照没锁的老样子演。
   */
  async function holdPet(steps: Step[]): Promise<void> {
    if (showLockRelease !== null) clearTimeout(showLockRelease);
    showLockRelease = null;
    const showMs = steps.length ? steps[steps.length - 1].at + LINE_MS : 0;
    const ttl = Math.min(LOCK_MAX_TTL_MS, showMs + SHOW_LOCK_SPARE_MS);
    let failure = '';
    for (const lockId of showLock === null ? [null] : [showLock, null]) {
      try {
        const result = await petFetch('POST', '/lock', lockId === null ? { ttl } : { lockId, ttl }, null);
        if (result.ok === true && typeof result.lockId === 'string') {
          showLock = result.lockId;
          return;
        }
        failure = JSON.stringify(result);
      } catch (error) {
        failure = errorText(error);
      }
    }
    showLock = null;
    log(`演出占不住宠物：${failure}`);
  }

  /** 演完放开宠物（等收场的动作播完、在最后一帧停一会儿；退出时立刻放） */
  function releasePet(afterMs: number): void {
    if (showLockRelease !== null) clearTimeout(showLockRelease);
    showLockRelease = setTimeout(() => {
      showLockRelease = null;
      const lockId = showLock;
      if (lockId === null) return;
      showLock = null;
      petFetch('POST', '/lock/release', { lockId }, null)
        .then((result) => {
          if (result.ok !== true) log(`演出放开宠物失败：${JSON.stringify(result)}`);
        })
        .catch((error: unknown) => log(`演出放开宠物失败：${errorText(error)}`));
    }, afterMs);
  }

  /** 说一句话的选项：配图（表情包池里的名称，插件按池校验）；要不要联动播一段说话动画；气泡显示多久 */
  interface SayOptions {
    image?: string;
    /** false = 只冒气泡不打断正在播的动画（突破这类演出期间的台词用） */
    anim?: boolean;
    /** 气泡显示时长（毫秒）：演出的台词给成一步那么长，下一句自然顶替上一句 */
    durationMs?: number;
  }

  async function say(text: string, options: SayOptions = {}): Promise<boolean> {
    // 出门在外时家里有话要说（提醒、看屏幕、Claude……）：先回家再说
    if (trip) await comeHome('called');
    const image = options.image;
    const duration = options.durationMs;
    try {
      const result = await petRequest('POST', '/broadcast', {
        text,
        anim: options.anim ?? true,
        ...(image ? { image } : {}),
        ...(duration === undefined ? {} : { duration }),
      });
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
  function speak(instruction: string, fallback: string, options: SayOptions = {}): Promise<void> {
    const next = speaking.then(async () => {
      if (disposed) return;
      generating = true;
      let text: string | null;
      try {
        text = await generate(instruction);
      } finally {
        generating = false;
      }
      await say(text ?? fallback, options);
    });
    speaking = next.catch(() => undefined);
    return next;
  }

  /**
   * 排进说话队列说一句固定的话（不调模型）：修炼的升级 / 炼丹这类模板句也走队列，
   * 不和正在生成或显示的那句互相顶掉（say 不排队：主动点的、要立刻有回应的才直接说）
   */
  function sayLine(text: string, options: SayOptions = {}): Promise<void> {
    const next = speaking.then(async () => {
      if (!disposed) await say(text, options);
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
    if (!ai.canSeeScreen()) {
      if (manual) await say('先在 AI 设置里把模型配好，我才能看屏幕哦～');
      return { ok: false, reason: 'not-ready' };
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
      // 正在演一场（心魔）时也不联动说话动画：手动看屏幕照样能看，只是别顶掉演出的动画
      if (!(await say(text, { image: meme?.name, ...(battle ? { anim: false } : {}) })))
        return { ok: false, text, reason: 'say-failed' };
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
      // 修炼：主人离开电脑（解除心浮气躁，可能「调息」）
      if (event.type === 'leave') {
        const practice = cultivationOn();
        if (practice) onCultivation(now, practice.onLeave(now));
      }
    }
    for (const event of health.tick(now, snap)) {
      diary.note(now, event, event === 'sit' ? '提醒主人起来活动一下' : '提醒主人喝水');
      void announceHealth(event);
      // 修炼：久坐提醒响了（进入「心浮气躁」）
      if (event === 'sit') {
        const practice = cultivationOn();
        if (practice) practice.onSitReminder(now);
      }
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

    // 修炼：在电脑前就涨修为（事件冒泡、记日记在 onCultivation）；平时在电脑前、没出门、没在说话时偶尔打坐
    const practice = cultivationOn();
    if (practice) {
      onCultivation(now, practice.tick(now, snap?.present ?? false));
      if (
        snap?.present &&
        trip === null &&
        battle === null &&
        now >= meditateAt &&
        !generating &&
        now - lastSpokeAt >= SPOKE_HOLD_MS
      ) {
        meditateAt = now + meditateGapMs();
        void playExtra('修炼-打坐');
      }
    }

    // 自动碎碎念在跑时，看屏幕占它让出的那一拍（takeWhisperTurn），不另起一路；没在跑才自己按间隔看
    if (!whisperRunning(now) && screenDue(now)) void lookAtScreen(false);
    await syncVisit();
    await refreshStatus(now);
    await refreshMenu();
  }

  /**
   * 到点该自动看屏幕：开着、没出门、没在演一场、人在且 activeIdleSec 内碰过键鼠、离上次够间隔、
   * 能看（模型已就绪 + 已授权）
   * @param activeIdleSec 「最近碰过键鼠」的窗口（秒）
   */
  function screenDue(now: number, activeIdleSec = SCREEN_ACTIVE_IDLE_SEC): boolean {
    const config = deps.appConfig();
    return (
      config.screen.enabled &&
      trip === null &&
      battle === null &&
      tracker.snapshot()?.present === true &&
      electron.powerMonitor.getSystemIdleTime() < activeIdleSec &&
      now - lastScreenAt >= config.screen.intervalMin * 60_000 &&
      !screenBusy &&
      ai.canSeeScreen() &&
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
    // 正在演一场（心魔试炼）：气泡按时间线一句一句走，碎碎念别来抢
    if (battle) return true;
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
      // 端口与发往地址默认照常（BEACON_PORT + 每块网卡的广播地址）；测试里注入成随机的、不往外发
      ...(deps.beacon?.port !== undefined ? { port: deps.beacon.port } : {}),
      ...(deps.beacon?.targets ? { targets: deps.beacon.targets } : {}),
      // 设置页手动填的邻居：广播之外再单播一份（跨网段用），每次发送时现取，改了下一拍生效
      peers: () =>
        deps.appConfig().visit.peers.map((address) => ({ address, port: deps.beacon?.peerPort ?? BEACON_PORT })),
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

  /** 见面结束后给自己记一句摘要（不 await：可能正是从说话队列里被叫回来的）；生成不了就保留旧摘要 */
  function saveMemo(id: string, owner: string, pet: string, lines: readonly string[]): void {
    if (!deps.appConfig().visit.chat || spokenCount(lines) < 2) return;
    void compose(memoPrompt(owner, pet, lines), '')
      .then((text) => {
        const summary = cleanText(text, LINE_MAX);
        if (summary) neighbors.setSummary(id, summary);
      })
      .catch((error: unknown) => log(`串门：写见面摘要失败：${errorText(error)}`));
  }

  /** 接待这一侧：VisitHost 收到敲门、说话、告辞时来问这里 */
  const hostHandlers: HostHandlers = {
    canHost: () => trip === null && knockingOn === null,
    knocked(visitor) {
      log(`串门：${visitor.owner}（${visitor.address}）家的 ${visitor.pet} 来敲门`);
      // 正在演一场（心魔 / 历练）：照常接待，先把这场快进结束——客人窗口要站在宠物旁边，不能让两只叠着
      skipTrial();
      // 历练小窗也收起：进度都在存档里，客人走了再从菜单接着走
      adventure?.suspend();
      adventureShows.closeAll(0);
      // 熟人 + 开了「直接请进」 + 主人在电脑前：不用主人点头（VisitHost.knock 调这里之前就挂好了 pending，同步让进是安全的）
      if (shouldAutoAdmit(neighbors, visitor, deps.appConfig().visit.autoAdmitFriends, tracker.snapshot()?.present)) {
        void say(`熟人 ${visitor.owner} 家的 ${visitor.pet} 来啦，直接请它进来～`);
        letIn(true);
        void refreshMenu();
        return;
      }
      // 没验证过身份、昵称却和某个熟人一样：多半是抄来的名字，说清楚让主人自己拿主意
      if (!visitor.id && neighbors.list().some((record) => record.friend && record.owner === visitor.owner)) {
        void say(`自称是 ${visitor.owner} 家的 ${visitor.pet}，可我没认出来，要让它进来吗？`);
      } else {
        void say(`${visitor.owner} 家的 ${visitor.pet} 来敲门啦，右键点「让 ${visitor.pet} 进来」请它进门～`);
      }
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
        await visitLine(
          hostPrompt(visitor.owner, visitor.pet, lines, HOST_ASK.answer, current?.memory ?? null),
          '欢迎来玩呀～',
        ),
        LINE_MAX,
      );
      lines.push(`你：${reply}`);
      if (current) current.lastLineAt = Date.now();
      // 正在演一场（切磋）：回话不联动说话动画，别顶掉演出的动画
      await say(reply, battle ? { anim: false } : undefined);
      return reply;
    },
    note(visitor, text) {
      // 只收熟人的捎话：验过身份（有 id 才算验上）、是熟人、开着捎话，缺一样都不收
      if (!notesAllowed(neighbors, visitor.id, visitor.id !== undefined, deps.appConfig().visit.notes)) return false;
      log(`串门：${visitor.owner} 托 ${visitor.pet} 捎来一句话`);
      // 客人窗口的气泡里念出来，自家宠物不复述；原文不进提示词
      if (hosting?.visitor === visitor) hosting.window.say(`${visitor.owner} 托我带话：${text}`, NOTE_BUBBLE_MS);
      diary.note(Date.now(), 'visit', `${visitor.owner} 托 ${visitor.pet} 带来一句话`);
      return true;
    },
    // 切磋（X5）：协议层已验过模式、版本与名帖；关不关、忙不忙、认不认得客人在这边答
    spar(visitor, card, commit) {
      return hostSpar(visitor, card, commit);
    },
    reveal(visitor, nonce, line) {
      return hostReveal(visitor, nonce, line);
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
    // 刚打完一场、窗口还没收摊：立刻关掉——客人窗口和心魔窗口都按同一套位置规则摆在宠物旁边，叠着不像话
    closeTrial(0);
    const now = Date.now();
    // 进门时先把「记这次之前」的上次见面备忘算好，整趟都用它；再记这次见面（只记验证过身份的）
    const memory = visitor.id
      ? neighbors.meet(visitor.id, { owner: visitor.owner, pet: visitor.pet }, 'hosted', now)
      : null;
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
      memory,
      lastNudgeAt: 0,
      notesSent: 0,
      lastNoteAt: 0,
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
    const memory = current.memory;
    // 生成不了就不起话题（没有兜底句：固定的开场白聊不下去）；头一回起话题时提醒可以提上次聊的
    const ask = current.openers === 1 && memory ? `${HOST_ASK.opener}${MEMORY_HINT}` : HOST_ASK.opener;
    const text = cleanText(await compose(hostPrompt(owner, pet, current.lines, ask, memory), ''), LINE_MAX);
    if (hosting !== current || !text) return;
    current.lines.push(`你：${text}`);
    current.lastLineAt = Date.now();
    visitHost?.tell({ type: 'line', text });
    // 正在演一场（切磋）时起话题：不联动说话动画（带 anim 的气泡会顶掉演出的动画）
    await say(text, battle ? { anim: false } : undefined);
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
    // 正在演一场（切磋）：一起玩的动画会把演出的动画顶掉，先不玩
    if (!current || battle) return;
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
    // 正在演一场（切磋）：吃东西的动画会把演出的动画顶掉，先不吃
    if (!current || battle || !pouch.take(snack.label)) return;
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
    // 正在切磋（主人家这一侧）：收摊——账在亮随机数那一步就记过了，不会漏
    cancelSpar();
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
    if (visitor.id) {
      saveMemo(visitor.id, visitor.owner, visitor.pet, current?.lines ?? []);
      lastGuest = { id: visitor.id, at: Date.now() };
    }
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
      // 切磋（X5）：开着修炼、没在打、客人是验证过身份的（奖励与邻居簿都靠 id 记）时才有
      if (cultivationOn() && guest.id && !spar && !battle)
        actions.set(`${MENU_VISIT_GROUP}/和客人切磋`, () => void inviteSpar());
      for (const thing of PLAY_THINGS) actions.set(`和 ${guest.pet} 一起玩/${thing.label}`, () => playTogether(thing));
      for (const snack of pouch.kinds()) actions.set(`请 ${guest.pet} 吃/${snack.label}`, () => treatGuest(snack));
      // 只对验证过身份的客人提供熟人开关：陌生人没身份可标，冒名的也不能被拉成熟人
      const guestId = guest.id;
      if (guestId) actions.set(friendLabel(neighbors, guestId, guest.owner), () => toggleFriend(neighbors, guestId));
      // 捎话也只对熟客开（托它带回去给它的主人）；客人带 id 就是敲门签名验上了
      if (notesAllowed(neighbors, guestId, guestId !== undefined, notesOn()))
        actions.set(`捎话给 ${guest.owner}`, () => void fireNote(noteViaGuest()));
    } else if (trip) {
      actions.set(`从 ${trip.host.owner} 家回来`, () => comeHome('called'));
      // 切磋（X5）：开着修炼、没在打时才有（在别人家做客，对面是主人家的宠物）
      if (cultivationOn() && !spar && !battle)
        actions.set(`${MENU_VISIT_GROUP}/找主人家的宠物切磋`, () => void startGuestSpar());
      const hostId = trip.host.id;
      // 只对验证过身份的主人家提供熟人开关（trip.verified：见 startTrip）；捎话也只对熟人家开
      if (trip.verified)
        actions.set(friendLabel(neighbors, hostId, trip.host.owner), () => toggleFriend(neighbors, hostId));
      if (trip.verified && notesAllowed(neighbors, hostId, true, notesOn()))
        actions.set(`捎话给 ${trip.host.owner}`, () => void fireNote(noteToHost()));
    } else if (enabled && visiting && knockingOn === null) {
      const ordered = orderNeighbors(neighborhood?.list() ?? [], neighbors, lastGuest, Date.now());
      // 回访项也算在 MENU_NEIGHBORS_MAX 里：放了回访，列表就少列一位
      const nearby = ordered.list.slice(0, MENU_NEIGHBORS_MAX - (ordered.revisit ? 1 : 0));
      if (ordered.revisit) {
        const revisit = ordered.revisit;
        actions.set(`${MENU_VISIT_GROUP}/回访 ${revisit.owner} 家`, () => goVisit(revisit.id));
      }
      for (const neighbor of nearby) {
        // 熟人加个后缀，一眼能认出来
        const suffix = neighbors.get(neighbor.id)?.friend === true ? '（熟人）' : '';
        let label = `${MENU_VISIT_GROUP}/去 ${neighbor.owner} 家${suffix}`;
        for (let n = 2; actions.has(label); n += 1)
          label = `${MENU_VISIT_GROUP}/去 ${neighbor.owner} 家${suffix}（${n}）`;
        actions.set(label, () => goVisit(neighbor.id));
      }
      // 没有邻居也留个入口：不然开了串门，右键里一点痕迹都没有
      if (nearby.length === 0 && !ordered.revisit) {
        actions.set(`${MENU_VISIT_GROUP}/附近还没有邻居`, () =>
          say('附近还没发现开着串门的桌宠～同一网络里的同事也打开串门就能看到啦'),
        );
      }
    }
    return actions;
  }

  /** 捎话开关现在的值（「捎话给 X」菜单项和收捎话都用） */
  function notesOn(): boolean {
    return deps.appConfig().visit.notes;
  }

  /**
   * 捎话不等小窗：小窗最长开 2 分钟，等它的话调用方（菜单点击的处理）会被拖住很久。
   * 失败路径都在动作里处理过，这里只兜底记日志，不许出现未处理的 Promise 拒绝。
   */
  function fireNote(sending: Promise<void>): Promise<void> {
    return sending.catch((error: unknown) => log(`串门：捎话出错：${errorText(error)}`));
  }

  /** 出门在熟人家：主人写一句话，捎给对方主人；结果转播回自家（不说 say：那会先把宠物叫回家） */
  async function noteToHost(): Promise<void> {
    const current = trip;
    if (!current) return;
    const owner = current.host.owner;
    const text = await noteOpener.ask(owner);
    if (text === null || trip !== current) return;
    const now = Date.now();
    if (current.notesSent >= NOTE_MAX || (current.notesSent > 0 && now - current.lastNoteAt < NOTE_GAP_MS)) {
      relay('（捎话：发太多了，等一会儿再捎）');
      return;
    }
    let result: NoteReply | null = null;
    try {
      result = await sendNote(current.host, { token: current.token, text });
    } catch (error) {
      log(`串门：捎话没送到：${errorText(error)}`);
    }
    if (trip !== current) return;
    if (result?.ok) {
      current.notesSent += 1;
      current.lastNoteAt = Date.now();
      diary.note(Date.now(), 'visit', `帮主人给 ${owner} 捎了句话`);
      relay('（捎话：捎到啦～）');
      return;
    }
    relay(`（捎话：${noteFailText(owner, result)}）`);
  }

  /** 家里来了熟客：主人写一句话，托客人带回去给它的主人 */
  async function noteViaGuest(): Promise<void> {
    const current = hosting;
    if (!current) return;
    const { owner, pet } = current.visitor;
    const text = await noteOpener.ask(owner);
    if (text === null) return;
    const now = Date.now();
    if (current.notesSent >= NOTE_MAX || (current.notesSent > 0 && now - current.lastNoteAt < NOTE_GAP_MS)) {
      void say('捎话发太多了，等一会儿再捎～');
      return;
    }
    // 攒着等客人下次报平安时捎过去（旧客人会丢掉不认识的 note 事件）；日记只记捎过，不记内容
    if (!visitHost?.tell({ type: 'note', text })) return;
    current.notesSent += 1;
    current.lastNoteAt = Date.now();
    diary.note(Date.now(), 'visit', `帮主人给 ${owner} 捎了句话`);
    void say(`好啦，这句话我让 ${pet} 带给 ${owner}～`);
  }

  /** 出门：先敲门，对方主人点头了才进门 */
  async function goVisit(id: string): Promise<void> {
    const neighbor = neighborhood?.get(id);
    if (!neighbor) {
      await say('它好像已经不在附近了～');
      return;
    }
    if (trip || knockingOn || visitHost?.guest() || visitHost?.knocking() || !deps.appConfig().visit.visiting) return;
    // 出门前先收起历练小窗；正在打或者正在赶路时不能出门（进度在存档里，等这一趟走完再去）
    if (adventure && !adventure.beforeTrip()) {
      await say('这边正打着呢，等这一趟走完再去吧～');
      return;
    }
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
    // 进门时先把「记这次之前」的上次见面备忘算好，整趟都用它；再记这次见面（只记验证过身份的）
    const memory = verified
      ? neighbors.meet(host.id, { owner: host.owner, pet: host.pet }, 'visited', Date.now())
      : null;
    const current: Trip = {
      host,
      token,
      verified,
      memory,
      since: Date.now(),
      lines: [],
      lastLineAt: Date.now(),
      rounds: 0,
      answers: 0,
      treats: [],
      notesSent: 0,
      lastNoteAt: 0,
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
    // 头一句打招呼时有上次见面的备忘，就提醒可以提一句
    const greet = first && current.memory;
    await chatTrip(
      current,
      first ? (greet ? `${GUEST_ASK.greet}${MEMORY_HINT}` : GUEST_ASK.greet) : GUEST_ASK.follow,
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
      const text = cleanText(
        await visitLine(guestPrompt(owner, pet, current.lines, ask, current.memory), fallback),
        LINE_MAX,
      );
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
    } else if (event.type === 'note') {
      // 主人家托自家宠物带回给它主人的话：只转播给主人看，不回话、不进提示词。
      // 收的条件和发的一样（notesAllowed）：没验上主人家的身份、不是熟人、关了捎话，都直接丢
      if (!notesAllowed(neighbors, current.host.id, current.verified, notesOn())) {
        log(`串门：${owner} 家捎来的话没认上，丢了`);
        return;
      }
      relay(`（${owner} 托我带回来的话）${event.text}`, NOTE_RELAY_MS, NOTE_RELAY_MS);
      diary.note(Date.now(), 'visit', `${owner} 托我带回一句话`);
      return;
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
    } else if (event.type === 'spar-invite') {
      // 主人家邀战（X5）：开着修炼就自动应战（§X5 的口径——客人那边关了切磋就忽略，不回话）
      void startGuestSpar();
      return;
    } else {
      ask = GUEST_ASK.poke;
    }
    if (!deps.appConfig().visit.chat || current.answers >= GUEST_ANSWERS) return;
    current.answers += 1;
    void chatTrip(current, ask, '嘿嘿～');
  }

  /**
   * 做客时把聊天转播回自家：自家宠物冒气泡（不走 say：say 会先叫它回家），这几秒窗口调亮看得清。
   * 一条接一条排着放，每条至少显示 holdMs 才许被下一条顶掉（聊天是 RELAY_MIN_MS；
   * 捎到的话要显示满自己的时长）；排到时已经回家了就不放。
   * @param durationMs 气泡显示多久（捎到的话比聊天久，默认 RELAY_MS）
   */
  function relay(text: string, durationMs = RELAY_MS, holdMs = RELAY_MIN_MS): void {
    const now = Date.now();
    const wait = Math.max(0, relayFreeAt - now);
    relayFreeAt = now + wait + holdMs;
    setTimeout(() => {
      if (trip) showRelay(text, durationMs);
    }, wait);
  }

  function showRelay(text: string, durationMs: number): void {
    // 切磋演出期间（battle 在跑、人在别人家）转播的台词只出气泡，不改亮度：
    // 开演时 fadeHome(1)，收摊后由 startGuestSpar 退回 AWAY_OPACITY
    if (!(trip !== null && battle !== null)) {
      fadeHome(electron, RELAY_OPACITY);
      if (relayTimer !== null) clearTimeout(relayTimer);
      relayTimer = setTimeout(() => {
        relayTimer = null;
        if (trip) fadeHome(electron, AWAY_OPACITY);
      }, durationMs);
    }
    void petRequest('POST', '/broadcast', { text, anim: false, duration: durationMs })
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
    // 正在切磋（客人这一侧）：转播收摊，账在亮随机数那一步就记过了，不会漏
    cancelSpar();
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
    if (current.verified) saveMemo(current.host.id, owner, pet, current.lines);
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

  // ---------- 修炼 ----------

  /** 修炼（X2）：开关开着才建档；状态、修为来源都在 Cultivation 里，这里只接线 */
  let cultivation: Cultivation | null = null;
  /**
   * 正在演的一场（心魔试炼；X5 的切磋复用同一套）。非 null 时：菜单换成「快进」、
   * 碎碎念与自动看屏幕让一让、平时打坐不播、有人来敲门先把这场快进结束、修炼冒泡不联动动画。
   */
  let battle: BattleShow | null = null;
  /** 一场心魔试炼的三扇窗（每场记自己的一份引用，收摊只关自己那组） */
  interface TrialWindows {
    guest: GuestWindow;
    arena: ArenaWindow;
    fx: FxWindow;
  }
  /**
   * 还没收完的每一场心魔试炼：上一场演完等 `CLOSE_HOLD_MS` 收摊时又开了下一场，
   * 两组都要能各自关掉；敲门、退出时全部立刻关（§X14，照切磋的 `sparWindows` 那套）。
   */
  const trialWindowGroups = new Set<TrialWindows>();
  /** 这场渡劫的特效层（X7 第二步：乌云与闪电；演完 `CLOSE_HOLD_MS` 后关掉） */
  let tribulationFx: FxWindow | null = null;
  /** 下次平时打坐最早什么时候（40–60 分钟一次） */
  let meditateAt = Date.now() + meditateGapMs();

  /** 开关开着才有修炼；第一次用到时建档（开关关着不建 cultivation.json） */
  function cultivationOn(): Cultivation | null {
    if (!deps.appConfig().cultivation.enabled) return null;
    if (!cultivation)
      cultivation = new Cultivation(deps.cultivationPath, (m) => log(`修炼：${m}`), deps.cultivationRng);
    return cultivation;
  }

  /**
   * 修炼事件：冒泡（排进现有的说话队列）+ 记日记。
   * @param options 冒空气泡的选项：X3 演完一场时的奖励冒泡要传 `{ anim: false }`——
   *   收场的胜利 / 倒地动画还在播，带 anim 的气泡会把它顶掉（X2 真机踩过的坑）
   */
  function onCultivation(now: number, events: CultivationEvent[], options: SayOptions = {}): void {
    const view = cultivation?.view();
    // 正在演一场：冒泡一律 anim: false——升级、炼丹这些气泡撞上演出，会把正在播的动画顶掉（X2 真机的坑）
    if (battle) options = { ...options, anim: false };
    for (const event of events) {
      if (event.kind === 'stage-up') {
        void sayLine(`修为精进，到${stageLabel(event.stage)}啦～`, options);
        diary.note(now, 'cultivate', `修为精进，到了${stageLabel(event.stage)}`);
      } else if (event.kind === 'full') {
        void speak('修为刚修满一个大境界（圆满），可以渡劫了。跟主人说一声。', '可以渡劫了～', options);
        diary.note(now, 'cultivate', '修为圆满，可以渡劫了');
      } else if (event.kind === 'breakthrough') {
        // 突破的 `修炼-突破` 动画与那句感言都在渡劫的演出里（battle-show 的收场 + runTribulation 的结果感言），
        // 这里只记日记——再播一遍、再说一句就是重复（§X4 每次渡劫只 +1 次模型调用）
        diary.note(now, 'cultivate', `渡劫成功，突破到${view?.label ?? '下一个大境界'}`);
      } else if (event.kind === 'offer') {
        // 二选一挂出来了（菜单两项，10 分钟）：模板句，不调模型（§X4 每次渡劫只 +1 次）
        void sayLine(`有两个新招式可以领悟：${SKILLS[event.a].name}和${SKILLS[event.b].name}，右键「修炼」里挑一个～`, {
          ...options,
          anim: false,
        });
      } else if (event.kind === 'choose') {
        void sayLine(`我领悟了${SKILLS[event.skill].name}～`, options);
        diary.note(now, 'cultivate', `领悟了${SKILLS[event.skill].name}`);
      } else if (event.kind === 'tribulation-fail') {
        void sayLine(event.lost > 0 ? `没扛住，修为退了 ${event.lost}` : '没扛住天雷，修为一点没退', options);
        diary.note(now, 'cultivate', `渡劫没扛住，修为退了 ${event.lost}`);
      } else if (event.kind === 'rest') {
        void sayLine(`调息回来，修为 +${event.gain}`, options);
        diary.note(now, 'cultivate', `调息，修为 +${event.gain}`);
      } else if (event.kind === 'pill') {
        void sayLine('炼成一颗破境丹～', options);
        diary.note(now, 'cultivate', '炼成一颗破境丹');
      } else if (event.kind === 'xp') {
        // 一场的进账（心魔试炼 / 切磋）：只在真的进了账时才发（圆满、当天不算收益的切磋、连点没恢复的心魔都没有这条）
        void sayLine(`这一场修为 +${event.amount}`, options);
      } else if (event.kind === 'trial-tired') {
        // 心魔收益随间隔恢复：离上一场不到 10 分钟只给一部分（连点就一点没有），说一声免得以为白打了
        void sayLine(`心魔还没缓过来，这一场收益打了折；再过 ${event.minutes} 分钟打才是满额～`, options);
      } else if (event.kind === 'title') {
        // 秘境结局给的称号（Y1 只入账；真正的演出在 Y3 的历练小窗）
        void sayLine(`得了称号「${event.title}」～`, options);
        diary.note(now, 'cultivate', `得了称号「${event.title}」`);
      } else {
        // 打赢心魔掉了一件还没有的法宝
        void sayLine(`得到法宝：${WEAPONS[event.weapon].name}～`, options);
        diary.note(now, 'cultivate', `得到法宝：${WEAPONS[event.weapon].name}`);
      }
    }
  }

  /**
   * 播一段修炼 / 战斗的新素材（修炼-打坐、战斗-起手、法宝-水枪 等）。这些素材不注册进动画池
   * （用户的 main-config.jsonc 会整段替换 animations），一律走 /anim 的 url 形态；
   * 素材缺了只是那一下没动画，播之前不查文件在不在。
   * 注意：之后任何带 anim 的气泡（/broadcast 默认联动说话动画）都会把它顶掉——
   * 要边播边说话就用 anim: false 的气泡（X3 的对战演出都得这样）。
   * @param facing 对战要面朝对手（素材统一画成朝左，宠物朝右站时整段镜像）
   * @param rate 倍速（0.5–3）：让一段 4–6 秒的素材正好占满时间线上的一步（battle-show 算好传进来）
   */
  function playExtra(name: string, options: { facing?: 'left' | 'right'; rate?: number } = {}): Promise<void> {
    return petRequest('POST', '/anim', {
      url: `${deps.petBase}/thumb/main/${encodeURIComponent(name)}.webm`,
      ...(options.facing ? { facing: options.facing } : {}),
      ...(options.rate === undefined ? {} : { rate: options.rate }),
    })
      .then((result) => {
        if (result.ok !== true) log(`播放动画失败（${name}）：${JSON.stringify(result)}`);
      })
      .catch((error: unknown) => log(`播放动画失败（${name}）：${errorText(error)}`));
  }

  /**
   * 播一段**动画池里的现有素材**（`/anim` 的名字形态；§X4 渡劫失败播「工作状态-垂头叹气冒汗」）。
   * 池里的名字由用户的 main-config.jsonc 整段替换（animations.events.workStatus 那一档），
   * 名字不在池里宿主回 unknown-animation——只是那一下没动画，气泡和气血条照旧（§2.3 的素材缺失口径）。
   */
  function playPooled(name: string, rate: number): Promise<void> {
    return petRequest('POST', '/anim', { name, rate })
      .then((result) => {
        if (result.ok !== true) log(`播放池内动画失败（${name}）：${JSON.stringify(result)}`);
      })
      .catch((error: unknown) => log(`播放池内动画失败（${name}）：${errorText(error)}`));
  }

  /**
   * 开这一场的**特效窗口**（X7）：盖住两只宠物，把飞行物从出手方手里画到对方身上。
   * 两只的舞台：自家宠物从 `homePet.box()` 推、对手从它窗口的 bounds 推（都在 fx-window.ts 的纯函数里）；
   * 朝向跟着「对手在哪一边」——自家宠物面朝对手、对手面朝自家宠物，`hand` 才落在挥出的那只手上。
   * 摆不了（还没收到宠物位置）时那边打一行 warn、回一个空操作的窗口：时间线、台词、气血条照常走。
   */
  function openShowFx(foeBounds: () => Rect | null, foeOnLeft: () => boolean, foeShadow = false): FxWindow {
    return openFxWindow(
      electron,
      `${new URL(deps.petBase).origin}/app/fx`,
      { base: `${deps.petBase}/pic/fx/`, names: FX_ASSETS },
      (): [Stage | null, Stage | null] => {
        const box = homePet.box();
        if (!box) return [null, null];
        // 两只面对面：自家宠物面朝对手（口径同 runTrial / runHostSparShow 的 playExtra facing），
        // 对手窗口面朝自家宠物（`GuestWindow` 的 face 也是这一套）
        const selfFacing: 'left' | 'right' = foeOnLeft() ? 'left' : 'right';
        const foeRect = foeBounds();
        const foe = foeRect ? foeStage(foeRect, selfFacing === 'left' ? 'right' : 'left') : null;
        return [homeStage(box, selfFacing), foe];
      },
      () => {
        const box = homePet.box();
        const point = box
          ? { x: box.left + box.size / 2, y: box.top + box.size / 2 }
          : electron.screen.getCursorScreenPoint();
        return electron.screen.getDisplayNearestPoint(point).workArea;
      },
      (message) => log(`修炼：${message}`),
      { foeShadow },
    );
  }

  // ---------- 历练（Y3） ----------

  /** 演一场（Y2 对手窗口 + 擂台 + 特效层，速战 / 完整）与收窗口；流程只拿到「演一场」这个 Promise */
  const adventureShows = createAdventureShows({
    electron,
    petBase: deps.petBase,
    home: homePet.box,
    openFx: openShowFx,
    holdPet,
    releasePet,
    setBattle: (show) => {
      battle = show;
    },
    refreshMenu: () => void refreshMenu(),
    playExtra: (anim, options) => void playExtra(anim, options),
    say: (text, options) => void say(text, options),
    stageLabel: () => cultivationOn()?.view().label ?? '',
    disposed: () => disposed,
    closeHoldMs: CLOSE_HOLD_MS,
  });

  /** 历练（Y3）：小窗与流程；存读档、演出、宠物动作、模型总结都从外面注入。修炼开着才建（设置里后开的也算） */
  function ensureAdventure(): AdventureFlow | null {
    if (adventure) return adventure;
    const practice = cultivationOn();
    if (!practice) return null;
    adventure = new AdventureFlow({
      def: SANWANG,
      openWindow: () =>
        openAdventureWindow(electron, `${new URL(deps.petBase).origin}/app/adventure`, deps.petBase, homePet.box, {
          prefer: adventurePrefer(),
        }),
      fight: adventureShows.fight,
      skipFight: skipTrial,
      play: (anim) => void playExtra(anim),
      say: (text, options) => void say(text, options),
      compose,
      getRun: () => practice.adventureRun(),
      saveRun: (run) => practice.saveRun(Date.now(), run),
      done: (run, reason) => practice.adventureDone(Date.now(), run, reason),
      onEvents: (events, now) => onCultivation(now, events, { anim: false }),
      diary: (text) => diary.note(Date.now(), 'cultivate', text),
      progress: () => practice.adventureProgress(SANWANG.id),
      fighter: () => practice.fighter(petName()),
      stage: () => practice.view().stage,
      petName,
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      random: Math.random,
      onChange: () => void refreshMenu(),
    });
    return adventure;
  }

  /** 开小窗：存档里有没走完的一趟就接着走 */
  async function runAdventure(): Promise<void> {
    const flow = ensureAdventure();
    if (!flow || trip !== null || hosting !== null) return;
    await flow.open();
    void refreshMenu();
  }

  /** 小窗放宠物哪一边：和对手窗口相反（对手默认站左边，小窗就放右边） */
  function adventurePrefer(): 'left' | 'right' {
    const box = homePet.box();
    if (!box) return 'right';
    const workArea = electron.screen.getDisplayNearestPoint({
      x: box.left + box.size / 2,
      y: box.top + box.size / 4,
    }).workArea;
    return guestSide(guestBounds(box, workArea, undefined, { scale: 1, tight: true }), box) === 'left'
      ? 'right'
      : 'left';
  }

  // ---------- 心魔试炼（X3 演出） ----------

  /**
   * 开一场心魔试炼：心魔窗口 + 擂台 → 引擎算一场 → 按时间线演 → 算奖励、记日记、收摊、说赛后感言。
   * 演法（§X3）：每句台词走 /broadcast 的 anim: false、时长和一步相当，下一句自然顶替上一句；
   * 台词不进说话队列（它们按时间线走），但碎碎念与自动看屏幕在这期间让路。
   * 收摊不等模型（§X14）：菜单、窗口、记账都在 compose 之前，赛后感言回来只负责说。
   */
  async function runTrial(): Promise<void> {
    const practice = cultivationOn();
    if (!practice || battle || trip || hosting) return;
    // 上一场演完还没收完的那组立刻关：新一场不能和它叠着，也不能让它稍后收摊时关错窗口（§X14）
    for (const old of [...trialWindowGroups]) closeTrialWindows(old, 0);
    let windows: TrialWindows | null = null;
    const you = practice.fighter(petName());
    const foe = shadowOf(you);
    const events = fight(you, foe, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const steps = timeline(events, [you.name, foe.name], Math.random, [you.skills, foe.skills]);
    const guest = openGuestWindow(
      electron,
      `${new URL(deps.petBase).origin}/app/guest`,
      foe.name,
      homePet.box,
      () => undefined, // 心魔不响应戳一下的反应
      // 对战等大、贴身：攻击特效的飞行距离才对得上素材里的命中时刻（串门维持小一号的表意）
      { tint: 'shadow', scale: 1, tight: true },
    );
    const arena = openArenaWindow(
      electron,
      `${new URL(deps.petBase).origin}/app/arena`,
      homePet.box,
      () => windows?.guest.bounds() ?? null,
    );
    // 心魔要播的动画先取到窗口里（X7：换源不等网络，出手才和飞行物对得上）
    guest.preload(SHOW_ANIMS);
    // 特效层（X7）：飞行物从出手方手里飞到对方身上，命中那一刻对方才开始反应
    // 心魔放出来的飞行物和命中特效也用它的暗紫配色（手里那件暗色道具出手时颜色才接得上，不突然变鲜艳）
    const fx = openShowFx(
      () => windows?.guest.bounds() ?? null,
      () => guest.side === 'left',
      true,
    );
    windows = { guest, arena, fx };
    trialWindowGroups.add(windows);
    const scoreboard = arenaScoreboard({
      self: { label: `${you.name} · ${practice.view().label}`, maxHp: you.hp },
      foe: { label: foe.name, maxHp: foe.hp },
    });
    // 自家宠物面朝对手：素材统一画成朝左，心魔站左边就原样播、站右边就镜像
    battle = new BattleShow(steps, {
      self: {
        play: (anim, rate) => void playExtra(anim, { facing: guest.side === 'left' ? 'left' : 'right', rate }),
        // 演出台词：anim 一律 false（带 anim 的气泡会顶掉正在播的动画），时长跟着时间线的一步
        say: (line, durationMs) => void say(line, { anim: false, durationMs }),
      },
      foe: {
        play: (anim, rate) => guest.play(anim, rate),
        say: (line, durationMs) => guest.say(line, durationMs),
      },
      arena: (hp) => {
        arena.place(homePet.box(), guest.bounds());
        // 左右跟着两只的实际位置：心魔站在自家宠物左边时它那条在左
        arena.update(scoreboard(hp, guest.side === 'left'));
        // 特效层跟着两只挪（放一发时也会自己挪一次）
        fx.place();
      },
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
    });
    void refreshMenu();
    const end = events[events.length - 1];
    const won = end.kind === 'end' && end.winner === 0;
    // 先占住宠物再开演：两段动画之间别插播随机活动（等锁的这一下可能被退出打断，所以留住这一场）
    const show = battle;
    await holdPet(steps);
    await show.run();
    battle = null;
    releasePet(disposed ? 0 : CLOSE_HOLD_MS);
    // 中途退出了（dispose）：别再把这场算进存档
    if (disposed) return;
    // 奖励（修为进账、掉法宝、战绩都在 trialDone 里；冒泡与日记在 onCultivation）
    onCultivation(Date.now(), practice.trialDone(Date.now(), won), { anim: false });
    diary.note(Date.now(), 'cultivate', won ? '心魔试炼打赢了' : '心魔试炼没打赢');
    // 演完马上收摊（§X14）：菜单换回来、这一场的窗口按 CLOSE_HOLD_MS 收，都不等赛后感言
    void refreshMenu();
    closeTrialWindows(windows, CLOSE_HOLD_MS);
    // 赛后感言：走 compose（只带人设，§2.2 的口径），生成不了用模板；anim: false 别顶掉收场动画。
    // 回来时已经开了下一场（battle 不是 null）就不说了，免得插进下一场的台词里
    const instruction =
      `你刚跟自己的心魔打了一架（${you.name} 对 ${foe.name}），${won ? '你赢了' : '你输了'}。` +
      '跟主人说一句赛后感言。' +
      (won ? '别提修为和法宝的数字。' : '输了不丢人，放平心态，下次再来。');
    const text = cleanText(
      await compose(instruction, won ? '心魔被打跑了，呼～' : '心魔太强了，我输了，下次再来～'),
      LINE_MAX,
    );
    if (battle === null) void say(text, { anim: false });
  }

  /** 关掉某一组心魔试炼的窗口：0 = 立刻，`CLOSE_HOLD_MS` = 演完停一会儿；同一组只关一次 */
  function closeTrialWindows(windows: TrialWindows, afterMs: number): void {
    const close = (): void => {
      if (!trialWindowGroups.delete(windows)) return;
      windows.guest.close(0);
      windows.arena.close(0);
      windows.fx.close(0);
    };
    if (afterMs <= 0) close();
    else setTimeout(close, afterMs);
  }

  /** 关掉所有还没收完的心魔窗口、擂台与特效层（有人来敲门、退出时立刻关；新开一场时先清上一组） */
  function closeTrial(afterMs: number): void {
    for (const windows of [...trialWindowGroups]) closeTrialWindows(windows, afterMs);
  }

  /** 快进：停掉剩下的步骤，直接看结果（菜单「修炼/快进」，有人敲门时也用它收场；渡劫同样用它） */
  function skipTrial(): void {
    battle?.skip();
  }

  // ---------- 渡劫（X4） ----------

  /**
   * 开一场渡劫：扛天雷 → 成功进下一个大境界并挂出二选一，失败扣修为（不掉境界，不设冷却）。
   * 演出复用 X3 的执行器，**没有对手窗口**（`foe: null`，也不开擂台：只有一只宠物一道一道挨雷，
   * 气泡报「第 i/N 道天雷 -25」）；吃丹先播 `修炼-服丹`，每道雷 `修炼-挨雷`，
   * 成功播 `修炼-突破`、失败播池里的 `工作状态-垂头叹气冒汗`。
   * @param wantPill 主人点的是「服丹后渡劫」：气血上限 ×1.2，这一颗丹在 tribulationDone 里扣掉
   */
  async function runTribulation(wantPill: boolean): Promise<void> {
    const practice = cultivationOn();
    if (!practice || battle || trip || hosting) return;
    const plan = practice.tribulationPlan(Date.now());
    if (!plan) {
      void say('还没修到圆满，先不急～');
      return;
    }
    if (wantPill && !plan.canPill) {
      void say('手里没有破境丹，炼成了再吃～');
      return;
    }
    const you = practice.tribulationFighter(petName(), wantPill);
    const events = tribulate(you, plan.strikes, plan.stage, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // 台词报「第 i/N 道」的 N 用 plan 的雷数：没扛住时引擎提前收尾，事件里只有前几道雷
    const steps = timeline(events, [you.name, '天雷'], Math.random, [you.skills, []], {
      tribulation: { pill: wantPill, strikes: plan.strikes },
    });
    // 特效层（X7 第二步）：每道雷的乌云与闪电画在渡劫者头顶（没有对手；朝向按素材原样朝左）
    const fx = openShowFx(
      () => null,
      () => true,
    );
    tribulationFx = fx;
    battle = new BattleShow(steps, {
      self: {
        // 渡劫没有对手，不指定朝向（素材朝左原样播即可，天雷在头顶）
        play: (anim, rate, from) => void (from === 'pool' ? playPooled(anim, rate) : playExtra(anim, { rate })),
        say: (line, durationMs) => void say(line, { anim: false, durationMs }),
      },
      foe: null,
      // 渡劫不开擂台：没有对手，两条血没得画
      arena: () => fx.place(),
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
    });
    void refreshMenu();
    const end = events[events.length - 1];
    const survived = end.kind === 'end' && end.winner === 0;
    const show = battle;
    await holdPet(steps);
    await show.run();
    battle = null;
    releasePet(disposed ? 0 : CLOSE_HOLD_MS);
    closeTribulationFx(CLOSE_HOLD_MS);
    // 中途退出了（dispose）：这场不算，境界与修为都不动
    if (disposed) return;
    // 结果进存档（属性加成、扣修为、丹数、二选一都在这一步）；冒泡与日记在 onCultivation
    onCultivation(Date.now(), practice.tribulationDone(Date.now(), survived, wantPill), { anim: false });
    // 结果感言走 compose（只带人设，口径同 X3 的赛后感言），生成不了用模板；anim: false 别顶掉收场动画
    const instruction =
      `你刚渡了一次劫（${plan.strikes} 道天雷，${wantPill ? '吃了破境丹' : '没吃丹'}），` +
      `${survived ? `成功突破到${plan.nextLabel}` : '没扛住，被天雷劈回原形'}。跟主人说一句感言。` +
      (survived ? '别提境界和招式。' : '渡劫失败不掉境界，歇一歇还能再渡，别灰心。');
    const text = cleanText(
      await compose(instruction, survived ? '渡劫成功啦，呼～' : '天雷太猛了，我没扛住……再来一次！'),
      LINE_MAX,
    );
    void say(text, { anim: false });
    void refreshMenu();
  }

  /** 关掉渡劫的特效层（演完 `CLOSE_HOLD_MS` 后收尾；退出时立刻关） */
  function closeTribulationFx(afterMs: number): void {
    const closing = tribulationFx;
    if (!closing) return;
    tribulationFx = null;
    closing.close(afterMs);
  }

  /**
   * 渡劫的右键项（圆满时替换 X1 的「突破」）：直接渡；有丹时多一项「服丹后渡劫」
   * （气血上限 ×1.2，一次最多吃 1 颗）。没在打、没出门、家里没客人时才有，和「心魔试炼」同一口径。
   */
  function tribulationActions(practice: Cultivation, actions: Map<string, () => unknown>): void {
    // 历练小窗开着时不能开心魔试炼和渡劫：先关了小窗再说
    if (battle || trip !== null || hosting !== null || adventure?.active === true) return;
    const plan = practice.tribulationPlan(Date.now());
    if (!plan) return;
    actions.set(`${MENU_CULTIVATION_GROUP}/渡劫`, () => void runTribulation(false));
    if (plan.canPill) actions.set(`${MENU_CULTIVATION_GROUP}/服丹后渡劫`, () => void runTribulation(true));
  }

  // ---------- 切磋（X5） ----------

  /**
   * 正在进行的切磋（两边各自记自己这一侧；一台电脑要么在家接待、要么出门做客，不会两边都有）：
   *   - host：invited = 已把 spar-invite 捎给客人，等它发 /v1/spar 来；card = 已回了名帖与随机数，
   *     等客人 reveal（对不上或超时都按客人认输）；showing = 开打了（演出在 battle 里跑）。
   *   - guest：asking = 已发了 /v1/spar（带着随机数的承诺）；showing = 在转播那一场（也在 battle 里跑）。
   * 战绩与奖励都在「开打」那一步记（两边同时记各自的账），演出只是回放：快进、客人走、退出都不会把账弄乱。
   */
  interface SparState {
    role: 'host' | 'guest';
    stage: 'invited' | 'card' | 'asking' | 'showing';
    since: number;
    /** 等客人应战 / 亮随机数的定时器（超时按客人认输）；客人这一侧没有 */
    timer: ReturnType<typeof setTimeout> | null;
    /** host：客人的承诺与名帖、自己亮出去的随机数 */
    commit?: string;
    guestCard?: SparCard;
    hostNonce?: string;
  }

  let spar: SparState | null = null;

  /**
   * 这一场切磋开着的窗口：对手窗口（主人家那边是客人窗口、客人这边是「主人家的宠物」窗口；心魔试炼没有）、
   * 擂台、特效层。每一场记自己的一份引用——上一场演完到 `CLOSE_HOLD_MS` 收摊之间又开了下一场时，收摊只关自己那份，
   * 不会把下一场的窗口误关掉，也不会把上一场的窗口丢下没人关（§X11「顺手发现」第 1 条就是漏关的教训）。
   */
  interface SparWindows {
    foe: GuestWindow | null;
    arena: ArenaWindow;
    fx: FxWindow;
  }
  /** 还没收完的每一场（上一场演完等 `CLOSE_HOLD_MS` 收摊时又开了下一场，两组都要在退出 / 回家时立刻关掉） */
  const sparWindows = new Set<SparWindows>();

  /** 收摊一场切磋（客人走了 / 回家了 / 退出）：定时器停掉、演出停掉、窗口全部立刻关 */
  function cancelSpar(): void {
    const current = spar;
    spar = null;
    if (current) {
      if (current.timer !== null) clearTimeout(current.timer);
      // dispose 只是让 run() 立刻 resolve；battle 不清零的话菜单永远挂着「快进」、
      // 后续心魔 / 渡劫 / 切磋全被 `if (battle)` 挡住（真机踩过：一场演完全锁死）
      battle?.dispose();
      battle = null;
    }
    // 演完到 `CLOSE_HOLD_MS` 收摊之间回家 / 被请回也要立刻关（那会儿 spar 已经是 null，靠窗口组收尾）
    for (const windows of [...sparWindows]) closeSparWindows(windows, 0);
  }

  /**
   * 关掉某一场切磋的窗口：0 = 立刻（回家 / 被请回 / 退出），`CLOSE_HOLD_MS` = 演完留一会儿再收。
   * 只按传进来的这一组关——上一场的收摊不会把下一场的窗口误关掉，也不会把上一场丢下没人关。
   */
  function closeSparWindows(windows: SparWindows, afterMs: number): void {
    if (!sparWindows.has(windows)) return;
    const close = (): void => {
      if (!sparWindows.delete(windows)) return;
      windows.foe?.close(0);
      windows.arena.close(0);
      windows.fx.close(0);
    };
    if (afterMs <= 0) close();
    else setTimeout(close, afterMs);
  }

  /** 主人家发起切磋（菜单「串门/和客人切磋」）：把 spar-invite 捎给客人，等它应战（§X5 第 1 步） */
  function inviteSpar(): void {
    const current = hosting;
    if (!current?.visitor.id || !cultivationOn() || spar || battle) return;
    if (!visitHost?.tell({ type: 'spar-invite' })) return;
    const state: SparState = { role: 'host', stage: 'invited', since: Date.now(), timer: null };
    state.timer = setTimeout(() => {
      if (spar !== state || state.stage !== 'invited') return;
      spar = null;
      log(`串门：${current.visitor.pet} 没接切磋的招`);
      void say(`${current.visitor.pet} 好像没接招～`);
      void refreshMenu();
    }, sparWaitMs);
    spar = state;
    void say(`${current.visitor.pet}，来跟我过两招～`);
    void refreshMenu();
  }

  /** 主人家这一侧收到 /v1/spar（客人应约或主动）：off / busy / no-id 在这里答，答应了回名帖与随机数 */
  async function hostSpar(visitor: Visitor, card: SparCard, commit: string): Promise<SparReply> {
    const practice = cultivationOn();
    if (!practice) return { ok: false, reason: 'off' };
    // 在打才算忙；等客人应战（invited）的那份不算——客人现在就是来应战的
    if (battle || (spar && !(spar.role === 'host' && spar.stage === 'invited'))) return { ok: false, reason: 'busy' };
    // 没验证过身份的客人没有稳定的 id：修为奖励没法按邻居去重、邻居簿也没得记，不接
    if (!visitor.id) return { ok: false, reason: 'no-id' };
    const hostNonce = randomSparNonce();
    const state: SparState = {
      role: 'host',
      stage: 'card',
      since: Date.now(),
      timer: null,
      commit,
      guestCard: card,
      hostNonce,
    };
    // 客人应了邀约（或自己先开的口）：把等邀约的那份状态连定时器一起收掉
    const invited = spar;
    if (invited && invited.timer !== null) clearTimeout(invited.timer);
    state.timer = setTimeout(() => {
      if (spar !== state || state.stage !== 'card') return;
      guestConceded(visitor, '超时没亮随机数');
    }, sparWaitMs);
    spar = state;
    log(`串门：${visitor.pet} 应战切磋（${stageLabel(card.stage)}）`);
    return { ok: true, card: sparCardOf(practice.fighter(petName()), practice.view().stage), nonce: hostNonce };
  }

  /** 客人没亮随机数（对不上 / 超时，§X5）：按客人认输记，这场不开打 */
  function guestConceded(visitor: Visitor, why: string): void {
    const state = spar;
    if (state?.timer) clearTimeout(state.timer);
    spar = null;
    const practice = cultivationOn();
    if (practice && visitor.id) {
      onCultivation(Date.now(), practice.sparDone(Date.now(), visitor.id, true), { anim: false });
      neighbors.recordSpar(visitor.id, true);
    }
    diary.note(Date.now(), 'cultivate', `和 ${visitor.owner} 家的 ${visitor.pet} 切磋，它${why}，算它认输`);
    void say(`${visitor.pet} ${why}，这场算它认输啦～`, { anim: false });
    void refreshMenu();
  }

  /** 主人家这一侧收到 /v1/spar/reveal（客人亮随机数）：核承诺，对不上或超时都按客人认输，核过了开打 */
  async function hostReveal(visitor: Visitor, nonce: string, line: string): Promise<SparRevealReply> {
    const state = spar;
    if (!state || state.role !== 'host' || state.stage !== 'card') return { ok: false, reason: 'late' };
    if (Date.now() - state.since > sparWaitMs) {
      guestConceded(visitor, '超时没亮随机数');
      return { ok: false, reason: 'late' };
    }
    if (sparCommit(nonce) !== state.commit) {
      guestConceded(visitor, '随机数对不上');
      return { ok: false, reason: 'mismatch' };
    }
    if (state.timer !== null) clearTimeout(state.timer);
    state.stage = 'showing';
    void runHostSparShow(visitor, state, nonce, line);
    return { ok: true };
  }

  /**
   * 主人家这一侧的切磋演出：两边各自用同一对随机数算同一场（必然一致），这边演全套——
   * 自家宠物对客人窗口（照旧粉色），头顶擂台两条血，名帖里的境界上名牌。
   * 账（修为、战绩、邻居簿、日记）在开演前就记下：演出只是回放，中途快进 / 收摊都不会把账弄乱。
   */
  async function runHostSparShow(
    visitor: Visitor,
    state: SparState,
    guestNonce: string,
    guestLine: string,
  ): Promise<void> {
    const practice = cultivationOn();
    const current = hosting;
    if (!practice || !current || !visitor.id || !state.guestCard || !state.hostNonce) return;
    const guestCard = state.guestCard;
    const you = practice.fighter(petName());
    const foe = cardFighter(visitor.pet, guestCard);
    const events = sparFight(you, foe, guestNonce, state.hostNonce);
    const end = events[events.length - 1];
    const won = end.kind === 'end' && end.winner === 0;
    // 记账：修为进账、战绩、邻居簿、日记（冒泡的 anim 一律 false，演出马上开场）
    onCultivation(Date.now(), practice.sparDone(Date.now(), visitor.id, won), { anim: false });
    neighbors.recordSpar(visitor.id, won);
    diary.note(Date.now(), 'cultivate', `和 ${visitor.owner} 家的 ${visitor.pet} 切磋，${won ? '赢了' : '输了'}`);
    // 台词也用这一对随机数挑（X12）：客人那边按同一颗种子排，两块屏幕上的解说逐句相同
    const steps = timeline(events, [you.name, foe.name], sparLineRng(guestNonce, state.hostNonce), [
      you.skills,
      foe.skills,
    ]);
    const arena = openArenaWindow(electron, `${new URL(deps.petBase).origin}/app/arena`, homePet.box, () =>
      current.window.bounds(),
    );
    // 客人要播的动画先取到窗口里（X7：换源不等网络，出手才和飞行物对得上）
    current.window.preload(SHOW_ANIMS);
    // 特效层（X7）：客人窗口就是这一场的对手（照旧粉色；体型进门时就定了，跟随切磋复用串门的客人窗口）
    const fx = openShowFx(
      () => current.window.bounds(),
      () => current.window.side === 'left',
    );
    const windows: SparWindows = { foe: null, arena, fx };
    sparWindows.add(windows);
    const scoreboard = arenaScoreboard({
      self: { label: `${you.name} · ${practice.view().label}`, maxHp: you.hp },
      foe: { label: `${foe.name} · ${stageLabel(guestCard.stage)}`, maxHp: foe.hp },
    });
    battle = new BattleShow(steps, {
      self: {
        // 自家宠物面朝对手（素材统一画成朝左，客人站右边时整段镜像）
        play: (anim, rate) => void playExtra(anim, { facing: current.window.side === 'left' ? 'left' : 'right', rate }),
        say: (line, durationMs) => void say(line, { anim: false, durationMs }),
      },
      foe: {
        play: (anim, rate) => current.window.play(anim, rate),
        say: (line, durationMs) => current.window.say(line, durationMs),
      },
      arena: (hp) => {
        arena.place(homePet.box(), current.window.bounds());
        // 左右跟着两只的实际位置：客人站在自家宠物左边时它那条在左
        arena.update(scoreboard(hp, current.window.side === 'left'));
        fx.place();
      },
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
    });
    void refreshMenu();
    const show = battle;
    await holdPet(steps);
    await show.run();
    battle = null; // 不清零的话「快进」常驻菜单、下一场被 guard 挡住（真机踩过）
    releasePet(disposed ? 0 : CLOSE_HOLD_MS);
    const cancelled = spar !== state || disposed;
    if (spar === state) spar = null;
    if (cancelled) return;
    // 客人跟着 reveal 捎回来的赛后感言先上客人窗口的气泡；自家的走 compose（只带人设，每场 +1 次调用）。
    // 演完马上收摊（§X14）：菜单换回来、这一场的窗口按 CLOSE_HOLD_MS 收，都不等自家的赛后感言
    if (guestLine) current.window.say(guestLine, LINE_MS);
    void refreshMenu();
    closeSparWindows(windows, CLOSE_HOLD_MS);
    const instruction =
      `你刚和来串门的${visitor.pet}（${visitor.owner} 家的）切磋了一场，${won ? '你赢了' : '你输了'}。` +
      '跟主人说一句赛后感言。' +
      (won ? '别提修为和法宝的数字。' : '切磋点到为止，输了不丢人，下次再战。');
    const text = cleanText(await compose(instruction, won ? '切磋赢啦，承让承让～' : '切磋输了，下次再战！'), LINE_MAX);
    // 回来时已经开了下一场（battle 不是 null）就不说了，免得插进下一场的台词里
    if (battle === null) void say(text, { anim: false });
  }

  /**
   * 客人这一侧的切磋（菜单「串门/找主人家的宠物切磋」；收到 spar-invite 也走这里，§X5 的自动应战）：
   * 发名帖与承诺 → 拿到主人家的随机数后这一场就定了 → 编好自己的赛后感言跟着 reveal 带过去 →
   * 记账、在自家屏幕上把这一场演全套（对手是主人家的宠物窗口；`say` 会先把宠物叫回家，台词全走转播）。
   */
  async function startGuestSpar(): Promise<void> {
    const current = trip;
    const practice = cultivationOn();
    if (!current || !practice || spar || battle) return;
    const state: SparState = { role: 'guest', stage: 'asking', since: Date.now(), timer: null };
    spar = state;
    relay('（切磋）跟它过两招～');
    void refreshMenu();
    const ownNonce = randomSparNonce();
    let reply: SparReply;
    try {
      reply = await sendSpar(current.host, {
        token: current.token,
        mode: SPAR_MODE,
        card: sparCardOf(practice.fighter(petName()), practice.view().stage),
        commit: sparCommit(ownNonce),
      });
    } catch (error) {
      log(`串门：切磋的请求没送到：${errorText(error)}`);
      if (spar === state) spar = null;
      relay('（切磋）没送到，改天再切');
      return;
    }
    if (trip !== current || spar !== state) return;
    if (!reply.ok) {
      guestSparFailed(state, reply.reason);
      return;
    }
    const you = practice.fighter(petName());
    const hostFighter = cardFighter(current.host.pet, reply.card);
    // 名帖里的境界没法验证真伪（§设计 4.7）：奖励小、还封顶，照它报的打就是了
    const events = sparFight(hostFighter, you, ownNonce, reply.nonce);
    const end = events[events.length - 1];
    const won = end.kind === 'end' && end.winner === 1;
    // 感言先编好（跟着 reveal 带过去，在主人家的客人窗口里说）；编太久退回模板，别拖过主人家的时限
    const remark = await sparRemark(current, won);
    if (trip !== current || spar !== state) return;
    let revealed: SparRevealReply;
    try {
      revealed = await sendReveal(current.host, { token: current.token, nonce: ownNonce, line: remark });
    } catch (error) {
      log(`串门：随机数没亮出去：${errorText(error)}`);
      guestSparFailed(state, 'late');
      return;
    }
    if (trip !== current || spar !== state) return;
    if (!revealed.ok) {
      guestSparFailed(state, revealed.reason);
      return;
    }
    // 记账（对面同时也在记它的）：修为进账、战绩、日记
    onCultivationRelayed(Date.now(), practice.sparDone(Date.now(), current.host.id, won));
    if (current.verified) neighbors.recordSpar(current.host.id, won);
    diary.note(
      Date.now(),
      'cultivate',
      `和 ${current.host.owner} 家的 ${current.host.pet} 切磋，${won ? '赢了' : '输了'}`,
    );
    // 演出：跟主人家同一张时间线（同一对随机数、同一个 timeline、同一颗台词种子）。引擎里主人家是 0 号，
    // 这边先按引擎序号排好名字与招式表，再换边成本地视角（自家宠物 0 号、对手 1 号）
    const ordered = timeline(events, [hostFighter.name, you.name], sparLineRng(ownNonce, reply.nonce), [
      hostFighter.skills,
      you.skills,
    ]);
    const steps = swapSides(ordered);
    state.stage = 'showing';
    // 对手窗口：本机 /app/guest，名牌是主人家的；默认粉色——两边都是自家原色、对方粉色，和主人家屏幕对称
    const foe = openGuestWindow(
      electron,
      `${new URL(deps.petBase).origin}/app/guest`,
      `${current.host.owner} 家的 ${current.host.pet}`,
      homePet.box,
      () => undefined,
      { scale: 1, tight: true },
    );
    // 对手要播的动画先取到窗口里（X7：换源不等网络，出手才和飞行物对得上）
    foe.preload(SHOW_ANIMS);
    const arena = openArenaWindow(electron, `${new URL(deps.petBase).origin}/app/arena`, homePet.box, () =>
      foe.bounds(),
    );
    // 特效层：对手是主人家的宠物窗口（默认粉色，不用心魔配色）
    const fx = openShowFx(
      () => foe.bounds(),
      () => foe.side === 'left',
    );
    const windows: SparWindows = { foe, arena, fx };
    sparWindows.add(windows);
    const scoreboard = arenaScoreboard({
      self: { label: `${you.name} · ${practice.view().label}`, maxHp: you.hp },
      foe: { label: `${hostFighter.name} · ${stageLabel(reply.card.stage)}`, maxHp: hostFighter.hp },
    });
    battle = new BattleShow(steps, {
      self: {
        // 自家宠物面朝对手（素材统一画成朝左，对手站右边时整段镜像）
        play: (anim, rate) => void playExtra(anim, { facing: foe.side === 'left' ? 'left' : 'right', rate }),
        // say 会先把宠物叫回家：演出台词只发 anim: false 的转播气泡（演出期间 showRelay 不改亮度）
        say: (line, durationMs) => showRelay(line, durationMs),
      },
      foe: {
        play: (anim, rate) => foe.play(anim, rate),
        say: (line, durationMs) => foe.say(line, durationMs),
      },
      arena: (hp) => {
        arena.place(homePet.box(), foe.bounds());
        // 左右跟着两只的实际位置：主人家的宠物站在自家宠物左边时它那条在左
        arena.update(scoreboard(hp, foe.side === 'left'));
        fx.place();
      },
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
    });
    // 做客时自家宠物是半透明的（AWAY_OPACITY）：开演亮回原色；演出期间转播不改亮度，
    // 等窗口一起收摊（CLOSE_HOLD_MS）后才退回半透明
    if (relayTimer !== null) {
      clearTimeout(relayTimer);
      relayTimer = null;
    }
    fadeHome(electron, 1);
    void refreshMenu();
    const show = battle;
    await holdPet(steps);
    await show.run();
    battle = null; // 不清零的话「快进」常驻菜单、下一场被 guard 挡住（真机踩过）
    releasePet(disposed ? 0 : CLOSE_HOLD_MS);
    const cancelled = trip !== current || spar !== state || disposed;
    if (spar === state) spar = null;
    if (cancelled) return;
    // 结果与感言照旧转播（演完了，按平时的转播调亮、到点退回半透明）
    relay(won ? '（切磋）这场我赢啦！' : '（切磋）这场输了，下次再战～');
    relay(remark);
    void refreshMenu();
    closeSparWindows(windows, CLOSE_HOLD_MS);
    // 窗口收摊时退回做客的半透明；转播的气泡还挂着就交给它到点再退（又开了一场就不动）
    setTimeout(() => {
      if (trip === current && battle === null && relayTimer === null) fadeHome(electron, AWAY_OPACITY);
    }, CLOSE_HOLD_MS);
  }

  /** 客人的赛后感言：按人设编一句（只带人设，§2.2 的口径），编太久退回模板（模型卡住别拖垮 reveal） */
  async function sparRemark(current: Trip, won: boolean): Promise<string> {
    const { owner, pet } = current.host;
    const instruction =
      `你正在${owner}家做客，刚和它家的宠物${pet}切磋了一场，${won ? '你赢了' : '你输了'}。说一句赛后感言。` +
      (won ? '别提修为和法宝的数字。' : '切磋点到为止，输了不丢人。');
    const fallback = won ? '切磋赢啦，承让承让～' : '切磋输了，下次再战！';
    const composed = compose(instruction, fallback);
    const capped = new Promise<string>((done) => setTimeout(() => done(fallback), SPAR_REMARK_CAP_MS));
    return Promise.race([composed, capped]);
  }

  /**
   * 客人这边没打成：对面关着 / 正忙 / 版本不同……说清楚原因就好，谁都没记账；
   * 认输类的（随机数对不上、没按时亮出去）对面已经按它赢记了账，这边同样按输记，两边才对得上。
   */
  function guestSparFailed(state: SparState, reason: SparFailure | 'mismatch' | 'late'): void {
    if (spar === state) spar = null;
    const current = trip;
    relay(`（切磋）${sparFailText(reason)}`);
    if (current && (reason === 'mismatch' || reason === 'late')) {
      const practice = cultivationOn();
      if (practice) onCultivationRelayed(Date.now(), practice.sparDone(Date.now(), current.host.id, false));
      if (current.verified) neighbors.recordSpar(current.host.id, false);
      diary.note(
        Date.now(),
        'cultivate',
        `和 ${current.host.owner} 家的 ${current.host.pet} 切磋，${
          reason === 'late' ? '没按时亮随机数' : '随机数没对上'
        }，认输了`,
      );
    }
    void refreshMenu();
  }

  /** 切磋没打成的原因，说给自家主人听（§X5 点名的两种说法在这里：还不会切磋、版本不一样） */
  function sparFailText(reason: SparFailure | 'mismatch' | 'late'): string {
    switch (reason) {
      case 'old-host':
        return '对方的桌宠还不会切磋';
      case 'off':
        return '对方没开修炼，切不了';
      case 'busy':
        return '对方正在切磋，等会儿吧';
      case 'version':
        return '两边版本不一样，切磋不了';
      case 'unsupported-mode':
        return '对方不支持这种打法';
      case 'bad-card':
        return '对方没看懂我的名帖';
      case 'no-id':
        return '对方没认出我，切不了';
      case 'bad-request':
        return '没打成';
      case 'mismatch':
        return '随机数没对上，算我认输';
      case 'late':
        return '亮随机数迟了，算我认输';
      default:
        return '已经回家了';
    }
  }

  /** 在别人家做客时的切磋奖励冒泡：say 会先把宠物叫回家，一律转播回来；日记照记（+20 也能顶出升级） */
  function onCultivationRelayed(now: number, events: CultivationEvent[]): void {
    for (const event of events) {
      if (event.kind === 'xp') {
        relay(`（切磋）这一场修为 +${event.amount}`);
      } else if (event.kind === 'stage-up') {
        relay(`（切磋）修为精进，到${stageLabel(event.stage)}啦～`);
        diary.note(now, 'cultivate', `修为精进，到了${stageLabel(event.stage)}`);
      } else if (event.kind === 'full') {
        relay('（切磋）修为圆满，可以渡劫了～');
        diary.note(now, 'cultivate', '修为圆满，可以渡劫了');
      }
    }
  }

  /**
   * 修炼的右键项（开关开着才有）：信息项带境界和百分比（变了才重新注册）；
   * 圆满时是「渡劫」（有丹再多一项「服丹后渡劫」，§X4 替换掉 X1 的「突破」）；
   * 渡劫成功后挂 10 分钟两项「领悟：X」；演一场时换成「快进」。
   */
  function cultivationActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    const practice = cultivationOn();
    if (!practice) return actions;
    const view = practice.view();
    actions.set(`${MENU_CULTIVATION_GROUP}/${view.label} · ${view.percent}%`, () => {
      const now = practice.view();
      void say(
        `我在${now.label}（${now.percent}%），气血 ${now.stats.hp}、灵力 ${now.stats.power}、` +
          `身法 ${now.stats.agility}、遁速 ${now.stats.speed}，有 ${now.weapons.length} 件法宝～`,
      );
    });
    // 历练（Y3）：开着修炼才有；存档里有没走完的一趟时带层数
    if (ensureAdventure()) {
      const run = practice.adventureRun();
      actions.set(`${MENU_CULTIVATION_GROUP}/历练${run ? `（第 ${run.layer} 层）` : ''}`, () => void runAdventure());
    }
    if (view.full) tribulationActions(practice, actions);
    // 二选一：两项「领悟：X」（点了才消失；10 分钟没人挑就由 cultivation 在 tick 里随机定一个）
    if (view.offer) {
      for (const skill of [view.offer.a, view.offer.b]) {
        actions.set(`${MENU_CULTIVATION_GROUP}/领悟：${SKILLS[skill].name}`, () => {
          onCultivation(Date.now(), practice.choose(Date.now(), skill));
          void refreshMenu();
        });
      }
    }
    // 心魔试炼：没在打、没出门、家里没客人时才有；打的时候换成「快进」
    if (battle) actions.set(`${MENU_CULTIVATION_GROUP}/快进`, skipTrial);
    else if (trip === null && hosting === null && adventure?.active !== true)
      actions.set(`${MENU_CULTIVATION_GROUP}/心魔试炼`, () => void runTrial());
    return actions;
  }

  // ---------- 右键菜单 ----------

  /**
   * 要注册的菜单项。宿主每个 owner 最多 20 项（`>` 就整份拒了，菜单从此不再更新），
   * 所以这里按优先级兜底截断：固定的两项 + 修炼（最多 4：信息、渡劫、服丹后渡劫、领悟×2 中的一种组合）
   * 在前，串门项在后——挤不下时先少列几个邻居 / 少几样一起玩和零食，「送客」「切磋」「心魔试炼」「渡劫」这些都要留。
   */
  function wantedLabels(): string[] {
    const labels = [MENU_LOOK, MENU_DIARY, ...cultivationActions().keys(), ...visitActions().keys()];
    return labels.length > MENU_ITEMS_MAX ? labels.slice(0, MENU_ITEMS_MAX) : labels;
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
      const action = cultivationActions().get(label) ?? visitActions().get(label);
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
          // 不等动作做完就接着轮询：动作可能很慢（敲门要等对方主人点头、看屏幕 / 写日记要等模型生成），
          // 等的话这段时间里后面的点击全被堵住，得等它结束才一起处理。各动作有自己的防重入保护
          // （screenBusy、knockingOn、trip……），并发点进来也乱不了；失败在这里兜底记日志，不能有未处理的拒绝
          if (pet !== null)
            void onMenuClick(label).catch((error: unknown) => log(`菜单项「${label}」没处理成：${errorText(error)}`));
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
        // 修炼：一轮活干完了（干满 30 秒才报「done」，口径在 claude-hooks），有机会炼成一颗破境丹
        const practice = cultivationOn();
        if (practice) onCultivation(Date.now(), practice.onClaudeDone(Date.now()));
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
    neighbors: {
      identityId: () => visitIdentity.id,
      list: () => neighbors.list(),
      setFriend: (id, friend) => neighbors.setFriend(id, friend),
      forget: (id) => neighbors.forget(id),
      clear: () => neighbors.clear(),
      resetIdentity() {
        if (hosting || trip || knockingOn) return false;
        resetVisitIdentity(deps.identityPath);
        visitIdentity = loadVisitIdentity(deps.identityPath, (message) => log(`串门：${message}`));
        // 关掉信标和接待，下一拍 syncVisit 用新身份重开；别的电脑要重新认这台电脑了
        if (neighborhood) {
          neighborhood.stop();
          neighborhood = null;
          log('串门：信标关了（要换新身份重开）');
        }
        if (visitHost) void closeHost();
        log('串门：换了新的串门身份');
        return true;
      },
    },
    cultivation: { view: () => cultivation?.view() ?? null },
    dispose() {
      disposed = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
      noteOpener.dispose();
      // 正在切磋：定时器、擂台、演出（或转播）都收掉
      cancelSpar();
      // 正在演一场：停掉剩下的步骤、立刻收窗口（不留下空转的心魔与擂台）
      battle?.dispose();
      battle = null;
      closeTrial(0);
      closeTribulationFx(0);
      // 历练：小窗和这一场的窗口都关掉；run 已经在存档里，不补结算
      adventure?.dispose();
      adventureShows.closeAll(0);
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

/** 这次见面聊过的句数（「（一起吃西瓜）」这类一起做过的事不算） */
function spokenCount(lines: readonly string[]): number {
  return lines.filter((line) => !line.startsWith('（')).length;
}

/** 熟人开关的菜单文案（X 是对方主人的昵称） */
function friendLabel(book: NeighborBook, id: string, owner: string): string {
  return book.get(id)?.friend === true ? `${owner} 不再是熟人` : `把 ${owner} 设为熟人`;
}

/** 点一下菜单项：是熟人的取消，不是的设为 */
function toggleFriend(book: NeighborBook, id: string): void {
  book.setFriend(id, book.get(id)?.friend !== true);
}

/** 捎话没捎成的经过（noteToHost 转播给主人用） */
function noteFailText(owner: string, result: NoteReply | null): string {
  switch (result && !result.ok ? result.reason : 'unreachable') {
    case 'not-friend':
      return `${owner} 那边没把我们当熟人`;
    case 'too-many':
      return '发太多了，等一会儿再捎';
    case 'old-host':
      return '对方的版本太旧，捎不了话';
    case 'sent-home':
    case 'not-visiting':
      return '已经回家了';
    default:
      return '没送到，再试一次';
  }
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

/** 平时打坐的间隔（40–60 分钟随机） */
function meditateGapMs(): number {
  return (MEDITATE_GAP_MIN + Math.floor(Math.random() * MEDITATE_JITTER_MIN)) * 60_000;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
