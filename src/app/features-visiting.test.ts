import { visitConfig, freeUdpPort, withFeatures, until } from './features-testkit.ts';
import { parseBeacon, isProbe } from './visit.ts';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';

test('串门：手动填的邻居收到信标，关掉「允许别人来我家做客」后收到的是探测', async () => {
  const config = visitConfig();
  config.visit.peers = ['127.0.0.1'];
  const peerPort = await freeUdpPort();
  const peer = createSocket('udp4');
  const messages: Buffer[] = [];
  peer.on('message', (raw) => messages.push(Buffer.from(raw)));
  await new Promise<void>((done) => peer.bind(peerPort, '127.0.0.1', done));
  try {
    await withFeatures(
      { config, beacon: { port: await freeUdpPort(), targets: () => [], peerPort } },
      async (_features, _said, _bodies, _home, extras) => {
        // 接待开着：announce() 不是 null，手动邻居的端口上收到的是信标
        await until(() => messages.some((raw) => parseBeacon(raw) !== null), '收到信标', 500);
        assert.ok(
          messages.some((raw) => parseBeacon(raw)?.owner),
          '信标里带着昵称',
        );
        assert.ok(
          messages.every((raw) => !isProbe(raw)),
          '还没关接待，不该发探测',
        );
        // 关掉接待：下一拍 syncVisit 关掉接待端口，之后的发送只剩探测（邻居还在，信标监听不关）
        config.visit.hosting = false;
        await until(() => messages.some((raw) => isProbe(raw)), '收到探测', 750);
        assert.ok(
          extras.logs.some((line) => line.includes('接待关了')),
          '接待确实关了',
        );
      },
    );
  } finally {
    peer.close();
  }
});

// ---------- 隔空切磋（X15） ----------
