/**
 * 逐手对传（X19）的驱动测试：两边按同一串出手算出同一串事件；对面不合法的招、等超时都按掉线。
 * 协议层（/v1/spar/turn、/v1/duel/turn）在 visit.test.ts；features 接线在 features-spar-live.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalChoices, startLiveClient, startLiveServer, toneOf } from './battle-live.ts';
import type { LiveVersus } from './battle-live.ts';
import { fight, rngFrom } from './battle.ts';
import type { BattleView, Controller, Fighter } from './battle.ts';
import type { ShowSides } from './battle-show.ts';

const a: Fighter = {
  name: '甲',
  hp: 60,
  power: 6,
  agility: 6,
  speed: 5,
  weapons: ['water-gun'],
  skills: ['dove'],
};
const b: Fighter = {
  name: '乙',
  hp: 58,
  power: 5,
  agility: 5,
  speed: 6,
  weapons: ['poker'],
  skills: [],
};
const seed = 'a'.repeat(64) + ':' + 'b'.repeat(64);

/** 不真开窗口的一套演出出口（测试里 skip 掉，只跑协议和决策） */
const silent: ShowSides = {
  self: { play: () => undefined, say: () => undefined },
  foe: { play: () => undefined, say: () => undefined },
  arena: () => undefined,
  shoot: () => undefined,
};

const noop = (): void => undefined;
const logs: string[] = [];

/** 同一个种子的解说随机数（两边各拿一颗，序列相同） */
const lineRng = (): (() => number) => {
  const rng = rngFrom(seed + ':lines');
  return rng;
};

function serve(waitMs = 2_000): LiveVersus {
  return startLiveServer({
    a,
    b,
    seed,
    local: 0,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: (message) => logs.push(message),
    waitMs,
  });
}

function clientWith(server: LiveVersus, waitMs = 2_000): LiveVersus {
  return startLiveClient({
    a,
    b,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: (message) => logs.push(message),
    waitMs,
    sendTurn: async (body) => server.turn(body.index, body.action),
  });
}

test('X19 逐手对传：两边按同一串出手，算出同一串事件', async () => {
  logs.length = 0;
  const server = serve();
  const client = clientWith(server);
  client.skip();
  server.skip();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents, '发起方打完了');
  assert.ok(serverEvents, '应战方打完了');
  assert.deepEqual(clientEvents, serverEvents, '两边的事件逐条相同');
  assert.ok(
    clientEvents.some((event) => event.kind === 'decide'),
    '逐手局每一手都记 decide',
  );
});

test('X16 逐手对传：farewell 开关传到底，两边按同一串出手算出同一场（含送走）', async () => {
  const fa: Fighter = {
    name: '甲',
    hp: 9_999,
    power: 6,
    agility: 0,
    speed: 50,
    weapons: [],
    skills: ['farewell-wind'],
  };
  const fb: Fighter = { name: '乙', hp: 9_999, power: 5, agility: 0, speed: 1, weapons: [], skills: [] };
  const pick: Controller = {
    decide: (view) =>
      view.you.skills.includes('farewell-wind') && !view.you.used.includes('farewell-wind')
        ? { kind: 'skill', skill: 'farewell-wind' }
        : { kind: 'unarmed' },
  };
  let chosen: { seed: string; events: ReturnType<typeof fight> } | null = null;
  for (let i = 0; i < 60 && chosen === null; i++) {
    const trial = `farewell-live-${i}`;
    const events = fight(fa, fb, trial, [pick, pick], { farewell: true });
    const end = events[events.length - 1];
    if (end.kind === 'end' && end.reason === 'farewell') chosen = { seed: trial, events };
  }
  assert.ok(chosen, '该有一个种子在逐手局里送走');
  const server = startLiveServer({
    a: fa,
    b: fb,
    seed: chosen!.seed,
    local: 0,
    show: silent,
    lineRng: rngFrom(chosen!.seed + ':lines'),
    farewell: true,
    decide: async (view) => ({ action: pick.decide(view) }),
    think: noop,
    log: noop,
    waitMs: 2_000,
  });
  const client = startLiveClient({
    a: fa,
    b: fb,
    seed: chosen!.seed,
    local: 1,
    show: silent,
    lineRng: rngFrom(chosen!.seed + ':lines'),
    farewell: true,
    decide: async (view) => ({ action: pick.decide(view) }),
    think: noop,
    log: noop,
    waitMs: 2_000,
    sendTurn: async (body) => server.turn(body.index, body.action),
  });
  client.skip();
  server.skip();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents && serverEvents);
  assert.deepEqual(clientEvents, chosen!.events, '逐手局和整场（同一个 farewell 开关）算出同一串');
  assert.deepEqual(serverEvents, chosen!.events);
  const end = clientEvents[clientEvents.length - 1];
  assert.equal(end.kind === 'end' && end.reason, 'farewell');
});

test('X19 逐手对传：对面出了不合法的招按掉线，不替它编招', async () => {
  const server = serve();
  const reply = await server.turn(0, { kind: 'skill', skill: 'dove' });
  assert.deepEqual(reply, { ok: false, reason: 'illegal' });
  assert.equal(await server.done, null, '这一场按掉线收，不算打完');
});

test('X19 逐手对传：等对面出手超时按掉线', async () => {
  const server = serve(20);
  assert.equal(await server.done, null);
});

test('X19 逐手对传：收到对面不合法的招 / 等不到对面都按掉线', async () => {
  const bad = startLiveClient({
    a,
    b,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: noop,
    waitMs: 2_000,
    sendTurn: async (body) => (body.action ? { ok: true } : { ok: true, action: { kind: 'skill', skill: 'dove' } }),
  });
  bad.skip();
  assert.equal(await bad.done, null, '不合法的招按掉线');

  const late = startLiveClient({
    a,
    b,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: noop,
    waitMs: 20,
    sendTurn: () => new Promise(() => undefined),
  });
  late.skip();
  assert.equal(await late.done, null, '等超时按掉线');
});

test('X17 出招分类：控制、回复保命与伤害按动作效果归类', () => {
  const cases = [
    [{ kind: 'weapon', weapon: 'snowball' }, 'control'],
    [{ kind: 'weapon', weapon: 'duster' }, 'control'],
    [{ kind: 'skill', skill: 'lion-roar' }, 'control'],
    [{ kind: 'skill', skill: 'ink' }, 'control'],
    [{ kind: 'skill', skill: 'whale-gulp' }, 'sustain'],
    [{ kind: 'skill', skill: 'bloom' }, 'sustain'],
    [{ kind: 'skill', skill: 'myriad-self' }, 'sustain'],
    [{ kind: 'skill', skill: 'finger-sword' }, 'damage'],
    [{ kind: 'skill', skill: 'dragon-palm' }, 'damage'],
    [{ kind: 'weapon', weapon: 'water-gun' }, 'damage'],
    [{ kind: 'unarmed' }, 'damage'],
  ] as const;
  for (const [action, tone] of cases) assert.equal(toneOf(action), tone);
});

test('X17 出招分类：legalChoices 带上 tone，pick 与动作顺序不变', () => {
  const view: BattleView = {
    self: 0,
    hp: [60, 60],
    maxHp: [60, 60],
    you: {
      weapons: ['snowball', 'duster', 'water-gun'],
      skills: ['lion-roar', 'bloom', 'whale-gulp', 'myriad-self', 'ink', 'finger-sword', 'dragon-palm'],
      used: [],
    },
    foe: { weapons: [], skills: [] },
  };
  const choices = legalChoices(view);
  assert.deepEqual(
    choices.map((choice) => choice.pick),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.deepEqual(
    choices.map((choice) => choice.tone),
    [
      'control',
      'control',
      'damage',
      'damage',
      'control',
      'sustain',
      'sustain',
      'sustain',
      'control',
      'damage',
      'damage',
    ],
  );
});
