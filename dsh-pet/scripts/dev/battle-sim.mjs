/**
 * dev/battle-sim.mjs —— 对战引擎的平衡模拟（开发自测工具，不入 npm 包）：随机生成成千上万对角色对打，
 * 打印胜率表（同境界、境界差、每件法宝和每个招式的持有优势、心魔、渡劫），给 §X0 的平衡断言定调。
 *
 * 用法（strip-types 与 test-register 的说明见 scripts/test-ts-resolver.mjs）：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/battle-sim.mjs [--pairs 2000]
 *
 * 角色用 src/app/battle-testkit.ts 的 fighterAt 生成（和平衡断言共用同一份成长近似）。
 * 境界映射：炼气 0–8；筑基 9–11、金丹 12–14、元婴 15–17、化神 18–20、炼虚 21–23、合体 24–26、大乘 27–29。
 * 渡劫雷数（§X4）：进筑基、金丹 3 道，进元婴、化神 6 道，之后 9 道。
 */
import { fight, shadowOf, tribulate, WEAPONS, SKILLS } from '../../src/app/battle.ts';
import { fighterAt } from '../../src/app/battle-testkit.ts';

const pairs = Number(process.argv.includes('--pairs') ? process.argv[process.argv.indexOf('--pairs') + 1] : 2000);
const rng = Math.random;
const seedOf = (i) => `sim-${i}`;

function fighters(stage) {
  const a = fighterAt(stage, rng);
  const b = fighterAt(stage, rng);
  a.name = '甲';
  b.name = '乙';
  return [a, b];
}

function winRate(make) {
  let wins = 0;
  for (let i = 0; i < pairs; i++) if (fight(...make(i), seedOf(i)).at(-1).winner === 0) wins++;
  return wins / pairs;
}

function withWeapon(f, id) {
  f.weapons = [id, ...f.weapons.filter((w) => w !== id)];
  return f;
}
function withoutWeapon(f, id) {
  f.weapons = f.weapons.filter((w) => w !== id);
  return f;
}
/** 持有方把一个随机招换成 X（而不是白多一个招），量出来的才是 X 本身的分量 */
function withSkill(f, id) {
  if (f.skills.includes(id)) return f;
  if (f.skills.length === 0) return ((f.skills = [id]), f);
  f.skills[Math.floor(Math.random() * f.skills.length)] = id;
  return f;
}

const HOLDOUT_STAGE = 10; // 筑基中期：有一件多的法宝和一个换招的位置，量持有优势最稳

console.log(`对打 ${pairs} 场一场一种子（--pairs 可调）\n`);

for (const stage of [4, 10, 16, 25]) {
  let timeouts = 0;
  for (let i = 0; i < pairs; i++) if (fight(...fighters(stage), seedOf(i)).at(-1).reason === 'timeout') timeouts++;
  console.log(
    `同境界 stage=${stage}：甲胜率 ${winRate(() => fighters(stage)).toFixed(3)}（封顶判定 ${(timeouts / pairs).toFixed(2)}）`,
  );
}
console.log('');

for (const [hi, lo, label] of [
  [10, 9, '1 个小境界（10 对 9）'],
  [13, 10, '1 个大境界（13 对 10）'],
  [16, 13, '1 个大境界（16 对 13）'],
  [4, 1, '炼气 3 层（4 对 1）'],
]) {
  let wins = 0;
  for (let i = 0; i < pairs; i++) {
    const hi0 = fighterAt(hi, rng);
    const lo0 = fighterAt(lo, rng);
    hi0.name = '甲';
    lo0.name = '乙';
    if (fight(hi0, lo0, seedOf(i)).at(-1).winner === 0) wins++;
  }
  console.log(`高 ${label}：高的胜率 ${(wins / pairs).toFixed(3)}`);
}
console.log('');

for (const id of Object.keys(WEAPONS)) {
  const rate = winRate(() => {
    const [a, b] = fighters(HOLDOUT_STAGE);
    return [withWeapon(a, id), withoutWeapon(b, id)];
  });
  console.log(`法宝 ${WEAPONS[id].name}：持有方胜率 ${rate.toFixed(3)}`);
}
console.log('');

for (const id of Object.keys(SKILLS)) {
  const rate = winRate(() => {
    const [a, b] = fighters(HOLDOUT_STAGE);
    return [withSkill(a, id), b];
  });
  console.log(`招式 ${SKILLS[id].name}：持有方胜率 ${rate.toFixed(3)}`);
}
console.log('');

for (const stage of [4, 10, 16, 25]) {
  let shadowWins = 0;
  for (let i = 0; i < pairs; i++) {
    const me = fighters(stage)[0];
    if (fight(me, shadowOf(me), seedOf(i)).at(-1).winner === 0) shadowWins++;
  }
  console.log(`心魔 stage=${stage}：本体胜率 ${(shadowWins / pairs).toFixed(3)}`);
}
console.log('');

const strikesOf = (stage) => (stage <= 12 ? 3 : stage <= 18 ? 6 : 9);
for (const stage of [9, 12, 15, 18, 21, 24, 27]) {
  const strikes = strikesOf(stage);
  for (const pill of [false, true]) {
    let ok = 0;
    for (let i = 0; i < pairs; i++) {
      const f = fighterAt(stage, rng);
      if (pill) f.hp = Math.floor(f.hp * 1.2);
      if (tribulate(f, strikes, stage, seedOf(i)).at(-1).winner === 0) ok++;
    }
    console.log(`渡劫 stage=${stage} ${strikes} 道雷${pill ? '（吃丹）' : ''}：成功率 ${(ok / pairs).toFixed(3)}`);
  }
}
