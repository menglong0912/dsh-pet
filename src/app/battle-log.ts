/**
 * 战报（本地存档，只给复盘用）：把一整场切磋的输入、逐手决策和结算事件落成 JSON。
 *
 * 为什么记这个：引擎本身是确定性的（同一颗种子 + 同一串决策 = 同一场），但逐手局的
 * 决策来自面板 / 模型 / 攻略，演完就没了——输了以后想知道「第三手为什么丢了个控制」，
 * 只能靠战报把每一手重新摊开。每条几 KB～几十 KB，只留最近 BATTLE_LOG_LIMIT 场。
 *
 * 目录：`$DSH_HOME/dsh-pet/battles/`（不给就由 `deps.battlesDir` 决定）。
 * 复盘：`node scripts/dev/battle-log.mjs` 列出、`... show latest` 摊开一手一手看。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action, BattleEvent, Fighter } from './battle';
import { MOVES, SKILLS, WEAPONS } from './battle';

/** 一场最多留几条战报（超出按时间删最旧的） */
export const BATTLE_LOG_LIMIT = 50;

/** 一手：谁出的、出了什么、出完双方还剩多少气血 */
export interface BattleLogTurn {
  /** 第几手（按 decide 事件顺序，从 1 开始） */
  i: number;
  /** 引擎里的编号：0 = 被挑战方（主人家 / 应战方），1 = 挑战方（客人 / 隔空挑战方） */
  actor: 0 | 1;
  /** 出招方的名字（摊开看时不用再去 fighters 里对号） */
  by: string;
  action: Action;
  /** 这一手的中文名（招式 / 法宝 / 招式表 / 空手） */
  label: string;
  /** 鲸派气功蓄力后的自动释放：引擎自己补的一手，不算玩家决策 */
  autoRelease?: boolean;
  /** 这一手之后双方气血 */
  hp: [number, number];
}

/** 名帖摘要（战报里顺手存一份带中文名的，复盘工具不用再引引擎表） */
export interface BattleLogCard {
  name: string;
  hp: number;
  power: number;
  agility: number;
  speed: number;
  weapons: string[];
  skills: string[];
}

/** 一场切磋的战报 */
export interface BattleLogRecord {
  version: 1;
  /** 落盘时刻（毫秒） */
  at: number;
  kind: 'spar' | 'trial';
  /** 本地这一侧选的出招方式：auto / ai / manual / guide */
  mode: string;
  /** 这一场的种子（种子 + 决策就能完整复算；早期路径没传时会缺） */
  seed?: string;
  /** 本地是 0 号还是 1 号 */
  local: 0 | 1;
  /** 两边的境界牌子（引擎顺序：0 号在前） */
  stages: [string, string];
  /** 两边名帖（引擎顺序：0 号在前；原始 id，复算用） */
  fighters: [Fighter, Fighter];
  /** 两边名帖的中文摘要（摊开看用） */
  cards: [BattleLogCard, BattleLogCard];
  /** 这一场的引擎选项 */
  options: { farewell?: boolean; damageScale?: number; maxHitShare?: number };
  /** 结算：winner 按引擎编号；won 是本地视角的输赢 */
  result: { winner: 0 | 1 | null; reason?: string; forfeit: boolean; won: boolean };
  turns: BattleLogTurn[];
  /** 完整结算事件（演出时间线就是它排出来的，复盘时能对上每一段） */
  events: BattleEvent[];
}

export interface BattleLogInput {
  at: number;
  kind: 'spar' | 'trial';
  mode: string;
  seed?: string;
  local: 0 | 1;
  stages: [string, string];
  fighters: [Fighter, Fighter];
  options?: { farewell?: boolean; damageScale?: number; maxHitShare?: number };
  /** 认输：引擎在认输那条路上不一定补 end 事件（心魔全自动局就没有），由调用方直接标 */
  forfeit?: boolean;
  events: BattleEvent[];
}

/** 出招的中文名（战报里直接用，复盘工具不必再引一张表） */
export function actionLabel(action: Action): string {
  switch (action.kind) {
    case 'skill':
      return SKILLS[action.skill]?.name ?? action.skill;
    case 'weapon':
      return WEAPONS[action.weapon]?.name ?? action.weapon;
    case 'move':
      return MOVES[action.move]?.name ?? action.move;
    default:
      return '空手';
  }
}

/** 名帖摘要：把 id 换成中文名（战报直接可读） */
function cardOf(f: Fighter): BattleLogCard {
  return {
    name: f.name,
    hp: f.hp,
    power: f.power,
    agility: f.agility,
    speed: f.speed,
    weapons: f.weapons.map((id) => WEAPONS[id]?.name ?? id),
    skills: f.skills.map((id) => SKILLS[id]?.name ?? id),
  };
}

/** 把一场打完的事件流折成战报：逐手决策 + 结算 */
export function battleLogOf(input: BattleLogInput): BattleLogRecord {
  const [zero, one] = input.fighters;
  const cards: [BattleLogCard, BattleLogCard] = [cardOf(zero), cardOf(one)];
  const turns: BattleLogTurn[] = [];
  for (const event of input.events) {
    if (event.kind !== 'decide') continue;
    turns.push({
      i: turns.length + 1,
      actor: event.actor,
      by: (event.actor === 0 ? zero : one).name,
      action: event.action,
      label: actionLabel(event.action),
      ...(event.autoRelease ? { autoRelease: true } : {}),
      hp: event.hp,
    });
  }
  // 收尾事件一定在最后：倒着找第一条 end（不用 findLast，tsconfig 的 lib 停在 ES2020）
  let end: Extract<BattleEvent, { kind: 'end' }> | undefined;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const event = input.events[i];
    if (event.kind === 'end') {
      end = event;
      break;
    }
  }
  const winner = end ? end.winner : null;
  // 认输优先：心魔全自动那条路只停演出，事件流里没有 end（按对方赢、本地负记）
  const forfeit = input.forfeit === true || (end ? end.reason === 'forfeit' : false);
  return {
    version: 1,
    at: input.at,
    kind: input.kind,
    mode: input.mode,
    ...(input.seed ? { seed: input.seed } : {}),
    local: input.local,
    stages: input.stages,
    fighters: input.fighters,
    cards,
    options: input.options ?? {},
    result: forfeit
      ? { winner: input.local === 0 ? 1 : 0, reason: 'forfeit', forfeit: true, won: false }
      : {
          winner,
          ...(end ? { reason: end.reason } : {}),
          forfeit: false,
          won: winner === input.local,
        },
    turns,
    events: input.events,
  };
}

/** 折档 + 落盘一步到位（切磋、心魔都用它；出错抛给调用方按旁路处理） */
export function saveBattleLog(dir: string, input: BattleLogInput, limit = BATTLE_LOG_LIMIT): string {
  return writeBattleLog(dir, battleLogOf(input), limit);
}

/**
 * 落盘一条战报，顺手删掉超出 `limit` 的旧文件。失败直接抛，调用方按「日志没写成」处理
 * （战报是旁路，不能因为它把一场切磋搅黄）。
 * @returns 写出的文件路径
 */
export function writeBattleLog(dir: string, record: BattleLogRecord, limit = BATTLE_LOG_LIMIT): string {
  mkdirSync(dir, { recursive: true });
  const stamp = String(record.at).padStart(13, '0');
  const tie = Math.random().toString(36).slice(2, 6);
  const file = join(dir, `battle-${stamp}-${tie}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  pruneBattleLogs(dir, limit);
  return file;
}

/** 只留最新的 `limit` 份（文件名按 13 位时间戳前缀排，字典序就是时间序） */
export function pruneBattleLogs(dir: string, limit = BATTLE_LOG_LIMIT): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^battle-\d{13}-[a-z0-9]+\.json$/.test(name));
  } catch {
    return [];
  }
  names.sort();
  const removed: string[] = [];
  for (const name of names.slice(0, Math.max(0, names.length - Math.max(0, limit)))) {
    try {
      rmSync(join(dir, name));
      removed.push(name);
    } catch {
      // 删不掉就算了，下次再清
    }
  }
  return removed;
}

/**
 * 摊成人能读的文本：一行一手，最后一行结算。`scripts/dev/battle-log.mjs` 和日志里都用它。
 * @param limit 最多打几手（0 = 全打）
 */
export function formatBattleLog(record: BattleLogRecord, limit = 0): string {
  const me = record.cards[record.local];
  const foe = record.cards[record.local === 0 ? 1 : 0];
  const foeStage = record.stages[record.local === 0 ? 1 : 0];
  const { result } = record;
  const card = (c: BattleLogCard): string =>
    `血 ${c.hp} 灵 ${c.power} 身 ${c.agility} 速 ${c.speed}；法宝 ${c.weapons.join('、') || '无'}；招式 ${c.skills.join('、') || '无'}`;
  const lines: string[] = [
    `${formatTime(record.at)} · 切磋 · ${record.mode}${record.seed ? ` · 种子 ${record.seed}` : ''}`,
    `我方 ${me.name}（${record.stages[record.local]}）：${card(me)}`,
    `对方 ${foe.name}（${foeStage}）：${card(foe)}`,
    `结果：${result.won ? '赢' : '输'}${result.forfeit ? '（认输）' : ''}，${result.reason ?? '—'}`,
  ];
  const turns = limit > 0 ? record.turns.slice(0, limit) : record.turns;
  for (const turn of turns) {
    const mine = turn.actor === record.local;
    lines.push(
      `${String(turn.i).padStart(2)} ${mine ? '→' : '←'} ${turn.by} ${turn.label}${turn.autoRelease ? '（自动释放）' : ''} 血 ${turn.hp[0]}/${turn.hp[1]}`,
    );
  }
  if (turns.length < record.turns.length) lines.push(`…还有 ${record.turns.length - turns.length} 手`);
  return lines.join('\n');
}

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
