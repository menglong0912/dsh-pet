/**
 * 测试和平衡脚本用的成长近似（X0）：按任务书 §X1 的境界表把角色长到某个小境界，X1 会换成正式成长规则。
 *
 * 境界映射：炼气九层（stage 0–8）之内升级 = 随机一项 +1～2、气血 +6；进 stage 9、12、15、18、21、24、27
 * 是大境界突破 = 三项各 +1、气血 +20、随机得一个还没有的招式，另外多一件法宝（凡器 70%、灵器 25%、
 * 神器 5%，不重复，图鉴集齐为止）。初始三项各随机 2–5（合计 11）、气血 50、随机一件凡器、没有招式。
 */
import { WEAPONS, WEAPON_IDS, SKILL_IDS, majorBreaks, type Fighter, type WeaponId, type SkillId } from './battle';
import { drawInitialStats } from './cultivation';

/**
 * X16 之前的 17 门招式：Y0 历练的平衡夹具仍按这批配招（图鉴扩到 19 后，
 * `fighterAt` 的随机组合会整体换一批，Y0 的目标区间就不再是同一批角色）。
 * 只给「旧内容回归」用；修炼成长和 X16 的平衡照样读 `SKILL_IDS`。
 */
export const Y0_SKILL_IDS: readonly SkillId[] = [
  'play-dead',
  'dove',
  'bubble',
  'sixth-sense',
  'shadow-fists',
  'critical',
  'spirit-beast',
  'bloom',
  'lion-roar',
  'blue-whale',
  'whale-song',
  'ink',
  'whale-gulp',
  'jelly-clone',
  'myriad-self',
  'dream-chant',
  'finger-sword',
];

export function fighterAt(stage: number, rng: () => number, skillPool: readonly SkillId[] = SKILL_IDS): Fighter {
  // 初始属性用正式建档的同一套抽法（一次抽成，不拒绝重抽）
  const initial = drawInitialStats(rng);
  let power = initial.power;
  let agility = initial.agility;
  let speed = initial.speed;
  let hp = initial.hp;
  const drawWeapon = (grade: '凡器' | '灵器' | '神器'): WeaponId | undefined => {
    const pool = WEAPON_IDS.filter((id) => WEAPONS[id].grade === grade && !weapons.includes(id));
    return pool.length > 0 ? pool[Math.floor(rng() * pool.length)] : undefined;
  };
  const weapons: WeaponId[] = [];
  const firstMortal = drawWeapon('凡器');
  if (firstMortal) weapons.push(firstMortal);
  const skills: SkillId[] = [];
  const bump = () => {
    const which = Math.floor(rng() * 3);
    const gain = 1 + Math.floor(rng() * 2);
    if (which === 0) power += gain;
    else if (which === 1) agility += gain;
    else speed += gain;
  };
  for (let k = 1; k <= stage; k++) {
    if (majorBreaks(k) > majorBreaks(k - 1)) {
      power += 1;
      agility += 1;
      speed += 1;
      hp += 20;
      const roll = rng();
      const grade = roll < 0.7 ? '凡器' : roll < 0.95 ? '灵器' : '神器';
      const drop = drawWeapon(grade) ?? drawWeapon('凡器') ?? drawWeapon('灵器') ?? drawWeapon('神器');
      if (drop) weapons.push(drop);
      const missing = skillPool.filter((id) => !skills.includes(id));
      if (missing.length > 0) skills.push(missing[Math.floor(rng() * missing.length)]);
    } else {
      bump();
      hp += 6;
    }
  }
  return { name: '', hp, power, agility, speed, weapons, skills };
}

/** 小型确定性 PRNG（mulberry32）：生成角色用的随机数也要可复现 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
