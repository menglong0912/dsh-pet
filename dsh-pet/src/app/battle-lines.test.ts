import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOf } from './battle-lines.ts';
import { WEAPON_IDS, type BattleEvent, type SkillId } from './battle.ts';

/** 名字按 12 字上限来验长度 */
const names: [string, string] = ['小花小花小花小花', '心魔心魔心魔心魔'];
const pick = (rolls: number[], event: Partial<BattleEvent> & Pick<BattleEvent, 'kind' | 'actor'>): string[] => {
  const out: string[] = [];
  for (let i = 0; i < rolls.length; i++) {
    const line = lineOf({ hp: [10, 10], ...event } as BattleEvent, names, () => (i + 0.01) / rolls.length);
    if (line !== null) out.push(line);
  }
  return out;
};

test('start 和 decide 不配台词', () => {
  assert.equal(
    lineOf({ actor: 0, kind: 'start', hp: [10, 10] }, names, () => 0),
    null,
  );
  assert.equal(
    lineOf({ actor: 0, kind: 'decide', action: { kind: 'unarmed' }, hp: [10, 10] }, names, () => 0),
    null,
  );
});

test('每件法宝的命中都有专属台词，且不超过 40 字', () => {
  const weapons = WEAPON_IDS;
  for (const weapon of weapons) {
    const lines = pick([0, 0.4, 0.8], { actor: 0, kind: 'hit', weapon, damage: 9, crit: false, blocked: false });
    assert.ok(lines.length >= 2, `${weapon} 至少两句`);
    for (const line of lines) {
      assert.ok(line.length <= 40, `${weapon} 的台词超长：${line}`);
      assert.ok(line.includes(names[0]) && line.includes('9'), line);
    }
  }
  // 空手也有两句以上，说的是小拳头
  const unarmed = pick([0, 0.4, 0.8], { actor: 1, kind: 'hit', damage: 5, crit: false, blocked: false });
  assert.ok(unarmed.length >= 2 && unarmed.every((l) => l.includes(names[1]) && l.includes('5')));
  assert.ok(
    unarmed.some((l) => l.includes('拳头')),
    '空手说的是小拳头',
  );
});

test('会心和泡泡挡伤在台词里体现，总长仍 ≤ 40 字', () => {
  const crit = lineOf(
    { actor: 0, kind: 'hit', weapon: 'firework', damage: 30, crit: true, blocked: false, hp: [10, 2] },
    names,
    () => 0,
  );
  assert.ok(crit?.startsWith('会心一击！'), crit ?? '');
  assert.ok(crit!.length <= 40);
  const blocked = lineOf(
    { actor: 1, kind: 'combo', damage: 12, crit: false, blocked: true, hp: [10, 4] },
    names,
    () => 0,
  );
  assert.ok(blocked?.endsWith('（泡泡挡掉一半）'), blocked ?? '');
  assert.ok(blocked!.length <= 40);
});

test('化鸽遁那句只给真有化鸽遁的一方', () => {
  const event: BattleEvent = { actor: 0, kind: 'dodge', hp: [10, 10] };
  // 没传 skillSets 或双方都没有化鸽遁：只会说通用闪避句
  const noDove: ([SkillId[], SkillId[]] | undefined)[] = [undefined, [['bubble'], ['bubble']]];
  for (const sets of noDove) {
    for (const r of [0.01, 0.5, 0.99]) {
      const line = lineOf(event, names, () => r, sets);
      assert.ok(!line!.includes('鸽子'), `不该说鸽子：${line}`);
    }
  }
  // 有化鸽遁：才说得出鸽子句
  const withDove = new Set<string>();
  for (const r of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    withDove.add(lineOf(event, names, () => r, [['dove'], []])!);
  }
  assert.ok(
    [...withDove].some((l) => l.includes('鸽子')),
    '有化鸽遁应该说得出鸽子句',
  );
});

test('其余事件各有台词，名字和数值都对得上', () => {
  const cases: [BattleEvent, (line: string) => boolean][] = [
    [{ actor: 0, kind: 'combo', damage: 7, crit: false, blocked: false, hp: [10, 3] }, (l) => l.includes('7')],
    [{ actor: 1, kind: 'counter', damage: 6, blocked: false, hp: [4, 10] }, (l) => l.includes('6')],
    [
      { actor: 0, kind: 'beast', damage: 5, blocked: false, hp: [10, 5] },
      (l) => l.includes(names[0]) && l.includes('5'),
    ],
    [{ actor: 1, kind: 'skip', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 0, kind: 'play-dead', hp: [1, 10] }, (l) => l.includes(names[0])],
    [{ actor: 0, kind: 'skill', skill: 'bloom', heal: 25, hp: [30, 10] }, (l) => l.includes('25')],
    [{ actor: 0, kind: 'skill', skill: 'lion-roar', damage: 15, hp: [10, 5] }, (l) => l.includes('15')],
    [{ actor: 0, kind: 'skill', skill: 'blue-whale', damage: 28, hp: [10, 2] }, (l) => l.includes('28')],
    [{ actor: 0, kind: 'strike', index: 0, damage: 21, blocked: false, hp: [9, 0] }, (l) => l.includes('21')],
    [
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [10, 0] },
      (l) => l.includes(names[0]) || l.includes(names[1]),
    ],
  ];
  for (const [event, check] of cases) {
    const line = lineOf(event, names, () => 0);
    assert.ok(line !== null, `${event.kind} 应该有台词`);
    assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
    assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
  }
});

test('同一种事件多次掷随机数会换着说', () => {
  const event: BattleEvent = { actor: 0, kind: 'dodge', hp: [10, 10] };
  const seen = new Set([
    lineOf(event, names, () => 0.01),
    lineOf(event, names, () => 0.5),
    lineOf(event, names, () => 0.99),
  ]);
  assert.ok(seen.size >= 2, '闪避的几句模板应该轮着来');
});

test('X8：新法宝的迟缓 / 两颗、跳过按原因、打空、分身、三个新主动都有台词，不超过 40 字', () => {
  const cases: [BattleEvent, (line: string) => boolean][] = [
    [
      { actor: 0, kind: 'hit', weapon: 'duster', damage: 6, crit: false, blocked: false, slowed: true, hp: [10, 4] },
      (l) => l.includes('6') && /笑|乐/.test(l),
    ],
    [
      { actor: 0, kind: 'hit', weapon: 'slingshot', damage: 16, crit: false, blocked: false, twin: true, hp: [10, 4] },
      (l) => l.includes('16') && /两颗/.test(l),
    ],
    [{ actor: 1, kind: 'skip', cause: 'freeze', hp: [10, 10] }, (l) => l.includes(names[1]) && /冰/.test(l)],
    [{ actor: 1, kind: 'skip', cause: 'sleep', hp: [10, 10] }, (l) => l.includes(names[1]) && /睡|呼/.test(l)],
    [{ actor: 1, kind: 'skip', cause: 'stun', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 1, kind: 'miss', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 1, kind: 'decoy', hp: [10, 10] }, (l) => l.includes(names[1]) && l.includes('水母')],
    [{ actor: 0, kind: 'skill', skill: 'whale-song', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 0, kind: 'skill', skill: 'ink', hp: [10, 10] }, (l) => l.includes(names[1]) && l.includes('墨')],
    [
      { actor: 0, kind: 'skill', skill: 'whale-gulp', damage: 22, heal: 11, hp: [10, 10] },
      (l) => l.includes('22') && l.includes('11'),
    ],
  ];
  for (const [event, check] of cases) {
    for (const roll of [0.01, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
    }
  }
  // 迟缓 / 两颗的专属句叠上会心或挡伤，仍不超长
  for (const flag of [{ slowed: true as const }, { twin: true as const }]) {
    for (const extra of [
      { crit: true, blocked: false },
      { crit: false, blocked: true },
    ]) {
      const line = lineOf(
        { actor: 0, kind: 'hit', weapon: 'duster', damage: 99, ...extra, ...flag, hp: [10, 4] },
        names,
        () => 0.5,
      );
      assert.ok(line!.length <= 40, `叠加后超长：${line}`);
    }
  }
});

test('X9：魂影替挨、入梦、穿护体、三个新主动都有台词，不超过 40 字', () => {
  const names: [string, string] = ['阿鲸', '心魔'];
  const cases: Array<[BattleEvent, (line: string) => boolean]> = [
    [{ actor: 0, kind: 'mirror', hp: [10, 10] }, (l) => l.includes(names[0]) && l.includes('魂影')],
    [{ actor: 1, kind: 'skip', cause: 'dream', hp: [10, 10] }, (l) => l.includes(names[1]) && /梦/.test(l)],
    [{ actor: 0, kind: 'skill', skill: 'myriad-self', hp: [10, 10] }, (l) => l.includes(names[0])],
    [
      { actor: 0, kind: 'skill', skill: 'dream-chant', damage: 21, hp: [10, 4] },
      (l) => l.includes('21') && l.includes(names[1]),
    ],
    [{ actor: 0, kind: 'skill', skill: 'finger-sword', damage: 26, hp: [10, 4] }, (l) => l.includes('26')],
    [
      { actor: 0, kind: 'skill', skill: 'finger-sword', damage: 26, pierce: true, hp: [10, 4] },
      (l) => l.includes('26') && /护体/.test(l),
    ],
  ];
  for (const [event, check] of cases) {
    for (const roll of [0.01, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
    }
  }
});
