/**
 * 演出时间线与执行器的单测（X3）。
 *
 * 时间线是纯函数：喂进引擎事件序列，直接核对排出来的每一步（映射、rate、反应延迟、快进）。
 * 执行器注入假的手 + mock timers 拨时间，不真等（X2 的口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fighterAt } from './battle-testkit.ts';
import { MAX_STAGE } from './cultivation.ts';
import {
  fight,
  shadowOf,
  tribulate,
  SKILLS,
  WEAPONS,
  type Action,
  type BattleEvent,
  type Fighter,
  type SkillId,
} from './battle.ts';
import {
  BEAT_MS,
  BattleShow,
  LINE_MS,
  OPEN_MS,
  rateFor,
  reactDelayOf,
  REACT_MS,
  SLOT_MS,
  timeline,
  type ShowSides,
  type Step,
} from './battle-show.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 固定序列的随机数（常量会让「从几句里挑一句」永远挑同一句，看不出轮着来对不对） */
function seq(start = 0): () => number {
  let i = start;
  return () => ((i++ % 7) / 7 + 0.02) % 1;
}

const NAMES: [string, string] = ['小鱼', '心魔'];
const hp: [number, number] = [100, 90];

const start = (actor: 0 | 1): BattleEvent => ({ actor, kind: 'start', hp });
const decide = (actor: 0 | 1, action: Action, after: [number, number] = hp): BattleEvent => ({
  actor,
  kind: 'decide',
  action,
  hp: after,
});
const hit = (actor: 0 | 1, damage = 20, after: [number, number] = [100, 70], blocked = false): BattleEvent => ({
  actor,
  kind: 'hit',
  damage,
  crit: false,
  blocked,
  hp: after,
});
const combo = (actor: 0 | 1, damage = 15, after: [number, number] = [100, 55], blocked = false): BattleEvent => ({
  actor,
  kind: 'combo',
  damage,
  crit: false,
  blocked,
  hp: after,
});
const counter = (actor: 0 | 1, damage = 12, after: [number, number] = [88, 70], blocked = false): BattleEvent => ({
  actor,
  kind: 'counter',
  damage,
  blocked,
  hp: after,
});
const beast = (actor: 0 | 1, damage = 6, after: [number, number] = [100, 74], blocked = false): BattleEvent => ({
  actor,
  kind: 'beast',
  damage,
  blocked,
  hp: after,
});
const strike = (index = 0, damage = 30, after: [number, number] = [70, 0], blocked = false): BattleEvent => ({
  actor: 0,
  kind: 'strike',
  index,
  damage,
  blocked,
  hp: after,
});

/** 只用空手：出手次数可控（自动出招还会放招式、用法宝，格子数不好核） */
const unarmed: { decide(): Action } = { decide: () => ({ kind: 'unarmed' }) };

test('rateFor：素材时长 ÷ 步长，夹在 /anim 允许的 0.5–3', () => {
  // 战斗-出拳 5 秒要占满 2.4 秒的一步 → 2.083
  assert.equal(rateFor('战斗-出拳', SLOT_MS), 2.083);
  // 表里没列的（法宝都是 4 秒）
  assert.equal(rateFor(WEAPONS['water-gun'].anim, SLOT_MS), 1.667);
  // 反应动画的窗口 = 一格减去那 0.9 秒
  assert.equal(rateFor(SKILLS.dove.anim, SLOT_MS - REACT_MS), 2.667);
  // 6 秒的打坐摊到 2 秒 → 3，再长也夹到上限（越界宿主直接拒，那一下就没动画了）
  assert.equal(rateFor('修炼-打坐', 2_000), 3);
  // 4 秒的素材摊到 12 秒 → 0.333，夹到下限
  assert.equal(rateFor('战斗-起手', 12_000), 0.5);
});

test('开场：两边各一段起手式，都在 t=0', () => {
  const steps = timeline([start(0)], NAMES, seq());
  assert.deepEqual(
    steps.map((step) => [step.at, step.who, step.anim, step.rate]),
    [
      [0, 0, '战斗-起手', 1.667],
      [0, 1, '战斗-起手', 1.667],
    ],
  );
  assert.deepEqual(steps[0].hp, hp);
});

test('出手 → 台词 → 挨打反应：反应比出手晚到攻击素材的打击时刻，落在对方那一边', () => {
  const steps = timeline([start(0), decide(0, { kind: 'unarmed' }), hit(0)], NAMES, seq());
  assert.deepEqual(
    steps.filter((step) => step.anim).map((step) => [step.at, step.who, step.anim]),
    [
      [0, 0, '战斗-起手'],
      [0, 1, '战斗-起手'],
      [OPEN_MS, 0, '战斗-出拳'],
      [OPEN_MS + reactDelayOf('战斗-出拳'), 1, '战斗-受击'],
    ],
  );
  const line = steps.find((step) => step.line);
  assert.ok(line && line.who === 0 && line.at === OPEN_MS, `台词挂在出手那一方：${JSON.stringify(line)}`);
  assert.match(line?.line ?? '', /小鱼/);
});

test('reactDelayOf：反应延迟 = 素材打击时刻 ÷ 倍速（固定 0.9 秒只有出拳对得上）', () => {
  // 出拳 5s：打击在 2.0s，倍速 2.083 → 960ms（≈ X3 原来的固定 900，观感不变）
  assert.equal(reactDelayOf('战斗-出拳'), 960);
  // 水枪 4s：水柱打在 1.9s，倍速 1.667 → 1140ms（固定 900 时对方在水柱沾身前就挨揍了）
  assert.equal(reactDelayOf('法宝-水枪'), 1140);
  // 气球 4s：炸在 2.0s → 1200ms
  assert.equal(reactDelayOf('法宝-气球'), 1200);
  // 蓝鲸 5s：俯冲撞在 2.25s，倍速 2.083 → 1080ms
  assert.equal(reactDelayOf('招式-蓝鲸现世'), 1080);
  // 表里没有的 / 没有攻击动画：退回固定 REACT_MS
  assert.equal(reactDelayOf('战斗-胜利'), REACT_MS);
  assert.equal(reactDelayOf(null), REACT_MS);
});

test('映射：法宝攻击用 法宝-<名>，招式用 招式-<名>，空手用 战斗-出拳', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'weapon', weapon: 'whale-tail' }),
      { actor: 1, kind: 'dodge', hp } as BattleEvent,
      decide(0, { kind: 'skill', skill: 'blue-whale' }),
      { actor: 0, kind: 'skill', skill: 'blue-whale', damage: 40, hp: [100, 50] } as BattleEvent,
    ],
    NAMES,
    seq(),
  );
  assert.deepEqual(
    steps.filter((step) => step.anim).map((step) => step.anim),
    ['战斗-起手', '战斗-起手', WEAPONS['whale-tail'].anim, '战斗-闪避', SKILLS['blue-whale'].anim, '战斗-受击'],
  );
});

test('闪避：只有真有化鸽遁那一方播「招式-化鸽遁」', () => {
  const dodge = { actor: 1, kind: 'dodge', hp } as BattleEvent;
  const dove: [SkillId[], SkillId[]] = [[], ['dove']];
  const none: [SkillId[], SkillId[]] = [[], []];
  const anims = (skillSets: [SkillId[], SkillId[]]) =>
    timeline([start(0), dodge], NAMES, seq(), skillSets)
      .filter((step) => step.anim)
      .map((step) => [step.who, step.anim]);
  assert.deepEqual(anims(dove), [
    [0, '战斗-起手'],
    [1, '战斗-起手'],
    [1, SKILLS.dove.anim],
  ]);
  assert.deepEqual(anims(none), [
    [0, '战斗-起手'],
    [1, '战斗-起手'],
    [1, '战斗-闪避'],
  ]);
  // 台词那边同样只看 skillSets（lineOf 的第四参数）
  const lines = timeline([start(0), dodge], NAMES, seq(), dove)
    .filter((step) => step.line)
    .map((step) => step.line);
  assert.ok(
    lines.some((line) => line?.includes('鸽子')),
    `化鸽遁的句子：${lines.join(' / ')}`,
  );
});

test('同一格里的第二、三段错开 BEAT_MS；下一件事另起一格', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'unarmed' }),
      hit(0, 20, [100, 70]),
      combo(0, 15, [100, 55]),
      decide(1, { kind: 'unarmed' }, [100, 55]),
      hit(1, 12, [88, 55]),
    ],
    NAMES,
    seq(),
  );
  assert.deepEqual(
    steps.filter((step) => step.line).map((step) => step.at),
    [OPEN_MS, OPEN_MS + BEAT_MS, OPEN_MS + SLOT_MS],
  );
});

test('挡下的那一下：挨打方播招式-泡泡护体（代替战斗-受击），时刻跟着攻击素材的打击时刻', () => {
  const delay = reactDelayOf('战斗-出拳');
  const stepMaps = (blocked: boolean) => {
    const sets: [SkillId[], SkillId[]] = [[], ['bubble']];
    return timeline([start(0), decide(0, { kind: 'unarmed' }), hit(0, 20, [100, 80], blocked)], NAMES, seq(), sets)
      .filter((step) => step.anim && step.at >= OPEN_MS)
      .map((step) => [step.at, step.who, step.anim, step.rate]);
  };
  assert.deepEqual(
    stepMaps(true),
    [
      [OPEN_MS, 0, '战斗-出拳', rateFor('战斗-出拳', SLOT_MS)],
      [OPEN_MS + delay, 1, SKILLS.bubble.anim, rateFor(SKILLS.bubble.anim, SLOT_MS - delay)],
    ],
    '泡泡护体是防御方（挨打那一方）的动画',
  );
  assert.deepEqual(
    stepMaps(false),
    [
      [OPEN_MS, 0, '战斗-出拳', rateFor('战斗-出拳', SLOT_MS)],
      [OPEN_MS + delay, 1, '战斗-受击', rateFor('战斗-受击', SLOT_MS - delay)],
    ],
    '没挡下照旧战斗-受击',
  );
  // combo / beast / counter 也一样看 blocked：挡下就是对面那一边吹泡泡
  const blockedCases: Array<[string, BattleEvent, 0 | 1, [SkillId[], SkillId[]]]> = [
    ['combo', combo(0, 10, [100, 90], true), 1, [[], ['bubble']]],
    ['beast', beast(0, 5, [100, 95], true), 1, [[], ['bubble']]],
    ['counter', counter(1, 8, [92, 90], true), 0, [['bubble'], []]],
  ];
  for (const [label, event, reactWho, sets] of blockedCases) {
    const steps = timeline([start(0), decide(0, { kind: 'unarmed' }), event], NAMES, seq(), sets);
    const react = steps.filter((step) => step.anim === SKILLS.bubble.anim);
    assert.equal(react.length, 1, `${label} 挡下时只有一步泡泡护体`);
    assert.equal(react[0].who, reactWho, `${label}：泡泡护体播在挨打那一方`);
    assert.equal(steps.filter((step) => step.anim === '战斗-受击').length, 0, `${label}：挡下了就不播战斗-受击`);
  }
});

test('灵兽助阵：beast 那一拍出兽方加播招式-灵兽助阵，和台词同拍', () => {
  const steps = timeline([start(0), decide(0, { kind: 'unarmed' }), hit(0), beast(0, 6, [100, 64])], NAMES, seq());
  const atBeast = OPEN_MS + BEAT_MS;
  assert.deepEqual(
    steps.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.at, step.who, step.anim]),
    [
      [OPEN_MS, 0, '战斗-出拳'],
      [atBeast, 0, SKILLS['spirit-beast'].anim],
      [OPEN_MS + reactDelayOf('战斗-出拳'), 1, '战斗-受击'],
      [atBeast + reactDelayOf(SKILLS['spirit-beast'].anim), 1, '战斗-受击'],
    ],
    '出手方自己那拍追加灵兽（顶掉攻击动画的尾巴）；挨打方各跟各的打击时刻（灵兽那一下跟灵兽素材的冲撞时刻）',
  );
  const beastLine = steps.find((step) => step.at === atBeast && step.line);
  assert.ok(beastLine && beastLine.who === 0, '灵兽那句台词和动画同拍、在出手方');
  assert.equal(
    steps.find((step) => step.anim === SKILLS['spirit-beast'].anim)?.rate,
    rateFor(SKILLS['spirit-beast'].anim, SLOT_MS),
    '灵兽助阵占满出手那一格',
  );
});

test('第六感：反击方贴着自己挨的那一下之后加播招式-第六感（先挨一下、再反手劈）', () => {
  const steps = timeline(
    [start(0), decide(0, { kind: 'unarmed' }), hit(0, 20, [100, 70]), counter(1, 12, [88, 70])],
    NAMES,
    seq(),
  );
  const atCounter = OPEN_MS + BEAT_MS;
  const hitDelay = reactDelayOf('战斗-出拳');
  const senseDelay = hitDelay + 300;
  assert.deepEqual(
    steps.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.at, step.who, step.anim]),
    [
      [OPEN_MS, 0, '战斗-出拳'],
      [OPEN_MS + hitDelay, 1, '战斗-受击'],
      [atCounter + REACT_MS, 0, '战斗-受击'],
      [atCounter + senseDelay, 1, SKILLS['sixth-sense'].anim],
    ],
    '反击方挨的（hit 的受击）跟着攻击素材的打击时刻；第六感再晚 300ms（贴着挨完再反劈）；' +
      '出手方挨的反击是徒手快打，维持固定 REACT_MS',
  );
  const sense = steps.find((step) => step.anim === SKILLS['sixth-sense'].anim);
  assert.equal(sense?.rate, rateFor(SKILLS['sixth-sense'].anim, SLOT_MS - senseDelay), '反应窗口算倍速');
  const counterLine = steps.find((step) => step.at === atCounter && step.line);
  assert.ok(counterLine && counterLine.who === 1, '反击的台词还在反击方那一拍');
  // 反击打回去那一下被泡泡挡了：出手方照上一条播泡泡护体
  const blockedCounter = timeline(
    [start(0), decide(0, { kind: 'unarmed' }), hit(0, 20, [100, 70]), counter(1, 12, [76, 70], true)],
    NAMES,
    seq(),
    [['bubble'], []],
  );
  assert.deepEqual(
    blockedCounter.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.at, step.who, step.anim]),
    [
      [OPEN_MS, 0, '战斗-出拳'],
      [OPEN_MS + hitDelay, 1, '战斗-受击'],
      [atCounter + REACT_MS, 0, SKILLS.bubble.anim],
      [atCounter + senseDelay, 1, SKILLS['sixth-sense'].anim],
    ],
  );
});

test('无影手：combo 那一拍出手方加播招式-无影手，没有 shadow-fists 时只有台词', () => {
  const events = [start(0), decide(0, { kind: 'unarmed' }), hit(0), combo(0, 12, [100, 43])];
  const anims = (skillSets: [SkillId[], SkillId[]]) =>
    timeline(events, NAMES, seq(), skillSets)
      .filter((step) => step.anim && step.at >= OPEN_MS)
      .map((step) => [step.at, step.who, step.anim]);
  const atCombo = OPEN_MS + BEAT_MS;
  const delay = reactDelayOf('战斗-出拳');
  assert.deepEqual(
    anims([['shadow-fists'], []]),
    [
      [OPEN_MS, 0, '战斗-出拳'],
      [atCombo, 0, SKILLS['shadow-fists'].anim],
      [OPEN_MS + delay, 1, '战斗-受击'],
      [atCombo + delay, 1, '战斗-受击'],
    ],
    '一拳接连续拳影（和 combo 台词同拍），挨打方两段攻击各反应一次',
  );
  assert.deepEqual(
    anims([[], []]),
    [
      [OPEN_MS, 0, '战斗-出拳'],
      [OPEN_MS + delay, 1, '战斗-受击'],
      [atCombo + delay, 1, '战斗-受击'],
    ],
    '连击来自身法 / 毽子这些加成，出手方没无影手就不配拳影',
  );
  // 无影手只看出手方，不是挨打方
  assert.deepEqual(anims([[], ['shadow-fists']]), anims([[], []]));
});

test('收场：赢的播胜利、输的播倒地，结果台词和它们一起标 closing（快进跳到这几步）', () => {
  const steps = timeline(
    [start(0), { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [55, 0] } as BattleEvent],
    NAMES,
    seq(),
  );
  const closing = steps.filter((step) => step.closing);
  assert.deepEqual(
    closing.map((step) => [step.at, step.who, step.anim ?? 'line']),
    [
      [OPEN_MS, 0, '战斗-胜利'],
      [OPEN_MS, 1, '战斗-倒地'],
      [OPEN_MS, 0, 'line'],
    ],
  );
  assert.deepEqual(
    closing.map((step) => step.hp),
    [
      [55, 0],
      [55, 0],
      [55, 0],
    ],
  );
});

test('假死遁：救回来那一下自己播招式-假死遁；被定住只有台词没动画', () => {
  const steps = timeline(
    [
      start(0),
      hit(0, 200, [100, 0]),
      { actor: 1, kind: 'play-dead', hp: [100, 1] } as BattleEvent,
      { actor: 1, kind: 'skip', hp: [100, 1] } as BattleEvent,
    ],
    NAMES,
    seq(),
  );
  assert.deepEqual(
    steps.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.who, step.anim]),
    [[1, SKILLS['play-dead'].anim]],
    '这一拳被打倒又爬起来，不播受击（假死遁自己播）',
  );
  const skip = steps.find((step) => step.line?.includes('定在原地') || step.line?.includes('愣在原地'));
  assert.ok(skip && skip.who === 1, 'skip 有一句、出现在被定住那一方');
});

test('渡劫：一道雷一格，没有对手的反应；雷被泡泡挡了改播渡劫者自己的护体', () => {
  const steps = timeline([start(0), strike(0), strike(1)], ['小鱼', '天雷'], seq());
  const strikes = steps.filter((step) => step.anim === '修炼-挨雷');
  assert.deepEqual(
    strikes.map((step) => step.at),
    [OPEN_MS, OPEN_MS + SLOT_MS],
  );
  assert.deepEqual(
    strikes.map((step) => step.who),
    [0, 0],
  );
  assert.equal(steps.filter((step) => step.anim === '战斗-受击').length, 0);
  // 挡下的那道：同一拍换成招式-泡泡护体（渡劫只有自家这一边，没有对手的反应）
  const blockedSteps = timeline([start(0), strike(0, 30, [85, 0], true)], ['小鱼', '天雷'], seq(), [['bubble'], []]);
  assert.deepEqual(
    blockedSteps.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.at, step.who, step.anim]),
    [[OPEN_MS, 0, SKILLS.bubble.anim]],
  );
});

test('气血：每一步都带上它之后的两条血（擂台照它刷新）', () => {
  const steps = timeline([start(0), decide(0, { kind: 'unarmed' }), hit(0, 20, [100, 70])], NAMES, seq());
  assert.ok(steps.every((step) => step.hp.length === 2));
  assert.deepEqual(steps[steps.length - 1].hp, [100, 70]);
});

test('真引擎的一场：时间线按时间递增，整场长度可控（一场别拖太久）', () => {
  const a: Fighter = { name: '小鱼', hp: 120, power: 10, agility: 8, speed: 9, weapons: ['poker'], skills: ['dove'] };
  const b = shadowOf(a);
  const steps = timeline(fight(a, b, 'show-1', [unarmed, unarmed]), NAMES, seq(), [a.skills, b.skills]);
  assert.ok(steps.length > 4, '该排出一串步骤');
  assert.ok(
    steps.every((step, i) => i === 0 || steps[i - 1].at <= step.at),
    '时间线按时间递增',
  );
  // 出手封顶 30 次（引擎的兜底），也就 30 格 + 开场 + 收场
  assert.ok(steps[steps.length - 1].at < 90_000, `整场不超过 90 秒：实际 ${steps[steps.length - 1].at / 1000} 秒`);
});

/** 执行器用的假手：记下每次调用 */
interface FakeSide {
  played: Array<[string, number]>;
  said: Array<[string, number]>;
  play(anim: string, rate: number): void;
  say(line: string, durationMs: number): void;
}

function fakeSide(): FakeSide {
  const played: Array<[string, number]> = [];
  const said: Array<[string, number]> = [];
  return {
    played,
    said,
    play: (anim, rate) => void played.push([anim, rate]),
    say: (line, durationMs) => void said.push([line, durationMs]),
  };
}

/** 注入给执行器的定时器（测试里用 mock.timers 拨时间） */
const timers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const stepAt = (at: number, who: 0 | 1, over: Partial<Step> = {}): Step => ({ at, who, hp: [10, 10], ...over });

/** 一边演一边核对：各边的记录本 + 擂台推过的值 */
function makeShow(steps: Step[], foe: FakeSide | null = fakeSide()) {
  const self = fakeSide();
  const arena: number[] = [];
  const sides: ShowSides = { self, foe, arena: (pair) => void arena.push(pair[0]) };
  return { self, foe, arena, show: new BattleShow(steps, sides, timers) };
}

test('执行器：按 at 依次播，台词按 LINE_MS 显示，最后一步放完才 resolve', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, foe, arena, show } = makeShow([
    stepAt(0, 0, { anim: '战斗-起手', rate: 1.5 }),
    stepAt(0, 1, { line: '起手' }),
    stepAt(SLOT_MS, 0, { line: '一拳', hp: [10, 3] }),
  ]);
  let settled = false;
  const done = show.run();
  void done.then(() => (settled = true));

  t.mock.timers.tick(0);
  assert.deepEqual(self.played, [['战斗-起手', 1.5]]);
  assert.deepEqual(foe?.said, [['起手', LINE_MS]]);

  t.mock.timers.tick(SLOT_MS);
  assert.deepEqual(self.said, [['一拳', LINE_MS]]);
  assert.deepEqual(arena, [10, 10, 10]);
  assert.equal(settled, false, '台词还在显示，不算演完');

  t.mock.timers.tick(LINE_MS);
  await done;
  assert.equal(settled, true);
});

test('没有对手窗口（X4 渡劫）：对手那几步只是没画面，气血条照更新，不报错', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, arena, show } = makeShow(
    [stepAt(0, 0, { line: '第一道雷' }), stepAt(100, 1, { anim: '战斗-受击' }), stepAt(200, 0, { line: '第二道雷' })],
    null,
  );
  const done = show.run();
  t.mock.timers.tick(10_000);
  await done;
  assert.deepEqual(
    self.said.map(([line]) => line),
    ['第一道雷', '第二道雷'],
  );
  assert.deepEqual(arena, [10, 10, 10], '三步都刷了擂台');
});

test('快进：剩下的步骤不播，直接到结果（收场几步 + 最终气血），run 立即结束', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, foe, arena, show } = makeShow([
    stepAt(0, 0, { anim: '战斗-起手' }),
    stepAt(SLOT_MS, 0, { line: '打你' }),
    stepAt(6_000, 0, { anim: '战斗-胜利', hp: [50, 0], closing: true }),
    stepAt(6_000, 1, { line: '我赢了', hp: [50, 0], closing: true }),
  ]);
  let settled = false;
  const done = show.run();
  void done.then(() => (settled = true));
  t.mock.timers.tick(SLOT_MS);
  assert.deepEqual(self.said, [['打你', LINE_MS]]);
  show.skip();
  await done;
  assert.equal(settled, true);
  assert.deepEqual(self.played, [
    ['战斗-起手', 1],
    ['战斗-胜利', 1],
  ]);
  assert.deepEqual(foe?.said, [['我赢了', LINE_MS]]);
  assert.deepEqual(arena, [10, 10, 50, 50]);
  show.skip();
  assert.equal(self.played.length, 2, '已经收场，再快进不重复播');
});

test('快进时时间线没有收场那几步：至少把气血条推到最终值', async () => {
  const { arena, show } = makeShow([stepAt(0, 0, { anim: '战斗-起手', hp: [7, 3] })]);
  const done = show.run();
  show.skip();
  await done;
  assert.deepEqual(arena, [7]);
});

test('dispose：挂着的步骤一步都不再播，run 立即结束', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, arena, show } = makeShow([stepAt(0, 0, { anim: '战斗-起手' }), stepAt(5_000, 0, { line: '后话' })]);
  const done = show.run();
  t.mock.timers.tick(0);
  show.dispose();
  await done;
  t.mock.timers.tick(60_000);
  assert.deepEqual(self.played, [['战斗-起手', 1]], 'dispose 之前那一步照播');
  assert.deepEqual(self.said, [], '后面的不播');
  assert.deepEqual(arena, [10]);
});

test('空时间线：run 直接结束（引擎没给事件也不能卡住调用方）', async () => {
  const { show, self } = makeShow([]);
  await show.run();
  assert.deepEqual(self.played, []);
});

test('真引擎的若干场：素材名都对得上包内素材、倍速都在 /anim 允许区间、整场不拖沓', () => {
  // 素材名是拼出来的（法宝-<名> / 招式-<名>），拼错就是「那一下没动画」——这里逐个核到文件；
  // 倍速越界宿主直接回 bad-request，同样等于没动画。
  const assets = new Set(
    readdirSync(join(packageRoot, 'assets', 'webm'))
      .filter((file) => file.endsWith('.webm'))
      .map((file) => file.slice(0, -'.webm'.length)),
  );
  // 境界扫到顶： fighterAt 一路攒下被动招式，高境界那几只才带得出泡泡护体 / 灵兽助阵 / 第六感 / 无影手
  const newAnims = [
    SKILLS.bubble.anim,
    SKILLS['spirit-beast'].anim,
    SKILLS['sixth-sense'].anim,
    SKILLS['shadow-fists'].anim,
  ];
  const played = new Set<string>();
  for (let stage = 0; stage <= MAX_STAGE; stage += 1) {
    const you = fighterAt(stage, seq(stage));
    const foe = shadowOf(you);
    for (const events of [
      fight(you, foe, `sweep-${stage}`, [unarmed, unarmed]),
      tribulate(you, 3, stage, `tribulate-${stage}`),
    ]) {
      const steps = timeline(events, [you.name, foe.name], seq(), [you.skills, foe.skills]);
      for (const step of steps) {
        if (step.anim) {
          assert.ok(assets.has(step.anim), `素材不存在：${step.anim}`);
          played.add(step.anim);
        }
        if (step.rate !== undefined) assert.ok(step.rate >= 0.5 && step.rate <= 3, `倍速越界：${step.rate}`);
      }
      assert.ok(steps[steps.length - 1].at < 90_000, `整场不超过 90 秒：${steps[steps.length - 1].at / 1000}`);
    }
  }
  // 这四段是这次新接的：没演到就是扫描白跑（招式攒不满、映射没生效都算）
  for (const anim of newAnims) assert.ok(played.has(anim), `这批扫描没演到 ${anim}`);
});
