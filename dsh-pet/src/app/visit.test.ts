import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { request } from 'node:http';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  broadcastAddresses,
  cleanText,
  encodeBeacon,
  isLanAddress,
  knockOn,
  Neighborhood,
  parseBeacon,
  parseEvents,
  PING_MS,
  tripRequest,
  VisitHost,
} from './visit.ts';
import type { Beacon, HostHandlers, Visitor } from './visit.ts';

const me = { owner: '小王', pet: '小鱼' };

test('cleanText drops control and bidi characters, squeezes spaces, and cuts by characters', () => {
  assert.equal(cleanText('  你好\n\t世界\u202e反过来\u0000 ', 60), '你好 世界 反过来');
  assert.equal(cleanText('一二三四五六七八九十十一十二', 12), '一二三四五六七八九十十一');
  assert.equal(cleanText('😀😀😀', 2), '😀😀');
  assert.equal(cleanText(42, 12), '');
  assert.equal(cleanText('\u200b\n', 12), '');
});

test('beacons round-trip, and anything that is not ours or is malformed is ignored', () => {
  const beacon: Beacon = { id: 'abcdef0123456789', owner: '小王\n', pet: '小鱼', port: 51234 };
  assert.deepEqual(parseBeacon(encodeBeacon(beacon)), { ...beacon, owner: '小王' });
  const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
  const base = { app: 'dsh-pet', v: 1, id: 'abcdef0123456789', owner: '小王', pet: '小鱼', port: 51234 };
  assert.equal(parseBeacon(raw({ ...base, app: 'other' })), null);
  assert.equal(parseBeacon(raw({ ...base, v: 2 })), null);
  assert.equal(parseBeacon(raw({ ...base, port: 70000 })), null);
  assert.equal(parseBeacon(raw({ ...base, owner: '\u0000' })), null);
  assert.equal(parseBeacon(raw({ ...base, pet: 'x'.repeat(600) })), null); // 超过一条信标的大小
  assert.equal(parseBeacon(Buffer.from('not json')), null);
  assert.equal(parseBeacon(raw({ ...base, owner: '一二三四五六七八九十十一十二' }))?.owner, '一二三四五六七八九十十一');
  // 名字要拼进右键菜单项：半角「/」会被当成子菜单分隔，换成全角
  assert.equal(parseBeacon(raw({ ...base, owner: '小/王', pet: 'a/b' }))?.pet, 'a／b');
});

test('broadcast addresses: one per LAN interface, skipping loopback, IPv6 and point-to-point tunnels', () => {
  const iface = (address: string, netmask: string, extra: Partial<NetworkInterfaceInfo> = {}) =>
    ({ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null, ...extra }) as NetworkInterfaceInfo;
  assert.deepEqual(
    broadcastAddresses({
      lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
      en0: [
        iface('192.168.1.23', '255.255.255.0'),
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          internal: false,
        } as NetworkInterfaceInfo,
      ],
      en7: [iface('10.0.5.7', '255.255.0.0')],
      bridge0: [iface('192.168.1.40', '255.255.255.0')], // 同一网段：只发一次
      utun4: [iface('100.101.102.103', '255.255.255.255')],
    }),
    ['192.168.1.255', '10.0.255.255'],
  );
});

test('only private, link-local, CGNAT and loopback addresses count as the LAN', () => {
  for (const address of [
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.9',
    '169.254.3.4',
    '100.64.0.1',
    '127.0.0.1',
    '::ffff:192.168.1.2',
    '::1',
  ]) {
    assert.equal(isLanAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', undefined]) {
    assert.equal(isLanAddress(address), false, String(address));
  }
});

test('a neighborhood lists other pets it hears from, ignores itself and junk, forgets the silent ones, and can listen without announcing', async () => {
  let clock = 1_000_000;
  const logs: string[] = [];
  const a: Neighborhood = new Neighborhood({
    id: 'aaaaaaaa-self',
    announce: () => ({ owner: '我', pet: '小蓝', port: 1111 }),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [{ address: '127.0.0.1', port: a.port() }], // 发给自己：要被认出来忽略掉
    now: () => clock,
  });
  await a.start();
  let hosting = true;
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => (hosting ? { owner: '小王', pet: '小鱼', port: 2222 } : null),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [{ address: '127.0.0.1', port: a.port() }],
    now: () => clock,
  });
  const junk = createSocket('udp4');
  try {
    await b.start();
    junk.send('{"app":"dsh-pet"}', a.port(), '127.0.0.1');
    for (let i = 0; i < 100 && a.list().length === 0; i += 1) await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(
      a.list().map(({ id, owner, pet, port, address }) => ({ id, owner, pet, port, address })),
      [{ id: 'bbbbbbbb-other', owner: '小王', pet: '小鱼', port: 2222, address: '127.0.0.1' }],
    );
    assert.equal(a.get('bbbbbbbb-other')?.owner, '小王');
    clock += 21_000;
    assert.deepEqual(a.list(), []);
    assert.equal(a.get('bbbbbbbb-other'), undefined);
    // 不接待客人：只听不发，别人看不到它
    b.stop();
    hosting = false;
    await b.start();
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(a.list(), []);
    assert.deepEqual(logs, []);
  } finally {
    junk.close();
    a.stop();
    b.stop();
  }
});

/** 起一个只听 127.0.0.1 的接待端，handlers 可按测试覆盖；fn 结束后关掉 */
async function withHost(
  overrides: Partial<HostHandlers> & { knockWaitMs?: number; now?: () => number },
  fn: (host: VisitHost, port: number, calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const handlers: HostHandlers = {
    canHost: () => true,
    knocked: (visitor) => calls.push(`knocked ${visitor.owner}/${visitor.pet}@${visitor.address}`),
    knockEnded: (_visitor, reason) => calls.push(`knock-ended ${reason}`),
    line: (visitor, text) => {
      calls.push(`line ${text}`);
      return Promise.resolve(`欢迎\n${visitor.pet}～`);
    },
    left: (_visitor, reason, text) => calls.push(`left ${reason} ${text}`),
    ...overrides,
  };
  const host = new VisitHost(handlers, {
    log: () => undefined,
    knockWaitMs: overrides.knockWaitMs,
    now: overrides.now,
  });
  const port = await host.listen('127.0.0.1');
  try {
    await fn(host, port, calls);
  } finally {
    await host.close();
  }
}

/** 敲门，并在对方「主人」收到敲门后按 accept 答复 */
function knockAndAnswer(host: VisitHost, port: number, accept: boolean) {
  const answering = new Promise<Visitor | null>((resolve) => {
    const wait = () => (host.knocking() ? resolve(host.answer(accept)) : setTimeout(wait, 5));
    wait();
  });
  return Promise.all([knockOn({ address: '127.0.0.1', port }, me), answering]);
}

test('a visit: knock, get let in, chat, then leave; a second knock meanwhile is busy', async () => {
  let clock = 0;
  await withHost({ now: () => clock }, async (host, port, calls) => {
    const target = { address: '127.0.0.1', port };
    const [answer, visitor] = await knockAndAnswer(host, port, true);
    assert.equal(answer.ok, true);
    assert.deepEqual(visitor, { owner: '小王', pet: '小鱼', address: '127.0.0.1' });
    assert.deepEqual(host.guest(), visitor);
    const token = answer.ok ? answer.token : '';

    assert.deepEqual(await knockOn(target, { owner: '小李', pet: '阿花' }), { ok: false, reason: 'busy' });
    assert.deepEqual(await tripRequest(target, '/v1/chat', { token, text: '你好呀\n' }), {
      ok: true,
      reply: '欢迎 小鱼～',
      events: [],
    });
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token }), { ok: true, reply: '', events: [] });
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token: 'f'.repeat(32) }), {
      ok: false,
      reason: 'not-visiting',
    });
    assert.deepEqual(await tripRequest(target, '/v1/leave', { token, text: '拜拜' }), {
      ok: true,
      reply: '',
      events: [],
    });
    assert.equal(host.guest(), null);
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token }), { ok: false, reason: 'not-visiting' });

    // 同一地址 30 秒内不能再敲
    assert.deepEqual(await knockOn(target, me), { ok: false, reason: 'too-soon' });
    clock += 31_000;
    const [again] = await knockAndAnswer(host, port, false);
    assert.deepEqual(again, { ok: false, reason: 'declined' });
    assert.deepEqual(calls, [
      'knocked 小王/小鱼@127.0.0.1',
      'line 你好呀',
      'left leave 拜拜',
      'knocked 小王/小鱼@127.0.0.1',
    ]);
  });
});

test('what the host has to tell the guest rides on the next ping, once, newest kept when too much piles up', async () => {
  await withHost({}, async (host, port) => {
    const target = { address: '127.0.0.1', port };
    assert.equal(host.tell({ type: 'poke' }), false, '没有客人时没人可告诉');
    const [answer] = await knockAndAnswer(host, port, true);
    const token = answer.ok ? answer.token : '';
    assert.equal(host.tell({ type: 'line', text: '你喜欢吃什么？' }), true);
    host.tell({ type: 'poke' });
    host.tell({ type: 'play', what: '吃西瓜' });
    const ping = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(ping.ok && ping.events, [
      { type: 'line', text: '你喜欢吃什么？' },
      { type: 'poke' },
      { type: 'play', what: '吃西瓜' },
    ]);
    const again = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(again.ok && again.events, [], '捎过一次就清掉');
    for (let n = 1; n <= 10; n += 1) host.tell({ type: 'line', text: `第 ${n} 句` });
    const piled = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(piled.ok && piled.events.map((event) => (event.type === 'line' ? event.text : event.type)), [
      '第 3 句',
      '第 4 句',
      '第 5 句',
      '第 6 句',
      '第 7 句',
      '第 8 句',
      '第 9 句',
      '第 10 句',
    ]);
  });
});

test('events from the other side are checked like everything else it sends', () => {
  assert.deepEqual(parseEvents(undefined), [], '旧版本不带 events');
  assert.deepEqual(parseEvents('poke'), []);
  assert.deepEqual(
    parseEvents([
      { type: 'line', text: '你好\u202e呀\n' },
      { type: 'line', text: '' },
      { type: 'poke', extra: 1 },
      { type: 'play', what: '吃西瓜吃西瓜吃西瓜吃西瓜吃西瓜' },
      { type: 'play' },
      { type: 'gift', what: '糖葫芦' },
      { type: 'gift', what: 42 },
      { type: 'dance' },
      null,
      'line',
    ]),
    [
      { type: 'line', text: '你好 呀' },
      { type: 'poke' },
      { type: 'play', what: '吃西瓜吃西瓜吃西瓜吃西瓜' },
      { type: 'gift', what: '糖葫芦' },
    ],
  );
  assert.equal(parseEvents(Array.from({ length: 20 }, () => ({ type: 'poke' }))).length, 8);
});

test('the host can send a guest home, and the guest hears it on its next ping', async () => {
  await withHost({}, async (host, port, calls) => {
    const target = { address: '127.0.0.1', port };
    const [answer] = await knockAndAnswer(host, port, true);
    const token = answer.ok ? answer.token : '';
    assert.equal(host.sendHome()?.pet, '小鱼');
    assert.equal(host.sendHome(), null);
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token }), { ok: false, reason: 'sent-home' });
    assert.deepEqual(await tripRequest(target, '/v1/chat', { token, text: '诶？' }), {
      ok: false,
      reason: 'sent-home',
    });
    // 送走客人不经 left（主人自己点的，调用方自己收尾）
    assert.deepEqual(calls, ['knocked 小王/小鱼@127.0.0.1']);
  });
});

test('nobody answering the door ends the knock; a busy host turns knocks away without asking', async () => {
  await withHost({ knockWaitMs: 50 }, async (host, port, calls) => {
    assert.deepEqual(await knockOn({ address: '127.0.0.1', port }, me), { ok: false, reason: 'no-answer' });
    assert.equal(host.knocking(), null);
    assert.deepEqual(calls, ['knocked 小王/小鱼@127.0.0.1', 'knock-ended no-answer']);
  });
  await withHost({ canHost: () => false }, async (_host, port, calls) => {
    assert.deepEqual(await knockOn({ address: '127.0.0.1', port }, me), { ok: false, reason: 'busy' });
    assert.deepEqual(calls, []);
  });
});

test('a guest that goes quiet is reported lost', async () => {
  let clock = 0;
  // 只接管 setInterval（失联检查是接待端 listen 时起的 setInterval，必须在那之前接管）；
  // 敲门用的 setTimeout 与网络照常走真的
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withHost({ now: () => clock }, async (host, port, calls) => {
      await knockAndAnswer(host, port, true);
      clock += 29_000;
      mock.timers.tick(PING_MS);
      assert.ok(host.guest(), '没到 30 秒还算在');
      clock += 2_000;
      mock.timers.tick(PING_MS);
      assert.equal(host.guest(), null);
      assert.deepEqual(calls, ['knocked 小王/小鱼@127.0.0.1', 'left lost ']);
    });
  } finally {
    mock.timers.reset();
  }
});

/** 直接发一个请求（fetch 不让随便设 Origin），返回状态码与应答 */
function raw(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/knock', method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('requests from web pages, oversized or malformed bodies and nameless knocks are refused', async () => {
  await withHost({}, async (_host, port, calls) => {
    const knock = JSON.stringify(me);
    assert.equal((await raw(port, knock, { origin: 'http://192.168.1.9:8080' })).status, 403);
    // 超过 4 KB：读到一半直接断开连接，不读完
    await assert.rejects(raw(port, 'x'.repeat(5000)));
    assert.equal((await raw(port, '[1]')).status, 400);
    assert.equal((await raw(port, JSON.stringify({ owner: '\u0000', pet: '小鱼' }))).status, 400);
    assert.deepEqual(calls, []);
  });
});
