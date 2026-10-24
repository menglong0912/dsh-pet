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

const saveSchema = z.object({
  version: z.literal(1),
  stage: z.number().int().min(0).max(MAX_STAGE),
  progress: z.number().int().min(0),
  stats: statsSchema,
  weapons: z.array(z.enum(WEAPON_IDS)).max(WEAPON_IDS.length),
  skills: z.array(z.enum(SKILL_IDS)).max(SKILL_IDS.length),
  pills: z.number().int().min(0).max(9),
  /** X4 的二选一放这，X1 里恒为 null */
  offer: z.null(),
  today: todaySchema,
  record: z.object({ wins: z.number().int().min(0), losses: z.number().int().min(0) }),
});

export type CultivationSave = z.infer<typeof saveSchema>;

/** 修炼过程中发生的事（X2 拿去冒泡和记日记） */
export type CultivationEvent =
  | { kind: 'stage-up'; stage: number }
  | { kind: 'full' }
  | { kind: 'breakthrough'; skill?: SkillId }
  | { kind: 'rest'; gain: number }
  | { kind: 'pill' }
  | { kind: 'drop'; weapon: WeaponId };

/** 设置页和右键菜单用的只读视图 */
export interface CultivationView {
  stage: number;
  /** 「炼气三层」「筑基中期」；大乘后期修满是「大乘圆满」 */
  label: string;
  /** 当前小境界进度百分比，取整 */
  percent: number;
  /** 圆满（大境界最后一个小境界修满，可以突破） */
  full: boolean;
  stats: CultivationStats;
  weapons: string[];
  skills: string[];
  pills: number;
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
 * 单拍最多计入多长的「在电脑前」：接线每 5 秒（TICK_MS）喂一拍，正常间隔远小于这个数；
 * 睡眠 / 合盖后醒来的那一拍间隔会很长，不封顶就会把整段睡眠当成在场，一下攒满当天的 240
 */
export const TICK_MAX_ELAPSED_MS = 30_000;
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

/** 是不是本大境界的最后一个小境界（修满 = 圆满，等突破） */
export function isFullStage(stage: number): boolean {
  return stage < MAX_STAGE ? majorBreaks(stage + 1) > majorBreaks(stage) : true;
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

export class Cultivation {
  private stage = 0;
  private progress = 0;
  private stats: CultivationStats;
  private weapons: WeaponId[];
  private skills: SkillId[];
  private pills = 0;
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
      this.today = saved.today;
      this.record = saved.record;
    } else {
      // 第一次建档：三项各随机 2–5（合计 11）、气血 50、随机一件凡器、没有招式
      let power: number;
      let agility: number;
      let speed: number;
      do {
        power = 2 + Math.floor(this.rng() * 4);
        agility = 2 + Math.floor(this.rng() * 4);
        speed = 11 - power - agility;
      } while (speed < 2 || speed > 5);
      this.stats = { hp: 50, power, agility, speed };
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
      return saveSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
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

  /** 修为进账：满一个小境界就升下一个、余下带过去；圆满（大境界最后一段修满）就停住，多出来的不要 */
  private addXp(amount: number): CultivationEvent[] {
    const events: CultivationEvent[] = [];
    if (isFullStage(this.stage) && this.progress >= stageReq(this.stage)) return events; // 已经圆满：不再涨
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
    return events;
  }

  /** 在电脑前每满 1 分钟 +1（心浮气躁时攒 2 分钟才 +1）；本地 0–4 点不涨；每天封顶 240 */
  tick(now: number, present: boolean): CultivationEvent[] {
    this.rollDay(now);
    const events: CultivationEvent[] = [];
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
        events.push(...this.addXp(1));
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
        events.push({ kind: 'rest', gain: REST_GAIN });
        events.push(...this.addXp(REST_GAIN));
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
      events = this.addXp(won ? TRIAL_WIN_XP : TRIAL_LOSE_XP);
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
      events = this.addXp(won ? SPAR_WIN_XP : SPAR_LOSE_XP);
    }
    this.save();
    return events;
  }

  /** 圆满时进下一个大境界：三项各 +1、气血 +20、随机得一个还没有的招式（X4 会换成渡劫加二选一） */
  breakthrough(now: number): CultivationEvent[] {
    this.rollDay(now);
    if (this.stage >= MAX_STAGE || !isFullStage(this.stage) || this.progress < stageReq(this.stage)) return [];
    this.stage += 1;
    this.progress = 0;
    this.stats.power += 1;
    this.stats.agility += 1;
    this.stats.speed += 1;
    this.stats.hp += 20;
    const missing = SKILL_IDS.filter((id) => !this.skills.includes(id));
    const skill = missing.length > 0 ? missing[Math.floor(this.rng() * missing.length)] : undefined;
    if (skill) this.skills.push(skill);
    this.dirty = true;
    this.save();
    return [{ kind: 'breakthrough', ...(skill ? { skill } : {}) }];
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
      offer: null,
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
