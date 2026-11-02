#!/usr/bin/env node
/**
 * battle-log.mjs —— 看战报（`src/app/battle-log.ts` 写出来的那些 JSON）。
 *
 * 战报在 `$DSH_HOME/dsh-pet/battles/`（没设 DSH_HOME 就是系统的应用数据目录）。
 * 每条战报都带：两边的名帖（含中文名）、出招方式、种子、每一手谁出了什么、每手后的气血、结算。
 *
 * 用法：
 *   node scripts/dev/battle-log.mjs                 # 列最近 10 场
 *   node scripts/dev/battle-log.mjs list 30         # 列最近 30 场
 *   node scripts/dev/battle-log.mjs show latest     # 摊开最近一场（一手一行）
 *   node scripts/dev/battle-log.mjs show latest 10  # 只看前 10 手
 *   node scripts/dev/battle-log.mjs show battle-1793591514791-abcd.json
 *   node scripts/dev/battle-log.mjs path            # 只打印战报目录
 *   ... 末尾都可以加 `--dir <目录>` 换一个战报目录
 *
 * 纯 node：不引引擎源码，中文名在战报里已经存好了。要拿种子 + 决策复算整场，
 * 再写脚本 import `src/app/battle.ts` 的 fight()（见 scripts/dev/battle-sim.mjs 的写法）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 系统默认的应用数据目录（和 Electron 的 app.getPath('appData') 同口径） */
function defaultAppData() {
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

/** 桌宠的数据根（`DSH_HOME`；没设就是 `<应用数据>/dsh-pet`，和 src/app/main.ts 的口径一致） */
function appHome() {
  return process.env.DSH_HOME ?? join(defaultAppData(), 'dsh-pet');
}

/** 战报目录：`$DSH_HOME/dsh-pet/battles` */
function defaultDir() {
  return join(appHome(), 'dsh-pet', 'battles');
}

function parseArgs(argv) {
  const args = { command: 'list', count: 10, file: null, dir: defaultDir() };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      args.dir = argv[++i];
      continue;
    }
    rest.push(argv[i]);
  }
  const command = rest.shift() ?? 'list';
  if (command === 'show') {
    args.command = 'show';
    args.file = rest.shift() ?? 'latest';
    if (rest[0] !== undefined) args.count = Number(rest[0]) || 0;
    return args;
  }
  if (command === 'path' || command === 'list') {
    args.command = command;
    if (rest[0] !== undefined) args.count = Number(rest[0]) || 10;
    return args;
  }
  // 不写命令、直接给文件名也当 show
  if (command.endsWith('.json')) {
    args.command = 'show';
    args.file = command;
    return args;
  }
  if (command !== 'list') throw new Error(`不认识的命令：${command}（list / show / path）`);
  return args;
}

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^battle-\d{13}-[a-z0-9]+\.json$/.test(name))
    .sort();
}

function readRecord(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  return record;
}

function stamp(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function list(dir, count) {
  const all = files(dir);
  if (all.length === 0) {
    console.log(`没有战报：${dir}`);
    console.log('（打一场切磋就会写；目录不对可以用 --dir 指定）');
    return;
  }
  for (const name of all.slice(-Math.max(1, count)).reverse()) {
    let record;
    try {
      record = readRecord(join(dir, name));
    } catch {
      console.log(`${name}  ← 读不了（文件坏了？）`);
      continue;
    }
    const me = record.cards[record.local];
    const foe = record.cards[record.local === 0 ? 1 : 0];
    const verdict = record.result.forfeit ? '认输' : record.result.won ? '胜' : '负';
    console.log(
      `${stamp(record.at)}  ${verdict.padEnd(2, ' ')}  ${String(record.mode).padEnd(6, ' ')}  ` +
        `${me.name} vs ${foe.name}（${record.stages[record.local === 0 ? 1 : 0]}）  ${record.turns.length} 手  ${name}`,
    );
  }
  console.log(`\n共 ${all.length} 条，目录 ${dir}`);
}

function show(dir, which, limit) {
  const all = files(dir);
  if (all.length === 0) {
    console.log(`没有战报：${dir}`);
    return;
  }
  const name = which === 'latest' ? all[all.length - 1] : which;
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`找不到战报：${path}`);
  const record = readRecord(path);
  const cards = record.cards;
  const me = cards[record.local];
  const foe = cards[record.local === 0 ? 1 : 0];
  const foeStage = record.stages[record.local === 0 ? 1 : 0];
  const card = (c) =>
    `血 ${c.hp} 灵 ${c.power} 身 ${c.agility} 速 ${c.speed}；法宝 ${c.weapons.join('、') || '无'}；招式 ${c.skills.join('、') || '无'}`;
  console.log(`${stamp(record.at)} · 切磋 · ${record.mode}${record.seed ? ` · 种子 ${record.seed}` : ''}`);
  console.log(`我方 ${me.name}（${record.stages[record.local]}）：${card(me)}`);
  console.log(`对方 ${foe.name}（${foeStage}）：${card(foe)}`);
  console.log(
    `结果：${record.result.won ? '赢' : '输'}${record.result.forfeit ? '（认输）' : ''}，${record.result.reason ?? '—'}`,
  );
  console.log(`文件：${path}\n`);
  const turns = limit > 0 ? record.turns.slice(0, limit) : record.turns;
  for (const turn of turns) {
    const mine = turn.actor === record.local;
    console.log(
      `${String(turn.i).padStart(2)} ${mine ? '→' : '←'} ${turn.by} ${turn.label}${turn.autoRelease ? '（自动释放）' : ''}  血 ${turn.hp[0]}/${turn.hp[1]}`,
    );
  }
  if (turns.length < record.turns.length) console.log(`…还有 ${record.turns.length - turns.length} 手`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === 'path') console.log(args.dir);
else if (args.command === 'list') list(args.dir, args.count);
else show(args.dir, args.file, args.count);
