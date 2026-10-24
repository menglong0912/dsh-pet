/**
 * dev/visit-peer.mjs —— 假邻居（开发自测工具，不入 npm 包）：没有第二台电脑，也能让真 app 当主人家或当客人来测串门。
 *
 * host  扮演主人家：开一个接待监听，每 2 秒往 127.0.0.1:47340 发一条信标，真 app 开着串门时右键「串门」里
 *       就会出现「去 测试邻居 家」；app 来敲门时按 --accept 处理（auto 1 秒后让进，ask 等标准输入 y / n），
 *       客人说话回一句固定的话，敲门、说话、告辞这些事都打印出来。
 * visit 扮演客人：往真 app 敲门进门（不给 --port 时，从 app.log 最后一条「串门：接待开了，端口 N」里读端口），
 *       进门后每 5 秒报一次平安，收到的事（它家宠物说话、摸一下、一起玩、请吃零食）都打印出来。
 *
 * 用法（参照 dev/mock-server.mjs；strip-types 与 test-register 的说明见 scripts/test-ts-resolver.mjs）：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs host  [--owner 测试邻居] [--pet 小测] [--accept auto|ask] [--identity <路径>|none]
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs visit [--port N] [--host-id <32位十六进制>] [--identity <路径>|none]
 *
 * --identity 给了路径才落盘（脚本与真 app 互相验明正身、日志里看 verified 用）；缺省在内存里生成，不写文件；
 *   --identity none 模拟旧版本，不签名。visit 模式签名需要主人家的 id（来自信标）：脚本连脚本自测时
 *   从 host 模式打印的「身份」里抄过来，用 --host-id 带上；不带 --host-id 就不签名（当旧版本客人）。
 *
 * host 的标准输入命令：line <话> / poke / play <项> / gift <项> / home（请客人回家）；ask 模式下 y / n 答复敲门。
 * visit 的标准输入命令：say <话> / leave（告辞，后面可以带告别的话）。
 * 两种模式 10 分钟后自动退出。
 */
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BEACON_PORT, PING_MS, VisitHost, encodeBeacon, knockOn, tripRequest } from '../../src/app/visit.ts';
import { generateVisitIdentity, loadVisitIdentity } from '../../src/app/visit-identity.ts';

const OWNER_DEFAULT = '测试邻居';
const PET_DEFAULT = '小测';
/** 客人说话时固定回的这一句 */
const REPLY = '欢迎欢迎，随便玩呀～';
const BEACON_MS = 2_000;
const AUTO_EXIT_MS = 10 * 60_000;
/** 真 app 的日志（接待端口从这里读） */
const LOG_PATH = join(homedir(), 'Library', 'Logs', 'dsh-pet', 'app.log');

const print = (message) => console.log(`[visit-peer] ${message}`);
const errorText = (error) => (error instanceof Error ? error.message : String(error));

const USAGE = `用法：
  node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs host  [--owner 测试邻居] [--pet 小测] [--accept auto|ask] [--identity <路径>|none]
  node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs visit [--port N] [--host-id <32位十六进制>] [--identity <路径>|none]`;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'host' && mode !== 'visit') return null;
  const options = { mode, owner: OWNER_DEFAULT, pet: PET_DEFAULT, accept: 'auto', port: 0, hostId: '', identity: '' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--owner' && value) {
      options.owner = value;
      i += 1;
    } else if (flag === '--pet' && value) {
      options.pet = value;
      i += 1;
    } else if (flag === '--accept' && (value === 'auto' || value === 'ask')) {
      options.accept = value;
      i += 1;
    } else if (flag === '--port' && /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 65535) {
      options.port = Number(value);
      i += 1;
    } else if (flag === '--host-id' && /^[0-9a-f]{32}$/.test(value ?? '')) {
      options.hostId = value;
      i += 1;
    } else if (flag === '--identity' && value) {
      options.identity = value;
      i += 1;
    } else {
      return null;
    }
  }
  return options;
}

/** 本脚本的串门身份：--identity none 模拟旧版本（不签名）；给了路径才落盘，不给就在内存里生成一对（不留文件） */
function identityOf(options) {
  if (options.identity === 'none') return null;
  if (options.identity) {
    const identity = loadVisitIdentity(options.identity, (message) => print(`串门：${message}`));
    print(`身份 ${identity.id}（${options.identity}）`);
    return identity;
  }
  const identity = generateVisitIdentity();
  print(`身份 ${identity.id}（内存里，不写文件；要跨进程不变就用 --identity <路径>）`);
  return identity;
}

// ---------- host 模式 ----------

async function runHost(options) {
  const identity = identityOf(options);
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked(visitor) {
        print(
          `${visitor.owner}（${visitor.address}）家的 ${visitor.pet} 来敲门${visitor.id ? `，verified（${visitor.id}）` : '，没验证上（当陌生人）'}`,
        );
        if (options.accept === 'auto') setTimeout(() => host.answer(true), 1_000);
        else print('等标准输入：y 让进 / n 不让进');
      },
      knockEnded(visitor, reason) {
        print(`${visitor.owner} 家的 ${visitor.pet} ${reason === 'gone' ? '不等答复，走了' : '敲门没等到答复'}`);
      },
      async line(visitor, text) {
        print(`${visitor.pet}：${text}`);
        return REPLY;
      },
      left(visitor, reason, text) {
        print(`${visitor.pet} ${reason === 'leave' ? `告辞：${text || '（没说话）'}` : '太久没动静，当它走了'}`);
      },
    },
    { log: (message) => print(message), identity },
  );
  const port = await host.listen('127.0.0.1');
  print(`接待开了，端口 ${port}`);
  print(`信标每 ${BEACON_MS / 1000} 秒发往 127.0.0.1:${BEACON_PORT}（owner=${options.owner}，pet=${options.pet}）`);

  // 信标只发不收：真 app 在 BEACON_PORT 上听；那边没开串门也没关系，UDP 发出去就不管了
  const beacon = createSocket({ type: 'udp4' });
  beacon.on('error', () => {});
  const payload = encodeBeacon({
    id: identity ? identity.id : randomUUID(),
    owner: options.owner,
    pet: options.pet,
    port,
  });
  const sendBeacon = () => beacon.send(payload, BEACON_PORT, '127.0.0.1', () => {});
  sendBeacon();
  setInterval(sendBeacon, BEACON_MS);

  createInterface({ input: process.stdin }).on('line', (raw) => {
    const input = raw.trim();
    const command = input.split(/\s+/)[0];
    const text = input.slice(command.length).trim();
    if (command === 'y' || command === 'n') {
      const visitor = host.answer(command === 'y');
      print(visitor ? (command === 'y' ? `让 ${visitor.pet} 进来了` : `没让 ${visitor.pet} 进来`) : '没有人在敲门');
      return;
    }
    switch (command) {
      case 'line':
        if (!text) {
          print('用法：line <话>');
          return;
        }
        print(host.tell({ type: 'line', text }) ? `捎给客人：${text}` : '没有客人在，捎不出去');
        return;
      case 'poke':
        print(host.tell({ type: 'poke' }) ? '捎给客人：主人摸了它一下' : '没有客人在，捎不出去');
        return;
      case 'play':
      case 'gift': {
        if (!text) {
          print(`用法：${command} <项>`);
          return;
        }
        const sent = host.tell(command === 'play' ? { type: 'play', what: text } : { type: 'gift', what: text });
        print(sent ? `捎给客人：${command === 'play' ? '一起' : '请它吃'}${text}` : '没有客人在，捎不出去');
        return;
      }
      case 'home': {
        const visitor = host.sendHome();
        print(visitor ? `请 ${visitor.pet} 回家了` : '没有客人在');
        return;
      }
      default:
        if (input) {
          print(
            `不认识的命令：${command}（line / poke / play / gift / home${options.accept === 'ask' ? ' / y / n' : ''}）`,
          );
        }
    }
  });
}

// ---------- visit 模式 ----------

/** app.log 最后一条「串门：接待开了，端口 N」里的端口；读不到 null */
function hostPortFromLog() {
  let text;
  try {
    // 只读文件末尾一段：日志会越长越大，接待端口基本都在最近
    const fd = openSync(LOG_PATH, 'r');
    try {
      const { size } = fstatSync(fd);
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const found = [...text.matchAll(/串门：接待开了，端口 (\d+)/g)].at(-1);
  return found ? Number(found[1]) : null;
}

function printEvent(event) {
  if (event.type === 'line') print(`它家宠物说：${event.text}`);
  else if (event.type === 'poke') print('它家主人摸了你一下');
  else if (event.type === 'play') print(`它家请你一起玩：${event.what}`);
  else print(`它家请你吃：${event.what}`);
}

/** 被请回家 / 不被当客人了：都该走了 */
const HOME_REASONS = { 'sent-home': '被请回家了', 'not-visiting': '那边已经不当我是客人了' };

async function runVisit(options) {
  const identity = identityOf(options);
  let port = options.port;
  if (!port) {
    port = hostPortFromLog();
    if (!port) {
      print(`没给 --port，${LOG_PATH} 里也读不到「串门：接待开了，端口 N」`);
      process.exit(1);
    }
    print(`从 app.log 读到接待端口 ${port}`);
  }
  if (identity && !options.hostId) print('没给 --host-id：当旧版本客人，不签名');
  const host = { address: '127.0.0.1', port };
  print(`敲 ${host.address}:${port} 的门（${options.owner} 家的 ${options.pet}）……`);
  const answer = await knockOn(
    host,
    { owner: options.owner, pet: options.pet },
    identity,
    options.hostId || null,
  ).catch((error) => {
    print(`敲门失败：${errorText(error)}`);
    process.exit(1);
  });
  if (!answer.ok) {
    print(`敲门没成：${answer.reason}`);
    process.exit(1);
  }
  const token = answer.token;
  print(
    `进门啦（${answer.verified ? 'verified：主人家的签名对上了' : '没认出主人家（旧对端或签名不对）'}）；say <话> 说话，leave 告辞`,
  );

  // 每 5 秒报一次平安，打印主人家捎来的事；连着 3 次送不到（跟真 app 一样）就当失联，回家
  let pingFailures = 0;
  setInterval(() => {
    void tripRequest(host, '/v1/ping', { token })
      .then((result) => {
        pingFailures = 0;
        if (!result.ok) {
          print(`该回家了：${HOME_REASONS[result.reason] ?? result.reason}`);
          process.exit(0);
        }
        for (const event of result.events) printEvent(event);
      })
      .catch((error) => {
        pingFailures += 1;
        print(`报平安失败（${pingFailures}）：${errorText(error)}`);
        if (pingFailures >= 3) {
          print('和主人家连不上了，回家');
          process.exit(0);
        }
      });
  }, PING_MS);

  createInterface({ input: process.stdin }).on('line', (raw) => {
    const input = raw.trim();
    const command = input.split(/\s+/)[0];
    const text = input.slice(command.length).trim();
    if (command !== 'say' && command !== 'leave') {
      if (input) print(`不认识的命令：${command}（say / leave）`);
      return;
    }
    if (command === 'say' && !text) {
      print('用法：say <话>');
      return;
    }
    void tripRequest(host, command === 'say' ? '/v1/chat' : '/v1/leave', { token, text })
      .then((result) => {
        if (command === 'leave') {
          print(result.ok ? '告辞了' : `告辞没成：${result.reason}`);
          process.exit(0);
          return;
        }
        if (!result.ok) {
          print(`说不了话，${HOME_REASONS[result.reason] ?? result.reason}`);
          process.exit(0);
          return;
        }
        print(`它家宠物回：${result.reply || '……'}`);
        for (const event of result.events) printEvent(event);
      })
      .catch((error) => print(`没送到：${errorText(error)}`));
  });
}

// ---------- 入口 ----------

const options = parseArgs(process.argv.slice(2));
if (!options) {
  console.error(USAGE);
  process.exit(1);
}
process.on('SIGINT', () => process.exit(0));
setTimeout(() => {
  print('10 分钟到了，自动退出');
  process.exit(0);
}, AUTO_EXIT_MS);
try {
  if (options.mode === 'host') await runHost(options);
  else await runVisit(options);
} catch (error) {
  print(`跑不起来：${errorText(error)}`);
  process.exit(1);
}
