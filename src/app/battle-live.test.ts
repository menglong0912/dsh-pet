/**
 * 逐手对传（X19）的驱动测试：两边按同一串出手算出同一串事件；对面不合法的招、等超时都按掉线。
 * 协议层（/v1/spar/turn、/v1/duel/turn）在 visit.test.ts；features 接线在 features-spar-live.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLiveClient, startLiveServer } from './battle-live.ts';
import type { LiveVersus } from './battle-live.ts';
import { rngFrom } from './battle.ts';
import type { Fighter } from './battle.ts';
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
