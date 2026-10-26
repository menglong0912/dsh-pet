/**
 * 修炼核心（修炼路线 X1）：境界、修为、属性成长、每日封顶和存档，全在这一个类里，可离线单测。
 *
 * 不读时钟、不碰 Electron：所有方法都带 now，由 X2 的接线每拍喂进来；随机数经构造函数注入。
 * 修为来源只在装 feature 的那台电脑上算（在电脑前、久坐提醒、Claude 干完活、心魔、切磋），不上网。
 *
 * 存在 $DSH_HOME/dsh-pet/cultivation.json，先写临时文件再改名（同 saveAppConfig）。
 * 文件读不了或内容坏了 → 把原文件改名为 .bad-<时间>、明确 warn，按第一次建档重建（不静默覆盖）。
 * 每天第一次写入前，先把旧文件复制成 cultivation.json.bak（只留一份，下次覆盖）。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { diaryDate } from './diary';
import {
  SKILLS,
  SKILL_IDS,
  WEAPONS,
  WEAPON_IDS,
  majorBreaks,
  type Fighter,
  type SkillId,
  type WeaponId,
} from './battle';

/** 大境界：名字、小境界名、每个小境界要的修为（炼气九层，之后每个大境界三段） */
const MAJORS: ReadonlyArray<{ name: string; subs: readonly string[]; req: number }> = [
  { name: '炼气', subs: ['一层', '二层', '三层', '四层', '五层', '六层', '七层', '八层', '九层'], req: 150 },
  { name: '筑基', subs: ['初期', '中期', '后期'], req: 1_000 },
  { name: '金丹', subs: ['初期', '中期', '后期'], req: 2_000 },
  { name: '元婴', subs: ['初期', '中期', '后期'], req: 4_000 },
  { name: '化神', subs: ['初期', '中期', '后期'], req: 7_000 },
  { name: '炼虚', subs: ['初期', '中期', '后期'], req: 10_000 },
  { name: '合体', subs: ['初期', '中期', '后期'], req: 14_000 },
  { name: '大乘', subs: ['初期', '中期', '后期'], req: 20_000 },
];

/** 最后一个小境界（大乘后期）：修满显示「大乘圆满」，之后不再涨 */
export const MAX_STAGE = 29;

const statsSchema = z.object({
  hp: z.number().int().min(1),
  power: z.number().int().min(1),
  agility: z.number().int().min(1),
  speed: z.number().int().min(1),
});

export type CultivationStats = z.infer<typeof statsSchema>;

/** 日记口径的一天里的各项计数（跨凌晨 4 点换日清零） */
const todaySchema = z.object({
  date: z.string(),
  /** 在电脑前攒下的修为（每天封顶 240） */
  presence: z.number().int().min(0),
  /** 在电脑前的毫秒数 */
  presenceMs: z.number().int().min(0),
  /** 调息次数（每天最多 3） */
  rests: z.number().int().min(0),
  /** 今天炼成过几颗丹（每天最多 3） */
  pills: z.number().int().min(0),
  /** 今天心魔算过收益的场次（只有第 1 场有收益） */
  trial: z.number().int().min(0),
  /** 今天切磋算过收益的邻居（同一邻居一天一场，收益每天前 3 场） */
  spars: z.array(z.string().min(1).max(64)).max(16),
});

/** 渡劫成功后待选的二选一（X4）：两个招式编号 + 有效期（毫秒时间戳，过期在 tick 里随机定一个） */
const offerSchema = z.object({
  a: z.enum(SKILL_IDS),
  b: z.enum(SKILL_IDS),
  until: z.number().int().nonnegative(),
});

type CultivationOffer = z.infer<typeof offerSchema>;

const saveSchema = z.object({
  version: z.literal(1),
  stage: z.number().int().min(0).max(MAX_STAGE),
  progress: z.number().int().min(0),
  stats: statsSchema,
  weapons: z.array(z.enum(WEAPON_IDS)).max(WEAPON_IDS.length),
  skills: z.array(z.enum(SKILL_IDS)).max(SKILL_IDS.length),
  pills: z.number().int().min(0).max(9),
  /** X4 的二选一；X1 建的旧档恒为 null（nullable 保持读得了） */
  offer: offerSchema.nullable(),
  today: todaySchema,
  record: z.object({ wins: z.number().int().min(0), losses: z.number().int().min(0) }),
});

export type CultivationSave = z.infer<typeof saveSchema>;

/** 修炼过程中发生的事（X2 拿去冒泡和记日记） */
export type CultivationEvent =
  | { kind: 'stage-up'; stage: number }
  | { kind: 'full' }
  /** 渡劫成功、进了新大境界（属性加成已到账；招式在下面那条 `offer` / `choose` 里） */
  | { kind: 'breakthrough' }
  /** 二选一挂出来了（菜单两项，`until` 前有效） */
  | { kind: 'offer'; a: SkillId; b: SkillId }
  /** 领悟了某一门招式（主人点的，或二选一过期随机定的） */
  | { kind: 'choose'; skill: SkillId }
  /** 渡劫失败：扣了这么多修为（不掉境界） */
  | { kind: 'tribulation-fail'; lost: number }
  | { kind: 'rest'; gain: number }
  | { kind: 'pill' }
  | { kind: 'drop'; weapon: WeaponId }
  /**
   * 这一笔实际进了账的修为（X3 打完一场要照它冒泡「修为 +30」）。
   * 只在真的加进去时发（amount > 0）：圆满之后多出来的不要、当天不算收益的场次，都不发——
   * 冒泡「+30」而存档一点没动是骗人。一次升级跨两个小境界会发多条。
   */
  | { kind: 'xp'; amount: number };

/** `tribulationPlan` 的结论：这一场渡劫的开场条件（§X4） */
export interface TribulationPlan {
  /** 喂给引擎 `tribulate` 的境界（渡的是当前这一境圆满，天雷按它涨） */
  stage: number;
  /** 要扛几道雷 */
  strikes: number;
  /** 有没有破境丹可吃（气血上限 ×1.2，一次最多吃 1 颗） */
  canPill: boolean;
  /** 渡过去要进的那一境（菜单、日记用） */
  nextLabel: string;
}

/** 设置页和右键菜单用的只读视图 */
export interface CultivationView {
  stage: number;
  /** 「炼气三层」「筑基中期」；大乘后期修满是「大乘圆满」 */
  label: string;
  /** 当前小境界进度百分比，取整 */
  percent: number;
  /** 圆满（大境界最后一个小境界修满，可以渡劫） */
  full: boolean;
  stats: CultivationStats;
  weapons: string[];
  skills: string[];
  pills: number;
  /** 渡劫成功后待选的二选一（菜单的「领悟：X」两项）；没有就 null */
  offer: { a: SkillId; b: SkillId } | null;
  record: { wins: number; losses: number };
}

/** 这一段修为每天从在电脑前攒多少（tick 的封顶） */
export const PRESENCE_DAILY_MAX = 240;
/** 调息加多少修为 */
const REST_GAIN = 20;
/** 调息：每天最多几次、离开离久坐提醒多近才算 */
const REST_DAILY_MAX = 3;
const REST_WINDOW_MS = 10 * 60_000;
/** 一分钟攒 1 点；心浮气躁时减半（攒 2 分钟才 +1） */
const MINUTE_MS = 60_000;
/** 破境丹：库存上限、每天最多炼几颗、每次 Claude 干完活的炼成概率 */
const PILLS_MAX = 9;
const PILLS_DAILY_MAX = 3;
const PILL_CHANCE = 0.2;
/** 心魔：当天只有第 1 场有收益，赢了 30% 掉一件还没有的法宝 */
const TRIAL_WIN_XP = 30;
const TRIAL_LOSE_XP = 10;
const DROP_CHANCE = 0.3;
/** 切磋：每天前 3 场有收益 */
const SPAR_DAILY_MAX = 3;
const SPAR_WIN_XP = 20;
const SPAR_LOSE_XP = 10;
/**
 * 渡劫（X4）：失败扣当前小境界 20% 的修为，最多 300（设计 §4.3：封顶以后任何境界失败最多耽误一天左右）。
 * 扣完就不再是圆满，攒回来才能再渡劫——这本身就是冷却，**不另设冷却计时**。
 */
const TRIBULATION_LOSS_SHARE = 0.2;
const TRIBULATION_LOSS_MAX = 300;
/** 破境丹：渡劫这一场气血上限 ×1.2，每次渡劫最多吃 1 颗 */
const PILL_HP_FACTOR = 1.2;
/** 二选一挂 10 分钟（设计 §4.3：这是「完全不能控制」那条差评的最小补救，不加别的操作） */
const OFFER_MS = 10 * 60_000;
/**
 * 单拍最多计入多长的「在电脑前」：接线每 5 秒（TICK_MS）喂一拍，正常间隔远小于这个数；
 * 睡眠 / 合盖后醒来的那一拍间隔会很长，不封顶就会把整段睡眠当成在场，一下攒满当天的 240
 */
export const TICK_MAX_ELAPSED_MS = 30_000;
/** 图鉴删掉 / 改名的法宝：旧编号 → 新编号（X8：气球删了，换成接替它的雪球） */
const RENAMED_WEAPONS: Record<string, WeaponId> = { balloon: 'snowball' };

/**
 * 读档前先按现在的图鉴迁移（X8）：存档的 zod 校验认图鉴编号，删了的法宝留在档里会整档读不出来、被当成坏档重建。
 * 改了名的换成新编号（已经有了就去掉），其余不认识的法宝 / 招式编号丢掉。`changed` = 动过（要写回）。
 */
export function migrateCatalog(raw: unknown): { save: unknown; changed: boolean } {
  if (typeof raw !== 'object' || raw === null) return { save: raw, changed: false };
  const save = raw as { weapons?: unknown; skills?: unknown };
  let changed = false;
  const known = new Set<string>(WEAPON_IDS);
  if (Array.isArray(save.weapons)) {
    const weapons: string[] = [];
    for (const id of save.weapons) {
      const next = typeof id === 'string' ? (RENAMED_WEAPONS[id] ?? id) : id;
      if (typeof next !== 'string' || !known.has(next) || weapons.includes(next)) {
        changed = true;
        continue;
      }
      if (next !== id) changed = true;
      weapons.push(next);
    }
    save.weapons = weapons;
  }
  const skills = new Set<string>(SKILL_IDS);
  if (Array.isArray(save.skills)) {
    const kept = save.skills.filter((id) => typeof id === 'string' && skills.has(id));
    if (kept.length !== save.skills.length) changed = true;
    save.skills = kept;
  }
  return { save, changed };
}

/** 掉法宝的品级权重（同 battle-testkit 的成长近似）：凡器 70%、灵器 25%、神器 5% */
const GRADE_WEIGHT: Record<'凡器' | '灵器' | '神器', number> = { 凡器: 0.7, 灵器: 0.25, 神器: 0.05 };

function emptyToday(date: string): z.infer<typeof todaySchema> {
  return { date, presence: 0, presenceMs: 0, rests: 0, pills: 0, trial: 0, spars: [] };
}

/** 「炼气三层」「筑基中期」；full 且是大乘后期时是「大乘圆满」 */
export function stageLabel(stage: number, full = false): string {
  const major = MAJORS[majorBreaks(stage)];
  const label = `${major.name}${major.subs[stage - indexOfMajorStart(stage)]}`;
  return full && stage === MAX_STAGE ? '大乘圆满' : label;
}

/** 这个大境界在 stage 序号里的起点 */
function indexOfMajorStart(stage: number): number {
  const big = majorBreaks(stage);
  return big === 0 ? 0 : 9 + (big - 1) * 3;
}

/** 每个小境界要的修为 */
export function stageReq(stage: number): number {
  return MAJORS[majorBreaks(stage)].req;
}

/** 是不是本大境界的最后一个小境界（修满 = 圆满，等渡劫） */
export function isFullStage(stage: number): boolean {
  return stage < MAX_STAGE ? majorBreaks(stage + 1) > majorBreaks(stage) : true;
}

/**
 * 渡劫要扛几道雷（§X4）：进筑基、金丹 3 道，进元婴、化神 6 道，之后 9 道。
 * @param nextStage 要进的那个小境界（圆满时是 `stage + 1`）
 */
export function tribulationStrikes(nextStage: number): number {
  const big = majorBreaks(nextStage);
  return big <= 2 ? 3 : big <= 4 ? 6 : 9;
}

/**
 * 心魔掉法宝：在还没有的法宝里按品级权重挑（凡器 70%、灵器 25%、神器 5%）。
 * 某个品级已经集齐就把它的权重去掉，其余按比例分；全都集齐返回 null。
 */
export function drawDropWeapon(owned: WeaponId[], rng: () => number): WeaponId | null {
  const missing = WEAPON_IDS.filter((id) => !owned.includes(id));
  if (missing.length === 0) return null;
  const grades = (Object.keys(GRADE_WEIGHT) as Array<keyof typeof GRADE_WEIGHT>).filter((grade) =>
    missing.some((id) => WEAPONS[id].grade === grade),
  );
  let pickAt = rng() * grades.reduce((sum, grade) => sum + GRADE_WEIGHT[grade], 0);
  const grade = grades.find((g) => (pickAt -= GRADE_WEIGHT[g]) < 0) ?? grades[grades.length - 1];
  const pool = missing.filter((id) => WEAPONS[id].grade === grade);
  return pool[Math.floor(rng() * pool.length)];
}

/** 灵力 2 / 3 / 4 / 5 各自的权重（合计 12）：见 drawInitialStats */
const POWER_WEIGHTS = [2, 3, 4, 3];

/**
 * 第一次建档的初始属性：气血 50、灵力 / 身法 / 遁速各 2–5（合计 11）。
 * 按权重抽灵力、再在「保证遁速也落在 2–5」的区间里抽身法，一次抽成——不用拒绝重抽
 * （注入常量随机数的测试会在重抽里死循环）；权重正好让每个 (灵力, 身法) 组合等概率，
 * 和当初拒绝重抽的分布逐点一致（battle-testkit 的平衡测试依赖这套抽样）。
 */
export function drawInitialStats(rng: () => number): CultivationStats {
  let pickAt = rng() * POWER_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const index = POWER_WEIGHTS.findIndex((weight) => (pickAt -= weight) < 0);
  const power = 2 + (index === -1 ? POWER_WEIGHTS.length - 1 : index);
  const agilityMin = Math.max(2, 11 - power - 5);
  const agilityMax = Math.min(5, 11 - power - 2);
  const agility = agilityMin + Math.floor(rng() * (agilityMax - agilityMin + 1));
  return { hp: 50, power, agility, speed: 11 - power - agility };
}

export class Cultivation {
  private stage = 0;
  private progress = 0;
  private stats: CultivationStats;
  private weapons: WeaponId[];
  private skills: SkillId[];
  private pills = 0;
  /** 渡劫成功后待选的二选一（§X4）：10 分钟有效，过期在 tick 里随机定一个 */
  private offer: CultivationOffer | null = null;
  private today: z.infer<typeof todaySchema> = emptyToday('');
  private record = { wins: 0, losses: 0 };
  /** 心浮气躁（久坐提醒到主人离开电脑为止）；不落盘，重启就不躁了 */
  private restless = false;
  private lastSitAt = 0;
  /** 上一拍的时刻（算在电脑前的毫秒数用） */
  private lastTickAt: number | null = null;
  /** 攒到一半的分钟（心浮气躁减半也从这出） */
  private minuteDebtMs = 0;
  /** 换日后的第一次写入要先备份旧文件 */
  private pendingBackup = false;
  /** 持久状态变没变：没变就不写盘（tick 每 5 秒一拍，不能一拍一写） */
  private dirty = false;
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private readonly rng: () => number;
  /** 单拍计入上限：默认是上面的常量；测试可以放大，加速长成长路径 */
  private readonly maxTickElapsedMs: number;

  /** @param warn 文件读不了 / 写不了时的告警出口 */
  constructor(
    path: string,
    warn: (message: string) => void,
    rng: () => number = Math.random,
    maxTickElapsedMs = TICK_MAX_ELAPSED_MS,
  ) {
    this.path = path;
    this.warn = warn;
    this.rng = rng;
    this.maxTickElapsedMs = maxTickElapsedMs;
    const saved = this.load();
    if (saved) {
      this.stage = saved.stage;
      this.progress = saved.progress;
      this.stats = saved.stats;
      this.weapons = saved.weapons;
      this.skills = saved.skills;
      this.pills = saved.pills;
      this.offer = saved.offer;
      this.today = saved.today;
      this.record = saved.record;
    } else {
      // 第一次建档：drawInitialStats 的初始属性、随机一件凡器、没有招式
      this.stats = drawInitialStats(this.rng);
      const mortal = WEAPON_IDS.filter((id) => WEAPONS[id].grade === '凡器');
      this.weapons = [mortal[Math.floor(this.rng() * mortal.length)]];
      this.skills = [];
      this.dirty = true;
      this.save();
    }
  }

  private load(): CultivationSave | null {
    if (!existsSync(this.path)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      const migrated = migrateCatalog(raw);
      const saved = saveSchema.parse(migrated.save);
      // 迁移过（图鉴删改）：标脏，下一拍写回
      if (migrated.changed) this.dirty = true;
      return saved;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const bad = `${this.path}.bad-${Date.now()}`;
      try {
        renameSync(this.path, bad);
        this.warn(`修炼存档读不了（${reason}），已改名 ${bad}，按第一次建档重建`);
      } catch (renameError) {
        const renameReason = renameError instanceof Error ? renameError.message : String(renameError);
        this.warn(`修炼存档读不了（${reason}），改名 ${bad} 也没成（${renameReason}）：文件留着没动，按第一次建档重建`);
      }
      return null;
    }
  }

  /** 跨凌晨 4 点换日：各项计数清零，标记下次写入前先备份 */
  private rollDay(now: number): void {
    const date = diaryDate(now);
    if (this.today.date === date) return;
    this.pendingBackup = this.today.date !== '';
    this.today = emptyToday(date);
    this.dirty = true;
  }

  /**
   * 修为进账：满一个小境界就升下一个、余下带过去；圆满（大境界最后一段修满）就停住，多出来的不要。
   * @returns events = 升级 / 圆满；added = **实际进了账**的数（圆满之后是 0）——
   *   trialDone / sparDone 拿它发一条 `xp` 事件，X3 打完才敢照实冒泡「修为 +30」
   */
  private addXp(amount: number): { events: CultivationEvent[]; added: number } {
    const events: CultivationEvent[] = [];
    if (isFullStage(this.stage) && this.progress >= stageReq(this.stage)) return { events, added: 0 }; // 已经圆满：不再涨
    const beforeStage = this.stage;
    const beforeProgress = this.progress;
    let left = amount;
    while (left > 0) {
      const req = stageReq(this.stage);
      const take = Math.min(req - this.progress, left);
      this.progress += take;
      left -= take;
      if (this.progress < req) break;
      if (isFullStage(this.stage)) {
        events.push({ kind: 'full' });
        break;
      }
      this.progress = 0;
      this.stage += 1;
      // 同一大境界内升级：随机一项 +1～2、气血 +6
      const gain = 1 + Math.floor(this.rng() * 2);
      const which = Math.floor(this.rng() * 3);
      if (which === 0) this.stats.power += gain;
      else if (which === 1) this.stats.agility += gain;
      else this.stats.speed += gain;
      this.stats.hp += 6;
      events.push({ kind: 'stage-up', stage: this.stage });
    }
    if (this.stage !== beforeStage || this.progress !== beforeProgress) this.dirty = true;
    return { events, added: amount - left };
  }

  /** 在电脑前每满 1 分钟 +1（心浮气躁时攒 2 分钟才 +1）；本地 0–4 点不涨；每天封顶 240 */
  tick(now: number, present: boolean): CultivationEvent[] {
    this.rollDay(now);
    // 二选一挂到点：没人挑就随机定一个（§X4）
    const events: CultivationEvent[] = this.expireOffer(now);
    const raw = this.lastTickAt === null ? 0 : Math.max(0, now - this.lastTickAt);
    // 睡眠 / 合盖后的那一拍间隔很长：最多只计入 maxTickElapsedMs（见常量注释）
    const elapsed = Math.min(raw, this.maxTickElapsedMs);
    this.lastTickAt = now;
    if (present && elapsed > 0) {
      this.today.presenceMs += elapsed;
      // 本地 0–4 点不涨：这段不算进分钟债
      if (new Date(now).getHours() >= 4) this.minuteDebtMs += elapsed;
      const perPoint = this.restless ? 2 * MINUTE_MS : MINUTE_MS;
      while (this.today.presence < PRESENCE_DAILY_MAX && this.minuteDebtMs >= perPoint) {
        this.minuteDebtMs -= perPoint;
        this.today.presence += 1;
        this.dirty = true;
        // 在场涨的这点修为不另发 xp 事件：tick 一分钟一条会把冒泡刷满，
        // 需要照实报进账的地方（心魔、切磋）自己有收益
        events.push(...this.addXp(1).events);
      }
      if (this.today.presence >= PRESENCE_DAILY_MAX) this.minuteDebtMs = 0;
    }
    this.save();
    return events;
  }

  /** 久坐提醒响了：进入「心浮气躁」，到主人离开电脑为止 */
  onSitReminder(now: number): CultivationEvent[] {
    this.rollDay(now);
    this.restless = true;
    this.lastSitAt = now;
    this.save();
    return [];
  }

  /** 主人离开电脑：解除心浮气躁；离上次久坐提醒不到 10 分钟，「调息」+20，每天最多 3 次 */
  onLeave(now: number): CultivationEvent[] {
    this.rollDay(now);
    const events: CultivationEvent[] = [];
    if (this.restless) {
      this.restless = false;
      if (now - this.lastSitAt < REST_WINDOW_MS && this.today.rests < REST_DAILY_MAX) {
        this.today.rests += 1;
        this.dirty = true;
        // rest 事件本来就带 gain（加了多少修为），不再另发一条 xp
        events.push({ kind: 'rest', gain: REST_GAIN });
        events.push(...this.addXp(REST_GAIN).events);
      }
    }
    this.save();
    return events;
  }

  /** Claude 一轮活干完：20% 炼成一颗破境丹，每天最多 3 颗（库存另有限制） */
  onClaudeDone(now: number): CultivationEvent[] {
    this.rollDay(now);
    const events: CultivationEvent[] = [];
    if (this.today.pills < PILLS_DAILY_MAX && this.pills < PILLS_MAX && this.rng() < PILL_CHANCE) {
      this.pills += 1;
      this.today.pills += 1;
      this.dirty = true;
      events.push({ kind: 'pill' });
    }
    this.save();
    return events;
  }

  /** 心魔试炼结束：战绩都记；收益只有当天第 1 场有，赢了 30% 掉一件还没有的法宝 */
  trialDone(now: number, won: boolean): CultivationEvent[] {
    this.rollDay(now);
    this.record[won ? 'wins' : 'losses'] += 1;
    this.dirty = true;
    let events: CultivationEvent[] = [];
    if (this.today.trial < 1) {
      this.today.trial = 1;
      const gained = this.addXp(won ? TRIAL_WIN_XP : TRIAL_LOSE_XP);
      events = gained.events;
      if (gained.added > 0) events.unshift({ kind: 'xp', amount: gained.added });
      if (won && this.rng() < DROP_CHANCE) {
        const weapon = drawDropWeapon(this.weapons, this.rng);
        if (weapon) {
          this.weapons.push(weapon);
          events.push({ kind: 'drop', weapon });
        }
      }
    }
    this.save();
    return events;
  }

  /** 切磋结束：战绩都记；同一个邻居每天只算 1 场，每天前 3 场有收益 */
  sparDone(now: number, id: string, won: boolean): CultivationEvent[] {
    this.rollDay(now);
    this.record[won ? 'wins' : 'losses'] += 1;
    this.dirty = true;
    let events: CultivationEvent[] = [];
    if (!this.today.spars.includes(id) && this.today.spars.length < SPAR_DAILY_MAX) {
      this.today.spars.push(id);
      const gained = this.addXp(won ? SPAR_WIN_XP : SPAR_LOSE_XP);
      events = gained.events;
      if (gained.added > 0) events.unshift({ kind: 'xp', amount: gained.added });
    }
    this.save();
    return events;
  }

  /**
   * 渡劫的开场条件（§X4）：圆满时给「要扛几道雷、有没有丹可吃」；不能渡（没圆满、已经修到头）返回 null。
   * `stage` 是喂给引擎 `tribulate` 的境界（渡的是当前这一境圆满，天雷按它涨）。
   */
  tribulationPlan(now: number): TribulationPlan | null {
    this.rollDay(now);
    if (this.stage >= MAX_STAGE) return null;
    if (!isFullStage(this.stage) || this.progress < stageReq(this.stage)) return null;
    return {
      stage: this.stage,
      strikes: tribulationStrikes(this.stage + 1),
      canPill: this.pills > 0,
      /** 渡过去要进的那一境（菜单和日记用得上） */
      nextLabel: stageLabel(this.stage + 1),
    };
  }

  /**
   * 渡劫收场（§X4）：扛过全部天雷 = 成功，进下一个大境界（属性照 X1 的大境界加成），
   * 再从还没有的招式里随机挑两个挂成二选一；失败只扣修为（不掉境界），攒回来才能再渡。
   * 只有开打前 `tribulationPlan` 放行过（还圆满着）的这一场才结算；不圆满时调用是空操作（连丹都不扣），
   * 免得重复结算把境界推上去。接线在 run() 前后各查一次 plan 就够，这里不另设「渡劫进行中」的状态。
   * @param usedPill 这一场吃了破境丹（气血上限 ×1.2 由调用方在开打前加到 Fighter 上）：丹数 −1
   */
  tribulationDone(now: number, survived: boolean, usedPill: boolean): CultivationEvent[] {
    this.rollDay(now);
    const events: CultivationEvent[] = [];
    const able = this.stage < MAX_STAGE && isFullStage(this.stage) && this.progress >= stageReq(this.stage);
    if (!able) {
      this.save();
      return events;
    }
    // 丹是开打前生效的（气血上限 ×1.2 已经喂给引擎），扛没扛住都算吃了
    if (usedPill && this.pills > 0) {
      this.pills -= 1;
      this.dirty = true;
    }
    if (!survived) {
      // 扣当前小境界 20% 的修为，最多 300；扣完就不再是圆满（攒回来才能再渡，不设冷却计时）
      const lost = Math.min(
        Math.floor(stageReq(this.stage) * TRIBULATION_LOSS_SHARE),
        this.progress,
        TRIBULATION_LOSS_MAX,
      );
      if (lost > 0) {
        this.progress -= lost;
        this.dirty = true;
      }
      events.push({ kind: 'tribulation-fail', lost });
      this.save();
      return events;
    }
    this.stage += 1;
    this.progress = 0;
    this.stats.power += 1;
    this.stats.agility += 1;
    this.stats.speed += 1;
    this.stats.hp += 20;
    this.dirty = true;
    events.push({ kind: 'breakthrough' });
    // 二选一：在还没有的招式里随机挑两个（10 分钟有效）
    const missing = SKILL_IDS.filter((id) => !this.skills.includes(id));
    if (missing.length >= 2) {
      const first = Math.floor(this.rng() * missing.length);
      const second = (first + 1 + Math.floor(this.rng() * (missing.length - 1))) % missing.length;
      this.offer = { a: missing[first], b: missing[second], until: now + OFFER_MS };
      this.dirty = true;
      events.push({ kind: 'offer', a: this.offer.a, b: this.offer.b });
    } else if (missing.length === 1) {
      // 只剩一个还没学的（正常成长走不到这一步，图鉴扩充以后才会）：直接给它，不挂二选一
      const skill = missing[0];
      this.skills.push(skill);
      this.dirty = true;
      events.push({ kind: 'choose', skill });
    }
    this.save();
    return events;
  }

  /**
   * 二选一里挑一个领悟（菜单「修炼/领悟：X」）。不在待选里（没挂出来、过期被随机定了、编号不对）
   * 就什么都不做，返回空事件。
   */
  choose(now: number, skill: SkillId): CultivationEvent[] {
    this.rollDay(now);
    const events = this.expireOffer(now);
    const offer = this.offer;
    if (!offer || (skill !== offer.a && skill !== offer.b)) return events;
    this.offer = null;
    if (!this.skills.includes(skill)) this.skills.push(skill);
    this.dirty = true;
    this.save();
    return [...events, { kind: 'choose', skill }];
  }

  /** 二选一到期：没人挑就随机定一个（§X4，tick 每拍查一次） */
  private expireOffer(now: number): CultivationEvent[] {
    const offer = this.offer;
    if (!offer || now < offer.until) return [];
    this.offer = null;
    const skill = this.rng() < 0.5 ? offer.a : offer.b;
    if (!this.skills.includes(skill)) this.skills.push(skill);
    this.dirty = true;
    this.save();
    return [{ kind: 'choose', skill }];
  }

  /** 给引擎的 Fighter（心魔、切磋、渡劫都用它） */
  fighter(name: string): Fighter {
    return {
      name,
      hp: this.stats.hp,
      power: this.stats.power,
      agility: this.stats.agility,
      speed: this.stats.speed,
      weapons: [...this.weapons],
      skills: [...this.skills],
    };
  }

  /**
   * 渡劫用的 Fighter（§X4）：吃了破境丹就把气血上限 ×1.2，其余照旧。
   * ×1.2 的口径放在这里，接线只管「吃没吃」，不重复一份数学（向下取整，和心魔的 ×0.9 同口径）。
   */
  tribulationFighter(name: string, usedPill: boolean): Fighter {
    const f = this.fighter(name);
    if (usedPill) f.hp = Math.floor(f.hp * PILL_HP_FACTOR);
    return f;
  }

  view(): CultivationView {
    const full = isFullStage(this.stage) && this.progress >= stageReq(this.stage);
    return {
      stage: this.stage,
      label: stageLabel(this.stage, full),
      percent: Math.floor((this.progress / stageReq(this.stage)) * 100),
      full,
      stats: { ...this.stats },
      weapons: this.weapons.map((id) => WEAPONS[id].name),
      skills: this.skills.map((id) => SKILLS[id].name),
      pills: this.pills,
      offer: this.offer ? { a: this.offer.a, b: this.offer.b } : null,
      record: { ...this.record },
    };
  }

  private save(): void {
    // 只有持久状态真的变了才写盘（presenceMs 这类每拍都变的统计跟着下一次真正的写入落盘）
    if (!this.dirty) return;
    if (this.pendingBackup && existsSync(this.path)) {
      try {
        copyFileSync(this.path, `${this.path}.bak`);
      } catch (error) {
        this.warn(`修炼存档备份不了：${this.path}.bak（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    this.pendingBackup = false;
    this.dirty = false;
    const data: CultivationSave = {
      version: 1,
      stage: this.stage,
      progress: this.progress,
      stats: this.stats,
      weapons: this.weapons,
      skills: this.skills,
      pills: this.pills,
      offer: this.offer,
      today: this.today,
      record: this.record,
    };
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.path);
    } catch (error) {
      this.warn(`修炼存档存不下：${this.path}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
}
