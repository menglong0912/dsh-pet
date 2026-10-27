/**
 * 掉法宝的抽取规则（历练 Y1 从 cultivation.ts 挪出来）：心魔和秘境掉落共用。
 *
 * 单独一个模块是为了断开 `dungeon.ts ⇄ cultivation.ts` 的循环：
 * Y1 起 cultivation 要读秘境的存档、结算和随机数，而 dungeon 又用这里的掉落规则。
 * 纯函数：随机数由参数传入。
 */
import { WEAPONS, WEAPON_IDS, type WeaponId } from './battle';

/** 掉法宝的品级权重（同 battle-testkit 的成长近似）：凡器 70%、灵器 25%、神器 5% */
const GRADE_WEIGHT: Record<'凡器' | '灵器' | '神器', number> = { 凡器: 0.7, 灵器: 0.25, 神器: 0.05 };

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
