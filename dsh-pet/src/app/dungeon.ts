/**
 * 通用跑图（历练路线 Y0）：给定存档里的一趟状态和主人的一个决定，算出下一个状态和这一步要演什么。
 *
 * 纯逻辑：不碰 Electron、不读写文件、不读时钟（`now` 由参数传入）、不调模型。
 * 秘境特有的东西（春秋蝉、白凝冰、炼蛊……）只写在各自的定义文件和钩子里（`dungeon-sanwang.ts`），
 * 这一层不出现任何具体秘境的名字——以后加血色禁地只加数据。
 *
 * **先记账再演出**：主人的每个决定都由这里先算完、写进状态；演到一半退出 app，重开时这一步已经算完，
 * 直接到下一个决定，不会重算、不会换结果。
 * **种子**：每个节点的随机数都从「种子 + 层 + 节点 + 第几轮」派生（`nodeRng` / `fightSeed`）。
 * 「第几轮」是倒带用的：倒回去以后同一层要重新掷，不然照样再输一次。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MOVES,
  MOVE_IDS,
  SKILL_IDS,
  WEAPONS,
  WEAPON_IDS,
  fight,
  majorBreaks,
  rngFrom,
  type Action,
  type BattleEvent,
  type Controller,
  type Fighter,
  type MoveId,
  type WeaponId,
} from './battle';
import { drawDropWeapon } from './cultivation';

/** 秘境规则版本：秘境规则变了就 +1，旧版本的一趟按撤退结算（任务书 §3 Y0） */
export const DUNGEON_VERSION = 1;
/** 每一步赶路 15 秒，不能跳过（设计 §7.2：快进只压缩战斗） */
export const TRAVEL_MS = 15_000;
/** 进了 24 小时还没走完，按撤退结算 */
export const RUN_TTL_MS = 24 * 60 * 60 * 1000;

export type Tier = 'mob' | 'elite' | 'boss';

/** 对手倍率：按主人当前小境界的典型成长取期望值，再乘档（任务书 §3 Y0「数值」） */
export const FOE_MULT: Record<Tier, number> = { mob: 0.8, elite: 0.9, boss: 0.9 };
/**
 * 各档的修为收益（各秘境一样）：设计 §4.7 的数值翻倍——按原数一趟平均约 10、手动每小时约 150，
 * 离设计 §7.1 的约 350 太远，2026-10-27 用户拍板翻倍（宝箱、收齐后的法宝折算同步翻倍）
 */
export const FIGHT_XP: Record<Tier, number> = { mob: 8, elite: 14, boss: 24 };
/** 精英：30% 掉一件还没有的法宝 */
export const ELITE_DROP_CHANCE = 0.3;
/** 守护那一份里功法玉简的比例（其余是一件法宝） */
export const BOSS_SCROLL_CHANCE = 0.15;
/** 图鉴收齐以后掉法宝改掉的修为（设计 §4.7「收齐以后」） */
export const DROP_FALLBACK_XP = 10;
/** 宝箱：修为 6–12、15% 破境丹；20% 是机关，没躲开扣 15% 气血 */
export const CHEST_XP_MIN = 6;
export const CHEST_XP_MAX = 12;
export const CHEST_PILL_CHANCE = 0.15;
export const CHEST_TRAP_CHANCE = 0.2;
export const CHEST_CUT_SHARE = 0.15;
/** 灵泉（调息）回这么多比例的气血上限 */
export const SPRING_HEAL = 0.3;
/** 灵泉余韵：开打前回这么多 */
export const ECHO_HEAL = 0.1;
/** 托管：气血低于这个比例就优先找灵泉（设计 §4.8 写的是「低于一半」） */
export const AUTO_SPRING_BELOW = 0.72;

/** 守护前最多挑几件法宝（设计 §4.5） */
export const LOADOUT_MAX = 3;

/** 加持（设计 §4.4）：只在这一趟有效，不进长期存档 */
export type BlessingId = 'echo' | 'borrow' | 'core' | 'light' | 'last-stand' | 'mouse';

export interface BlessingDef {
  id: BlessingId;
  name: string;
  text: string;
  /** 卡面素材（`assets/pic/adventure/通用/加持-<名>.png`） */
  card: string;
  /** 压境入内时不进池（借剑：法宝全封住了，多一件法宝无从谈起） */
  noSuppressed?: boolean;
  /** 开打前改 Fighter 的那几项 */
  fighter?: { power?: number; dodge?: number; desperate?: number };
}

export const BLESSINGS: Record<BlessingId, BlessingDef> = {
  echo: {
    id: 'echo',
    name: '灵泉余韵',
    text: '泉水的凉意留在身上：之后每场开打前回 10% 气血',
    card: '加持-灵泉余韵',
  },
  borrow: {
    id: 'borrow',
    name: '借剑',
    text: '不知哪位前辈的剑借你一用：这一趟多一件随机的灵器法宝',
    card: '加持-借剑',
    noSuppressed: true,
  },
  core: { id: 'core', name: '妖丹', text: '吞了枚妖丹，灵力 +3', card: '加持-妖丹', fighter: { power: 3 } },
  light: {
    id: 'light',
    name: '身轻如燕',
    text: '身子轻得像片羽毛，闪避 +6%',
    card: '加持-身轻如燕',
    fighter: { dodge: 0.06 },
  },
  'last-stand': {
    id: 'last-stand',
    name: '背水一战',
    text: '气血低于三成时，伤害 ×1.3',
    card: '加持-背水一战',
    fighter: { desperate: 1.3 },
  },
  mouse: { id: 'mouse', name: '寻宝鼠', text: '一只老鼠钻进怀里：守护的掉落多一份', card: '加持-寻宝鼠' },
};

export const BLESSING_IDS = Object.keys(BLESSINGS) as BlessingId[];

/** 节点种类（设计 §4.2，各秘境按场景换皮） */
export type NodeKind = 'mob' | 'elite' | 'boss' | 'chest' | 'spring' | 'event' | 'ruin';

/** 文案可以按这一趟的状态现编（秘境自己写在数据文件里，通用层只调用） */
export type NodeText = string[] | ((run: Run) => string[]);

/** 判定：属性 + 难度（成功率显示在选项旁边） */
export interface CheckDef {
  stat: 'power' | 'agility';
  /** 难度绝对值；不给就按主人当前小境界的典型属性期望值 × dcShare */
  dc?: number;
  /** 不给 dc 时按典型属性的这个倍数 */
  dcShare?: number;
}

/** 一个奇遇选项的结算：全是声明式字段，通用跑图照着执行，不认识「驭犬蛊」「定仙游」 */
export interface EventOutcome {
  text: NodeText;
  /** 回这么多比例的气血上限（治伤、调息） */
  healShare?: number;
  /** 扣掉当前气血的这么多（「气血减半」= 0.5） */
  cutShare?: number;
  loot?: Partial<Loot>;
  flags?: Record<string, string | number | boolean>;
  /** 这段奇遇之后接着打这一场（名册里的对手编号） */
  fight?: string;
  /** 打赢这场多掉几份（原著的杀人夺蛊） */
  fightExtra?: number;
  /** 打赢这场以后才打上的标记 */
  fightFlags?: Record<string, string | number | boolean>;
  /** 判定成功就跳过这一场（没有奖励） */
  skip?: boolean;
  /** 按撤退结算 */
  retreat?: boolean;
}

/** 奇遇的一个选项 */
export interface EventChoiceDef {
  label: string;
  /** 选项下面那行小字（「赢了多掉一份」「失败就被偷袭」） */
  note?: string;
  check?: CheckDef;
  /** 托管走哪个（设计 §4.8「选最稳妥的那个选项」） */
  safe?: boolean;
  /** 出现条件（「记得」才有的那两个原著选项） */
  when?: (run: Run) => boolean;
  /** 没有判定时就是结果；有判定时是成的那支 */
  outcome: EventOutcome;
  lose?: EventOutcome;
}

/** 奇遇：走进去直接结算（auto），或者让主人点一个选项（choices） */
export interface EventDef {
  choices?: EventChoiceDef[];
  auto?: EventOutcome;
}

/** 宝箱的判定改法（炼蛊关：每次都判、判定用灵力，炼废 = 炸炉） */
export interface ChestDef {
  /** 判定属性（默认身法） */
  check?: CheckDef;
  /** 是机关的概率（默认 20%；炼蛊关每次都要过判定，给 1） */
  trapChance?: number;
  /** 判定没过扣当前气血的这么多（默认 15%） */
  cutShare?: number;
  /** 判定没过还留不留这一份奖励（默认留：普通宝箱东西已经抓在手里；炼蛊关不给） */
  rewardOnFail?: boolean;
  /** 判定没过时的文案（默认「箱子里弹出机关」） */
  failText?: NodeText;
}

export interface NodeDef {
  id: string;
  kind: NodeKind;
  name: string;
  /** 节点图标（`assets/pic/adventure/通用/图标-<名>.png`） */
  icon: string;
  /** 场景插画（缺了显示这一层的底图，任务书 §2.1 的兜底） */
  art?: string;
  /** 宠物的秘境动作（`assets/webm/秘境-<名>.webm`） */
  anim?: string;
  text: NodeText;
  /** 战斗节点的对手编号（名册里的 id） */
  foe?: string;
  chest?: ChestDef;
  event?: EventDef;
  /** 灵泉节点的回血比例（默认 30%） */
  healShare?: number;
}

/** 名册里的对手（不进图鉴、不进名帖、不会掉落，所以 `BATTLE_VERSION` 不升） */
export interface FoeDef {
  id: string;
  name: string;
  tier: Tier;
  /** 招式表里的编号 */
  moves: MoveId[];
  /** 立绘 / 动作前缀（`对手-<名>`） */
  prefix: string;
  /** 复用别人立绘的那只（熔岩鳄、他派蛊师）：借谁的皮、加什么滤镜 */
  skin?: string;
  filter?: string;
  /** 精英的画法：放大 1.2 倍、加一圈金边（任务书 §2.3） */
  eliteLook?: boolean;
  /** 这一只自己的倍率（在档位倍率之外再乘一下；按模拟调数值用） */
  scale?: number;
  /** 打法（守护前亮出来，主人照它挑法宝） */
  tactics: string;
  /** 登场文字 */
  text: string[];
}

/** 规则钩子拿到的上下文：整个 party（多人时不止一只） */
export interface FightCtx {
  def: DungeonDef;
  run: Run;
  node: NodeDef;
  /** 自己这一边：一个成员一个 Fighter（现在只有自己） */
  party: Fighter[];
  /** 对手 */
  foe: Fighter;
  foeDef: FoeDef;
  /** 这一场这一轮的随机数（补丁用） */
  rng: () => number;
}

/** 倒带回哪一层、倒回去以后打上什么标记 */
export interface RewindTarget {
  layer: number;
  flags?: Record<string, string | number | boolean>;
}

export interface EndingDef {
  id: string;
  name: string;
  text: NodeText;
  /** 结局页宠物冒的那一句泡 */
  bubble?: NodeText;
  titles: string[];
  /** 在守护那一份之外多给几卷功法玉简 */
  scrolls?: number;
  /** 结局页的宠物动作（定仙游的碧芒一闪） */
  anim?: string;
}

/** 秘境自己的规则全挂在这几个钩子上：通用跑图里不出现具体秘境的名字 */
export interface DungeonRules {
  /** 这一层能不能撤（默认能） */
  canRetreat?: (run: Run, layer: number) => boolean;
  /** 输了能不能倒带、倒回哪一层、打什么标记（不给或 null = 没有地方可倒） */
  rewindTarget?: (run: Run, layer: number) => RewindTarget | null;
  /** 进这一层时存不存快照（给 false = 留着上一层那一份） */
  snapshot?: (run: Run, entering: number) => boolean;
  /** 这一层给哪些节点（分支层按路走；不给 = 用 layer.nodes） */
  nodes?: (run: Run, layer: LayerDef) => string[];
  /** 一层里有好几步（青铜大殿）：按这一趟的状态算出步序 */
  steps?: (run: Run, layer: LayerDef) => string[];
  /** 这一路给的一转蛊（开打前加进 Fighter.moves） */
  gu?: (run: Run) => MoveId | null;
  /** 驭犬蛊的狗数（Fighter.pack） */
  pack?: (run: Run) => number;
  /** 开打前的补丁：替挡、开场少两成气血、被背刺减半都在这里 */
  patchFight?: (ctx: FightCtx) => void;
  /** 打赢一场以后秘境自己的状态变化（每过一轮多一只驭犬蛊） */
  afterFight?: (ctx: FightCtx) => void;
  /** 守护这一场打的是谁（按标记换人） */
  boss?: (run: Run, node: NodeDef) => string | null;
  /** 结局（打赢守护才有） */
  ending?: (run: Run) => EndingDef | null;
  /** 提前揭开哪几层的迷雾（默认只露下一层） */
  revealLayers?: (run: Run) => number[];
  /** 提前亮出哪些对手的打法 */
  revealFoes?: (run: Run) => string[];
  /** 小窗上的日子和裂缝（只是文案，不影响数值） */
  day?: (run: Run) => { label: string; cracks: number };
}

export interface LayerDef {
  /** 第几层（1 起） */
  index: number;
  /** 地点标签（「三叉山 · 光柱」） */
  name: string;
  /** 这一层的底图（节点插画缺了就用它） */
  art?: string;
  /** 可选的节点编号（分支层） */
  nodes?: string[];
  /** 一层里好几步（大殿）：步序由 rules.steps 给 */
  linear?: boolean;
}

export interface DungeonDef {
  id: string;
  version: number;
  name: string;
  /** 原著境界（压境入内时双方都按它算；三王是筑基初期 = stage 9） */
  originStage: number;
  cover: string;
  map: string;
  /** 过场视频（缺了封面淡入 + 开场文字） */
  video: { enter: string; rewind: string };
  /** 进秘境的开场文字（原著原话放最显眼的位置） */
  opening: string[];
  foes: Record<string, FoeDef>;
  nodes: Record<string, NodeDef>;
  layers: LayerDef[];
  blessings: BlessingId[];
  /** 秘境共用的文案 */
  lines: {
    retreat: string[];
    lose: string[];
    /** 那个倒带按钮的名字（三王是「自爆，催动春秋蝉」） */
    rewind: string;
    /** 倒带以后小窗上写的那句 */
    rewindText: string[];
    /** 打上「记得」以后多出来的那句 */
    remember?: string;
    expired: string[];
  };
  rules: DungeonRules;
}

// ---------------------------------------------------------------------------
// 状态（导出 zod 的 runSchema，Y1 存档要用）
// ---------------------------------------------------------------------------

/** 这一趟攒下的东西：走完一并入账（Y1） */
export const lootSchema = z.object({
  xp: z.number().int().min(0),
  pills: z.number().int().min(0),
  weapons: z.array(z.enum(WEAPON_IDS)),
  scrolls: z.number().int().min(0),
  titles: z.array(z.string().min(1).max(16)),
});

export type Loot = z.infer<typeof lootSchema>;

export const memberSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(24),
  /** 跨场保留的气血（进秘境时满血） */
  hp: z.number().int().min(0),
  loot: lootSchema,
});

/** 战斗里的一次出手（手动战斗和回放的口子，设计 §4.16） */
export const actionDecisionSchema = z.object({
  kind: z.literal('action'),
  node: z.string().min(1).max(32),
  side: z.union([z.literal(0), z.literal(1)]),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('weapon'), weapon: z.enum(WEAPON_IDS) }),
    z.object({ kind: z.literal('unarmed') }),
    z.object({ kind: z.literal('skill'), skill: z.enum(SKILL_IDS) }),
    z.object({ kind: z.literal('move'), move: z.enum(MOVE_IDS) }),
  ]),
});

/** 主人的一个决定，以及战斗里自己一方的每次出手（进存档） */
export const decisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), node: z.string().min(1).max(32) }),
  z.object({ kind: z.literal('choice'), node: z.string().min(1).max(32), index: z.number().int().min(0).max(5) }),
  z.object({
    kind: z.literal('blessing'),
    node: z.string().min(1).max(32),
    blessing: z.enum(BLESSING_IDS),
  }),
  z.object({
    kind: z.literal('loadout'),
    node: z.string().min(1).max(32),
    weapons: z.array(z.enum(WEAPON_IDS)).max(LOADOUT_MAX),
  }),
  z.object({ kind: z.literal('rewind') }),
  z.object({ kind: z.literal('retreat') }),
  z.object({ kind: z.literal('end') }),
  actionDecisionSchema,
]);

export type Decision = z.infer<typeof decisionSchema>;

/** 跑图的核心状态：快照就是它的一份拷贝（不含 snapshot / decisions） */
const runCoreSchema = z.object({
  version: z.number().int().min(1),
  dungeon: z.string().min(1).max(32),
  /** 进秘境时的随机数（多人的口子：现在只有一份） */
  nonces: z.array(z.string().min(1).max(64)).min(1).max(4),
  seed: z.string().length(64),
  /** 压境入内 */
  suppressed: z.boolean(),
  mode: z.literal('solo'),
  leader: z.string().min(1).max(32),
  members: z.array(memberSchema).min(1).max(4),
  /** 第几层、这一层走到第几步（大殿有好几步） */
  layer: z.number().int().min(1),
  step: z.number().int().min(0),
  /** 走过的节点在这一层里的下标（一层多步时有多条，画走过的路用） */
  path: z.array(z.number().int().min(-1).max(9)).max(32),
  /** 第几轮（倒带以后 +1） */
  attempt: z.number().int().min(1),
  blessings: z.array(z.enum(BLESSING_IDS)),
  /** 秘境自己的状态：哪一王、驭犬蛊数、记得、识破…… */
  flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** running = 还在走；lost = 刚输了一场（能倒带或就此收场）；over = 已结算 */
  status: z.enum(['running', 'lost', 'over']),
  /** 走进节点以后还等主人点一下（选项 / 加持三选一 / 挑法宝） */
  pending: z
    .object({
      node: z.string().min(1).max(32),
      need: z.enum(['choice', 'blessing', 'loadout']),
      /** 加持三选一的候选 */
      options: z.array(z.string().max(32)).max(6),
    })
    .nullable(),
  /** 这一步的赶路什么时候走完；之前不收新的决定 */
  readyAt: z.number().int(),
  startedAt: z.number().int(),
});

export const runSchema = runCoreSchema.extend({
  /** 进这一层时存的一份拷贝，倒带用 */
  snapshot: runCoreSchema.nullable(),
  decisions: z.array(decisionSchema).default([]),
});

export type Run = z.infer<typeof runSchema>;
export type RunCore = z.infer<typeof runCoreSchema>;

// ---------------------------------------------------------------------------
// 现在能做的选择 / 这一步要演什么
// ---------------------------------------------------------------------------

/** 战斗节点亮出来的对手打法（守护前必看，设计 §4.5） */
export interface FoePreview {
  id: string;
  name: string;
  tier: Tier;
  tactics: string;
  moves: string[];
  hp: number;
}

export type Choice =
  /** 走到下一层（或本层下一步）的某个节点 */
  | { kind: 'node'; layer: number; step: number; node: NodeDef; foe?: FoePreview }
  /** 奇遇的选项（带成功率） */
  | { kind: 'choice'; node: string; index: number; label: string; note?: string; rate?: number }
  /** 加持三张卡 */
  | { kind: 'blessing'; node: string; blessing: BlessingId; name: string; text: string; card: string }
  /** 守护前挑法宝（不给就是全带） */
  | { kind: 'loadout'; node: string; weapons: WeaponId[]; max: number; foe: FoePreview }
  | { kind: 'rewind'; label: string }
  | { kind: 'retreat'; label: string }
  /** 输了又不倒带：就此收场 */
  | { kind: 'end'; label: string };

/** 一场战斗：双方 Fighter、事件序列、对手编号（事件不进存档，只给演出和回放） */
export interface FightResult {
  kind: 'fight';
  foe: string;
  tier: Tier;
  seed: string;
  fighters: [Fighter, Fighter];
  events: BattleEvent[];
  won: boolean;
  /** 打完的气血 [自己, 对手] */
  hp: [number, number];
  reward: Loot;
  /** 对手的每次出手（跟着结果返回：原样重放一场要用两边记下的出手） */
  foeActions: Action[];
}

export type OutcomeResult =
  | { kind: 'enter'; node: string; name: string; text: string[]; art?: string; anim?: string; foe?: FoePreview }
  | FightResult
  | { kind: 'chest'; success: boolean; reward: Loot; hpLost: number; text: string[]; anim?: string }
  | { kind: 'spring'; healed: number; hp: number; anim?: string }
  | { kind: 'event'; text: string[]; reward?: Loot; hpLost?: number; fought?: FightResult; anim?: string }
  | { kind: 'blessing'; blessing: BlessingId; name: string; text: string; card: string; anim?: string }
  | { kind: 'rewind'; layer: number; text: string[]; video: string }
  | {
      kind: 'end';
      reason: FinishReason;
      loot: Loot;
      text: string[];
      ending?: EndingDef;
      /** 结局页的宠物动作（得宝、定仙游） */
      anim?: string;
    };

/** 结算的原因：走完 / 输了 / 撤退 / 超时 */
export type FinishReason = 'clear' | 'lose' | 'retreat' | 'expired';

export interface StepOutcome {
  /** 这一步的赶路走完的时刻（之前的决定不收） */
  readyAt: number;
  /** 这一步有没有那 15 秒赶路（Y3 照它播 秘境-赶路 和头像移动） */
  travel: boolean;
  result: OutcomeResult;
  /** 这一步顺带把这一趟走完了：结算原因、战利品和结局（先演完这一步，再到结局页） */
  end?: { reason: FinishReason; loot: Loot; text: string[]; ending?: EndingDef };
}

export type StepResult = { run: Run; outcome: StepOutcome };

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

/** 多份随机数合成一个种子（多人的口子：先承诺后揭示，现在只传一份） */
export function seedOf(nonces: string[]): string {
  return createHash('sha256').update(nonces.join(':')).digest('hex');
}

/** 这个节点这一轮用的随机数：种子 + 层 + 节点 + 第几轮 */
export function nodeRng(run: Run, node: string): () => number {
  return rngFrom(`${run.seed}:${run.layer}:${node}:${run.attempt}`);
}

/** 这一场战斗的种子（同口径，所以倒带以后同一层会重新掷） */
export function fightSeed(run: Run, node: string): string {
  return `${run.seed}:${run.layer}:${node}:${run.attempt}`;
}

/**
 * 典型成长的期望值（任务书 §3 Y0「数值」）：`battle-testkit` 的 `fighterAt` 口径，但不随机、不带法宝招式。
 * 初始灵力 38/12、身法 47/12、遁速 47/12、气血 50（同 `drawInitialStats` 的权重，期望可逐项拆开算）；
 * 小境界随机一项 +1～2（每项期望 +0.5）、气血 +6；大境界突破三项各 +1、气血 +20。
 */
export function typicalStats(stage: number): { hp: number; power: number; agility: number; speed: number } {
  const big = majorBreaks(stage);
  const small = stage - big;
  const each = small * 0.5 + big;
  return {
    hp: 50 + small * 6 + big * 20,
    power: Math.round(38 / 12 + each),
    agility: Math.round(47 / 12 + each),
    speed: Math.round(47 / 12 + each),
  };
}

/** 判定成功率：同境界各属性贴典型值时约六成，高一项 +5%，夹在 20%–95% */
export function checkChance(stat: number, dc: number): number {
  return Math.min(0.95, Math.max(0.2, 0.55 + (stat - dc) * 0.05));
}

export function resolveText(text: NodeText, run: Run): string[] {
  return typeof text === 'function' ? text(run) : text;
}

function emptyLoot(): Loot {
  return { xp: 0, pills: 0, weapons: [], scrolls: 0, titles: [] };
}

function addLoot(into: Loot, gain: Partial<Loot>): void {
  into.xp += gain.xp ?? 0;
  into.pills += gain.pills ?? 0;
  into.scrolls += gain.scrolls ?? 0;
  for (const w of gain.weapons ?? []) if (!into.weapons.includes(w)) into.weapons.push(w);
  for (const t of gain.titles ?? []) if (!into.titles.includes(t)) into.titles.push(t);
}

function hasLoot(loot: Loot): boolean {
  return loot.xp > 0 || loot.pills > 0 || loot.weapons.length > 0 || loot.scrolls > 0 || loot.titles.length > 0;
}

function sumLoot(members: Run['members']): Loot {
  const total = emptyLoot();
  for (const m of members) addLoot(total, m.loot);
  return total;
}

/** 快照 = 不含 snapshot 和 decisions 的一份拷贝 */
function coreOf(run: Run): RunCore {
  const core: Record<string, unknown> = { ...structuredClone(run) };
  delete core.snapshot;
  delete core.decisions;
  return core as unknown as RunCore;
}

// ---------------------------------------------------------------------------
// 层的形状
// ---------------------------------------------------------------------------

function layerOf(def: DungeonDef, run: Run): LayerDef {
  const layer = def.layers.find((l) => l.index === run.layer);
  if (!layer) throw new Error(`秘境 ${def.id} 没有第 ${run.layer} 层`);
  return layer;
}

/** 这一层的节点序列：线性层按 rules.steps，分支层按 rules.nodes 或 layer.nodes */
function layerNodeIds(def: DungeonDef, run: Run, layer: LayerDef): string[] {
  if (layer.linear) return def.rules.steps?.(run, layer) ?? [];
  return def.rules.nodes?.(run, layer) ?? layer.nodes ?? [];
}

/** 现在能走到的节点：分支层全给，线性层只给下一步 */
export function reachableNodes(def: DungeonDef, run: Run): string[] {
  const layer = layerOf(def, run);
  const ids = layerNodeIds(def, run, layer);
  if (!layer.linear) return ids;
  return run.step < ids.length ? [ids[run.step]] : [];
}

/** 这一层要走几步：分支层选一个就走完，线性层要走完 steps 的每一步 */
function layerSteps(def: DungeonDef, run: Run, layer: LayerDef): number {
  return layer.linear ? layerNodeIds(def, run, layer).length : 1;
}

/** 这一场要打的那一只（守护按标记换人） */
export function foeOfNode(def: DungeonDef, run: Run, node: NodeDef): string | null {
  if (node.kind === 'boss') return def.rules.boss?.(run, node) ?? node.foe ?? null;
  return node.foe ?? null;
}

/** 主人当前小境界（startRun 记进 flags，对手按它算） */
export function stageOf(run: Run): number {
  return typeof run.flags.stage === 'number' ? run.flags.stage : 0;
}

export function selfMember(run: Run): Run['members'][number] {
  return run.members.find((m) => m.id === run.leader) ?? run.members[0];
}

// ---------------------------------------------------------------------------
// 双方 Fighter
// ---------------------------------------------------------------------------

/** 按档配出对手：典型成长期望值 × 倍率，四项都乘、向下取整、最低 1，再配上名册里的招式 */
export function buildFoe(def: DungeonDef, run: Run, foeId: string): Fighter {
  const roster = def.foes[foeId];
  if (!roster) throw new Error(`名册里没有对手 ${foeId}`);
  const stage = run.suppressed ? def.originStage : stageOf(run);
  const base = typicalStats(stage);
  const mult = FOE_MULT[roster.tier] * (roster.scale ?? 1);
  const cut = (n: number) => Math.max(1, Math.floor(n * mult));
  return {
    name: roster.name,
    hp: cut(base.hp),
    power: cut(base.power),
    agility: cut(base.agility),
    speed: cut(base.speed),
    weapons: [],
    skills: [],
    moves: [...roster.moves],
  };
}

/**
 * 自己这一边：跨场气血、这一路给的一转蛊、加持的修正、压境的封属性和砍到典型值都在这贴上去。
 * `pet` 是 `Cultivation.fighter()`。
 */
export function buildParty(def: DungeonDef, run: Run, pet: Fighter): Fighter[] {
  const gu = def.rules.gu?.(run) ?? null;
  const bonus = borrowOf(run);
  return run.members.map((m, i) => {
    if (i > 0) {
      // 队友的属性由队友自己的存档决定（试点只有自己）
      return { ...pet, name: m.name, hpNow: Math.max(1, m.hp) };
    }
    const f: Fighter = {
      ...pet,
      name: m.name,
      hp: Math.max(1, pet.hp),
      power: pet.power,
      agility: pet.agility,
      speed: pet.speed,
      weapons: [...pet.weapons],
      skills: [...pet.skills],
      hpNow: Math.max(1, m.hp),
    };
    if (run.suppressed) {
      // 压境入内：法宝和招式全封住，只用这一路给的一转蛊；四项取自己的和典型值里小的那个
      const typical = typicalStats(def.originStage);
      f.weapons = [];
      f.skills = [];
      f.hp = Math.max(1, Math.min(pet.hp, typical.hp));
      f.power = Math.max(1, Math.min(pet.power, typical.power));
      f.agility = Math.max(1, Math.min(pet.agility, typical.agility));
      f.speed = Math.max(1, Math.min(pet.speed, typical.speed));
      f.hpNow = Math.max(1, Math.min(f.hp, m.hp));
    }
    const moves: MoveId[] = [...(pet.moves ?? [])];
    if (gu && !moves.includes(gu)) moves.push(gu);
    if (moves.length > 0) f.moves = moves;
    if (gu === 'gu-dogs') f.pack = Math.max(1, def.rules.pack?.(run) ?? 1);
    // 加持改 Fighter 的那几项（多项叠加）
    let dodge = pet.mods?.dodge ?? 0;
    let desperate = pet.mods?.desperate;
    for (const id of run.blessings) {
      const add = BLESSINGS[id].fighter;
      if (!add) continue;
      if (add.power) f.power += add.power;
      if (add.dodge) dodge += add.dodge;
      if (add.desperate !== undefined)
        desperate = desperate === undefined ? add.desperate : Math.max(desperate, add.desperate);
    }
    const mods: { dodge?: number; desperate?: number } = {};
    if (dodge > 0) mods.dodge = dodge;
    if (desperate !== undefined) mods.desperate = desperate;
    if (Object.keys(mods).length > 0) f.mods = mods;
    // 借剑：这一趟多一件随机的灵器法宝（压境时不出这一张，法宝也全封着）
    if (!run.suppressed && bonus && !f.weapons.includes(bonus)) f.weapons.push(bonus);
    return f;
  });
}

/** 借剑那件法宝（记在 flags 里，Y1 不入长期存档） */
function borrowOf(run: Run): WeaponId | null {
  const raw = run.flags.borrow;
  return typeof raw === 'string' && (WEAPON_IDS as string[]).includes(raw) ? (raw as WeaponId) : null;
}

/** 选项旁边那个成功率（写文案的是秘境自己，公式在通用层）：看贴完加持、压境砍过的那份属性 */
export function chanceOf(def: DungeonDef, run: Run, pet: Fighter, check: CheckDef): number {
  const me = buildParty(def, run, pet)[0];
  const stat = check.stat === 'power' ? me.power : me.agility;
  const stage = run.suppressed ? def.originStage : stageOf(run);
  return checkChance(stat, Math.round(check.dc ?? typicalStats(stage)[check.stat] * (check.dcShare ?? 1)));
}

// ---------------------------------------------------------------------------
// 进秘境 / 查询
// ---------------------------------------------------------------------------

/** 进秘境：这一趟的种子在这时定下、存进状态；`pet` 是 `Cultivation.fighter()`，`stage` 是当前小境界 */
export function startRun(
  def: DungeonDef,
  options: { pet: Fighter; stage: number; suppressed: boolean; nonce: string; now: number },
): Run {
  const { pet, stage, suppressed, nonce, now } = options;
  const nonces = [nonce];
  const run: Run = {
    version: DUNGEON_VERSION,
    dungeon: def.id,
    nonces,
    seed: seedOf(nonces),
    suppressed,
    mode: 'solo',
    leader: 'self',
    members: [{ id: 'self', name: pet.name, hp: pet.hp, loot: emptyLoot() }],
    layer: 1,
    step: 0,
    path: [],
    attempt: 1,
    blessings: [],
    flags: { stage },
    status: 'running',
    pending: null,
    snapshot: null,
    decisions: [],
    // 进秘境本身算一步：赶路从这一刻起算
    readyAt: now + TRAVEL_MS,
    startedAt: now,
  };
  run.snapshot = coreOf(run);
  return run;
}

/** 现在能做的选择：下一层的节点、奇遇的选项（带成功率）、加持三张卡、守护前挑法宝、「催动春秋蝉」、撤退 */
export function choicesOf(def: DungeonDef, run: Run, pet: Fighter): Choice[] {
  const out: Choice[] = [];
  if (run.status === 'over') return out;
  if (run.status === 'lost') {
    if (def.rules.rewindTarget?.(run, run.layer)) out.push({ kind: 'rewind', label: def.lines.rewind });
    out.push({ kind: 'end', label: '就此收场' });
    return out;
  }
  if (run.pending) {
    const node = def.nodes[run.pending.node];
    if (!node) throw new Error(`状态里记着还没结算的节点 ${run.pending.node}，名册里没有它`);
    if (run.pending.need === 'choice') {
      (node.event?.choices ?? []).forEach((c, index) => {
        if (c.when && !c.when(run)) return;
        out.push({
          kind: 'choice',
          node: node.id,
          index,
          label: c.label,
          ...(c.note ? { note: c.note } : {}),
          ...(c.check ? { rate: chanceOf(def, run, pet, c.check) } : {}),
        });
      });
      return out;
    }
    if (run.pending.need === 'blessing') {
      for (const id of run.pending.options) {
        const b = BLESSINGS[id as BlessingId];
        if (b) out.push({ kind: 'blessing', node: node.id, blessing: b.id, name: b.name, text: b.text, card: b.card });
      }
      return out;
    }
    const foe = foePreviewOf(def, run, node);
    if (foe) out.push({ kind: 'loadout', node: node.id, weapons: weaponChoices(def, run, pet), max: LOADOUT_MAX, foe });
    return out;
  }
  for (const id of reachableNodes(def, run)) {
    const node = def.nodes[id];
    if (!node) throw new Error(`秘境 ${def.id} 的层里有个不存在的节点 ${id}`);
    const foe = foePreviewOf(def, run, node);
    out.push({ kind: 'node', layer: run.layer, step: run.step, node, ...(foe ? { foe } : {}) });
  }
  if (def.rules.canRetreat?.(run, run.layer) ?? true) out.push({ kind: 'retreat', label: '撤退' });
  return out;
}

function foePreviewOf(def: DungeonDef, run: Run, node: NodeDef): FoePreview | undefined {
  const foeId = foeOfNode(def, run, node);
  if (!foeId) return undefined;
  const roster = def.foes[foeId];
  if (!roster) throw new Error(`名册里没有对手 ${foeId}`);
  return {
    id: foeId,
    name: roster.name,
    tier: roster.tier,
    tactics: roster.tactics,
    moves: roster.moves.map((id) => MOVES[id].name),
    hp: buildFoe(def, run, foeId).hp,
  };
}

/** 能挑的法宝：自己有的（借剑那件也算）。压境时法宝全封住，没得挑 */
export function weaponChoices(_def: DungeonDef, run: Run, pet: Fighter): WeaponId[] {
  if (run.suppressed) return [];
  const out = [...pet.weapons];
  const bonus = borrowOf(run);
  if (bonus && !out.includes(bonus)) out.push(bonus);
  return out;
}

/** 这一趟还能看见后面哪几层（探路那类钩子揭开的照实显示） */
export function visibleLayers(def: DungeonDef, run: Run): number[] {
  const extra = def.rules.revealLayers?.(run) ?? [];
  return [...new Set([run.layer + 1, ...extra])].sort((a, b) => a - b);
}

/** 提前亮出打法的对手编号（眼下能走到的那些也算） */
export function revealedFoes(def: DungeonDef, run: Run): string[] {
  const out = new Set(def.rules.revealFoes?.(run) ?? []);
  for (const id of reachableNodes(def, run)) {
    const node = def.nodes[id];
    const foe = node ? foeOfNode(def, run, node) : null;
    if (node && foe) out.add(foe);
  }
  return [...out];
}

/** 小窗上的日子（「福地内第 N 天（外面已过 3N 天）」）；秘境没有这个钩子时 null */
export function dayLabel(def: DungeonDef, run: Run): { label: string; cracks: number } | null {
  return def.rules.day?.(run) ?? null;
}

// ---------------------------------------------------------------------------
// 推进一步
// ---------------------------------------------------------------------------

/**
 * 推进一步：先校验（这一趟已结算、赶路没走完、决定不在能做的选择里都拒绝），再由纯逻辑算出下一步。
 * 决定不合法就抛错——接线只会用 `choicesOf` 给过的决定，静默降级反而查不出问题。
 */
export function advance(def: DungeonDef, run: Run, pet: Fighter, decision: Decision, now: number): StepResult {
  if (run.status === 'over') throw new Error('这一趟已经结算完了');
  if (now < run.readyAt) throw new Error('这一步的赶路还没走完，还不收新的决定');
  const next = structuredClone(run);

  // 输了：只剩倒带和收场
  if (next.status === 'lost') {
    if (decision.kind === 'rewind') return rewind(def, next, now);
    if (decision.kind === 'end') return finish(def, next, 'lose', now, def.lines.lose);
    throw new Error('输了以后只能倒带或者就此收场');
  }

  if (decision.kind === 'retreat') {
    if (!(def.rules.canRetreat?.(next, next.layer) ?? true)) throw new Error('这一层撤不出去');
    return finish(def, next, 'retreat', now, def.lines.retreat);
  }

  // 节点里等主人点的那一下：不再算赶路
  if (next.pending) {
    const node = def.nodes[next.pending.node];
    if (!node) throw new Error(`状态里记着还没结算的节点 ${next.pending.node}`);
    if (next.pending.need === 'choice' && decision.kind === 'choice' && decision.node === node.id) {
      return applyChoice(def, next, node, pet, decision.index, now);
    }
    if (next.pending.need === 'blessing' && decision.kind === 'blessing' && decision.node === node.id) {
      return takeBlessing(def, next, node, pet, decision.blessing, now);
    }
    if (next.pending.need === 'loadout' && decision.kind === 'loadout' && decision.node === node.id) {
      next.pending = null;
      return doFight(def, next, node, pet, now, decision.weapons, false);
    }
    throw new Error(`「${node.name}」这一步要先做个选择，不是${decision.kind}`);
  }

  if (decision.kind !== 'node') throw new Error(`现在该走的是节点，不是${decision.kind}`);
  const node = def.nodes[decision.node];
  if (!node || !reachableNodes(def, next).includes(node.id)) throw new Error(`走不到这个节点：${decision.node}`);
  const layer = layerOf(def, next);
  next.path = [...next.path, layerNodeIds(def, next, layer).indexOf(node.id)];
  next.step = next.step + 1;
  return enterNode(def, next, node, pet, now);
}

/** 走进一个节点：能一次算完的当场算完（战斗就在这里打），只等选项 / 挑法宝 / 加持的才挂 pending */
function enterNode(def: DungeonDef, run: Run, node: NodeDef, pet: Fighter, now: number): StepResult {
  switch (node.kind) {
    case 'mob':
    case 'elite':
      return doFight(def, run, node, pet, now, null, true);
    case 'boss': {
      if (weaponChoices(def, run, pet).length > 0) {
        // 守护：先亮打法，等主人挑法宝（挑法宝不再算赶路）
        run.pending = { node: node.id, need: 'loadout', options: [] };
        return enterOutcome(def, run, node, now);
      }
      // 压境时法宝全封住，没得挑：直接打
      return doFight(def, run, node, pet, now, [], true);
    }
    case 'chest':
      return openChest(def, run, node, pet, now);
    case 'spring': {
      const m = selfMember(run);
      const max = Math.max(1, pet.hp);
      const healed = Math.min(Math.max(0, max - m.hp), Math.floor(max * (node.healShare ?? SPRING_HEAL)));
      m.hp += healed;
      return stepResult(
        def,
        run,
        now,
        { kind: 'spring', healed, hp: m.hp, ...(node.anim ? { anim: node.anim } : {}) },
        true,
      );
    }
    case 'ruin': {
      const pool = def.blessings.filter(
        (id) => !run.blessings.includes(id) && !(run.suppressed && BLESSINGS[id].noSuppressed),
      );
      const rng = nodeRng(run, node.id);
      const left = [...pool];
      const picks: BlessingId[] = [];
      while (picks.length < 3 && left.length > 0) picks.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
      if (picks.length === 0) {
        // 加持全攒齐了（走过五处以上才会碰到）：这一处只是看看，白走一步
        return stepResult(
          def,
          run,
          now,
          { kind: 'enter', node: node.id, name: node.name, text: resolveText(node.text, run) },
          true,
        );
      }
      run.pending = { node: node.id, need: 'blessing', options: picks };
      return enterOutcome(def, run, node, now);
    }
    case 'event': {
      const choices = node.event?.choices;
      if (choices && choices.some((c) => !c.when || c.when(run))) {
        run.pending = { node: node.id, need: 'choice', options: [] };
        return enterOutcome(def, run, node, now);
      }
      if (node.event?.auto) return applyOutcome(def, run, node, node.event.auto, pet, now, true);
      throw new Error(`奇遇 ${node.id} 既没有可用的选项也没有既定结果`);
    }
  }
}

/** 走进节点、还等主人点一下的那一步 */
function enterOutcome(def: DungeonDef, run: Run, node: NodeDef, now: number): StepResult {
  const foe = foePreviewOf(def, run, node);
  return {
    run,
    outcome: {
      readyAt: now + TRAVEL_MS,
      travel: true,
      result: {
        kind: 'enter',
        node: node.id,
        name: node.name,
        text: resolveText(node.text, run),
        ...(node.art ? { art: node.art } : {}),
        ...(node.anim ? { anim: node.anim } : {}),
        ...(foe ? { foe } : {}),
      },
    },
  };
}

/**
 * 宝箱：修为 +3–6、15% 破境丹；20% 是机关，按身法判定躲开，没躲开扣 15% 气血。
 * `chest` 换掉那套默认口径（炼蛊关：每次都判、判定用灵力，炼废 = 炸炉、这一份也没了）。
 */
function openChest(def: DungeonDef, run: Run, node: NodeDef, pet: Fighter, now: number): StepResult {
  const cfg = node.chest ?? {};
  const rng = nodeRng(run, node.id);
  const m = selfMember(run);
  const reward = emptyLoot();
  reward.xp = CHEST_XP_MIN + Math.floor(rng() * (CHEST_XP_MAX - CHEST_XP_MIN + 1));
  if (rng() < CHEST_PILL_CHANCE) reward.pills = 1;
  const trap = rng() < (cfg.trapChance ?? CHEST_TRAP_CHANCE);
  const success = !trap || rng() < chanceOf(def, run, pet, cfg.check ?? { stat: 'agility' });
  let hpLost = 0;
  if (!success) {
    if (!cfg.rewardOnFail) {
      reward.xp = 0;
      reward.pills = 0;
    }
    hpLost = Math.floor(m.hp * (cfg.cutShare ?? CHEST_CUT_SHARE));
    m.hp = Math.max(1, m.hp - hpLost);
  }
  addLoot(m.loot, reward);
  const text = success ? resolveText(node.text, run) : resolveText(cfg.failText ?? TRAP_TEXT, run);
  return stepResult(
    def,
    run,
    now,
    { kind: 'chest', success, reward, hpLost, text, ...(node.anim ? { anim: node.anim } : {}) },
    true,
  );
}

const TRAP_TEXT = ['咔——箱子里弹出机关，扫出一道火光。'];

/** 奇遇：主人点一个选项（判定在这里掷） */
function applyChoice(def: DungeonDef, run: Run, node: NodeDef, pet: Fighter, index: number, now: number): StepResult {
  const picked = (node.event?.choices ?? [])[index];
  if (!picked || (picked.when && !picked.when(run))) throw new Error(`这个选项目前不能选：${node.id}/${index}`);
  run.pending = null;
  let outcome = picked.outcome;
  if (picked.check) {
    const rng = nodeRng(run, node.id);
    if (rng() >= chanceOf(def, run, pet, picked.check) && picked.lose) outcome = picked.lose;
  }
  return applyOutcome(def, run, node, outcome, pet, now, false);
}

/** 按声明的字段结算一个奇遇结果 */
function applyOutcome(
  def: DungeonDef,
  run: Run,
  node: NodeDef,
  outcome: EventOutcome,
  pet: Fighter,
  now: number,
  travel: boolean,
): StepResult {
  const m = selfMember(run);
  const text = resolveText(outcome.text, run);
  if (outcome.flags) Object.assign(run.flags, outcome.flags);
  let hpLost = 0;
  if (outcome.healShare !== undefined) {
    const max = Math.max(1, pet.hp);
    m.hp = Math.min(max, m.hp + Math.floor(max * outcome.healShare));
  }
  if (outcome.cutShare !== undefined) {
    hpLost = Math.floor(m.hp * outcome.cutShare);
    m.hp = Math.max(1, m.hp - hpLost);
  }
  const reward = emptyLoot();
  if (outcome.loot) addLoot(reward, outcome.loot);
  addLoot(m.loot, reward);
  if (outcome.retreat) return finish(def, run, 'retreat', now, text);
  const base: OutcomeResult = {
    kind: 'event',
    text,
    ...(hasLoot(reward) ? { reward } : {}),
    ...(hpLost > 0 ? { hpLost } : {}),
    ...(node.anim ? { anim: node.anim } : {}),
  };
  if (outcome.fight) {
    const fought = runFight(def, run, { ...node, kind: 'elite', foe: outcome.fight }, pet, {
      extraRolls: outcome.fightExtra ?? 0,
      flags: outcome.fightFlags ?? null,
    });
    if (!fought.won) return loseRound(run, now, fought.result);
    addLoot(selfMember(run).loot, fought.result.reward);
    def.rules.afterFight?.(fought.ctx);
    return stepResult(def, run, now, { ...base, fought: fought.result }, travel);
  }
  return stepResult(def, run, now, base, travel);
}

/** 加持三选一（只在这一趟有效） */
function takeBlessing(
  def: DungeonDef,
  run: Run,
  node: NodeDef,
  pet: Fighter,
  blessing: BlessingId,
  now: number,
): StepResult {
  if (!run.pending || run.pending.need !== 'blessing' || !run.pending.options.includes(blessing)) {
    throw new Error(`这一张卡不在候选里：${blessing}`);
  }
  run.blessings = [...run.blessings, blessing];
  run.pending = null;
  if (blessing === 'borrow') {
    // 借剑：这一趟多一件随机的灵器法宝（还没有的里面挑；灵器全有了就换别的品级）
    const rng = nodeRng(run, node.id);
    const owned = weaponChoices(def, run, pet);
    let pool = WEAPON_IDS.filter((id) => WEAPONS[id].grade === '灵器' && !owned.includes(id));
    if (pool.length === 0) pool = WEAPON_IDS.filter((id) => !owned.includes(id));
    if (pool.length > 0) run.flags.borrow = pool[Math.floor(rng() * pool.length)];
  }
  const b = BLESSINGS[blessing];
  return stepResult(
    def,
    run,
    now,
    {
      kind: 'blessing',
      blessing: b.id,
      name: b.name,
      text: b.text,
      card: b.card,
      ...(node.anim ? { anim: node.anim } : {}),
    },
    false,
  );
}

/** 战斗节点（小怪 / 精英 / 守护） */
function doFight(
  def: DungeonDef,
  run: Run,
  node: NodeDef,
  pet: Fighter,
  now: number,
  loadout: WeaponId[] | null,
  travel: boolean,
): StepResult {
  const fought = runFight(def, run, node, pet, { loadout });
  if (!fought.won) return loseRound(run, now, fought.result);
  addLoot(selfMember(run).loot, fought.result.reward);
  def.rules.afterFight?.(fought.ctx);
  return stepResult(def, run, now, fought.result, travel);
}

interface Fought {
  result: FightResult;
  won: boolean;
  ctx: FightCtx;
}

interface FightOptions {
  /** 守护前挑的法宝（空 = 全带；只有守护节点用） */
  loadout?: WeaponId[] | null;
  /** 多掉几份（原著的杀人夺蛊） */
  extraRolls?: number;
  /** 打赢以后才打上的标记 */
  flags?: Record<string, string | number | boolean> | null;
}

/** 一场战斗的完整结算：配双方 → 钩子补丁 → `resolveFight` → 气血跨场 → 掉落 → 记出手 */
function runFight(def: DungeonDef, run: Run, node: NodeDef, pet: Fighter, options: FightOptions): Fought {
  const foeId = foeOfNode(def, run, node);
  if (!foeId) throw new Error(`战斗节点 ${node.id} 没有对手`);
  const roster = def.foes[foeId];
  const m = selfMember(run);
  const party = buildParty(def, run, pet);
  const foe = buildFoe(def, run, foeId);
  // 守护前挑法宝：引擎不用改，传进去的 weapons 少几件就行
  const loadout = options.loadout;
  if (roster.tier === 'boss' && loadout && loadout.length > 0) {
    const allowed = weaponChoices(def, run, pet);
    party[0].weapons = loadout.filter((w) => allowed.includes(w));
  }
  // 灵泉余韵：开打前回 10% 气血
  if (run.blessings.includes('echo')) {
    const max = Math.max(1, party[0].hp);
    m.hp = Math.min(max, m.hp + Math.floor(max * ECHO_HEAL));
    party[0].hpNow = Math.max(1, m.hp);
  }
  const seed = fightSeed(run, node.id);
  const ctx: FightCtx = { def, run, node, party, foe, foeDef: roster, rng: rngFrom(`${seed}:patch`) };
  def.rules.patchFight?.(ctx);
  const { events, hpAfter, won } = resolveFight(ctx.party, ctx.foe, seed);
  // 气血跨场：赢了带着剩下的血进下一步；输了由调用方清零
  m.hp = won ? hpAfter[0] : 0;
  const reward = won
    ? fightLoot(
        roster.tier,
        rngFrom(`${seed}:loot`),
        [...weaponChoices(def, run, pet), ...m.loot.weapons],
        options.extraRolls ?? 0,
        run.blessings.includes('mouse'),
      )
    : emptyLoot();
  if (won && options.flags) Object.assign(run.flags, options.flags);
  // 自己一方的每次出手记进 run.decisions（手动战斗和回放的口子，设计 §4.16）
  for (const action of actionsOf(events, 0)) {
    run.decisions = [...run.decisions, { kind: 'action', node: node.id, side: 0, action }];
  }
  const result: FightResult = {
    kind: 'fight',
    foe: foeId,
    tier: roster.tier,
    seed,
    fighters: [ctx.party[0], ctx.foe],
    events,
    won,
    hp: [hpAfter[0], hpAfter[1]],
    reward,
    foeActions: actionsOf(events, 1),
  };
  return { result, won, ctx };
}

function actionsOf(events: BattleEvent[], side: 0 | 1): Action[] {
  const out: Action[] = [];
  for (const e of events) if (e.kind === 'decide' && e.actor === side) out.push(e.action);
  return out;
}

/** 按档掉落（设计 §4.7）：小怪只有修为；精英 30% 掉一件还没有的法宝；守护必掉一份，15% 是功法玉简 */
export function fightLoot(tier: Tier, rng: () => number, owned: WeaponId[], extraRolls: number, mouse: boolean): Loot {
  const loot: Loot = { xp: FIGHT_XP[tier], pills: 0, weapons: [], scrolls: 0, titles: [] };
  const drop = () => {
    const weapon = drawDropWeapon(owned, rng);
    if (weapon) {
      loot.weapons.push(weapon);
      owned.push(weapon);
    } else loot.xp += DROP_FALLBACK_XP; // 图鉴收齐了：法宝改成修为
  };
  if (tier === 'elite') {
    if (rng() < ELITE_DROP_CHANCE) drop();
    for (let i = 0; i < extraRolls; i++) drop();
  }
  if (tier === 'boss') {
    const rolls = 1 + extraRolls + (mouse ? 1 : 0);
    for (let i = 0; i < rolls; i++) {
      if (rng() < BOSS_SCROLL_CHANCE) loot.scrolls += 1;
      else drop();
    }
  }
  return loot;
}

/** 输了：这一趟到此为止（能倒带的由主人选），已经拿到的照拿 */
function loseRound(run: Run, now: number, fought: FightResult): StepResult {
  run.status = 'lost';
  run.pending = null;
  selfMember(run).hp = 0;
  return { run, outcome: { readyAt: now, travel: false, result: fought } };
}

/** 倒带：回到钩子指定的那一层开头（气血、战利品、加持、驭犬蛊数都回到快照） */
function rewind(def: DungeonDef, run: Run, now: number): StepResult {
  const target = def.rules.rewindTarget?.(run, run.layer);
  if (!target) throw new Error('这一趟已经没有能倒回去的地方');
  if (!run.snapshot) throw new Error('状态里没有快照，倒不回去');
  const core = structuredClone(run.snapshot);
  const restored: Run = { ...core, snapshot: run.snapshot, decisions: run.decisions };
  restored.attempt = run.attempt + 1;
  restored.layer = target.layer;
  restored.step = 0;
  restored.pending = null;
  restored.status = 'running';
  restored.flags = { ...core.flags, ...(target.flags ?? {}), rewound: true };
  const layer = def.layers.find((l) => l.index === target.layer);
  const text = [...def.lines.rewindText, ...(layer ? [`回到了${layer.name}开头。`] : [])];
  if (def.lines.remember && target.flags?.remember) text.push(def.lines.remember);
  return {
    run: restored,
    outcome: {
      readyAt: now,
      travel: false,
      result: { kind: 'rewind', layer: target.layer, text, video: def.video.rewind },
    },
  };
}

/**
 * 走完这一步以后的位置变化 + 收场：最后一层走完就是「走完」（结局由钩子给）；
 * 本层还有下一步就停在这儿，否则进下一层（进层时存快照）。
 * @returns 这一步顺带把这一趟走完了时带回结算（附在 `StepOutcome.end`，演出照旧先演完这一步）
 */
function stepResult(def: DungeonDef, run: Run, now: number, result: OutcomeResult, travel: boolean): StepResult {
  run.pending = null;
  const layer = layerOf(def, run);
  const layerDone = run.step >= layerSteps(def, run, layer);
  if (layerDone && run.layer >= def.layers.length) {
    const ending = def.rules.ending?.(run) ?? null;
    const text = ending ? resolveText(ending.text, run) : ['这一趟走完了。'];
    const loot = finishRun(def, run, 'clear', ending);
    return {
      run,
      outcome: {
        readyAt: now + TRAVEL_MS,
        travel,
        result,
        end: { reason: 'clear', loot, text, ...(ending ? { ending } : {}) },
      },
    };
  }
  if (layerDone) {
    const entering = run.layer + 1;
    run.layer = entering;
    run.step = 0;
    if (def.rules.snapshot?.(run, entering) ?? true) run.snapshot = coreOf(run);
  }
  // 赶路的 15 秒只算在「走一步」上（travel = true）：节点里补点的那一下不再加一次
  return { run, outcome: { readyAt: travel ? now + TRAVEL_MS : now, travel, result } };
}

/** 收场：结算 + 结局的称号 / 玉简进账 */
function finish(def: DungeonDef, run: Run, reason: FinishReason, now: number, text: string[]): StepResult {
  const ending = reason === 'clear' ? (def.rules.ending?.(run) ?? null) : null;
  const loot = finishRun(def, run, reason, ending);
  return {
    run,
    outcome: {
      readyAt: now,
      travel: false,
      result: {
        kind: 'end',
        reason,
        loot,
        text,
        ...(ending ? { ending } : {}),
        ...(ending?.anim ? { anim: ending.anim } : {}),
      },
    },
  };
}

function finishRun(def: DungeonDef, run: Run, reason: FinishReason, ending: EndingDef | null): Loot {
  if (reason === 'clear' && ending) {
    addLoot(selfMember(run).loot, { titles: ending.titles, scrolls: ending.scrolls ?? 0 });
  }
  run.status = 'over';
  run.pending = null;
  return settle(def, run, reason);
}

/**
 * 结算：各成员这一趟攒下的东西并进一份。压境时修为 ×1.5，各秘境的修为一样（设计 §4.7）。
 * 输了不受罚：已经拿到的照拿（`lose` 只是没有结局那份称号和玉简）。
 */
export function settle(_def: DungeonDef, run: Run, reason: FinishReason): Loot {
  void reason;
  const total = sumLoot(run.members);
  if (run.suppressed) total.xp = Math.floor(total.xp * 1.5);
  return total;
}

/** 按原因收场（Y1 的超时结算要用）：不动传进来的状态，返回这一趟的战利品 */
export function settleByReason(def: DungeonDef, run: Run, reason: FinishReason): Loot {
  return settle(def, structuredClone(run), reason);
}

/** 进了 24 小时还没走完（Y1 的 tick 拿它按撤退结算） */
export function expired(run: Run, now: number): boolean {
  return run.status !== 'over' && now - run.startedAt >= RUN_TTL_MS;
}

// ---------------------------------------------------------------------------
// 留给多人和手动战斗的口子（设计 §4.13、§4.16）
// ---------------------------------------------------------------------------

/**
 * 节点里的战斗只走这一个入口：`party` 一个成员一个 Fighter（现在只有自己），里面就是
 * `fight(宠物, 对手, seed, controllers)`。返回事件、每个成员打完的气血、赢没赢。
 */
export function resolveFight(
  party: Fighter[],
  foe: Fighter,
  seed: string,
  controllers?: [Controller, Controller],
): { events: BattleEvent[]; hpAfter: number[]; won: boolean } {
  if (party.length === 0) throw new Error('队伍是空的');
  if (party.length > 1) throw new Error('试点只支持一个成员的队伍');
  const events = fight(party[0], foe, seed, controllers);
  const last = events[events.length - 1];
  const hp: [number, number] = last.kind === 'end' ? last.hp : [party[0].hpNow ?? party[0].hp, 0];
  return { events, hpAfter: [Math.max(0, hp[0]), Math.max(0, hp[1])], won: last.kind === 'end' && last.winner === 0 };
}

/** 照着记下的出手走（手动战斗的口子）：用完了按空手，以后换成「问主人」的信号 */
export function scriptedController(actions: readonly Action[]): Controller {
  let i = 0;
  return { decide: () => actions[i++] ?? { kind: 'unarmed' } };
}

/**
 * 原样重放一场：种子 + 记下的出手（自己一方在 `run.decisions` 里，对手那串跟着战斗结果返回）。
 * 两边的出招者都换成记下的出手，所以不依赖决策随机数——这就是 §4.16「重放到缺决策处」的走法。
 */
export function replayFight(
  party: Fighter[],
  foe: Fighter,
  seed: string,
  own: readonly Action[],
  foeActions: readonly Action[],
): { events: BattleEvent[]; hpAfter: number[]; won: boolean } {
  return resolveFight(party, foe, seed, [scriptedController(own), scriptedController(foeActions)]);
}

// ---------------------------------------------------------------------------
// 托管的挑法（设计 §4.8）：试点不接托管，模拟和测试要用
// ---------------------------------------------------------------------------

/** 岔路：气血低于一半先找灵泉，否则宝箱 > 妖兽 > 精英；奇遇选最稳妥的；遗迹随机；守护不挑法宝全带 */
export function autoDecide(def: DungeonDef, run: Run, pet: Fighter): Decision {
  if (run.status === 'lost') {
    return def.rules.rewindTarget?.(run, run.layer) ? { kind: 'rewind' } : { kind: 'end' };
  }
  if (run.pending) {
    const node = def.nodes[run.pending.node];
    if (!node) throw new Error(`状态里记着还没结算的节点 ${run.pending.node}`);
    if (run.pending.need === 'choice') {
      const visible = (node.event?.choices ?? [])
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => !c.when || c.when(run));
      return { kind: 'choice', node: node.id, index: (visible.find(({ c }) => c.safe) ?? visible[0])?.index ?? 0 };
    }
    if (run.pending.need === 'blessing') {
      const rng = nodeRng(run, node.id);
      const options = run.pending.options;
      const picked = options.length > 0 ? options[Math.floor(rng() * options.length)] : 'core';
      return { kind: 'blessing', node: node.id, blessing: picked as BlessingId };
    }
    return { kind: 'loadout', node: node.id, weapons: [] }; // 全带
  }
  const nodes = reachableNodes(def, run);
  const alive = selfMember(run).hp / Math.max(1, pet.hp);
  const prefer: NodeKind[] =
    alive < AUTO_SPRING_BELOW
      ? ['spring', 'chest', 'ruin', 'mob', 'event', 'elite', 'boss']
      : ['chest', 'ruin', 'mob', 'event', 'elite', 'spring', 'boss'];
  for (const kind of prefer) {
    const id = nodes.find((n) => def.nodes[n]?.kind === kind);
    if (id) return { kind: 'node', node: id };
  }
  if (nodes.length === 1) return { kind: 'node', node: nodes[0] };
  if (nodes.length > 1) {
    const rng = nodeRng(run, `layer${run.layer}`);
    return { kind: 'node', node: nodes[Math.floor(rng() * nodes.length)] };
  }
  return { kind: 'retreat' };
}
