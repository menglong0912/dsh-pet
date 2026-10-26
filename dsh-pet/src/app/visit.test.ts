import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  broadcastAddresses,
  cardFighter,
  cleanText,
  encodeBeacon,
  isLanAddress,
  isSparNonce,
  knockOn,
  Neighborhood,
  parseBeacon,
  parseEvents,
  parseSparCard,
  PING_MS,
  randomSparNonce,
  sendNote,
  sendReveal,
  sendSpar,
  sparCardOf,
  sparCommit,
  sparFight,
  SPAR_MODE,
  tripRequest,
  VisitHost,
} from './visit.ts';
import type { Beacon, HostHandlers, SparCard, Visitor } from './visit.ts';
import { BATTLE_VERSION, SKILL_IDS, WEAPON_IDS } from './battle.ts';
import type { Fighter, WeaponId } from './battle.ts';
import { generateVisitIdentity, knockMessage, welcomeMessage } from './visit-identity.ts';
import type { VisitIdentity } from './visit-identity.ts';

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
  overrides: Partial<HostHandlers> & { knockWaitMs?: number; now?: () => number; identity?: VisitIdentity | null },
  fn: (host: VisitHost, port: number, calls: string[], logs: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const logs: string[] = [];
  const handlers: HostHandlers = {
    canHost: () => true,
    knocked: (visitor) => calls.push(`knocked ${visitor.owner}/${visitor.pet}@${visitor.address}`),
    knockEnded: (_visitor, reason) => calls.push(`knock-ended ${reason}`),
    line: (visitor, text) => {
      calls.push(`line ${text}`);
      return Promise.resolve(`欢迎\n${visitor.pet}～`);
    },
    note: (visitor, text) => {
      calls.push(`note ${visitor.owner}:${text}`);
      return true;
    },
    spar: (visitor, card, commit) => {
      calls.push(`spar ${visitor.pet} stage${card.stage} hp${card.hp} ${commit.slice(0, 8)}`);
      return Promise.resolve({ ok: false, reason: 'off' });
    },
    reveal: (visitor, nonce, line) => {
      calls.push(`reveal ${visitor.pet} ${nonce.slice(0, 8)} ${line}`);
      return Promise.resolve({ ok: false, reason: 'late' });
    },
    left: (_visitor, reason, text) => calls.push(`left ${reason} ${text}`),
    ...overrides,
  };
  const host = new VisitHost(handlers, {
    log: (message) => logs.push(message),
    knockWaitMs: overrides.knockWaitMs,
    now: overrides.now,
    identity: overrides.identity,
  });
  const port = await host.listen('127.0.0.1');
  try {
    await fn(host, port, calls, logs);
  } finally {
    await host.close();
  }
}

/** 等接待端挂上敲门后按 accept 答复，返回那位 */
function answerWhen(host: VisitHost, accept: boolean): Promise<Visitor | null> {
  return new Promise((resolve) => {
    const wait = () => (host.knocking() ? resolve(host.answer(accept)) : setTimeout(wait, 5));
    wait();
  });
}

/** 敲门，并在对方「主人」收到敲门后按 accept 答复 */
function knockAndAnswer(host: VisitHost, port: number, accept: boolean) {
  return Promise.all([knockOn({ address: '127.0.0.1', port }, me), answerWhen(host, accept)]);
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
      { type: 'note', text: '帮我告诉我主人：明天带伞' },
      { type: 'note', text: '\u0000' },
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
      { type: 'note', text: '帮我告诉我主人：明天带伞' },
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

test('notes: a friend’s note gets through (cleaned), strangers, floods and old hosts are told why', async () => {
  let clock = 0;
  let accept = true;
  const notes: string[] = [];
  await withHost(
    {
      now: () => clock,
      note: (visitor, text) => {
        notes.push(`${visitor.owner}:${text}`);
        return accept;
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      // 熟人的收下，超长的按 cleanText 截到 LINE_MAX
      assert.deepEqual(await sendNote(target, { token, text: '告诉我主人：明天带伞' }), { ok: true });
      clock += 10_000;
      assert.deepEqual(await sendNote(target, { token, text: '一'.repeat(80) }), { ok: true });
      assert.deepEqual(notes, ['小王:告诉我主人：明天带伞', `小王:${'一'.repeat(60)}`]);
      assert.deepEqual(await sendNote(target, { token, text: '太快' }), { ok: false, reason: 'too-many' });
      clock += 10_000;
      // 不是熟人（对方没把自己标成熟人）：拒收（先问收不收，才算这条数）
      accept = false;
      assert.deepEqual(await sendNote(target, { token, text: '试试' }), { ok: false, reason: 'not-friend' });
      accept = true;
      for (let n = 2; n <= 4; n += 1) {
        clock += 10_000;
        assert.deepEqual(await sendNote(target, { token, text: `第 ${n} 句` }), { ok: true });
      }
      // 每趟最多 5 条：隔得再久也捎不进第 6 条
      clock += 10_000;
      assert.deepEqual(await sendNote(target, { token, text: '第 6 句' }), { ok: false, reason: 'too-many' });
      // 没进门 / 被请回家：如实带原因回去
      const stranger = 'f'.repeat(32);
      assert.deepEqual(await sendNote(target, { token: stranger, text: '谁？' }), {
        ok: false,
        reason: 'not-visiting',
      });
      host.sendHome();
      assert.deepEqual(await sendNote(target, { token, text: '还在吗' }), { ok: false, reason: 'sent-home' });
    },
  );

  // 旧主人家没有 /v1/note（404 + not-found）：客人这边认得出「对方的版本太旧」
  const old = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = JSON.stringify({ ok: false, reason: 'not-found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
    });
  });
  await new Promise<void>((done) => old.listen(0, '127.0.0.1', done));
  try {
    const port = (old.address() as AddressInfo).port;
    assert.deepEqual(await sendNote({ address: '127.0.0.1', port }, { token: 'ab'.repeat(16), text: '你好' }), {
      ok: false,
      reason: 'old-host',
    });
  } finally {
    old.closeAllConnections();
    await new Promise<void>((done) => old.close(() => done()));
  }
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

// ---------- 敲门签名与应答签名 ----------

/** 手拼一个签过名的敲门请求体（默认按 127.0.0.1、当前时间、要发出去的名字签，配得上的 hostId） */
function signedKnock(
  port: number,
  guest: VisitIdentity,
  host: VisitIdentity,
  tweaks: { id?: string; ts?: number; owner?: string; signOwner?: string; address?: string } = {},
): string {
  const owner = tweaks.owner ?? me.owner;
  const ts = tweaks.ts ?? Date.now();
  const sig = guest.sign(
    knockMessage({
      hostId: host.id,
      address: tweaks.address ?? '127.0.0.1',
      port,
      ts,
      owner: tweaks.signOwner ?? owner,
      pet: me.pet,
    }),
  );
  return JSON.stringify({ owner, pet: me.pet, id: tweaks.id ?? guest.id, pub: guest.pub, ts: String(ts), sig });
}

/** 敲一道签了名的门并放进来，返回进来的那位与应答；任何一步断了抛错 */
async function rawKnockIn(
  host: VisitHost,
  port: number,
  body: string,
): Promise<{ visitor: Visitor | null; answer: unknown }> {
  const answering = answerWhen(host, true);
  const result = await raw(port, body);
  return { visitor: await answering, answer: JSON.parse(result.body) };
}

test('a signed knock checks out; anything off is just a stranger the owner can still let in', async () => {
  const hostIdentity = generateVisitIdentity();
  const guestIdentity = generateVisitIdentity();

  // 四件套都对：客人以自己的身份进门，客人那边也应答验证通过
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const answering = answerWhen(host, true);
    const answer = await knockOn({ address: '127.0.0.1', port }, me, guestIdentity, hostIdentity.id);
    const visitor = await answering;
    assert.equal(answer.ok && answer.verified, true);
    assert.equal(visitor?.id, guestIdentity.id);
    assert.equal(host.guest()?.id, guestIdentity.id);
  });

  // 旧版本：不带签名四件套——当陌生人，照旧能人工让进
  await withHost({ identity: hostIdentity }, async (host, port, _calls, logs) => {
    const { visitor, answer } = await rawKnockIn(host, port, JSON.stringify(me));
    assert.equal((answer as { ok: boolean }).ok, true);
    assert.equal(visitor?.id, undefined);
    assert.equal(host.guest(), visitor);
    assert.ok(
      logs.some((line) => line.includes('当陌生人')),
      '日志里记下原因',
    );
  });

  // id 和公钥对不上
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { id: '0'.repeat(32) }),
    );
    assert.equal(visitor?.id, undefined);
  });

  // 时间戳超过 120 秒（签名也按那个时间签的，骗不过）
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { ts: Date.now() - 200_000 }),
    );
    assert.equal(visitor?.id, undefined);
  });

  // 签名里的地址和本机地址不同（模拟抄来的信标把请求转发给了别家）
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { address: '127.0.0.2' }),
    );
    assert.equal(visitor?.id, undefined);
  });

  // 篡改了 owner：签的是「小王」，发出去的是「小李」
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { owner: '小李', signOwner: '小王' }),
    );
    assert.equal(visitor?.id, undefined);
  });
});

test('the same signed knock cannot be replayed within the window', async () => {
  const hostIdentity = generateVisitIdentity();
  const guestIdentity = generateVisitIdentity();
  const ts = Date.now();
  let clock = ts;
  await withHost({ identity: hostIdentity, now: () => clock }, async (host, port) => {
    const body = signedKnock(port, guestIdentity, hostIdentity, { ts });
    const firstAnswering = answerWhen(host, true);
    const first = JSON.parse((await raw(port, body)).body) as { ok: boolean; token: string };
    assert.equal(first.ok, true);
    assert.equal((await firstAnswering)?.id, guestIdentity.id);
    await tripRequest({ address: '127.0.0.1', port }, '/v1/leave', { token: first.token, text: '' });
    // 过了同地址冷却（30 秒），ts 还在 120 秒窗口里：原样再发一遍
    clock += 31_000;
    const secondAnswering = answerWhen(host, true);
    const second = JSON.parse((await raw(port, body)).body) as { ok: boolean };
    assert.equal(second.ok, true);
    assert.equal((await secondAnswering)?.id, undefined, '重放的当陌生人');
  });
});

test('the guest only trusts a welcome signed for the address it dialed', async () => {
  const hostIdentity = generateVisitIdentity();
  const guestIdentity = generateVisitIdentity();
  // 旧主人家（没身份）：不带应答签名，照常进门，但不算认出这家人
  await withHost({}, async (host, port) => {
    const answering = answerWhen(host, true);
    const answer = await knockOn({ address: '127.0.0.1', port }, me, guestIdentity, hostIdentity.id);
    assert.equal(answer.ok, true);
    assert.equal(answer.verified, false);
    assert.equal((await answering)?.id, undefined);
  });
  // 应答签名里的地址不是自己拨的（真主人家在别处）：不认
  // 应答里 id 冒充熟人（抄来的），pub 和 sig 用自己的钥匙，签名内容、地址都对：也得识破
  const answerWith = (
    make: (token: string, port: number) => { id: string; pub: string; sig: string },
  ): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const port = (server.address() as AddressInfo).port;
        const token = 'ab'.repeat(16);
        const payload = JSON.stringify({ ok: true, token, ...make(token, port) });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length });
        res.end(payload);
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () =>
        resolve({
          port: (server.address() as AddressInfo).port,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        }),
      );
    });
  };
  const cases = [
    // 地址不符
    (token: string) => ({
      id: hostIdentity.id,
      pub: hostIdentity.pub,
      sig: hostIdentity.sign(welcomeMessage({ guestId: guestIdentity.id, address: '127.0.0.2', port: 41234, token })),
    }),
    // 冒充熟人：id 填真主人家的，钥匙用自己的
    (token: string, port: number) => {
      const attacker = generateVisitIdentity();
      return {
        id: hostIdentity.id,
        pub: attacker.pub,
        sig: attacker.sign(welcomeMessage({ guestId: guestIdentity.id, address: '127.0.0.1', port, token })),
      };
    },
  ];
  for (const make of cases) {
    const { port, close } = await answerWith(make);
    try {
      const answer = await knockOn({ address: '127.0.0.1', port }, me, guestIdentity, hostIdentity.id);
      assert.equal(answer.ok, true);
      assert.equal(answer.verified, false);
    } finally {
      await close();
    }
  }
});

// ---------- 切磋（X5） ----------

/** 一份合法的名帖（炼气二层：statCap(1) 是气血 61、其余 7，都有余量） */
const aCard: SparCard = {
  v: BATTLE_VERSION,
  stage: 1,
  hp: 56,
  power: 5,
  agility: 5,
  speed: 5,
  weapons: ['water-gun', 'poker'],
  skills: ['dove'],
};

const aFighter: Fighter = {
  name: '小鱼',
  hp: 80,
  power: 6,
  agility: 6,
  speed: 6,
  weapons: ['water-gun', 'top'],
  skills: ['dove', 'critical'],
};

test('cards: a valid card parses; version mismatches and anything over the codex or statCap is refused', () => {
  assert.deepEqual(parseSparCard(aCard), aCard);
  // 引擎版本不同（含 v 缺失、类型不对）都说「版本」；名帖本身倒是其余不合法都说 bad-card
  assert.equal(parseSparCard({ ...aCard, v: BATTLE_VERSION + 1 }), 'version');
  assert.equal(parseSparCard({ ...aCard, v: '1' }), 'version');
  assert.equal(parseSparCard('名帖'), 'version');
  assert.equal(parseSparCard({ ...aCard, hp: 999 }), null, '数值超过该境界的理论上限');
  assert.equal(parseSparCard({ ...aCard, power: 8 }), null);
  assert.equal(parseSparCard({ ...aCard, hp: 0 }), null);
  assert.equal(parseSparCard({ ...aCard, weapons: [...WEAPON_IDS, 'water-gun'] as WeaponId[] }), null, '法宝超过 8 件');
  assert.equal(parseSparCard({ ...aCard, weapons: ['nunchaku'] }), null, '法宝编号不认识');
  assert.equal(parseSparCard({ ...aCard, skills: [...SKILL_IDS, 'dove'] }), null, '招式超过 10 个');
  assert.equal(parseSparCard({ ...aCard, stage: 99 }), null, '境界出格');
  assert.equal(parseSparCard({ ...aCard, stage: -1 }), null);
  // 名帖与战斗档案互转，数值一件不少
  assert.deepEqual(cardFighter('阿花', sparCardOf(aFighter, 3)), { ...aFighter, name: '阿花' });
});

test('nonces and commits: 32-byte hex in, sha256 hex out', () => {
  const nonce = randomSparNonce();
  assert.ok(isSparNonce(nonce));
  assert.equal(nonce.length, 64);
  assert.equal(sparCommit(nonce), createHash('sha256').update(nonce).digest('hex'));
  assert.ok(!isSparNonce('a'.repeat(63)));
  assert.ok(!isSparNonce('g'.repeat(64)));
  assert.ok(!isSparNonce(nonce.toUpperCase()));
  assert.ok(!isSparNonce(''));
});

test('sparFight: both sides compute the same fight, the host is actor 0, and the seed order is pinned', () => {
  const guest: Fighter = {
    name: '阿花',
    hp: 76,
    power: 6,
    agility: 5,
    speed: 7,
    weapons: ['poker', 'snowball'],
    skills: ['bloom', 'sixth-sense'],
  };
  const guestNonce = 'a'.repeat(64);
  const hostNonce = 'b'.repeat(64);
  const events = sparFight(aFighter, guest, guestNonce, hostNonce);
  // 两边各自调，事件序列逐个相同（§X5 第 5 步）
  assert.deepEqual(sparFight(aFighter, guest, guestNonce, hostNonce), events);
  assert.equal(events[0].kind, 'start');
  assert.equal(events[0].actor, 0, '主人家是 actor 0');
  assert.equal(events[0].hp[0], aFighter.hp);
  // 种子是「客人随机数:主人家随机数」：顺序反了就是另一场
  assert.notDeepEqual(sparFight(aFighter, guest, hostNonce, guestNonce), events);
});

test("a spar challenge goes through with the host's card and nonce, and the reveal gets its line cleaned", async () => {
  await withHost(
    {
      spar: async (visitor, card, commit) => {
        assert.equal(visitor.pet, me.pet);
        assert.deepEqual(card, aCard);
        assert.equal(commit, sparCommit('c'.repeat(64)));
        return { ok: true, card: sparCardOf(aFighter, 4), nonce: 'b'.repeat(64) };
      },
      reveal: async (visitor, nonce, line) => {
        assert.equal(visitor.pet, me.pet);
        // 感言照台词清洗截断（没带的就空）
        assert.equal(line, nonce === 'c'.repeat(64) ? '你好 呀' : '');
        return nonce === 'c'.repeat(64) ? { ok: true } : { ok: false, reason: 'mismatch' };
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      const reply = await sendSpar(target, {
        token,
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(reply.ok);
      assert.equal(reply.ok && reply.nonce, 'b'.repeat(64));
      assert.ok(reply.ok && reply.card.v === BATTLE_VERSION && reply.card.stage === 4);
      // 应答里的名帖与随机数也照对方的规矩验过一遍（坏的要当 bad-card）
      assert.deepEqual(await sendReveal(target, { token, nonce: 'c'.repeat(64), line: '  你好\u202e呀\n' }), {
        ok: true,
      });
      assert.deepEqual(await sendReveal(target, { token, nonce: 'd'.repeat(64), line: '' }), {
        ok: false,
        reason: 'mismatch',
      });
    },
  );
});

test('a spar is refused with the right reason for each kind of wrong before the host is even asked', async () => {
  let asked = 0;
  await withHost(
    {
      spar: async () => {
        asked += 1;
        return { ok: false, reason: 'off' as const };
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      const ask = (body: Record<string, unknown>) =>
        sendSpar(target, { token, mode: SPAR_MODE, card: aCard, commit: sparCommit('c'.repeat(64)), ...body });
      assert.deepEqual(await ask({ mode: 'manual' }), { ok: false, reason: 'unsupported-mode' });
      assert.deepEqual(await ask({ commit: 'nope' }), { ok: false, reason: 'bad-request' });
      assert.deepEqual(await ask({ card: { ...aCard, v: BATTLE_VERSION + 1 } }), { ok: false, reason: 'version' });
      assert.deepEqual(await ask({ card: { ...aCard, hp: 999 } }), { ok: false, reason: 'bad-card' });
      assert.deepEqual(await ask({ card: { ...aCard, weapons: ['nunchaku'] } }), { ok: false, reason: 'bad-card' });
      assert.equal(asked, 0, '不对的请求根本没到 handlers.spar');
      // 到了的：handlers 说什么回什么；客人走了以后如实带 sent-home 回去
      assert.deepEqual(await ask({}), { ok: false, reason: 'off' });
      assert.equal(asked, 1);
      host.sendHome();
      assert.deepEqual(await ask({}), { ok: false, reason: 'sent-home' });
    },
  );
});

test("the guest also checks the host's reply card, nonce and reasons like everything else it sends", async () => {
  const replyWith = async (body: unknown): Promise<Awaited<ReturnType<typeof sendSpar>>> => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const payload = JSON.stringify(body);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as AddressInfo).port;
      return await sendSpar(
        { address: '127.0.0.1', port },
        {
          token: 'ab'.repeat(16),
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('c'.repeat(64)),
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  };
  // 名帖越上限 / 版本不同 / 随机数格式不对：都当 bad-card
  assert.deepEqual(await replyWith({ ok: true, card: { ...aCard, hp: 9_999 }, nonce: 'b'.repeat(64) }), {
    ok: false,
    reason: 'bad-card',
  });
  assert.deepEqual(await replyWith({ ok: true, card: { ...aCard, v: BATTLE_VERSION + 1 }, nonce: 'b'.repeat(64) }), {
    ok: false,
    reason: 'bad-card',
  });
  assert.deepEqual(await replyWith({ ok: true, card: aCard, nonce: '短' }), {
    ok: false,
    reason: 'bad-card',
  });
  // 拒绝的原因原样带回去；没有的路由（旧主人家）如实说 old-host
  assert.deepEqual(await replyWith({ ok: false, reason: 'off' }), { ok: false, reason: 'off' });
  assert.deepEqual(await replyWith({ ok: false, reason: 'not-found' }), { ok: false, reason: 'old-host' });
  assert.deepEqual(await replyWith({ ok: false, reason: '什么鬼' }), { ok: false, reason: 'not-visiting' });

  // 旧主人家没有 /v1/spar 与 /v1/spar/reveal（404 + not-found，同 sendNote 的口径）：两个方向都说「还不会切磋」
  const old = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const payload = JSON.stringify({ ok: false, reason: 'not-found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise<void>((done) => old.listen(0, '127.0.0.1', done));
  try {
    const port = (old.address() as AddressInfo).port;
    const target = { address: '127.0.0.1', port };
    assert.deepEqual(
      await sendSpar(target, {
        token: 'ab'.repeat(16),
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit('c'.repeat(64)),
      }),
      { ok: false, reason: 'old-host' },
    );
    assert.deepEqual(await sendReveal(target, { token: 'ab'.repeat(16), nonce: 'c'.repeat(64), line: '' }), {
      ok: false,
      reason: 'old-host',
    });
  } finally {
    old.closeAllConnections();
    await new Promise<void>((done) => old.close(() => done()));
  }
});

test('a spar invite rides the next ping, and parseEvents keeps it while still dropping unknown kinds', async () => {
  assert.deepEqual(parseEvents([{ type: 'spar-invite' }]), [{ type: 'spar-invite' }]);
  assert.deepEqual(parseEvents([{ type: 'spar-invite' }, { type: 'dance' }, null]), [{ type: 'spar-invite' }]);
  await withHost({}, async (host, port) => {
    const target = { address: '127.0.0.1', port };
    const [answer] = await knockAndAnswer(host, port, true);
    const token = answer.ok ? answer.token : '';
    assert.equal(host.tell({ type: 'spar-invite' }), true);
    const ping = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(ping.ok && ping.events, [{ type: 'spar-invite' }]);
  });
});
