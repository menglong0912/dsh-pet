/**
 * 对战演出（修炼路线 X3、X7）：把引擎的事件序列排成一条时间线，再按时间线把动画、飞行物、台词、气血条播出去。
 *
 * 分两半：
 *   - `timeline(events, names, rng, skillSets)` 是**纯函数**：只算「什么时候、哪一边、播什么、放什么飞行物、说什么」，
 *     不碰 Electron、不读时钟、不碰坐标（坐标在特效窗口那边按两只的舞台矩形算），可离线单测；
 *   - `BattleShow` 是个小执行器：构造时注入「自家宠物播动画 / 说话」「对手窗口播动画 / 说话」「擂台更新气血」
 *     「特效窗口放一发」这几只手，按时间线跑，支持 `skip()`（快进）和 `dispose()`。`features.ts` 只负责把真实的函数传进来。
 *
 * X7 把「出手」和「命中」分开了（2026-10-26 真机切磋录屏：特效烤在出手方整段素材里，水柱在窗口边上被一刀切断、
 * 鲸尾原地罩在出手方身上、两只中间的空隙从来没有东西飞过；对面按时间表播「受击」看着像自己突然头晕）。三层：
 *   1. **出手方做动作**：`ATTACK_SHOW` 里每招专属的出手素材（手里可以拿着道具，飞出去的那部分不画）；
 *   2. **飞行物单独画**：`Shot`（贴图、轨迹、飞行时间、个数、间隔、命中贴图、miss）由特效窗口画出来——
 *      从出手方手里的 `hand` 出发，飞到对方身上；
 *   3. **命中时刻对方才反应**：命中时刻 `impact = 放出 + 飞行时间` 是程序算出来的（不再估素材里的打击时刻），
 *      对方按这一招的受击方式（`Fly.react`：湿身、炸黑、砸头……）在 `impact − 前摇` 起播，结算台词与掉血都在 `impact`。
 *
 * **衔接**（用户要求「从出招到道具、特效到受击衔接丝滑」）：所有素材都从标准站姿开始、回到标准站姿结束，
 * 所以只要同一只宠物的一段动画**不被下一段从中间切断**，整场就是无缝的。时间线给两只各记一个「忙到几点」：
 *   - 出手类（主攻、无影手的连拳、灵兽、第六感的反劈）都排在自己上一段播完之后；
 *   - 下一格等两只都回到站姿（再喘一口气 `GAP_MS`）才开始；
 *   - 受击必须对准命中，不能往后挪：同一格里第二下命中时同一段受击还在播，就不重新起播（只画命中特效、掉血）。
 *
 * 节奏：出手动作在 `cursor` 起播，按素材时长算 `rate`（倍速）正好占满 `SLOT_MS`（超出 `/anim` 的合法区间就夹住）；
 * 离手时刻 `release = cursor + 原速出手时刻 ÷ 倍速`（见 `RELEASE`）；这一格第 k 段伤害的飞行物在
 * `release + k × BEAT_MS` 放出，一发里第 i 个再晚 `i × 间隔`。
 *
 * 作用在自己身上的那些照旧播原来的整段素材（没有飞行物）：凭空生花（回血）、假死遁、化鸽遁（闪避）、泡泡护体（挡下）。
 * 会心一击照旧不播：它只是 `hit` 结算的字段，没有独立的出手时刻，台词已解说。
 * 渡劫（X7 第二步）：每道雷是一发从天上来的 `sky` 飞行物——乌云淡入、闪电劈到头顶，渡劫者在劈中那一刻播触电。
 *
 * 台词气泡**一律不联动说话动画**（`anim: false` 由调用方保证——X2 真机踩过：带 anim 的气泡会顶掉
 * 正在播的动画），时长给成一步那么长（`LINE_MS`），下一句自然顶替上一句。
 */
import { WEAPONS, type Action, type BattleEvent, type SkillId } from './battle';
import { lineOf } from './battle-lines';
import { ANIM_RATE_MAX, ANIM_RATE_MIN } from '../host/anim';

/** 开场（两边起手）一格 */
export const OPEN_MS = 2_400;
/** 出手动作的窗口：4 秒的出手素材按它算倍速（§X3：一个出手事件约 2.4 秒） */
export const SLOT_MS = 2_400;
/** 同一格里多段伤害错开这么久（台词一句顶一句，飞行物一发接一发） */
export const BEAT_MS = 800;
/** 手喂的事件序列里没有出手格子时，受击比结算晚这么久（只有这种兜底情况才用） */
export const REACT_MS = 900;
/**
 * 反应素材的倍速窗口：受击 / 闪避 / 泡泡这些整段素材按它算倍速（4 秒的素材 ≈ 2.2 倍速）。
 * 倍速固定（不随命中时刻变），前摇换算才稳定。
 */
export const REACT_WINDOW_MS = 1_800;
/** 收场（赢的庆祝、输的倒地）一格 */
const CLOSE_MS = 3_000;
/** 两只都回到站姿以后，下一格再等这么久（喘口气，别一段接一段连成一片） */
const GAP_MS = 150;
/** 第六感：反击方挨完那一下、回到站姿后再反劈（至少比命中晚这么久） */
const SIXTH_SENSE_AFTER_MS = 300;
/** 灵兽助阵每场几次（同引擎 battle.ts 的 beastLeft） */
const BEAST_TIMES = 3;
/** 渡劫：乌云淡入多久以后闪电劈下来 */
const CLOUD_MS = 600;
/** 渡劫：闪电从云底劈到头顶的时长（页面里同名常量画闪两下） */
const BOLT_MS = 120;
/**
 * 演出台词的显示时长：和一步的时长相当（X2 的坑：气泡压着后面的动画不好看，
 * 短到一步长就正好被下一句顶替）
 */
export const LINE_MS = SLOT_MS;

/** 挨打（正面挨一下：拳、牌、拳影、掌劈、灵兽一撞）与挡下的反应素材 */
const HIT_ANIM = '受击-正面';
const BUBBLE_ANIM = '招式-泡泡护体';
/** 闪避（没有化鸽遁时） */
const DODGE_ANIM = '战斗-闪避';
/** 化鸽遁（素材名照 §2.3：招式-<名>） */
const DOVE_ANIM = '招式-化鸽遁';
/** 假死遁 */
const PLAY_DEAD_ANIM = '招式-假死遁';

/**
 * 素材时长（算 `rate` 与「忙到几点」用）：战斗-受击 / 倒地、修炼-突破、招式-假死遁是 5 秒，修炼-打坐 6 秒；
 * 没列的（X7 的出手 / 受击素材、其余整段素材）都是 4 秒。素材重做后改这里就行。
 */
const ANIM_MS: Record<string, number> = {
  '战斗-倒地': 5_000,
  '修炼-打坐': 6_000,
  '修炼-突破': 5_000,
  // 渡劫失败那一下（X4）：动画池里的现有素材，4.9 秒（名字形态播，见 TRIBULATION_LOSS_ANIM）
  '工作状态-垂头叹气冒汗': 5_000,
  '招式-假死遁': 5_000,
};
/** 表里没列的都是 4 秒 */
const DEFAULT_ANIM_MS = 4_000;

/**
 * 反应素材的前摇（**原速**毫秒）：起播后多久，观众才看得出「挨了 / 躲了」。起播时刻 = 命中时刻 − 前摇 ÷ 反应倍速。
 * 挨打类取实测的起动时刻（逐帧和第 0 帧比轮廓，变化超过身体面积 4% 的第一帧），让动作**从命中那一刻**开始——
 * 早了像未卜先知（2026-10-25 用户反馈「攻击刚出来就挨了」）。闪避类要在飞行物到之前已经躲开一半，
 * 泡泡要先吹好再被撞凹，所以取素材里「躲开 / 隐身 / 被撞凹」那一刻。素材重做后按同法重量。
 */
const REACTION_WINDUP_MS: Record<string, number> = {
  '受击-正面': 250,
  '受击-湿身': 83,
  '受击-炸黑': 83,
  '受击-惊吓': 83,
  '受击-震耳': 250,
  '受击-绊脚': 125,
  '受击-砸头': 292,
  '修炼-触电': 83,
  '招式-假死遁': 167,
  '战斗-闪避': 500,
  '招式-化鸽遁': 700,
  '招式-泡泡护体': 1_400,
};

/** 飞行轨迹（§X7）：直飞 / 抛物线 / 贴地 / 慢飘 / 高抛砸落 / 天雷（乌云 + 闪电，渡劫用） */
export type FxTrack = 'line' | 'arc' | 'ground' | 'float' | 'slam' | 'bolt';

/**
 * 特效贴图名（`assets/pic/fx/<名>.png`）：§X7 的素材清单。
 * 素材由主会话生成，代码里只按名字引用；缺了的那一张只是画不出来（§2.3 的素材缺失口径）。
 */
export type FxAssetName =
  // 飞行物
  | '毽子'
  | '扑克牌'
  | '水弹'
  | '气球'
  | '彩球'
  | '陀螺'
  | '水浪'
  | '烟花弹'
  | '声波'
  | '蓝鲸'
  | '灵兽'
  | '拳风'
  | '拳影'
  | '手刀'
  | '闪电'
  | '乌云'
  // 命中
  | '命中-星'
  | '命中-水花'
  | '命中-烟花'
  | '命中-气球爆'
  | '命中-纸牌'
  | '命中-羽毛'
  | '命中-彩星'
  | '命中-旋风'
  | '命中-声震'
  | '命中-巨浪'
  | '命中-泡泡'
  | '命中-斩'
  | '命中-电光';

/** 各轨迹的飞行时间（`bolt` = 乌云淡入 + 闪电劈下） */
const FLIGHT_MS: Record<FxTrack, number> = {
  line: 380,
  arc: 620,
  ground: 520,
  float: 900,
  slam: 700,
  bolt: CLOUD_MS + BOLT_MS,
};

/** 一发飞行物与它打中以后的样子（§X7 第三步那张表里「飞行物 / 轨迹 / 命中 / 受击」那几列） */
export interface Fly {
  /** 飞行物贴图名（`assets/pic/fx/<名>.png`） */
  kind: FxAssetName;
  track: FxTrack;
  /** 命中那一下的贴图 */
  hitFx: FxAssetName;
  /** 挨打方的反应素材：不给 = `战斗-受击`（被挡下照旧换泡泡、被闪避照旧闪避） */
  react?: string;
  /** 一发里齐发几个（默认 1）；多段法宝（扑克牌两张、三球三个）的「个数」由引擎的段数承担，不在这里 */
  count?: number;
  /**
   * 齐发时逐发的间隔（真实毫秒：水枪对准出手素材里三下扳机的间隔）；多段法宝是**逐段**的间隔——
   * 扑克牌、三球是一把撒出去的，几段紧挨着飞（不再隔一个 `BEAT_MS`），对方只演一次反应
   */
  gapMs?: number;
  /** 多段法宝逐段的色相步进（三球的三个球 0 / 120 / 240） */
  hueStep?: number;
}

/** 出手 → 动作 + 飞行物（§X7 第三步那张表；演出口径归演出，图鉴里不再存素材名） */
export interface AttackShow {
  /** 出手方播的出手素材（每招专属：手里可以有道具，飞出去的那部分不画） */
  action: string;
  /** 飞行物：不给 = 作用在自己身上的整段素材（回血那类），没有飞行物 */
  fly?: Fly;
}

/**
 * 出手 → 动作 + 飞行物（§X7 第三步）。键是 `Action` 的编号（空手 = unarmed），外加三种不是 `decide` 的追加出手：
 * `spirit-beast`（beast）、`sixth-sense`（counter）、`shadow-fists`（combo 且出手方有无影手）。
 */
export const ATTACK_SHOW: Record<string, AttackShow> = {
  unarmed: { action: '战斗-直拳', fly: { kind: '拳风', track: 'line', hitFx: '命中-星' } },
  'water-gun': {
    action: '出手-水枪',
    fly: { kind: '水弹', track: 'line', hitFx: '命中-水花', react: '受击-湿身', count: 3, gapMs: 225 },
  },
  poker: { action: '出手-扑克牌', fly: { kind: '扑克牌', track: 'line', hitFx: '命中-纸牌', gapMs: 150 } },
  shuttlecock: { action: '战斗-踢', fly: { kind: '毽子', track: 'arc', hitFx: '命中-羽毛', react: '受击-砸头' } },
  balloon: { action: '出手-气球', fly: { kind: '气球', track: 'float', hitFx: '命中-气球爆', react: '受击-惊吓' } },
  juggle: {
    action: '出手-三球',
    fly: { kind: '彩球', track: 'arc', hitFx: '命中-彩星', react: '受击-砸头', hueStep: 120, gapMs: 160 },
  },
  top: { action: '出手-陀螺', fly: { kind: '陀螺', track: 'ground', hitFx: '命中-旋风', react: '受击-绊脚' } },
  'whale-tail': { action: '出手-鲸尾', fly: { kind: '水浪', track: 'ground', hitFx: '命中-巨浪', react: '受击-湿身' } },
  firework: { action: '出手-烟花', fly: { kind: '烟花弹', track: 'line', hitFx: '命中-烟花', react: '受击-炸黑' } },
  'lion-roar': {
    action: '战斗-吼',
    fly: { kind: '声波', track: 'line', hitFx: '命中-声震', react: '受击-震耳', count: 3, gapMs: 180 },
  },
  'blue-whale': {
    action: '出手-召唤蓝鲸',
    fly: { kind: '蓝鲸', track: 'slam', hitFx: '命中-巨浪', react: '受击-湿身' },
  },
  // 回血：作用在自己身上，照旧播整段素材，没有飞行物
  bloom: { action: '招式-凭空生花' },
  // 三种追加出手
  'spirit-beast': { action: '出手-召唤灵兽', fly: { kind: '灵兽', track: 'float', hitFx: '命中-泡泡' } },
  'sixth-sense': { action: '出手-第六感', fly: { kind: '手刀', track: 'line', hitFx: '命中-斩' } },
  'shadow-fists': { action: '战斗-连拳', fly: { kind: '拳影', track: 'line', hitFx: '命中-星', count: 5, gapMs: 100 } },
};

/** 渡劫的一道雷（X7 第二步）：乌云 + 闪电从渡劫者头顶劈下，劈中播触电 */
export const TRIBULATION_FLY: Fly = { kind: '闪电', track: 'bolt', hitFx: '命中-电光', react: '修炼-触电' };

/** 这套表要用到的全部贴图（特效窗口开窗时预加载）：从表里取，不另抄一份清单；乌云是天雷那一发顺带画的 */
export const FX_ASSETS: FxAssetName[] = Array.from(
  new Set<FxAssetName>([
    ...[...Object.values(ATTACK_SHOW).map((show) => show.fly), TRIBULATION_FLY].flatMap((fly) =>
      fly ? [fly.kind, fly.hitFx] : [],
    ),
    '乌云',
  ]),
);

/**
 * 对战（心魔 / 切磋）里对手窗口可能播到的全部动画：开演前让客人窗口先取到页面里（`GuestWindow.preload`），
 * 换源时不用等网络——不然出手动作比特效窗口里的飞行物晚上屏。从表里取，不另抄一份清单。
 */
export const SHOW_ANIMS: string[] = Array.from(
  new Set([
    '战斗-起手',
    '战斗-胜利',
    '战斗-倒地',
    HIT_ANIM,
    BUBBLE_ANIM,
    DODGE_ANIM,
    DOVE_ANIM,
    PLAY_DEAD_ANIM,
    ...Object.values(ATTACK_SHOW).flatMap((show) => [show.action, ...(show.fly?.react ? [show.fly.react] : [])]),
  ]),
);

/**
 * 出手素材的出手时刻（**原速**毫秒）与出手那一刻手（道具口）的位置（640×360 舞台坐标、素材朝左）——主会话逐帧量好的。
 * 量法：逐帧找人物最靠左的不透明点，手臂（脚、尾巴、枪口、筒口）伸到最远、或道具刚离手的那一帧算出手。
 * 素材重做后按同法重量，改这张表即可。
 */
export const RELEASE: Record<string, { ms: number; hand: [number, number] }> = {
  '战斗-直拳': { ms: 1_660, hand: [180, 222] },
  '出手-水枪': { ms: 1_450, hand: [184, 212] },
  '出手-扑克牌': { ms: 1_500, hand: [196, 170] },
  '战斗-踢': { ms: 1_460, hand: [232, 284] },
  '出手-气球': { ms: 2_600, hand: [152, 263] },
  '出手-三球': { ms: 2_050, hand: [202, 184] },
  '出手-陀螺': { ms: 1_250, hand: [185, 280] },
  '出手-鲸尾': { ms: 2_450, hand: [50, 300] },
  '出手-烟花': { ms: 1_750, hand: [152, 112] },
  '战斗-吼': { ms: 750, hand: [195, 195] },
  '出手-召唤蓝鲸': { ms: 1_960, hand: [192, 194] },
  '出手-召唤灵兽': { ms: 1_250, hand: [160, 185] },
  '战斗-连拳': { ms: 1_000, hand: [204, 232] },
  '出手-第六感': { ms: 1_850, hand: [206, 216] },
};

/** 一段素材按这个倍速播完要多久 */
export function animLength(anim: string, rate: number): number {
  return Math.round((ANIM_MS[anim] ?? DEFAULT_ANIM_MS) / rate);
}

/** 离手比动作起播晚多久：原速的出手时刻 ÷ 倍速（倍速把素材压进格子，离手的真实时刻也跟着压缩） */
export function releaseOffset(action: string): number {
  const entry = RELEASE[action];
  return entry ? Math.round(entry.ms / rateFor(action, SLOT_MS)) : 0;
}

/**
 * 一段素材要正好占满 `windowMs`，该开几倍速。
 * 夹到 `/anim` 允许的 0.5–3（`ANIM_RATE_MIN` / `ANIM_RATE_MAX`）：越界宿主直接回 bad-request，
 * 那一下就没动画了，所以宁可让那一段短一点、被下一步顶掉。
 */
export function rateFor(anim: string, windowMs: number): number {
  const rate = (ANIM_MS[anim] ?? DEFAULT_ANIM_MS) / windowMs;
  return Math.min(ANIM_RATE_MAX, Math.max(ANIM_RATE_MIN, Number(rate.toFixed(3))));
}

/** 反应素材的倍速（固定按 `REACT_WINDOW_MS` 算） */
function reactRate(anim: string): number {
  return rateFor(anim, REACT_WINDOW_MS);
}

/** 反应起播比命中时刻提前多久（原速前摇 ÷ 倍速） */
export function windupOf(anim: string): number {
  return Math.round((REACTION_WINDUP_MS[anim] ?? 0) / reactRate(anim));
}

/** 一发飞行物（X7）：执行器到点交给特效窗口，坐标由窗口按两只的舞台矩形算（时间线只算时刻） */
export interface Shot {
  /** 飞行物贴图名（`assets/pic/fx/<名>.png`） */
  kind: FxAssetName;
  /** 轨迹 */
  track: FxTrack;
  /** 飞行时间：命中时刻 = 放出 + 这个 */
  flightMs: number;
  /** 一次放几个 */
  count: number;
  /** 齐发时逐发的间隔 */
  gapMs: number;
  /** 命中那一下的贴图 */
  hitFx: FxAssetName;
  /** 出手那一刻手的位置（640×360 舞台坐标、素材朝左；特效窗口按出手方朝向决定要不要镜像 x） */
  hand: [number, number];
  /** 这一发的色相（三球的三个球） */
  hue?: number;
  /** 被闪避：从对方身边掠过去（偏开一点）、淡出，不画命中特效 */
  miss?: boolean;
  /** 被泡泡护体挡下：打在泡泡朝着来路的那一侧（天雷打在泡泡顶上），不打在身上 */
  blocked?: boolean;
  /** 从天上来（渡劫的雷）：目标就是这一步的 `who` 自己，起点在它头顶上方 */
  sky?: boolean;
}

/**
 * 时间线上的一步。`who` 是引擎那边的序号（0 = 发起这场的一方 = 自家宠物，1 = 对手）。
 * `anim`、`line`、`shot` 都可以没有：那一步只是刷新气血条（命中那一刻掉血）。`closing` = 收场那几步
 * （结果动画和结果台词）——快进直接跳到它们。
 */
export interface Step {
  /** 距离开打的毫秒数 */
  at: number;
  who: 0 | 1;
  anim?: string;
  /** 这段素材的来处：不给（默认）= §2.3 的新素材，走 `/anim` 的 url 形态；`'pool'` = 动画池里的现有素材，走 name 形态 */
  from?: 'pool';
  /** 播这段动画的倍速（timeline 按素材时长算好，执行器原样传给 /anim 的 rate） */
  rate?: number;
  line?: string;
  /** 这一步放出的飞行物（X7） */
  shot?: Shot;
  /** 这一步之后的气血（擂台照它刷新） */
  hp: [number, number];
  closing?: boolean;
}

/** 这些事件是打在对方身上的，要对方播挨打（凭空生花是回血，不算挨打） */
function isDamageOnFoe(event: BattleEvent): boolean {
  if (event.kind === 'hit' || event.kind === 'combo' || event.kind === 'counter' || event.kind === 'beast') return true;
  return event.kind === 'skill' && event.damage !== undefined;
}

/** 出手在 `ATTACK_SHOW` 里的键：`Action` 的编号（空手 = unarmed） */
function showKeyOf(action: Action): string {
  if (action.kind === 'weapon') return action.weapon;
  if (action.kind === 'skill') return action.skill;
  return 'unarmed';
}

/** 一次出手放几段伤害（扑克牌两张、三球三个，各自独立判定命中）；非法宝是一发 */
function hitsOf(action: Action): number {
  return action.kind === 'weapon' ? WEAPONS[action.weapon].hits : 1;
}

/** 闪避动画：真有化鸽遁才是「化成一只鸽子」，否则通用闪避 */
function dodgeAnimOf(who: 0 | 1, skillSets?: [SkillId[], SkillId[]]): string {
  return skillSets?.[who]?.includes('dove') ? DOVE_ANIM : DODGE_ANIM;
}

/** 这一边有没有这门被动招式（`skillSets` 没传当作没有：只是少一段动画，台词和气血照旧） */
function hasSkill(who: 0 | 1, id: SkillId, skillSets?: [SkillId[], SkillId[]]): boolean {
  return skillSets?.[who]?.includes(id) ?? false;
}

/** 这一拍有没有被泡泡护体挡下（`skill` / `skip` 这些事件不带 blocked） */
function blockedHere(event: BattleEvent): boolean {
  return 'blocked' in event && event.blocked;
}

/** 这一格里的挨打反应有没有被紧随其后的假死遁顶掉（假死遁自己播，不重复挨一下） */
function playDeadAfter(events: BattleEvent[], index: number): boolean {
  const next = events[index + 1];
  return next !== undefined && next.kind === 'play-dead';
}

/** 渡劫（X4）失败那一下：动画池里的现有素材（名字形态播，不是 §2.3 的新素材） */
export const TRIBULATION_LOSS_ANIM = '工作状态-垂头叹气冒汗';
/** 渡劫（X4）成功那一下 */
export const TRIBULATION_WIN_ANIM = '修炼-突破';
/** 渡劫开场的服丹（§2.3 的 url 形态素材） */
export const TRIBULATION_PILL_ANIM = '修炼-服丹';

/**
 * `timeline` 的额外选项。
 * @param tribulation 渡劫这一场：没有对手窗口（`ShowSides.foe = null`），开场不吃丹就不播起手式、
 *   吃丹先播一段 `修炼-服丹`；收场用 `修炼-突破` / `工作状态-垂头叹气冒汗`（渡劫没有「打赢对手」那句
 *   台词，结果感言由调用方按人设说一句，见 features.ts）。引擎的事件里 `actor` 恒为 0（天雷不算一方），
 *   所以这几步都排在自家宠物那一边。
 *   `strikes` = 这一场该有几道雷（`tribulationPlan` 给的）：台词报「第 i/N 道」的 N。
 *   没扛住时事件里只有前几道雷，不传就会报成「第 2/2 道」那种偏小的数。
 */
export interface TimelineOptions {
  tribulation?: { pill: boolean; strikes?: number };
}

/** 这一格的出手（`decide` 排出来的；`closeSlot` 作废）。只有带飞行物的出手才会排出来 */
interface Slot {
  /** 出手方 */
  who: 0 | 1;
  show: AttackShow;
  /** 这一格的飞行物 */
  fly: Fly;
  /** 一次出手放几段伤害 */
  hits: number;
  /** 离手的那一刻（动作起播 + 原速出手时刻 ÷ 倍速） */
  release: number;
  /** 这一格里已经用掉几段 */
  segments: number;
  /**
   * 主攻那几段里由哪一段（从 1 数）决定对方的反应：有一段打中就是第一段打中的（受击 / 泡泡），全被躲开才是第一段闪避；
   * 其余几段只飞过去（打中的画命中特效、躲开的掠过），不另起反应——一把撒出去的扑克牌不会让对方先躲再挨、来回抽搐
   */
  primary: number;
  /** 主攻几段之间的间隔（多段法宝紧挨着飞；单段是 0） */
  gap: number;
  /** 这一格最后还有一下灵兽没出（引擎：带灵兽的一方前 3 次法宝 / 空手出手之后追加一击，对方还站着就一定出） */
  beast: boolean;
}

/**
 * 引擎事件 → 时间线。
 * @param events `fight()` / `tribulate()` 的事件序列
 * @param names 两边的名字（给 `lineOf`：[0] = 自家宠物，[1] = 对手）
 * @param rng 解说台词的随机数（注入序列才测得准）
 * @param skillSets 双方的招式表：闪避那句和闪避动画要看有没有化鸽遁，连击那一拍有没有无影手也看它
 * @param options 见 `TimelineOptions`（渡劫用）
 */
export function timeline(
  events: BattleEvent[],
  names: [string, string],
  rng: () => number,
  skillSets?: [SkillId[], SkillId[]],
  options?: TimelineOptions,
): Step[] {
  const steps: Step[] = [];
  const start = events.find((event) => event.kind === 'start');
  const base: [number, number] = start ? start.hp : [0, 0];
  const tribulation = options?.tribulation;
  /** 这场一共几道雷（渡劫台词报「第 i/N 道」用）：优先按 plan 给的雷数，没传就按事件里数得着的算（躲开的也算一道） */
  const strikeTotal = tribulation
    ? (tribulation.strikes ?? events.filter((event) => event.kind === 'strike' || event.kind === 'dodge').length)
    : 0;
  /** 渡劫：到第几道雷了（劈中的按引擎的 index，躲开的接着数） */
  let bolt = 0;
  /** 两只各自「忙到几点」：最后一段动画播完的时刻（出手类排在它之后，免得把上一段从中间切断） */
  const busy: [number, number] = [0, 0];
  /** 两只正在播的反应（同一格里再挨一下时同一段还在播，就不重新起播） */
  const reacting: [{ anim: string; until: number } | null, { anim: string; until: number } | null] = [null, null];
  /** 两边灵兽还剩几次（同引擎：有灵兽助阵的一方 3 次） */
  const beastLeft: [number, number] = [0, 1].map((who) =>
    hasSkill(who as 0 | 1, 'spirit-beast', skillSets) ? BEAST_TIMES : 0,
  ) as [number, number];

  /** 排一段动画，顺手记下这只忙到几点 */
  const pushAnim = (step: Step & { anim: string; rate: number }): void => {
    steps.push(step);
    busy[step.who] = Math.max(busy[step.who], step.at + animLength(step.anim, step.rate));
  };

  if (tribulation) {
    // 渡劫：没有对手，开场只有吃丹那一段（不吃丹就直接等第一道雷）
    if (tribulation.pill) {
      pushAnim({
        at: 0,
        who: 0,
        anim: TRIBULATION_PILL_ANIM,
        rate: rateFor(TRIBULATION_PILL_ANIM, OPEN_MS),
        line: '吃一颗破境丹，气色立马好起来',
        hp: base,
      });
    }
  } else {
    // 开场：两边各一段起手式（`start` 事件本身不再另排一步）
    for (const who of [0, 1] as const) {
      pushAnim({ at: 0, who, anim: '战斗-起手', rate: rateFor('战斗-起手', OPEN_MS), hp: base });
    }
  }
  let cursor = OPEN_MS;
  /** 这一格里已经排了几件事（决定后面的错开多远） */
  let beat = 0;
  /** 这一格的出手（null = 没有出手格子：那一拍没有飞行物，台词与反应照旧排在 `at` 附近） */
  let slot: Slot | null = null;
  /** 上一个事件之后的气血（飞行物放出、反应起播那一刻血还没掉，擂台照这个刷） */
  let before: [number, number] = base;
  /** 最近一段伤害命中的时刻（第六感贴着自己挨的那一下再反劈、假死遁对准致命那一下）；还没有命中过是 null */
  let lastImpact: number | null = null;

  /** 一格用完：下一件事另起一格——至少隔一个 `SLOT_MS`（多段台词再长一点），并且等两只都回到站姿 */
  const closeSlot = (): void => {
    if (beat > 0) {
      cursor = Math.max(cursor + Math.max(SLOT_MS, beat * BEAT_MS), busy[0] + GAP_MS, busy[1] + GAP_MS);
    }
    beat = 0;
    slot = null;
  };

  /**
   * 这一格里下一段伤害的飞行物：时刻与这一发的内容。主攻的第 k 段（从 0 数）在 `release + k × gap`，
   * 追击（combo）接在主攻最后一段之后、每次再隔一个 `BEAT_MS`；`reacts` = 这一段要不要让对方起反应（见 `Slot.primary`）
   */
  const takeSegment = (current: Slot): { at: number; reacts: boolean; extra: { count: number; hue?: number } } => {
    current.segments += 1;
    const k = current.segments - 1;
    const fly = current.fly;
    const main = k < current.hits;
    // 多段法宝（扑克牌两张、三球三个）的「个数」由引擎的段数承担：每段一个，各自可被闪避，
    // 三球的色相也逐段轮（0 / 120 / 240）；单段出手（空手、水枪、狮子吼……）的「个数」才是这一发的齐发数，
    // 追击（combo）那一发只放一个
    const count = current.hits > 1 || !main ? 1 : (fly.count ?? 1);
    const hue = current.hits > 1 && main && fly.hueStep !== undefined ? (k * fly.hueStep) % 360 : undefined;
    const lastMain = current.release + (current.hits - 1) * current.gap;
    return {
      at: main ? current.release + k * current.gap : lastMain + (k - current.hits + 1) * BEAT_MS,
      reacts: !main || current.segments === current.primary,
      extra: { count, ...(hue === undefined ? {} : { hue }) },
    };
  };

  /** 放一发：排一步 `shot`，返回它的命中时刻（= 放出 + 飞行时间） */
  const pushShot = (
    at: number,
    who: 0 | 1,
    action: string | null,
    fly: Fly,
    hp: [number, number],
    extra: { count?: number; hue?: number; miss?: boolean; blocked?: boolean; sky?: boolean } = {},
  ): number => {
    const shot: Shot = {
      kind: fly.kind,
      track: fly.track,
      flightMs: FLIGHT_MS[fly.track],
      count: extra.count ?? fly.count ?? 1,
      gapMs: fly.gapMs ?? 0,
      hitFx: fly.hitFx,
      hand: [...((action && RELEASE[action]?.hand) || [0, 0])] as [number, number],
      ...(extra.hue === undefined ? {} : { hue: extra.hue }),
      ...(extra.miss ? { miss: true } : {}),
      ...(extra.blocked ? { blocked: true } : {}),
      ...(extra.sky ? { sky: true } : {}),
    };
    steps.push({ at, who, shot, hp });
    return at + shot.flightMs;
  };

  /**
   * 对准命中时刻起播一段反应（受击 / 泡泡 / 闪避 / 触电 / 假死）：起播 = impact − 前摇，倍速固定。
   * 这只上一段反应还没播完：不另起（这一下只画特效、掉血、出台词），免得把它从中间切断；
   * 只有假死遁（`force`）照样起播——装死倒下那一下必须演出来。
   */
  const pushReaction = (
    impact: number,
    who: 0 | 1,
    anim: string,
    hp: [number, number],
    line?: string,
    force = false,
  ): void => {
    const at = impact - windupOf(anim);
    const current = reacting[who];
    if (!force && current && at < current.until) {
      if (line !== undefined) steps.push({ at, who, line, hp });
      return;
    }
    const rate = reactRate(anim);
    pushAnim({ at, who, anim, rate, ...(line === undefined ? {} : { line }), hp });
    reacting[who] = { anim, until: at + animLength(anim, rate) };
  };

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    // start 已经换成开场那两步；台词由 lineOf 决定（它说 null 的事件就只是没字，不是没画面）
    if (event.kind === 'start') continue;

    if (event.kind === 'decide') {
      closeSlot();
      const show = ATTACK_SHOW[showKeyOf(event.action)];
      pushAnim({ at: cursor, who: event.actor, anim: show.action, rate: rateFor(show.action, SLOT_MS), hp: event.hp });
      if (show.fly) {
        slot = {
          who: event.actor,
          show,
          fly: show.fly,
          hits: hitsOf(event.action),
          release: cursor + releaseOffset(show.action),
          segments: 0,
          primary: primaryOf(events, i, hitsOf(event.action)),
          gap: hitsOf(event.action) > 1 ? (show.fly.gapMs ?? 150) : 0,
          beast: event.action.kind !== 'skill' && beastLeft[event.actor] > 0,
        };
      }
      before = event.hp;
      continue;
    }

    if (event.kind === 'end') {
      closeSlot();
      if (tribulation) {
        // 渡劫：只有自家这一边（引擎把「没扛住」的 end 排在 actor 1，这里统一排到 0），
        // 成功播 修炼-突破、失败播 工作状态-垂头叹气冒汗（池里的现有素材，名字形态）。
        // 结果不配「谁赢了」那种台词：结果感言由调用方按人设说一句（§X4 每次渡劫只 +1 次模型调用）。
        const win = event.winner === 0;
        const anim = win ? TRIBULATION_WIN_ANIM : TRIBULATION_LOSS_ANIM;
        pushAnim({
          at: cursor,
          who: 0,
          anim,
          ...(win ? {} : { from: 'pool' as const }),
          rate: rateFor(anim, CLOSE_MS),
          hp: event.hp,
          closing: true,
        });
        continue;
      }
      const winner = event.winner;
      const loser = (winner ^ 1) as 0 | 1;
      for (const [who, anim] of [
        [winner, '战斗-胜利'],
        [loser, '战斗-倒地'],
      ] as const) {
        pushAnim({ at: cursor, who, anim, rate: rateFor(anim, CLOSE_MS), hp: event.hp, closing: true });
      }
      const line = lineOf(event, names, rng, skillSets);
      if (line) steps.push({ at: cursor, who: winner, line, hp: event.hp, closing: true });
      continue;
    }

    if (tribulation && (event.kind === 'dodge' || (event.kind === 'skill' && event.heal !== undefined))) {
      // 渡劫里的躲闪 = 这一道雷被躲开了（引擎只记 dodge、没有 strike）：照样一格，乌云聚起、闪电劈到身边的地上，
      // 闪避对准劈下的那一刻；两道雷之间的回血（凭空生花）自己占一格。都排在上一段播完之后，不切断触电
      closeSlot();
      const line = lineOf(event, names, rng, skillSets) ?? undefined;
      if (event.kind === 'dodge') {
        bolt += 1;
        const impact = pushShot(cursor, event.actor, null, TRIBULATION_FLY, before, { sky: true, miss: true });
        const said = line === undefined ? undefined : `第 ${bolt}/${strikeTotal} 道：${line}`;
        pushReaction(impact, event.actor, dodgeAnimOf(event.actor, skillSets), event.hp, said);
      } else {
        pushAnim({
          at: cursor,
          who: event.actor,
          anim: ATTACK_SHOW.bloom.action,
          rate: rateFor(ATTACK_SHOW.bloom.action, SLOT_MS),
          ...(line === undefined ? {} : { line }),
          hp: event.hp,
        });
      }
      beat += 1;
      before = event.hp;
      continue;
    }

    if (event.kind === 'strike') {
      // 渡劫（X7 第二步）：一道雷一格。乌云在 `cursor` 淡入，闪电劈到渡劫者头顶的那一刻（impact）
      // 播触电（被泡泡挡下就播泡泡护体，命中特效照样画在泡泡上），台词「第 i/N 道」也在 impact。
      closeSlot();
      bolt = event.index + 1;
      const blocked = blockedHere(event);
      const impact = pushShot(cursor, event.actor, null, TRIBULATION_FLY, before, { sky: true, blocked });
      let line = lineOf(event, names, rng, skillSets) ?? undefined;
      // 渡劫的台词报第几道雷（设计 §4.6：气泡显示「第 3 道天雷」）
      if (tribulation && line) line = `第 ${event.index + 1}/${strikeTotal} 道：${line}`;
      // 致命那道雷后面紧跟假死遁：倒下由假死遁自己演，不再触电（两段顶在一起只会打断它）
      if (!playDeadAfter(events, i)) {
        pushReaction(impact, event.actor, blocked ? BUBBLE_ANIM : (TRIBULATION_FLY.react ?? HIT_ANIM), before);
      }
      steps.push({ at: impact, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      lastImpact = impact;
      beat += 1;
      before = event.hp;
      continue;
    }

    // 结算事件：`at` 是这一拍的老时刻（没有飞行物的那几类——skip、回血——照它走）
    const at = cursor + beat * BEAT_MS;
    const line = lineOf(event, names, rng, skillSets) ?? undefined;
    const hpBefore = before;
    before = event.hp;
    beat += 1;

    if (event.kind === 'dodge') {
      // 自己躲开：飞行物掠过去（`miss`，不画命中特效），闪避动画对准它掠过的时刻（提前躲开一半）
      const anim = dodgeAnimOf(event.actor, skillSets);
      const current = slot;
      if (!current) {
        // 这一格没有出手（手喂的事件序列）：只是自己一闪，照旧排在 `at`
        pushAnim({
          at,
          who: event.actor,
          anim,
          rate: reactRate(anim),
          ...(line === undefined ? {} : { line }),
          hp: event.hp,
        });
        continue;
      }
      // 灵兽那一下被躲开（引擎只记一条 dodge）：它是这一格的最后一件事。灵兽照样召出来冲过去，只是扑了个空
      const beast = current.beast && current.who !== event.actor && lastOfSlot(events, i);
      let launch: number;
      let fly = current.fly;
      let action: string = current.show.action;
      let extra: { count?: number; hue?: number } = {};
      let reacts = true;
      const append = ATTACK_SHOW['spirit-beast'];
      if (beast && append.fly) {
        current.beast = false;
        beastLeft[current.who] -= 1;
        const moment = Math.max(at, busy[current.who]);
        pushAnim({
          at: moment,
          who: current.who,
          anim: append.action,
          rate: rateFor(append.action, SLOT_MS),
          hp: hpBefore,
        });
        launch = moment + releaseOffset(append.action);
        fly = append.fly;
        action = append.action;
      } else {
        const segment = takeSegment(current);
        launch = segment.at;
        extra = segment.extra;
        reacts = segment.reacts;
      }
      const impact = pushShot(launch, current.who, action, fly, hpBefore, { ...extra, miss: true });
      if (reacts) pushReaction(impact, event.actor, anim, event.hp, line);
      else if (line !== undefined) steps.push({ at: impact, who: event.actor, line, hp: event.hp });
      continue;
    }

    if (event.kind === 'play-dead') {
      // 自己装死：对准致命那一下的命中时刻倒下（那一下的受击已经被 playDeadAfter 省掉）；
      // 手喂的序列里没有命中时刻就排在这一拍
      if (lastImpact !== null && lastImpact >= cursor) {
        pushReaction(lastImpact, event.actor, PLAY_DEAD_ANIM, event.hp, line, true);
      } else {
        pushAnim({
          at,
          who: event.actor,
          anim: PLAY_DEAD_ANIM,
          rate: reactRate(PLAY_DEAD_ANIM),
          ...(line === undefined ? {} : { line }),
          hp: event.hp,
        });
      }
      continue;
    }

    if (isDamageOnFoe(event)) {
      const shooter = event.actor;
      const victim = (event.actor ^ 1) as 0 | 1;
      const react = !playDeadAfter(events, i);
      // 灵兽与第六感各有自己的出手（动作 + 飞行物），排在出手方上一段播完之后：
      // 灵兽等主攻的动作收势再召唤，第六感等自己挨完那一下回到站姿再反劈（「先挨后反」）
      const append: AttackShow | null =
        event.kind === 'beast'
          ? ATTACK_SHOW['spirit-beast']
          : event.kind === 'counter'
            ? ATTACK_SHOW['sixth-sense']
            : null;
      let launch: number;
      let fly: Fly;
      let action: string;
      let extra: { count?: number; hue?: number } = {};
      let reacts = react;
      if (event.kind === 'beast' && slot?.beast) {
        slot.beast = false;
        beastLeft[shooter] -= 1;
      }
      if (append?.fly) {
        const earliest = event.kind === 'counter' ? (lastImpact ?? at) + SIXTH_SENSE_AFTER_MS : at;
        const moment = Math.max(earliest, busy[shooter]);
        pushAnim({
          at: moment,
          who: shooter,
          anim: append.action,
          rate: rateFor(append.action, SLOT_MS),
          hp: hpBefore,
        });
        launch = moment + releaseOffset(append.action);
        fly = append.fly;
        action = append.action;
      } else if (slot) {
        const segment = takeSegment(slot);
        // 无影手的追击：等主攻的动作收势，再播「战斗-连拳」，拳影按连拳自己的出手时刻齐发；
        // 出手方没这门招式时 combo 不另播动作（手还伸着，再放一发同一格攻击的飞行物）
        const fists =
          event.kind === 'combo' && hasSkill(shooter, 'shadow-fists', skillSets) ? ATTACK_SHOW['shadow-fists'] : null;
        if (fists?.fly) {
          const moment = Math.max(segment.at, busy[shooter]);
          pushAnim({
            at: moment,
            who: shooter,
            anim: fists.action,
            rate: rateFor(fists.action, SLOT_MS),
            hp: hpBefore,
          });
          launch = moment + releaseOffset(fists.action);
          fly = fists.fly;
          action = fists.action;
        } else {
          launch = segment.at;
          fly = slot.fly;
          action = slot.show.action;
          extra = segment.extra;
          reacts = react && segment.reacts;
        }
      } else {
        // 手喂的事件序列里这一格没有出手：台词与受击照老口径排在 `at` 附近
        if (line !== undefined) steps.push({ at, who: shooter, line, hp: event.hp });
        if (react) pushReaction(at + REACT_MS, victim, blockedHere(event) ? BUBBLE_ANIM : HIT_ANIM, event.hp);
        continue;
      }
      const impact = pushShot(launch, shooter, action, fly, hpBefore, {
        ...extra,
        ...(blockedHere(event) ? { blocked: true } : {}),
      });
      lastImpact = impact;
      // 挡下的那一下改播挨打方自己的泡泡护体；其余按这一招的受击方式（湿身、炸黑、砸头……）
      if (reacts) pushReaction(impact, victim, blockedHere(event) ? BUBBLE_ANIM : (fly.react ?? HIT_ANIM), hpBefore);
      // 掉血与结算台词都在命中那一刻
      steps.push({ at: impact, who: shooter, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // skip（被定住）、回血：只有台词、没有飞行物
    if (line !== undefined) steps.push({ at, who: event.actor, line, hp: event.hp });
  }
  return steps.sort((a, b) => a.at - b.at);
}

/**
 * 主攻那几段里由哪一段（从 1 数）决定对方的反应（见 `Slot.primary`）：第一段打中的（含被泡泡挡下），全被躲开就第一段。
 * 主攻的段是 decide 之后的前 `hits` 个 hit / dodge（反击、假死夹在中间不算段；碰到追击、下一格就停）。
 */
function primaryOf(events: BattleEvent[], decideIndex: number, hits: number): number {
  let segment = 0;
  for (let j = decideIndex + 1; j < events.length && segment < hits; j += 1) {
    const event = events[j];
    if (event.kind === 'decide' || event.kind === 'end' || event.kind === 'combo') break;
    if (event.kind === 'hit' || (event.kind === 'skill' && event.damage !== undefined)) return segment + 1;
    if (event.kind === 'dodge') segment += 1;
  }
  return 1;
}

/** 这一件事是不是这一格的最后一件（后面紧跟下一格的 decide、收场，或者事件序列到头了） */
function lastOfSlot(events: BattleEvent[], index: number): boolean {
  const next = events[index + 1];
  return next === undefined || next.kind === 'decide' || next.kind === 'end';
}

/** 一边的手：播一段素材（带倍速）、说一句台词 */
export interface ShowSide {
  /**
   * 播一段素材。`from` = `'pool'` 时是动画池里的现有素材（走 `/anim` 的 name 形态），
   * 没给就是 §2.3 的新素材（url 形态）。`rate` 是 timeline 按素材时长算好的倍速。
   */
  play(anim: string, rate: number, from?: 'pool'): void;
  say(line: string, durationMs: number): void;
}

/** 执行器要注入的几只手：`foe` 为 null = 没有对手窗口（X4 渡劫） */
export interface ShowSides {
  /** 自家宠物 */
  self: ShowSide;
  /** 对手（心魔窗口 / 客人窗口） */
  foe: ShowSide | null;
  /** 擂台的气血条 */
  arena(hp: [number, number]): void;
  /** 特效窗口放一发（X7）：`who` 是出手方（天雷是渡劫者自己），坐标由特效窗口按两只的舞台矩形算 */
  shoot(shot: Shot, who: 0 | 1): void;
}

/** 可注入的定时器（测试里用 mock.timers 拨时间，不真等） */
export interface ShowTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: ShowTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 按时间线跑一场。`run()` 在演完（自然播完 / 快进 / dispose 都算）时 resolve，
 * 调用方接着算奖励、说赛后感言。
 *
 * `animLeadMs`：两边各自把「播动画」提前这么多发出去（[自家, 对手]）。动画要走一趟本机服务 / 换视频源才上屏，
 * 飞行物与气泡几乎是立刻的——不提前的话「手还没伸出去，东西先飞了」。提前量是真机录屏量出来的。
 */
export class BattleShow {
  private readonly steps: Step[];
  private readonly sides: ShowSides;
  private readonly timers: ShowTimers;
  private readonly animLeadMs: [number, number];
  /** 挂着的定时器句柄（快进 / dispose 要全停掉） */
  private pending: unknown[] = [];
  private done: (() => void) | null = null;
  private ended = false;

  constructor(steps: Step[], sides: ShowSides, timers: ShowTimers = realTimers, animLeadMs: [number, number] = [0, 0]) {
    this.steps = steps;
    this.sides = sides;
    this.timers = timers;
    this.animLeadMs = animLeadMs;
  }

  run(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.steps.length === 0) {
      this.finish();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.done = resolve;
      for (const step of this.steps) {
        if (step.anim) {
          const lead = this.animLeadMs[step.who];
          this.pending.push(this.timers.setTimeout(() => this.playAnim(step), Math.max(0, step.at - lead)));
        }
        this.pending.push(this.timers.setTimeout(() => this.playRest(step), step.at));
      }
      // 最后一步（收场）把台词显示完才收尾
      const last = this.steps[this.steps.length - 1];
      this.pending.push(this.timers.setTimeout(() => this.finish(), last.at + LINE_MS));
    });
  }

  /** 快进：停掉剩下的步骤，直接播收场（结果动画、结果台词、气血条的最终值） */
  skip(): void {
    if (this.ended) return;
    this.clearPending();
    const closing = this.steps.filter((step) => step.closing);
    for (const step of closing) {
      this.playAnim(step);
      this.playRest(step);
    }
    // 时间线没有收场那几步（比如事件序列被截断）：至少把气血条推到最终值
    if (closing.length === 0) this.sides.arena(this.steps[this.steps.length - 1]?.hp ?? [0, 0]);
    this.finish();
  }

  /** 收摊（退出、被别的事打断）：不再播任何步骤，run() 立即结束 */
  dispose(): void {
    this.clearPending();
    this.finish();
  }

  private sideOf(step: Step): ShowSide | null {
    return step.who === 0 ? this.sides.self : this.sides.foe;
  }

  private playAnim(step: Step): void {
    if (this.ended || !step.anim) return;
    // 没有对手窗口：那几步只是没画面
    this.sideOf(step)?.play(step.anim, step.rate ?? 1, step.from);
  }

  private playRest(step: Step): void {
    if (this.ended) return;
    this.sides.arena(step.hp);
    // 飞行物：谁放的那一步就交给特效窗口（窗口没开成时那边自己什么都不做）
    if (step.shot) this.sides.shoot(step.shot, step.who);
    if (step.line) this.sideOf(step)?.say(step.line, LINE_MS);
  }

  private clearPending(): void {
    for (const handle of this.pending.splice(0)) this.timers.clearTimeout(handle);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    const resolve = this.done;
    this.done = null;
    resolve?.();
  }
}
