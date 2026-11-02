/**
 * X27 群架联机的接线测试：右键菜单只留一项「加入邻居…」，点开弹窗列出**全部**邻居
 * （菜单每个 owner 只有 20 项，逐家列会挤掉串门 / 切磋 / 修炼）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import {
  cultivationEarly,
  freeUdpPort,
  hostedApp,
  until,
  visitConfig,
  windows,
  withFeatures,
} from './features-testkit.ts';
import { encodeBeacon } from './visit.ts';
import { generateVisitIdentity } from './visit-identity.ts';

test('X27 群架：菜单只占一项「加入邻居…」，弹窗列出全部邻居（不限 2 家）', async () => {
  windows.length = 0;
  const clicks: string[] = [];
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  // 三家邻居：旧口径只列最近两家，第三家看不到
  const peers = ['甲邻居', '乙邻居', '丙邻居'].map((owner, index) => ({
    owner,
    pet: `桌宠${index + 1}`,
    id: generateVisitIdentity().id,
    port: 4_000 + index,
  }));
  const sendBeacons = (): void => {
    for (const peer of peers) {
      beacon.send(
        encodeBeacon({ id: peer.id, owner: peer.owner, pet: peer.pet, port: peer.port }),
        beaconPort,
        '127.0.0.1',
        () => undefined,
      );
    }
  };
  try {
    await withFeatures(
      {
        config: visitConfig(),
        cultivation: cultivationEarly(),
        clicks,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        const { menus } = extras;
        const timer = setInterval(sendBeacons, 300);
        try {
          await hostedApp(home, extras); // 群架是双向的：接待端口得开着
          await until(
            () => menus.some((labels) => labels.includes('群架/加入邻居…（3 家）')),
            '群架加入邻居菜单项',
            400, // 菜单每 5 秒随 tick 重注册一次，等两拍
          );
          const latest = menus[menus.length - 1] ?? [];
          assert.ok(latest.length <= 20, `菜单不超过宿主上限：${latest.length}`);
          assert.ok(
            !latest.some((label) => label.startsWith('群架/加入 ') && label.endsWith(' 家')),
            '不再逐家占菜单项',
          );

          clicks.push('群架/加入邻居…（3 家）');
          await until(() => features.battle.state()?.title === '加入哪家的群架桌？', '选邻居面板');
          const options = features.battle.state()?.options.map((option) => option.label) ?? [];
          assert.deepEqual(
            [...options].sort(),
            peers.map((peer) => `${peer.owner} 家的 ${peer.pet}`).sort(),
            '三家邻居都在弹窗里',
          );

          // 点第一家：去问它有没有开桌。这里没起真接待，连不上就照实说（面板先收掉，别当成正在打）
          const picked = features.battle.state()?.options[0]?.label ?? '';
          const target = peers.find((peer) => `${peer.owner} 家的 ${peer.pet}` === picked);
          assert.ok(target, '弹窗里选得到这一家');
          assert.ok(features.battle.choose(1), '选了第一家');
          await until(() => said.some((line) => line.startsWith(`${target.pet} 家连不上`)), '连不上就照实说');
          assert.equal(features.battle.state(), null, '面板收掉了');
        } finally {
          clearInterval(timer);
        }
      },
    );
  } finally {
    beacon.close();
  }
});
