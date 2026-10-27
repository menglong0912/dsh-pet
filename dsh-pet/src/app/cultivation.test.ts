import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seededRng } from './battle-testkit.ts';
import { majorBreaks, statCap, WEAPON_IDS, type SkillId, type WeaponId } from './battle.ts';
import { diaryDate } from './diary.ts';
import {
  Cultivation,
  migrateCatalog,
  drawDropWeapon,
  type CultivationEvent,
  isFullStage,
  MAX_STAGE,
  stageLabel,
  stageReq,
  TICK_MAX_ELAPSED_MS,
  tribulationStrikes,
} from './cultivation.ts';

const MIN = 60_000;

/** 本地某天的某个时刻（默认中午，避开 0–4 点和换日） */
function at(day: number, hour = 12): number {
  return new Date(2026, 9, 20 + day, hour).getTime();
}

/** 存档里的进度（小数值时百分比取整看不出变化，直接读文件） */
function progressOf(path: string): number {
  return (JSON.parse(readFileSync(path, 'utf8')) as { progress: number }).progress;
}

function withPath(fn: (path: string, warns: string[]) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-cultivation-'));
  const path = join(dir, 'cultivation.json');
  const warns: string[] = [];
  try {
    fn(path, warns);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 大多数用例不关心睡眠封顶：放大单拍上限，让 1 分钟一拍照常计满 1 分钟 */
function open(path: string, seed: number): Cultivation {
  return new Cultivation(path, () => undefined, seededRng(seed), 24 * 3_600_000);
}

test('stageLabel covers the whole table, and req matches it', () => {
  assert.equal(stageLabel(0), '炼气一层');
  assert.equal(stageLabel(2), '炼气三层');
  assert.equal(stageLabel(8), '炼气九层');
  assert.equal(stageLabel(9), '筑基初期');
  assert.equal(stageLabel(10), '筑基中期');
  assert.equal(stageLabel(29), '大乘后期');
  assert.equal(stageLabel(29, true), '大乘圆满');
  assert.equal(stageReq(0), 150);
  assert.equal(stageReq(9), 1_000);
  assert.equal(stageReq(12), 2_000);
  assert.equal(stageReq(29), 20_000);
  // 大境界的分界和引擎的 majorBreaks 一致
  for (let stage = 0; stage < MAX_STAGE; stage++) {
    assert.equal(isFullStage(stage), majorBreaks(stage + 1) > majorBreaks(stage));
  }
  assert.ok(isFullStage(MAX_STAGE));
});

test('first save follows the creation rules and survives a restart', () => {
  withPath((path) => {
    const c = open(path, 7);
    const view = c.view();
    assert.equal(view.stage, 0);
    assert.equal(view.stats.hp, 50);
    assert.equal(view.stats.power + view.stats.agility + view.stats.speed, 11);
    assert.ok(view.stats.power >= 2 && view.stats.power <= 5);
    assert.ok(view.stats.agility >= 2 && view.stats.agility <= 5);
    assert.ok(view.stats.speed >= 2 && view.stats.speed <= 5);
    assert.equal(view.weapons.length, 1);
    assert.equal(view.skills.length, 0);
    // 重启后还在
    const again = open(path, 7);
    assert.deepEqual(again.view(), view);
  });
});

// 回归：建档属性曾用「拒绝重抽」，注入常量随机数（比如 0.1）会在里面死循环
test('first save draws legal initial stats even from a constant rng', () => {
  withPath((path) => {
    for (const value of [0, 0.5, 0.999]) {
      const c = new Cultivation(
        `${path}-${String(value).replace('.', '_')}`,
        () => undefined,
        () => value,
      );
      const { hp, power, agility, speed } = c.view().stats;
      assert.equal(hp, 50);
      assert.equal(power + agility + speed, 11);
      assert.ok(power >= 2 && power <= 5, `power=${power}`);
      assert.ok(agility >= 2 && agility <= 5, `agility=${agility}`);
      assert.ok(speed >= 2 && speed <= 5, `speed=${speed}`);
    }
  });
});

test('tick accumulates one xp per present minute', () => {
  withPath((path) => {
    const c = open(path, 1);
    let now = at(0);
    c.tick(now, false); // 第一拍只记时刻
    for (let i = 0; i < 5; i++) c.tick((now += MIN), true);
    assert.equal(progressOf(path), 5);
    // 不在电脑前不涨
    for (let i = 0; i < 3; i++) c.tick((now += MIN), false);
    assert.equal(progressOf(path), 5);
    // 重启：第一拍只记时刻（断电前的时间不算），之后照常攒
    const fresh = open(path, 1);
    fresh.tick(now, false);
    fresh.tick(now + MIN, true);
    assert.equal(progressOf(path), 6);
  });
});

test('tick does not accrue between 0 and 4 am', () => {
  withPath((path) => {
    const c = open(path, 1);
    const three = at(0, 3); // 凌晨 3 点
    c.tick(three, false);
    for (let i = 0; i < 10; i++) c.tick(three + (i + 1) * MIN, true);
    assert.equal(progressOf(path), 0);
    // 4 点过后恢复（先记一拍不涨的，把 3 点那段隔开）
    const four = at(0, 4);
    c.tick(four, false);
    for (let i = 0; i < 2; i++) c.tick(four + (i + 1) * MIN, true);
    assert.equal(progressOf(path), 2);
  });
});

test('presence xp is capped at 240 per day', () => {
  withPath((path) => {
    const c = open(path, 1);
    let now = at(0);
    c.tick(now, false);
    for (let i = 0; i < 300; i++) c.tick((now += MIN), true);
    // 240 = 炼气一层的 150 + 二层的 90
    assert.equal(c.view().stage, 1);
    assert.equal(c.view().percent, 60);
  });
});

test('restless halves the rate and leaving clears it', () => {
  withPath((path) => {
    const c = open(path, 1);
    let now = at(0);
    c.tick(now, false);
    c.onSitReminder(now);
    for (let i = 0; i < 3; i++) c.tick((now += MIN), true);
    assert.equal(progressOf(path), 1); // 攒 2 分钟才 +1，3 分钟只 +1
    // 离开：解除心浮气躁，而且离提醒不到 10 分钟，调息 +20
    const events = c.onLeave((now += MIN));
    assert.deepEqual(events[0], { kind: 'rest', gain: 20 });
    assert.equal(progressOf(path), 21);
    // 解除后恢复 1 分钟 +1：心浮气躁攒下的 1 分钟零头加上离开前后没拍到的 2 分钟，一共 +4
    for (let i = 0; i < 2; i++) c.tick((now += MIN), true);
    assert.equal(progressOf(path), 25);
  });
});

test('rest needs the 10-minute window and max 3 per day', () => {
  withPath((path) => {
    const c = open(path, 1);
    let now = at(0);
    for (let i = 0; i < 4; i++) {
      c.onSitReminder(now);
      const events = c.onLeave(now + 9 * MIN);
      if (i < 3) assert.ok(events.some((event) => event.kind === 'rest'));
      else assert.ok(!events.some((event) => event.kind === 'rest')); // 每天最多 3 次
      now += 10 * MIN;
    }
    // 离提醒超过 10 分钟的离开只解除心浮气躁，不调息
    c.onSitReminder(now);
    assert.deepEqual(c.onLeave(now + 11 * MIN), []);
  });
});

test('claudeDone grants pills at 20%, capped 3 a day and 9 in stock', () => {
  withPath((path) => {
    const c = open(path, 42);
    let now = at(0);
    let pills = 0;
    for (let i = 0; i < 200 && pills < 3; i++) {
      if (c.onClaudeDone(now).some((event) => event.kind === 'pill')) pills += 1;
      now += MIN;
    }
    assert.equal(c.view().pills, 3); // 每天最多 3 颗
    // 接着攒两天，攒到库存 9
    for (let day = 1; day <= 2; day++) {
      now = at(day);
      for (let i = 0; i < 300; i++) {
        c.onClaudeDone(now);
        now += MIN;
      }
    }
    assert.equal(c.view().pills, 9);
  });
});

test('trialDone rewards every trial of the day (no daily cap), record counts all', () => {
  withPath((path) => {
    const c = open(path, 3);
    c.trialDone(at(0), true);
    assert.equal(progressOf(path), 30);
    assert.deepEqual(c.view().record, { wins: 1, losses: 0 });
    // 同一天隔一小时再打：间隔早过了 10 分钟，照样满额进账（赢 +30、输 +10），场次和战绩都记
    c.trialDone(at(0, 13), true);
    c.trialDone(at(0, 14), false);
    assert.deepEqual(c.view().record, { wins: 2, losses: 1 });
    assert.equal(progressOf(path), 70);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { today: { trial: number } }).today.trial, 3);
  });
});

test('trialDone: the reward recovers with the gap since the last trial (full after 10 min), drops scale too', () => {
  withPath((path) => {
    const kinds = (events: CultivationEvent[]) => events.map((event) => event.kind);
    const tired = (events: CultivationEvent[]) =>
      events.flatMap((event) => (event.kind === 'trial-tired' ? [event.minutes] : []));
    // 常量 0.2：掉落判定是「0.2 < 30% × 恢复比例」，恢复满了掉、恢复一半不掉
    const c = new Cultivation(
      path,
      () => undefined,
      () => 0.2,
      24 * 3_600_000,
    );
    const t0 = at(0);
    // 第一次打：没有上一场，满额 +30、掉一件法宝，不说「没缓过来」
    assert.deepEqual(kinds(c.trialDone(t0, true)), ['xp', 'drop']);
    assert.equal(progressOf(path), 30);
    assert.equal(c.view().weapons.length, 2);
    // 10 秒后连点：一点修为都没有，也不掉；说一声还要 10 分钟
    const spam = c.trialDone(t0 + 10_000, true);
    assert.deepEqual(kinds(spam), ['trial-tired']);
    assert.deepEqual(tired(spam), [10]);
    assert.equal(progressOf(path), 30);
    // 再过 5 分钟：恢复一半，赢 +15，掉落概率 15% < 0.2 不掉
    const half = c.trialDone(t0 + 10_000 + 5 * MIN, true);
    assert.deepEqual(kinds(half), ['trial-tired', 'xp']);
    assert.deepEqual(tired(half), [5]);
    assert.equal(progressOf(path), 45);
    assert.equal(c.view().weapons.length, 2);
    // 再隔满 10 分钟：满额 +30、又掉一件，不再说「没缓过来」
    const rested = t0 + 10_000 + 15 * MIN;
    assert.deepEqual(kinds(c.trialDone(rested, true)), ['xp', 'drop']);
    assert.equal(progressOf(path), 75);
    assert.equal(c.view().weapons.length, 3);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { today: { trial: number } }).today.trial, 4);
    // 上一场的时刻落了盘：重启后马上再打照样没收益
    const reopened = new Cultivation(
      path,
      () => undefined,
      () => 0.2,
      24 * 3_600_000,
    );
    assert.deepEqual(kinds(reopened.trialDone(rested + 1_000, false)), ['trial-tired']);
    assert.equal(progressOf(path), 75);
    // 旧档没有 trialAt：读得出来，当没打过，下一场满额（输 +10）
    const old = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete old.trialAt;
    writeFileSync(path, JSON.stringify(old), 'utf8');
    const legacy = new Cultivation(
      path,
      () => undefined,
      () => 0.2,
      24 * 3_600_000,
    );
    assert.deepEqual(kinds(legacy.trialDone(rested + 2_000, false)), ['xp']);
    assert.equal(progressOf(path), 85);
  });
});

test('trialDone / sparDone report the xp that actually went in; tick and rest do not', () => {
  /** 只看 xp 事件（掉法宝是另一回事，随机数决定的，不在这里钉） */
  const xp = (events: CultivationEvent[]) => events.filter((event) => event.kind === 'xp');
  withPath((path) => {
    const c = open(path, 3);
    // 第 1 场赢：xp 30
    assert.deepEqual(xp(c.trialDone(at(0), true)), [{ kind: 'xp', amount: 30 }]);
    // 当天第 2 场：照样进账，xp 照实发
    assert.deepEqual(xp(c.trialDone(at(0, 13), false)), [{ kind: 'xp', amount: 10 }]);
    // 切磋：赢 20、输 10
    assert.deepEqual(xp(c.sparDone(at(1), 'a'.repeat(32), true)), [{ kind: 'xp', amount: 20 }]);
    assert.deepEqual(xp(c.sparDone(at(1), 'b'.repeat(32), false)), [{ kind: 'xp', amount: 10 }]);
    // tick 一点滴的进账不另发 xp（一分钟一条会刷满冒泡）；调息自带 gain 也不发
    const c2 = open(path, 3);
    c2.onSitReminder(at(2));
    assert.deepEqual(xp(c2.onLeave(at(2) + 9 * MIN)), []);
    assert.deepEqual(xp(c2.tick(at(2) + 10 * MIN, true)), []);
  });
});

test('no xp event when the gains land on nothing (already 圆满)', () => {
  withPath((path) => {
    const c = open(path, 5);
    for (let day = 0; !c.view().full; day++) {
      feedDay(c, day);
      assert.ok(day < 20, 'growth should terminate');
    }
    // 圆满：修为一点没进账 → 不发 xp 事件（回归：X3 的「修为 +30」要照实）；法宝照掉
    assert.equal(c.trialDone(at(9), true).filter((event) => event.kind === 'xp').length, 0);
    assert.equal(c.sparDone(at(9), 'a'.repeat(32), true).filter((event) => event.kind === 'xp').length, 0);
    assert.equal(c.view().percent, 100);
  });
});

test('sparDone counts each neighbor once a day, first 3 spars only', () => {
  withPath((path) => {
    const c = open(path, 3);
    c.sparDone(at(0), 'a'.repeat(32), true);
    assert.equal(progressOf(path), 20);
    // 同一个邻居再来一场：只记战绩
    c.sparDone(at(0, 13), 'a'.repeat(32), true);
    assert.equal(progressOf(path), 20);
    // 每天前 3 场有收益（邻居 a、b、c），第 4 个邻居 d 没有
    c.sparDone(at(0, 14), 'b'.repeat(32), false);
    c.sparDone(at(0, 15), 'c'.repeat(32), false);
    c.sparDone(at(0, 16), 'd'.repeat(32), true);
    assert.equal(progressOf(path), 40);
    // 战绩每场都记：a 两场、d 一场赢，b、c 输
    assert.deepEqual(c.view().record, { wins: 3, losses: 2 });
  });
});

/** 一天喂满在场修为（240，一次大跨步就够）再打一场心魔（+30），炼气九层圆满要 5 天；返回升级 / 圆满事件数 */
function feedDay(c: Cultivation, day: number): number {
  const now = at(day, 8);
  c.tick(now, false);
  const events = [...c.tick(now + 240 * MIN, true), ...c.trialDone(now + 241 * MIN, true)];
  return events.filter((event) => event.kind === 'stage-up' || event.kind === 'full').length;
}

function growToFull(path: string, seed: number): Cultivation {
  const c = open(path, seed);
  for (let day = 0; !c.view().full; day++) {
    feedDay(c, day);
    assert.ok(day < 20, 'growth should terminate');
  }
  return c;
}

/** 直接写存档（造圆满 / 有丹 / 待选二选一这些状态，不必真攒几天修为） */
function writeSave(path: string, patch: Record<string, unknown>): void {
  const base = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...base, ...patch }, null, 2), 'utf8');
}

/** 依次给值的随机数（注入常量会让「从几句里挑一句」「二选一挑一个」永远同一支，看不出轮着来对不对） */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** 事件里挑出某一支（顺便让类型收窄到那一个成员） */
function pickEvent<K extends CultivationEvent['kind']>(
  events: CultivationEvent[],
  kind: K,
): Extract<CultivationEvent, { kind: K }> {
  const found = events.find((event) => event.kind === kind);
  assert.ok(found, `事件里该有 ${kind}：${JSON.stringify(events)}`);
  return found as Extract<CultivationEvent, { kind: K }>;
}

test('stage-up carries the remainder and full stops at the brim', () => {
  withPath((path) => {
    const c = open(path, 5);
    const before = c.view().stats;
    let stageUps = 0;
    for (let day = 0; day < 5; day++) stageUps += feedDay(c, day);
    // 5 天 × 270 = 1350：炼气九层圆满，一共升了 8 次、圆满 1 次
    const view = c.view();
    assert.equal(view.stage, 8);
    assert.ok(view.full);
    assert.equal(view.percent, 100);
    assert.equal(stageUps, 9);
    assert.equal(view.stats.hp, before.hp + 8 * 6);
    // 圆满后再进账：多出来的不要，full 只发一次
    const extra = [...c.trialDone(at(5), false), ...c.sparDone(at(5), 'a'.repeat(32), true)];
    assert.deepEqual(extra, []);
    assert.equal(c.view().stage, 8);
    assert.equal(c.view().percent, 100);
  });
});

test('渡劫成功：进下一个大境界、挂出二选一（两个还没有的招式）', () => {
  withPath((path) => {
    const c = growToFull(path, 5);
    const before = c.view();
    assert.equal(before.stage, 8);
    const plan = c.tribulationPlan(at(5, 13));
    assert.deepEqual(plan, { stage: 8, strikes: 3, canPill: false, nextLabel: '筑基初期' });
    // 两个随机数 = 在 10 门还没学的招式里挑两个不同的
    const events = c.tribulationDone(at(5, 13), true, false);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['breakthrough', 'offer'],
    );
    const offer = pickEvent(events, 'offer');
    assert.notEqual(offer.a, offer.b, '二选一给的是两个不同招式');
    assert.equal(c.view().skills.length, 0, '待选期间招式还没到手');
    const after = c.view();
    assert.equal(after.stage, 9);
    assert.equal(after.label, '筑基初期');
    assert.equal(after.stats.hp, before.stats.hp + 20);
    assert.equal(after.stats.power, before.stats.power + 1);
    assert.equal(after.stats.agility, before.stats.agility + 1);
    assert.equal(after.stats.speed, before.stats.speed + 1);
    assert.equal(after.percent, 0);
    assert.deepEqual(after.offer, { a: offer.a, b: offer.b });
    // 再点一次：没圆满了，plan 给 null，done 也不动境界
    assert.equal(c.tribulationPlan(at(5, 14)), null);
    assert.deepEqual(c.tribulationDone(at(5, 14), true, false), []);
    assert.equal(c.view().stage, 9);
  });
});

test('雷数：进筑基、金丹 3 道，进元婴、化神 6 道，之后 9 道', () => {
  assert.equal(tribulationStrikes(9), 3); // 进筑基
  assert.equal(tribulationStrikes(12), 3); // 进金丹
  assert.equal(tribulationStrikes(15), 6); // 进元婴
  assert.equal(tribulationStrikes(18), 6); // 进化神
  for (const next of [21, 24, 27, 28, 30]) assert.equal(tribulationStrikes(next), 9);
});

test('渡劫失败：扣 20% 修为（封顶 300）、境界不掉、不再是圆满', () => {
  withPath((path) => {
    const c = growToFull(path, 5); // 炼气九层圆满（req 150）
    const events = c.tribulationDone(at(5, 13), false, false);
    assert.deepEqual(events, [{ kind: 'tribulation-fail', lost: 30 }]); // 150 × 20%
    const view = c.view();
    assert.equal(view.stage, 8, '失败不掉境界');
    assert.equal(view.percent, 80);
    assert.ok(!view.full, '不再是圆满：攒回来才能再渡（不设冷却计时）');
    assert.equal(c.tribulationPlan(at(5, 14)), null);
    // 没圆满时再算一场是空操作（不重复扣、也不报错）
    assert.deepEqual(c.tribulationDone(at(5, 15), false, false), []);
    assert.equal(progressOf(path), 120);
    // 攒回圆满：立刻能再渡（中间没有冷却）
    c.tick(at(5, 16), false);
    for (let i = 0; i < 30; i++) c.tick(at(5, 16) + (i + 1) * MIN, true);
    assert.ok(c.view().full);
    assert.deepEqual(c.tribulationPlan(at(5, 20)), { stage: 8, strikes: 3, canPill: false, nextLabel: '筑基初期' });
  });
});

test('扣修为封顶 300（合体后期 20% 是 2 800，太狠）', () => {
  withPath((path) => {
    open(path, 5); // 先建档
    writeSave(path, {
      stage: 26,
      progress: 14_000,
      stats: { hp: 300, power: 20, agility: 20, speed: 20 },
      weapons: ['water-gun'],
      skills: ['dove'],
      pills: 0,
    });
    const c = open(path, 5);
    assert.ok(c.view().full && c.view().label === '合体后期');
    assert.deepEqual(c.tribulationPlan(at(0)), { stage: 26, strikes: 9, canPill: false, nextLabel: '大乘初期' });
    assert.deepEqual(c.tribulationDone(at(0, 13), false, false), [{ kind: 'tribulation-fail', lost: 300 }]);
    assert.equal(progressOf(path), 13_700);
    assert.equal(c.view().stage, 26, '不掉境界');
    assert.ok(!c.view().full);
  });
});

test('大乘圆满渡劫成功：不再涨境界，也不挂二选一', () => {
  withPath((path) => {
    open(path, 5);
    writeSave(path, {
      stage: MAX_STAGE,
      progress: 20_000,
      stats: { hp: 300, power: 20, agility: 20, speed: 20 },
      weapons: ['water-gun'],
      skills: ['dove'],
      pills: 0,
    });
    const c = open(path, 5);
    assert.equal(c.tribulationPlan(at(0)), null, '修到头了（飞升在想法池）');
    assert.deepEqual(c.tribulationDone(at(0, 13), true, false), []);
    assert.equal(c.view().stage, MAX_STAGE);
  });
});

test('吃丹：气血 ×1.2（向下取整）、丹数 −1，扛不住也照扣', () => {
  withPath((path) => {
    growToFull(path, 5);
    writeSave(path, { pills: 2 });
    const again = open(path, 5);
    const plain = again.fighter('小鱼');
    assert.equal(again.tribulationFighter('小鱼', true).hp, Math.floor(plain.hp * 1.2));
    assert.equal(again.tribulationFighter('小鱼', false).hp, plain.hp, '没吃丹就照原样');
    assert.ok(again.tribulationPlan(at(5, 13))?.canPill, '有丹就能吃');
    again.tribulationDone(at(5, 14), true, true);
    assert.equal(again.view().pills, 1, '一次最多吃 1 颗');
    // 失败那一场丹也吃了：气血 ×1.2 是开打前生效的
    writeSave(path, { stage: 8, progress: 150 });
    const third = open(path, 5);
    third.tribulationDone(at(5, 16), false, true);
    assert.equal(third.view().pills, 0);
    // 没圆满时调用是空操作：丹不扣、境界也不动
    const before = third.view();
    assert.deepEqual(third.tribulationDone(at(5, 17), true, false), []);
    assert.deepEqual(third.view(), before);
  });
});

test('二选一：挑一个就到手；10 分钟没人挑，tick 里随机定一个', () => {
  withPath((path) => {
    const c = growToFull(path, 5);
    const events = c.tribulationDone(at(5, 13), true, false);
    const offer = pickEvent(events, 'offer');
    // 挑 b：b 到手，a 永远没了
    const chosen = c.choose(at(5, 14), offer.b);
    assert.deepEqual(chosen, [{ kind: 'choose', skill: offer.b }]);
    assert.deepEqual(c.fighter('我').skills, [offer.b]);
    assert.equal(c.view().offer, null);
    // 已经定过了：再点（挂着的两项都没了）什么都不做
    assert.deepEqual(c.choose(at(5, 15), offer.a), []);
    assert.deepEqual(c.fighter('我').skills, [offer.b], 'a 不会再被领悟');
  });
});

test('待选二选一重启还在；10 分钟没人挑，tick 里随机定一个（已有的不重复给）', () => {
  withPath((path) => {
    const until = at(0, 13);
    open(path, 5);
    writeSave(path, {
      stage: 8,
      progress: 150,
      stats: { hp: 98, power: 8, agility: 8, speed: 8 },
      weapons: ['water-gun'],
      skills: ['dove'],
      pills: 0,
      offer: { a: 'bubble', b: 'critical', until },
      today: {
        date: diaryDate(at(0, 8)),
        presence: 0,
        presenceMs: 0,
        rests: 0,
        pills: 0,
        trial: 0,
        spars: [],
      },
    });
    // 随机数序列：0.9 ≥ 0.5 → 过期时定 b（critical）
    const c = new Cultivation(path, () => undefined, seq([0.9]), 24 * 3_600_000);
    assert.deepEqual(c.view().offer, { a: 'bubble', b: 'critical' });
    // 没到期：tick 不动它，菜单那两项还在
    assert.deepEqual(c.tick(at(0, 12), false), []);
    assert.deepEqual(c.view().offer, { a: 'bubble', b: 'critical' });
    // 到点这一拍：随机定一个
    assert.deepEqual(c.tick(until, false), [{ kind: 'choose', skill: 'critical' }]);
    assert.deepEqual(c.fighter('我').skills, ['dove', 'critical'], '已有的不会被重复给');
    assert.equal(c.view().offer, null);
    // 定过一次不再定第二回
    assert.deepEqual(c.tick(until + MIN, false), []);
    // 存档里也落定了（重启不会再定一遍）
    assert.deepEqual(open(path, 5).view().offer, null);
  });
});

test('二选一不给已有的招式、也不会重复（随机数全 0 时不会拿到同一个两次）', () => {
  withPath((path) => {
    open(path, 5);
    writeSave(path, {
      stage: 8,
      progress: 150,
      stats: { hp: 98, power: 8, agility: 8, speed: 8 },
      weapons: ['water-gun'],
      // 已有两门：待选只能从剩下的 8 门里出
      skills: ['play-dead', 'dove'],
      pills: 0,
    });
    const c = new Cultivation(path, () => undefined, seq([0, 0]), 24 * 3_600_000);
    const offer = pickEvent(c.tribulationDone(at(0), true, false), 'offer');
    assert.notEqual(offer.a, offer.b, '随机数全 0 也必须挑两个不同的');
    for (const id of [offer.a, offer.b]) {
      assert.ok(!['play-dead', 'dove'].includes(id), `已有的 ${id} 不会再进待选`);
    }
  });
});

test('day rolls over at 4 am: counters reset and the old file is backed up', () => {
  withPath((path) => {
    const c = open(path, 3);
    let now = at(0);
    c.tick(now, false);
    for (let i = 0; i < 10; i++) c.tick((now += MIN), true);
    c.onClaudeDone(now);
    c.sparDone(now, 'a'.repeat(32), true);
    c.trialDone(now, true);
    assert.equal(progressOf(path), 60); // 10 + 20 + 30
    // 第二天凌晨 4 点（日记口径）之后的第一拍：先备份昨天的文件，计数清零
    c.tick(at(1, 4), false);
    assert.ok(existsSync(`${path}.bak`));
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { today: { date: string; presence: number } };
    assert.equal(saved.today.date, '2026-10-21');
    assert.equal(saved.today.presence, 0);
    // 备份的是昨天收尾时的那份
    const bak = JSON.parse(readFileSync(`${path}.bak`, 'utf8')) as { today: { date: string } };
    assert.equal(bak.today.date, '2026-10-20');
    // 第二天的心魔照样有收益
    c.trialDone(at(1, 5), true);
    assert.equal(progressOf(path), 90);
    assert.equal(c.view().record.wins, 3); // 昨天心魔 + 切磋各赢一场，今天心魔又赢一场
  });
});

test('X8 图鉴迁移：带气球的旧档读得出来，气球换成雪球（已有雪球就去掉），不认识的招式丢掉，下一拍写回', () => {
  withPath((path, warns) => {
    open(path, 1);
    writeSave(path, { weapons: ['poker', 'balloon'], skills: ['bubble', 'teleport'] });
    const c = new Cultivation(path, (message) => warns.push(message), seededRng(1), 24 * 3_600_000);
    assert.deepEqual(warns, [], '不当坏档');
    assert.ok(!readdirSync(dirname(path)).some((name) => name.includes('.bad-')), '没有改名成坏档');
    assert.deepEqual(c.view().weapons, ['扑克牌', '雪球']);
    assert.deepEqual(c.view().skills, ['泡泡护体']);
    c.tick(at(0), false);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { weapons: string[]; skills: string[] };
    assert.deepEqual(saved.weapons, ['poker', 'snowball'], '迁移结果写回了');
    assert.deepEqual(saved.skills, ['bubble']);
  });
  withPath((path) => {
    open(path, 1);
    writeSave(path, { weapons: ['snowball', 'balloon', 'top'] });
    const c = open(path, 1);
    assert.deepEqual(c.view().weapons, ['雪球', '陀螺'], '已经有雪球：气球直接去掉，不重复');
  });
  // 迁移函数本身：没有可迁的就说没动过（不平白写一次档）
  assert.equal(migrateCatalog({ weapons: ['poker'], skills: ['dove'] }).changed, false);
  assert.equal(migrateCatalog({ weapons: ['balloon'], skills: [] }).changed, true);
});

test('a corrupted file is renamed and rebuilt with a warning', () => {
  withPath((path, warns) => {
    writeFileSync(path, '{not json', 'utf8');
    const c = new Cultivation(path, (message) => warns.push(message));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /修炼存档读不了/);
    assert.equal(c.view().stage, 0); // 按第一次建档重建
    const bad = warns[0].match(/已改名 (\S+?)，/)?.[1];
    assert.ok(bad && existsSync(bad));
    // 重建后的档能正常读写
    c.trialDone(at(0), true);
    assert.equal(progressOf(path), 30);
  });
});

test('growth never exceeds statCap over random paths', () => {
  withPath((path) => {
    const rng = seededRng(99);
    const c = new Cultivation(path, () => undefined, rng, 24 * 3_600_000);
    let day = 0;
    // 一路修到大乘圆满：每天喂满在场修为、打一场心魔、圆满就渡劫成功并挑一个招式，随机数全部走 rng
    while (c.view().stage < MAX_STAGE || !c.view().full) {
      const now = at(day, 8);
      c.tick(now, false);
      c.tick(now + 240 * MIN, true);
      c.trialDone(now + 241 * MIN, true);
      if (c.view().full && c.view().stage < MAX_STAGE) {
        const events = c.tribulationDone(now + 242 * MIN, true, false);
        const offer = events.find((event) => event.kind === 'offer');
        if (offer?.kind === 'offer') c.choose(now + 243 * MIN, offer.a);
      }
      day += 1;
      assert.ok(day < 700, 'growth should terminate'); // 全程约 17.5 万修为，每天 270
    }
    const view = c.view();
    assert.equal(view.label, '大乘圆满');
    const cap = statCap(view.stage);
    assert.ok(view.stats.hp <= cap.hp, `hp ${view.stats.hp} > cap ${cap.hp}`);
    assert.ok(view.stats.power <= cap.power, `power ${view.stats.power} > cap ${cap.power}`);
    assert.ok(view.stats.agility <= cap.agility, `agility ${view.stats.agility} > cap ${cap.agility}`);
    assert.ok(view.stats.speed <= cap.speed, `speed ${view.stats.speed} > cap ${cap.speed}`);
    // 法宝只可能来自建档和心魔掉落，不重复
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { weapons: WeaponId[]; skills: SkillId[] };
    assert.equal(new Set(saved.weapons).size, saved.weapons.length);
    // 二选一一路挑下来也不会重复给同一个招式（10 个大境界段最多攒 10 门，图鉴 10 门）
    assert.equal(new Set(saved.skills).size, saved.skills.length);
  });
});

test('a long gap (sleep/lid-closed) is not counted as presence', () => {
  withPath((path) => {
    const c = new Cultivation(path, () => undefined, seededRng(1)); // 默认的单拍封顶
    const now = at(0);
    c.tick(now, false);
    // 睡 8 小时后醒来的那一拍 present 为真：间隔再长也只计封顶那一点，攒不满一分钟
    c.tick(now + 8 * 3_600_000, true);
    assert.equal(progressOf(path), 0);
    // 再来一拍才凑满一分钟
    c.tick(now + 8 * 3_600_000 + TICK_MAX_ELAPSED_MS, true);
    assert.equal(progressOf(path), 1);
  });
});

test('the save file is only written when persisted state changes', () => {
  withPath((path) => {
    const c = new Cultivation(path, () => undefined, seededRng(1)); // 默认的单拍封顶
    const now = at(0);
    c.tick(now, false); // 建档后第一拍（换日）会写一次
    const before = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    c.onSitReminder(now); // 只改不落盘的心浮气躁，不写
    c.onLeave(now + 11 * MIN); // 超过 10 分钟窗口：只解除，也不写
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(statSync(path).mtimeMs, mtime);
    // presenceMs 在涨，但还没攒满一分钟，不值得写
    const base = now + 12 * MIN;
    c.tick(base, false);
    c.tick(base + 10_000, true);
    c.tick(base + 20_000, true);
    c.tick(base + 25_000, false);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(statSync(path).mtimeMs, mtime);
    // 攒满一分钟：修为点数变了，这才写盘
    c.tick(base + 50_000, true);
    c.tick(base + 80_000, true);
    assert.equal(progressOf(path), 1);
    assert.notEqual(readFileSync(path, 'utf8'), before);
    assert.notEqual(statSync(path).mtimeMs, mtime);
  });
});

test('X1 那份存档（offer 恒为 null）照读；待选形状坏了照旧改名重建', () => {
  withPath((path, warns) => {
    const c = open(path, 5);
    c.trialDone(at(0), true); // 落一次盘
    // X1 写的就是 offer: null —— 换成待选形状之后仍要读得了
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { offer: unknown }).offer, null);
    const again = new Cultivation(path, () => undefined, seededRng(5), 24 * 3_600_000);
    assert.equal(again.view().offer, null);
    assert.equal(progressOf(path), 30, 'X1 的修为读得进来');
    // 待选形状不对（编号不在图鉴里）：整份存档按坏文件处理，不静默丢掉这一项
    writeSave(path, { offer: { a: 'not-a-skill', b: 'dove', until: at(1) } });
    const rebuilt = new Cultivation(path, (message) => warns.push(message), seededRng(5));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /修炼存档读不了/);
    assert.equal(rebuilt.view().offer, null);
    assert.equal(rebuilt.view().stage, 0);
  });
});

test('drawDropWeapon picks by grade weight among the missing', () => {
  const allButFirework = WEAPON_IDS.filter((id) => id !== 'firework');
  // 只剩神器烟花：随机数落在神器区间，拿到的必是它
  assert.equal(
    drawDropWeapon(allButFirework, () => 0.999),
    'firework',
  );
  // 凡器集齐：剩下的灵器 0.25 / 神器 0.05，roll 0.5 × 0.3 = 0.15 落在灵器区间
  const owned = WEAPON_IDS.filter((id) => !['juggle', 'top', 'whale-tail', 'firework'].includes(id));
  const calls = [0.5, 0];
  let call = 0;
  const draw = drawDropWeapon(owned, () => calls[call++]);
  assert.ok(draw === 'juggle' || draw === 'top');
  // 已有的不会再掉；全都集齐返回 null
  for (const roll of [0.01, 0.3, 0.6, 0.95]) {
    const drop = drawDropWeapon(['water-gun'], () => roll);
    assert.ok(drop && drop !== 'water-gun');
  }
  assert.equal(
    drawDropWeapon([...WEAPON_IDS], () => 0.999),
    null,
  );
});
