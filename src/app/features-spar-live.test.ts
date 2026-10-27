/**
 * X19 切磋逐手对传的接线测试：串门切磋、隔空切磋各走一场逐手局，
 * 打完才记账、掉线不记账、窗口全关；全自动的旧用例在 features-spar.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { startLiveClient, startLiveServer } from './battle-live.ts';
import type { LiveVersus } from './battle-live.ts';
import type { BattleEvent, Fighter } from './battle.ts';
import { rngFrom } from './battle.ts';
import type { ShowSides } from './battle-show.ts';
import {
  cultivationEarly,
  cultivationSave,
  emitPetBounds,
  env,
  fightCount,
  freeUdpPort,
  guestCard,
  hostFighter,
  hostedApp,
  neighborRecord,
  pickPanel,
  until,
  visitConfig,
  windowOn,
  windows,
  withFeatures,
} from './features-testkit.ts';
import { generateVisitIdentity } from './visit-identity.ts';
import {
  encodeBeacon,
  sendDuel,
  sendDuelReveal,
  sendDuelTurn,
  sparCardOf,
  sparCommit,
  SPAR_LIVE_MODE,
  VisitHost,
} from './visit.ts';
import type { SparCard } from './visit.ts';

const noop = (): void => undefined;
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 假对面按后备挑法出手用的一套不真开窗口的演出出口 */
const silent: ShowSides = {
  self: { play: noop, say: noop },
  foe: { play: noop, say: noop },
  arena: noop,
  shoot: noop,
};

const fakeFighter: Fighter = {
  // 慢一点的沙包：逐手局的测试里让 app（客人 / 挑战方）先出手，手动面板才等得到
  name: '大个',
  hp: 56,
  power: 1,
  agility: 1,
  speed: 1,
  weapons: ['water-gun'],
  skills: [],
};
const fakeCard = sparCardOf(fakeFighter, 1);
const HOST_NONCE = 'b'.repeat(64);

/** 假对面（串门切磋）：按后备挑法应战，逐手局的每一手经 sparTurn 递进来 */
async function fakeLiveSparHost(): Promise<{
  host: VisitHost;
  id: string;
  port: number;
  liveSeen: () => boolean;
  turns: () => number;
  done: () => BattleEvent[] | null;
}> {
  let live = false;
  let turnCalls = 0;
  let server: LiveVersus | null = null;
  let events: BattleEvent[] | null = null;
  const identity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => host.answer(true), 30),
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async (_visitor, _card, _commit, isLive) => {
        live = isLive === true;
        return { ok: true, card: fakeCard, nonce: HOST_NONCE };
      },
      reveal: async (_visitor, nonce) => {
        server = startLiveServer({
          a: fakeFighter,
          b: { ...hostFighter, name: '客人的宠物' },
          seed: `${nonce}:${HOST_NONCE}`,
          local: 0,
          show: silent,
          lineRng: rngFrom(`${nonce}:${HOST_NONCE}:lines`),
          decide: async () => null,
          think: noop,
          log: noop,
          waitMs: 5_000,
        });
        server.skip();
        void server.done.then((result) => (events = result));
        return { ok: true };
      },
      sparTurn: async (_visitor, index, action) => {
        turnCalls += 1;
        // 每一手故意慢一点：测试好在「打完了吗」之前检查还没记账
        await delay(15);
        return server ? server.turn(index, action) : { ok: false, reason: 'not-visiting' as const };
      },
      duel: async () => ({ ok: false, reason: 'off' as const }),
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity },
  );
  const port = await host.listen('127.0.0.1');
  return { host, id: identity.id, port, liveSeen: () => live, turns: () => turnCalls, done: () => events };
}

/** 假对面（隔空切磋）：签名验过后按后备挑法应战，逐手局的每一手经 duelTurn 递进来 */
async function fakeLiveDuelHost(): Promise<{
  host: VisitHost;
  id: string;
  port: number;
  liveSeen: () => boolean;
  done: () => BattleEvent[] | null;
}> {
  let live = false;
  let server: LiveVersus | null = null;
  let events: BattleEvent[] | null = null;
  const identity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: noop,
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'off' as const }),
      reveal: async () => ({ ok: false, reason: 'late' as const }),
      duel: async (_visitor, _card, _commit, isLive) => {
        live = isLive === true;
        return { ok: true, card: fakeCard, nonce: HOST_NONCE };
      },
      duelReveal: (_visitor, nonce) => {
        server = startLiveServer({
          a: fakeFighter,
          b: { ...hostFighter, name: '客人的宠物' },
          seed: `${nonce}:${HOST_NONCE}`,
          local: 0,
          show: silent,
          lineRng: rngFrom(`${nonce}:${HOST_NONCE}:lines`),
          decide: async () => null,
          think: noop,
          log: noop,
          waitMs: 5_000,
        });
        server.skip();
        void server.done.then((result) => (events = result));
      },
      duelTurn: async (_visitor, index, action) =>
        server ? server.turn(index, action) : { ok: false, reason: 'not-visiting' as const },
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity },
  );
  const port = await host.listen('127.0.0.1');
  return { host, id: identity.id, port, liveSeen: () => live, done: () => events };
}

test('X19 串门切磋逐手局（客人）：AI / 手动各打一场，打完才记账，窗口收干净', async () => {
  for (const pick of [2, 3] as const) {
    const clicks: string[] = [];
    windows.length = 0;
    env.battleCalls = 0;
    env.battleReplies = Array.from({ length: 60 }, () => '{"pick":1}');
    env.battleHold = null;
    const fake = await fakeLiveSparHost();
    const beaconPort = await freeUdpPort();
    const beacon = createSocket('udp4');
    beacon.on('error', () => undefined);
    const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
    const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
    sendBeacon();
    const timer = setInterval(sendBeacon, 300);
    const config = visitConfig();
    config.visit.hosting = false;
    config.visit.visiting = true;
    try {
      await withFeatures(
        {
          config,
          cultivation: cultivationEarly(),
          clicks,
          modeTimeoutMs: 2_000,
          aiTurnTimeoutMs: 500,
          actionTimeoutMs: 2_000,
          turnWaitMs: 2_000,
          beacon: { port: beaconPort, targets: () => [] },
        },
        async (features, said, _bodies, home, extras) => {
          const { menus } = extras;
          emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
          await until(
            () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
            '信标听见了邻居',
            400,
          );
          clicks.push('串门/去 测试邻居 家');
          await until(() => menus.some((labels) => labels.includes('串门/找主人家的宠物切磋')), '切磋项');
          clicks.push('串门/找主人家的宠物切磋');
          await pickPanel(features, pick, `第 ${pick} 种方式`);
          await until(() => fake.liveSeen(), '对面收到了 mode: live');
          // 三扇窗（对手 / 擂台 / 特效层）
          await until(
            () =>
              windowOn('/app/guest') !== undefined &&
              windowOn('/app/arena') !== undefined &&
              windowOn('/app/fx') !== undefined,
            '逐手切磋三扇窗',
            800,
          );
          // 打到一半还没记账
          await until(() => fake.turns() > 0, '对传了一手', 800);
          assert.equal(fightCount(home), 0, '打完之前不记账');
          if (pick === 2) {
            await until(() => env.battleCalls > 0, 'AI 问了一手', 800);
          } else {
            await until(() => features.battle.state()?.kind === 'action', '手动出招面板', 800);
            assert.ok(features.battle.choose(1), '手动点了第一手');
          }
          clicks.push('修炼/快进');
          await until(() => fake.done() !== null, '对面算完了这一场', 400);
          await until(() => fightCount(home) === 1, '打完才记账', 400);
          const events = fake.done()!;
          const end = events[events.length - 1]!;
          const won = end.kind === 'end' && end.winner === 1;
          const record = cultivationSave(home)!.record as { wins: number; losses: number };
          assert.equal(won ? record.wins : record.losses, 1, '输赢跟对面算的那场一致');
          assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
          await until(
            () =>
              (windowOn('/app/guest')?.destroyed ?? false) &&
              (windowOn('/app/arena')?.destroyed ?? false) &&
              (windowOn('/app/fx')?.destroyed ?? false),
            '收摊窗口全关',
            800,
          );
        },
      );
    } finally {
      clearInterval(timer);
      beacon.close();
      await fake.host.close();
      env.battleReplies = [];
      env.battleHold = null;
    }
  }
});

test('X19 串门切磋逐手局：对面不再回手，按掉线收，不记账、窗口全关', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const fake = await fakeLiveSparHost();
  // 这一场对面故意不回：把 sparTurn 换成永不返回
  const droppingIdentity = generateVisitIdentity();
  const dropping = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => dropping.answer(true), 30),
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: true, card: fakeCard, nonce: HOST_NONCE }),
      reveal: async () => ({ ok: true }),
      sparTurn: () => new Promise(() => undefined),
      duel: async () => ({ ok: false, reason: 'off' as const }),
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity: droppingIdentity },
  );
  const port = await dropping.listen('127.0.0.1');
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: droppingIdentity.id, owner: '测试邻居', pet: '大个', port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        clicks,
        modeTimeoutMs: 2_000,
        turnWaitMs: 200,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        const { menus } = extras;
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => menus.some((labels) => labels.includes('串门/找主人家的宠物切磋')), '切磋项');
        clicks.push('串门/找主人家的宠物切磋');
        await pickPanel(features, 2, 'AI 出招');
        // 掉线这一条不关心演出：先快进，等对面那一手超时
        clicks.push('修炼/快进');
        await until(() => said.some((text) => text.includes('切磋断了')), '掉线说了一句', 1_000);
        assert.equal(fightCount(home), 0, '掉线不记账');
        await until(
          () =>
            (windowOn('/app/guest')?.destroyed ?? true) &&
            (windowOn('/app/arena')?.destroyed ?? true) &&
            (windowOn('/app/fx')?.destroyed ?? true),
          '掉线窗口全关',
          800,
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await dropping.close();
    await fake.host.close();
    env.battleReplies = [];
  }
});

test('X19 隔空切磋逐手局（应战方）：自动应战打完才记账，窗口收干净', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const config = visitConfig();
  config.visit.hosting = true;
  await withFeatures(
    {
      config,
      cultivation: cultivationEarly(),
      neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
      clicks,
      modeTimeoutMs: 2_000,
      turnWaitMs: 2_000,
    },
    async (features, said, _bodies, home, extras) => {
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      const { port, hostId } = await hostedApp(home, extras);
      const target = { address: '127.0.0.1', port };
      const asking = sendDuel(target, hostId, { owner: '小李', pet: '阿花' }, challenger, {
        mode: SPAR_LIVE_MODE,
        card: guestCard(),
        commit: sparCommit(ownNonce),
      });
      await until(() => {
        const latest = extras.menus[extras.menus.length - 1] ?? [];
        return latest.includes('修炼/应战：小李 家的 阿花');
      }, '应战菜单');
      clicks.push('修炼/应战：小李 家的 阿花');
      // 应战方在自己的出招面板里选方式（这里选自动）
      await pickPanel(features, 1, '应战方式');
      const reply = await asking;
      assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
      if (!reply.ok) return;
      assert.deepEqual(await sendDuelReveal(target, { token: reply.token, nonce: ownNonce, line: '' }), { ok: true });
      // 挑战方这一侧按后备挑法把逐手局打完；应战方（app）在自己的屏幕上演
      const client = startLiveClient({
        a: cardFighterFor('桌宠', reply.card),
        b: { name: '阿花', hp: 56, power: 5, agility: 5, speed: 5, weapons: ['poker'], skills: ['dove'] },
        seed: `${ownNonce}:${reply.nonce}`,
        local: 1,
        show: silent,
        lineRng: rngFrom(`${ownNonce}:${reply.nonce}:lines`),
        decide: async () => null,
        think: noop,
        log: noop,
        waitMs: 2_000,
        sendTurn: (body, signal) => sendDuelTurn(target, { token: reply.token, ...body }, signal),
      });
      client.skip();
      await until(
        () =>
          windowOn('/app/guest') !== undefined &&
          windowOn('/app/arena') !== undefined &&
          windowOn('/app/fx') !== undefined,
        '应战方三扇窗',
        800,
      );
      await until(() => client.done !== null, '挑战方开着');
      // 让 app 快进把剩下的手演完；账仍然是打完才记
      assert.equal(fightCount(home), 0, '打完之前不记账');
      clicks.push('修炼/快进');
      const events = await client.done;
      assert.ok(events, '这一场打完了');
      await until(() => fightCount(home) === 1, '打完才记账', 800);
      const end = events![events.length - 1]!;
      const won = end.kind === 'end' && end.winner === 0;
      const record = cultivationSave(home)!.record as { wins: number; losses: number };
      assert.equal(won ? record.wins : record.losses, 1, '输赢跟挑战方算的那场一致');
      assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
      await until(
        () =>
          (windowOn('/app/guest')?.destroyed ?? false) &&
          (windowOn('/app/arena')?.destroyed ?? false) &&
          (windowOn('/app/fx')?.destroyed ?? false),
        '应战方收摊全关',
        800,
      );
    },
  );
});

test('X19 隔空切磋逐手局（应战方）：对面一直不传下一手，按掉线收，不记账', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const config = visitConfig();
  config.visit.hosting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
        clicks,
        modeTimeoutMs: 2_000,
        turnWaitMs: 200,
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        const { port, hostId } = await hostedApp(home, extras);
        const asking = sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
          mode: SPAR_LIVE_MODE,
          card: guestCard(),
          commit: sparCommit(ownNonce),
        });
        await until(() => {
          const latest = extras.menus[extras.menus.length - 1] ?? [];
          return latest.includes('修炼/应战：小李 家的 阿花');
        }, '应战菜单');
        clicks.push('修炼/应战：小李 家的 阿花');
        await pickPanel(features, 1, '应战方式');
        const reply = await asking;
        assert.ok(reply.ok);
        if (!reply.ok) return;
        await sendDuelReveal({ address: '127.0.0.1', port }, { token: reply.token, nonce: ownNonce, line: '' });
        // 之后一手都不发：应战方等 200ms 就按掉线
        await until(() => said.some((text) => text.includes('切磋断了')), '掉线说了一句', 1_000);
        assert.equal(fightCount(home), 0, '掉线不记账');
        await until(
          () =>
            (windowOn('/app/guest')?.destroyed ?? false) &&
            (windowOn('/app/arena')?.destroyed ?? false) &&
            (windowOn('/app/fx')?.destroyed ?? false),
          '掉线窗口全关',
          800,
        );
      },
    );
  } finally {
    env.battleReplies = [];
  }
});

test('X19 隔空切磋逐手局（挑战方）：AI 出招，打完才记账，窗口收干净', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  env.battleCalls = 0;
  env.battleReplies = Array.from({ length: 60 }, () => '{"pick":1}');
  env.battleHold = null;
  const fake = await fakeLiveDuelHost();
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(fake.id, '测试邻居', '大个')] },
        clicks,
        modeTimeoutMs: 2_000,
        aiTurnTimeoutMs: 500,
        turnWaitMs: 2_000,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => extras.menus.some((labels) => labels.includes('修炼/切磋/测试邻居 家的 大个')),
          '挑战项',
          400,
        );
        clicks.push('修炼/切磋/测试邻居 家的 大个');
        await pickPanel(features, 2, 'AI 出招');
        await until(() => fake.liveSeen(), '对面收到了 mode: live');
        await until(
          () =>
            windowOn('/app/guest') !== undefined &&
            windowOn('/app/arena') !== undefined &&
            windowOn('/app/fx') !== undefined,
          '挑战方三扇窗',
          800,
        );
        await until(() => env.battleCalls > 0, 'AI 问了一手', 800);
        assert.equal(fightCount(home), 0, '打完之前不记账');
        clicks.push('修炼/快进');
        await until(() => fake.done() !== null, '对面算完了这一场', 800);
        await until(() => fightCount(home) === 1, '打完才记账', 800);
        const events = fake.done()!;
        const end = events[events.length - 1]!;
        const won = end.kind === 'end' && end.winner === 1;
        const record = cultivationSave(home)!.record as { wins: number; losses: number };
        assert.equal(won ? record.wins : record.losses, 1, '输赢跟对面算的那场一致');
        assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
        await until(
          () =>
            (windowOn('/app/guest')?.destroyed ?? false) &&
            (windowOn('/app/arena')?.destroyed ?? false) &&
            (windowOn('/app/fx')?.destroyed ?? false),
          '挑战方收摊全关',
          800,
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await fake.host.close();
    env.battleReplies = [];
    env.battleHold = null;
  }
});

test('X19 旧对端回 unsupported-mode：串门 / 隔空都说「还不会逐手切磋」，不记账', async () => {
  // 串门：假主人家不认 mode: live
  const clicks: string[] = [];
  windows.length = 0;
  const strangerIdentity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => host.answer(true), 30),
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'unsupported-mode' }),
      reveal: async () => ({ ok: false, reason: 'late' }),
      duel: async () => ({ ok: false, reason: 'off' }),
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity: strangerIdentity },
  );
  const port = await host.listen('127.0.0.1');
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: strangerIdentity.id, owner: '测试邻居', pet: '大个', port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        clicks,
        modeTimeoutMs: 2_000,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => extras.menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => extras.menus.some((labels) => labels.includes('串门/找主人家的宠物切磋')), '切磋项');
        clicks.push('串门/找主人家的宠物切磋');
        await pickPanel(features, 2, 'AI 出招');
        await until(() => said.some((text) => text.includes('还不会逐手切磋')), '串门说了还不会逐手', 800);
        assert.equal(fightCount(home), 0, '没打成不记账');
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await host.close();
  }

  // 隔空：假挑战方不应战（旧对端在协议层回 unsupported-mode）
  const duelIdentity = generateVisitIdentity();
  const duelHost = new VisitHost(
    {
      canHost: () => true,
      knocked: noop,
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'off' }),
      reveal: async () => ({ ok: false, reason: 'late' }),
      duel: async () => ({ ok: false, reason: 'unsupported-mode' }) as never,
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity: duelIdentity },
  );
  const duelPort = await duelHost.listen('127.0.0.1');
  const duelClicks: string[] = [];
  windows.length = 0;
  const duelBeaconPort = await freeUdpPort();
  const duelBeacon = createSocket('udp4');
  duelBeacon.on('error', () => undefined);
  const duelPayload = encodeBeacon({ id: duelIdentity.id, owner: '测试邻居', pet: '大个', port: duelPort });
  const send = () => duelBeacon.send(duelPayload, duelBeaconPort, '127.0.0.1', () => undefined);
  send();
  const duelTimer = setInterval(send, 300);
  const duelConfig = visitConfig();
  duelConfig.visit.hosting = false;
  duelConfig.visit.visiting = true;
  try {
    await withFeatures(
      {
        config: duelConfig,
        cultivation: cultivationEarly(),
        clicks: duelClicks,
        modeTimeoutMs: 2_000,
        beacon: { port: duelBeaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        await until(
          () => extras.menus.some((labels) => labels.includes('修炼/切磋/测试邻居 家的 大个')),
          '挑战项',
          400,
        );
        duelClicks.push('修炼/切磋/测试邻居 家的 大个');
        await pickPanel(features, 2, 'AI 出招');
        await until(() => said.some((text) => text.includes('还不会逐手切磋')), '隔空说了还不会逐手', 800);
        assert.equal(fightCount(home), 0, '没打成不记账');
      },
    );
  } finally {
    clearInterval(duelTimer);
    duelBeacon.close();
    await duelHost.close();
  }
});

/** 名片换成 Fighter（测试里只用到名字与战斗档案） */
function cardFighterFor(name: string, card: SparCard): Fighter {
  return {
    name,
    hp: card.hp,
    power: card.power,
    agility: card.agility,
    speed: card.speed,
    weapons: [...card.weapons],
    skills: [...card.skills],
  };
}
