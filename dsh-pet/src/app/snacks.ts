/**
 * 零食袋：零食只有一个用处——家里来客时请它吃（features.ts 接线，串门总开关开着才攒）。
 *
 * 来源：主人在电脑前时，到了正常用餐时间（早饭 / 午饭 / 晚饭）宠物也分到一份；晚上偶尔有宵夜
 * （每晚只掷一次，SUPPER_CHANCE 的机会）。每顿至多一份；袋子满了（POUCH_MAX）这顿就不拿。
 * 存在一个小 JSON 文件里（$DSH_HOME/dsh-pet/snacks.json），重启应用不丢；文件读不了就当空袋子重新攒。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/** label 是菜单上和台词里的说法，anim 是内置皮肤里吃它的动画（客人窗口播） */
export interface Snack {
  label: string;
  anim: string;
}

const MEAL_SNACKS: readonly Snack[] = [
  { label: '糖葫芦', anim: '吃糖葫芦' },
  { label: '冰淇淋', anim: '吃冰淇淋融化' },
  { label: '年糕', anim: '吃年糕' },
  { label: '月饼', anim: '中秋赏月吃月饼' },
];
const SUPPER_SNACKS: readonly Snack[] = [
  { label: '饺子', anim: '吃饺子' },
  { label: '汤圆', anim: '吃汤圆' },
  { label: '长寿面', anim: '吃长寿面' },
];
export const SNACKS: readonly Snack[] = [...MEAL_SNACKS, ...SUPPER_SNACKS];

export function findSnack(label: string): Snack | undefined {
  return SNACKS.find((snack) => snack.label === label);
}

/** 一顿：本地时间 [from, to) 分钟内；chance = 这顿有零食的机会 */
interface Meal {
  name: string;
  from: number;
  to: number;
  chance: number;
  snacks: readonly Snack[];
}

/** 宵夜不是每晚都有 */
const SUPPER_CHANCE = 0.4;
const MEALS: readonly Meal[] = [
  { name: '早饭', from: 7 * 60 + 30, to: 9 * 60 + 30, chance: 1, snacks: MEAL_SNACKS },
  { name: '午饭', from: 11 * 60 + 30, to: 13 * 60 + 30, chance: 1, snacks: MEAL_SNACKS },
  { name: '晚饭', from: 17 * 60 + 30, to: 19 * 60 + 30, chance: 1, snacks: MEAL_SNACKS },
  { name: '宵夜', from: 21 * 60 + 30, to: 24 * 60, chance: SUPPER_CHANCE, snacks: SUPPER_SNACKS },
];
/** 袋子最多装几份 */
export const POUCH_MAX = 5;

const fileSchema = z.object({
  items: z.array(z.string()),
  /** 已经分过（或掷过没中、袋子满了跳过）的那几顿：「2026-10-24 午饭」 */
  served: z.array(z.string()),
});

export class SnackPouch {
  private items: string[] = [];
  private served: string[] = [];
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private readonly random: () => number;

  /**
   * @param path 零食袋文件
   * @param warn 文件读不了 / 写不了时的告警出口
   * @param random [0, 1) 随机源（测试注入）
   */
  constructor(path: string, warn: (message: string) => void, random: () => number = Math.random) {
    this.path = path;
    this.warn = warn;
    this.random = random;
    if (!existsSync(path)) return;
    try {
      const saved = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      this.items = saved.items.filter((label) => findSnack(label)).slice(0, POUCH_MAX);
      this.served = saved.served;
    } catch (error) {
      warn(`零食袋读不了，重新攒：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  /**
   * 每拍：主人在电脑前、正赶上一顿、这顿还没分过 → 分一份进袋子（宵夜偶尔才有）
   * @returns 这一拍分到的那份（哪一顿、什么零食）；没分到 null
   */
  tick(now: number, present: boolean): { meal: string; snack: Snack } | null {
    const date = new Date(now);
    const minute = date.getHours() * 60 + date.getMinutes();
    const meal = MEALS.find((item) => minute >= item.from && minute < item.to);
    if (!meal || !present) return null;
    const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    const key = `${day} ${meal.name}`;
    if (this.served.includes(key)) return null;
    // 只留今天的记录：之前的日子不会再用到
    this.served = [...this.served.filter((item) => item.startsWith(`${day} `)), key];
    let got: Snack | null = null;
    if (this.items.length < POUCH_MAX && this.random() < meal.chance) {
      got = meal.snacks[Math.floor(this.random() * meal.snacks.length)];
      this.items.push(got.label);
    }
    this.save();
    return got ? { meal: meal.name, snack: got } : null;
  }

  /** 袋子里有哪几样（同样的只列一次，按放进去的先后） */
  kinds(): Snack[] {
    return [...new Set(this.items)].flatMap((label) => findSnack(label) ?? []);
  }

  /** 拿出一份请客；袋子里没有这样 → false */
  take(label: string): boolean {
    const index = this.items.indexOf(label);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.save();
    return true;
  }

  private save(): void {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ items: this.items, served: this.served }, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.path);
    } catch (error) {
      this.warn(`零食袋存不下：${this.path}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
}
