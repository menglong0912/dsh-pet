import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seededRng } from './battle-testkit.ts';
import { majorBreaks, statCap, WEAPON_IDS, type WeaponId } from './battle.ts';
import {
  Cultivation,
  drawDropWeapon,
  isFullStage,
  MAX_STAGE,
  stageLabel,
  stageReq,
  TICK_MAX_ELAPSED_MS,
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

test('trialDone rewards only the first trial of the day, record counts all', () => {
  withPath((path) => {
    const c = open(path, 3);
    c.trialDone(at(0), true);
    assert.equal(progressOf(path), 30);
    assert.deepEqual(c.view().record, { wins: 1, losses: 0 });
    // 之后的场次只返回 0，战绩照记
    assert.deepEqual(c.trialDone(at(0, 13), true), []);
    assert.deepEqual(c.trialDone(at(0, 14), false), []);
    assert.deepEqual(c.view().record, { wins: 2, losses: 1 });
    assert.equal(progressOf(path), 30);
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

test('breakthrough advances the major stage and grants a new skill', () => {
  withPath((path) => {
    const c = growToFull(path, 5);
    const before = c.view();
    assert.equal(before.stage, 8);
    const events = c.breakthrough(at(5, 13));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'breakthrough');
    const after = c.view();
    assert.equal(after.stage, 9);
    assert.equal(after.label, '筑基初期');
    assert.equal(after.stats.hp, before.stats.hp + 20);
    assert.equal(after.stats.power, before.stats.power + 1);
    assert.equal(after.stats.agility, before.stats.agility + 1);
    assert.equal(after.stats.speed, before.stats.speed + 1);
    assert.equal(after.skills.length, 1);
    assert.equal(after.percent, 0);
    // 突破后再突破：没圆满，空操作
    assert.deepEqual(c.breakthrough(at(5, 14)), []);
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
    // 计数清零：第二场心魔又有收益了
    c.trialDone(at(1, 5), true);
    assert.equal(progressOf(path), 90);
    assert.equal(c.view().record.wins, 3); // 昨天心魔 + 切磋各赢一场，今天心魔又赢一场
  });
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
    // 一路修到大乘圆满：每天喂满在场修为、打一场心魔，随机数全部走 rng
    while (c.view().stage < MAX_STAGE || !c.view().full) {
      const now = at(day, 8);
      c.tick(now, false);
      c.tick(now + 240 * MIN, true);
      c.trialDone(now + 241 * MIN, true);
      if (c.view().full) c.breakthrough(now + 242 * MIN);
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
    const ids = JSON.parse(readFileSync(path, 'utf8')).weapons as WeaponId[];
    assert.equal(new Set(ids).size, ids.length);
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
