/**
 * 对战演出（修炼路线 X3）：把引擎的事件序列排成一条时间线，再按时间线把动画、台词、气血条播出去。
 *
 * 分两半：
 *   - `timeline(events, names, rng, skillSets)` 是**纯函数**：只算「什么时候、哪一边、播什么、说什么」，
 *     不碰 Electron、不读时钟，可离线单测；
 *   - `BattleShow` 是个小执行器：构造时注入「自家宠物播动画 / 说话」「对手窗口播动画 / 说话」「擂台更新气血」
 *     这几个函数，按时间线跑，支持 `skip()`（快进）和 `dispose()`。`features.ts` 只负责把真实的函数传进来。
 *
 * 节奏（设计 §4.6：一场别拖太久；§X3：一个出手事件约 2.4 秒）：一次出手占一格，同一格里多段伤害的
 * 台词错开一点，挨打方的反应比出手晚 0.9 秒（对上攻击打到的时刻）。素材都是 4–6 秒的整段，
 * 按素材时长算 `rate`（倍速）让它正好占满这一步（§X3）；算出来超出 `/anim` 的合法区间就夹住，
 * 夹住以后那一段会短一点，由下一步自然顶替。
 *
 * 被动招式里接得上出手时刻的 4 段（各按自己那一拍的动画归属放，都不打断出手方的攻击动画）：
 *   - 泡泡护体：挡伤时**挨打方**的反应动画换掉它（代替 `战斗-受击`，还是晚 0.9 秒那一拍）；
 *   - 灵兽助阵：**出手方**在 beast 那一拍（和台词同拍）加播，顶掉攻击动画的尾巴——自己那下打完、灵兽追加；
 *   - 第六感：**反击方**在 counter 那一拍的晚 0.9 秒加播，正好接在自己刚挨的那一下之后（先挨一下、再反手劈）；
 *   - 无影手：**出手方**在 combo 那一拍（和台词同拍）加播，顶掉攻击动画的中后段——一拳接连续拳影；
 *     出手方没有 shadow-fists 时 combo 照旧只有台词（人人的基础连击不配拳影）。
 * 会心一击不播：它是出手方蓄力重拳的素材，而会心只是 `hit` 结算的字段，没有独立的出手时刻，台词已解说。
 *
 * 台词气泡**一律不联动说话动画**（`anim: false` 由调用方保证——X2 真机踩过：带 anim 的气泡会顶掉
 * 正在播的动画），时长给成一步那么长（`LINE_MS`），下一句自然顶替上一句。
 */
import { SKILLS, WEAPONS, type BattleEvent, type SkillId } from './battle';
import { lineOf } from './battle-lines';
import { ANIM_RATE_MAX, ANIM_RATE_MIN } from '../host/anim';

/** 开场（两边起手）一格 */
export const OPEN_MS = 2_400;
/** 一次出手一格（§X3：一个出手事件约 2.4 秒） */
export const SLOT_MS = 2_400;
/** 同一格里多段伤害的台词错开这么久（一句顶一句，都看得清） */
export const BEAT_MS = 800;
/**
 * 挨打方的反应比出手晚这么久——**兜底值**：出手素材不在下面的 `HIT_AT_MS` 表里时才用它。
 * §X3 写的「约 0.9 秒」对出拳是准的（打击时刻 ÷ 倍速 ≈ 0.96 秒），真机看下来法宝类普遍偏早，
 * 现在按素材各自的打击时刻算（见 `reactDelayOf`）。
 */
export const REACT_MS = 900;
/** 兜底的反应动画窗口 */
const REACT_ANIM_MS = SLOT_MS - REACT_MS;
/** 收场（赢的庆祝、输的倒地）一格 */
const CLOSE_MS = 3_000;
/** 第六感（反劈）比「自己挨的那一下」再晚这么久：先挨后反，别被受击动画顶掉 */
const SIXTH_SENSE_AFTER_MS = 300;
/**
 * 演出台词的显示时长：和一步的时长相当（X2 的坑：气泡压着后面的动画不好看，
 * 短到一步长就正好被下一句顶替）
 */
export const LINE_MS = SLOT_MS;

/**
 * 素材时长（§2.3 那张表；法宝 8 件与多数招式 4 秒，战斗-出拳 / 受击 / 倒地、
 * 修炼-突破 / 挨雷、假死遁 / 会心一击 / 灵兽助阵 / 蓝鲸现世是 5 秒，修炼-打坐 6 秒）。
 * 算 `rate` 用，素材重做后改这里就行。
 */
const ANIM_MS: Record<string, number> = {
  '战斗-起手': 4_000,
  '战斗-出拳': 5_000,
  '战斗-受击': 5_000,
  '战斗-闪避': 4_000,
  '战斗-倒地': 5_000,
  '战斗-胜利': 4_000,
  '修炼-打坐': 6_000,
  '修炼-突破': 5_000,
  '修炼-挨雷': 5_000,
  '修炼-服丹': 4_000,
  // 渡劫失败那一下（X4）：动画池里的现有素材，4.9 秒（名字形态播，见 TRIBULATION_LOSS_ANIM）
  '工作状态-垂头叹气冒汗': 5_000,
  '招式-假死遁': 5_000,
  '招式-会心一击': 5_000,
  '招式-灵兽助阵': 5_000,
  '招式-蓝鲸现世': 5_000,
};
/** 表里没列的（8 件法宝、其余 6 个招式）都是 4 秒 */
const DEFAULT_ANIM_MS = 4_000;

/**
 * 出手素材里「攻击打到对方」的时刻（素材**原速**时间轴上的毫秒，分镜在 prompts 文档）。
 * 挨打方的反应延迟 = 打击时刻 ÷ 这一段的倍速（倍速把素材压进了格子，打击画面出现的真实时刻
 * 也跟着被压缩）——固定 0.9 秒只有出拳对得上，法宝 / 招式的打击动作在素材中后段，真机上
 * 就是「招还没打到、人先挨了」。素材重做后跟着分镜改这里。
 */
const HIT_AT_MS: Record<string, number> = {
  '战斗-出拳': 2_000,
  '法宝-水枪': 1_900,
  '法宝-扑克牌': 1_600,
  '法宝-毽子': 1_400,
  '法宝-气球': 2_000,
  '法宝-三球': 1_900,
  '法宝-陀螺': 1_500,
  '法宝-鲸尾': 1_800,
  '法宝-烟花': 1_900,
  '招式-狮子吼': 1_600,
  '招式-蓝鲸现世': 2_250,
  '招式-灵兽助阵': 2_150,
  '招式-无影手': 1_300,
};

/**
 * 挨打方的反应该比出手晚多久：按出手素材的打击时刻算（见 `HIT_AT_MS`），夹在
 * [400, SLOT_MS - 600]——太早看不出「打中才疼」，太晚反应动画刚起就贴格尾了。
 * 出手素材不在表里（null 或没见过）就退回固定的 `REACT_MS`。
 */
export function reactDelayOf(attackAnim: string | null): number {
  if (attackAnim === null) return REACT_MS;
  const at = HIT_AT_MS[attackAnim];
  if (at === undefined) return REACT_MS;
  const rate = rateFor(attackAnim, SLOT_MS); // timeline 给出手动画用的就是这个倍速
  return Math.min(Math.max(Math.round(at / rate), 400), SLOT_MS - 600);
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

/**
 * 时间线上的一步。`who` 是引擎那边的序号（0 = 发起这场的一方 = 自家宠物，1 = 对手）。
 * `anim` 与 `line` 至少有一个。`closing` = 收场那几步（结果动画和结果台词）——快进直接跳到它们。
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
  /** 这一步之后的气血（擂台照它刷新） */
  hp: [number, number];
  closing?: boolean;
}

/** 这些事件是打在对方身上的，要对方播挨打（凭空生花是回血，不算挨打） */
function isDamageOnFoe(event: BattleEvent): boolean {
  if (event.kind === 'hit' || event.kind === 'combo' || event.kind === 'counter' || event.kind === 'beast') return true;
  return event.kind === 'skill' && event.damage !== undefined;
}

/** 出手动画：法宝 → 法宝-<名>；空手 → 战斗-出拳；主动招式 → 招式-<名> */
function attackAnimOf(event: BattleEvent): string | null {
  if (event.kind !== 'decide') return null;
  const action = event.action;
  if (action.kind === 'weapon') return WEAPONS[action.weapon].anim;
  if (action.kind === 'skill') return SKILLS[action.skill].anim;
  return '战斗-出拳';
}

/** 闪避动画：真有化鸽遁才是「化成一只鸽子」，否则通用闪避 */
function dodgeAnimOf(who: 0 | 1, skillSets?: [SkillId[], SkillId[]]): string {
  return skillSets?.[who]?.includes('dove') ? SKILLS.dove.anim : '战斗-闪避';
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
 */
export interface TimelineOptions {
  tribulation?: { pill: boolean };
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
  if (tribulation) {
    // 渡劫：没有对手，开场只有吃丹那一段（不吃丹就直接等第一道雷）
    if (tribulation.pill) {
      steps.push({
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
      steps.push({ at: 0, who, anim: '战斗-起手', rate: rateFor('战斗-起手', OPEN_MS), hp: base });
    }
  }
  let cursor = OPEN_MS;
  /** 这一格里已经排了几句台词（决定后几句错开多远） */
  let beat = 0;
  /** 这一格出手方在播的攻击动画（挨打方的反应延迟按它的打击时刻算；跨格作废，decide 时重置） */
  let lastAttackAnim: string | null = null;

  /** 一格用完：按这一格里的句数推 cursor，下一件事另起一格 */
  const closeSlot = (): void => {
    if (beat > 0) cursor += Math.max(SLOT_MS, beat * BEAT_MS);
    beat = 0;
  };

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    // start 已经换成开场那两步；台词由 lineOf 决定（它说 null 的事件就只是没字，不是没画面）
    if (event.kind === 'start') continue;

    if (event.kind === 'decide') {
      closeSlot();
      const anim = attackAnimOf(event);
      lastAttackAnim = anim;
      if (anim) steps.push({ at: cursor, who: event.actor, anim, rate: rateFor(anim, SLOT_MS), hp: event.hp });
      continue;
    }

    if (event.kind === 'end') {
      closeSlot();
      if (tribulation) {
        // 渡劫：只有自家这一边（引擎把「没扛住」的 end 排在 actor 1，这里统一排到 0），
        // 成功播 修炼-突破、失败播 工作状态-垂头叹气冒汗（池里的现有素材，名字形态）。
        // 结果不配「谁赢了」那种台词：结果感言由调用方按人设说一句（§X4 每次渡劫 +1 次模型调用）。
        const win = event.winner === 0;
        const anim = win ? TRIBULATION_WIN_ANIM : TRIBULATION_LOSS_ANIM;
        steps.push({
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
      const finish = (who: 0 | 1, anim: string): void => {
        steps.push({ at: cursor, who, anim, rate: rateFor(anim, CLOSE_MS), hp: event.hp, closing: true });
      };
      finish(winner, '战斗-胜利');
      finish(loser, '战斗-倒地');
      const line = lineOf(event, names, rng, skillSets);
      if (line) steps.push({ at: cursor, who: winner, line, hp: event.hp, closing: true });
      continue;
    }

    if (event.kind === 'strike') {
      // 渡劫：一道雷一格，挨雷的是渡劫者自己（引擎里 actor 恒为 0），没有对手的反应。
      // 台词算一句（beat += 1）：下一道雷的 closeSlot 才会推走一整格，不然几道雷全挤在同一时刻。
      closeSlot();
      const blocked = blockedHere(event);
      // 雷被泡泡挡了：这一拍改播渡劫者自己的泡泡护体（吹泡、被撞凹又弹回、破成水珠），没有对手那一边
      const anim = blocked ? SKILLS.bubble.anim : '修炼-挨雷';
      steps.push({
        at: cursor,
        who: event.actor,
        anim,
        rate: rateFor(anim, SLOT_MS),
        line: lineOf(event, names, rng, skillSets) ?? undefined,
        hp: event.hp,
      });
      beat += 1;
      continue;
    }

    // 结算事件：台词跟在出手那一方的气泡里，同一格里的第二、三段错开 BEAT_MS
    const at = cursor + beat * BEAT_MS;
    const line = lineOf(event, names, rng, skillSets);
    if (line) steps.push({ at, who: event.actor, line, hp: event.hp });
    beat += 1;
    if (event.kind === 'dodge' || event.kind === 'play-dead') {
      // 自己躲开 / 自己装死：动画就是这一拍的主角，对面没挨到、不播挨打
      const anim = event.kind === 'dodge' ? dodgeAnimOf(event.actor, skillSets) : SKILLS['play-dead'].anim;
      steps.push({ at, who: event.actor, anim, rate: rateFor(anim, REACT_ANIM_MS), hp: event.hp });
    } else if (isDamageOnFoe(event) && !playDeadAfter(events, i)) {
      // 致命那一拳后面紧跟假死遁时不播挨打：倒下的动作由假死遁自己演，两下顶在一起只会打断它
      // 反应延迟对上**攻击素材的打击时刻**（出拳 ≈0.96s、水枪/烟花 ≈1.14s、气球 ≈1.2s……）；
      // counter 挨的是反击（徒手快打，没有素材可对），维持固定 REACT_MS；
      // beast 挨的是灵兽那一撞，跟灵兽素材自己的冲撞时刻
      const delay =
        event.kind === 'counter'
          ? REACT_MS
          : event.kind === 'beast'
            ? reactDelayOf(SKILLS['spirit-beast'].anim)
            : reactDelayOf(lastAttackAnim);
      // 挡下的那一下改播挨打方自己的泡泡护体（鼓腮吹泡、被撞凹又弹回、破成水珠）
      const anim = blockedHere(event) ? SKILLS.bubble.anim : '战斗-受击';
      steps.push({
        at: at + delay,
        who: (event.actor ^ 1) as 0 | 1,
        anim,
        rate: rateFor(anim, SLOT_MS - delay),
        hp: event.hp,
      });
    }
    if (event.kind === 'counter') {
      // 第六感：反击方先挨那一下（上面受击的延迟），贴着它之后再反手劈出手刀——
      // 同拍或更早会被自己挨打的受击动画瞬间顶掉，「先挨后反」就看不出来了
      const anim = SKILLS['sixth-sense'].anim;
      const delay = reactDelayOf(lastAttackAnim) + SIXTH_SENSE_AFTER_MS;
      steps.push({ at: at + delay, who: event.actor, anim, rate: rateFor(anim, SLOT_MS - delay), hp: event.hp });
    }
    if (event.kind === 'beast') {
      // 灵兽助阵：出手方自己追加的那一下，和台词同拍，顶掉攻击动画的尾巴（自己那下打完、灵兽再上）
      const anim = SKILLS['spirit-beast'].anim;
      steps.push({ at, who: event.actor, anim, rate: rateFor(anim, SLOT_MS), hp: event.hp });
    }
    if (event.kind === 'combo' && hasSkill(event.actor, 'shadow-fists', skillSets)) {
      // 无影手：这一拍是出手方的连续拳影，和台词同拍，顶掉攻击动画的中后段。
      // 出手方没这门招式时 combo 照旧只有台词（人人的基础连击不配拳影）
      const anim = SKILLS['shadow-fists'].anim;
      steps.push({ at, who: event.actor, anim, rate: rateFor(anim, SLOT_MS), hp: event.hp });
    }
    // skip（被定住）只有台词、没有动画：图鉴里没有「定住」那一段
  }
  return steps.sort((a, b) => a.at - b.at);
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
 */
export class BattleShow {
  private readonly steps: Step[];
  private readonly sides: ShowSides;
  private readonly timers: ShowTimers;
  /** 挂着的定时器句柄（快进 / dispose 要全停掉） */
  private pending: unknown[] = [];
  private done: (() => void) | null = null;
  private ended = false;

  constructor(steps: Step[], sides: ShowSides, timers: ShowTimers = realTimers) {
    this.steps = steps;
    this.sides = sides;
    this.timers = timers;
  }

  run(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.steps.length === 0) {
      this.finish();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.done = resolve;
      for (const step of this.steps) this.pending.push(this.timers.setTimeout(() => this.play(step), step.at));
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
    for (const step of closing) this.play(step);
    // 时间线没有收场那几步（比如事件序列被截断）：至少把气血条推到最终值
    if (closing.length === 0) this.sides.arena(this.steps[this.steps.length - 1]?.hp ?? [0, 0]);
    this.finish();
  }

  /** 收摊（退出、被别的事打断）：不再播任何步骤，run() 立即结束 */
  dispose(): void {
    this.clearPending();
    this.finish();
  }

  private play(step: Step): void {
    if (this.ended) return;
    this.sides.arena(step.hp);
    const side = step.who === 0 ? this.sides.self : this.sides.foe;
    // 没有对手窗口：那几步只是没画面，气血条照更新
    if (!side) return;
    if (step.anim) side.play(step.anim, step.rate ?? 1, step.from);
    if (step.line) side.say(step.line, LINE_MS);
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
