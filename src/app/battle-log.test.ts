import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoController,
  fight,
  rngFrom,
  SPAR_DAMAGE_SCALE,
  SPAR_MAX_HIT_SHARE,
  type BattleEvent,
  type Fighter,
} from './battle.ts';
import { BATTLE_LOG_LIMIT, battleLogOf, formatBattleLog, pruneBattleLogs, writeBattleLog } from './battle-log.ts';
import type { BattleLogInput } from './battle-log.ts';
import { fighterAt, seededRng } from './battle-testkit.ts';

const OPTIONS = { damageScale: SPAR_DAMAGE_SCALE, maxHitShare: SPAR_MAX_HIT_SHARE };

/** 打一场固定的切磋（双方都自动挑法），返回事件流 */
function fightOnce(seed = 'battle-log'): BattleEvent[] {
  const a = { ...fighterAt(10, seededRng(1)), name: '小黑' };
  const b = { ...fighterAt(10, seededRng(2)), name: '张小宝' };
  return fight(a, b, seed, [autoController(rngFrom(seed + ':a')), autoController(rngFrom(seed + ':b'))], OPTIONS);
}

const pair = (): [Fighter, Fighter] => [
  { ...fighterAt(10, seededRng(1)), name: '小黑' },
  { ...fighterAt(10, seededRng(2)), name: '张小宝' },
];

function input(over: Partial<BattleLogInput> = {}): BattleLogInput {
  return {
    at: 1_793_591_514_791,
    kind: 'spar',
    mode: 'guide',
    seed: 'guest:host',
    local: 0,
    stages: ['筑基中期', '筑基初期'],
    fighters: pair(),
    options: OPTIONS,
    events: fightOnce(),
    ...over,
  };
}

test('battleLogOf：逐手决策对上 decide 事件，结算按本地视角算输赢', () => {
  const record = battleLogOf(input());
  const decisions = input().events.filter((event) => event.kind === 'decide');
  assert.equal(record.turns.length, decisions.length, '一手一条');
  assert.deepEqual(
    record.turns.map((turn) => turn.action),
    decisions.map((event) => (event.kind === 'decide' ? event.action : null)),
    '动作原样保留（复算用）',
  );
  assert.ok(
    record.turns.every((turn) => turn.label.length > 0),
    '每一手都有中文名',
  );
  assert.ok(
    record.turns.every((turn) => turn.i >= 1 && turn.hp.length === 2),
    '序号与气血都在',
  );
  const events = input().events;
  const end = events[events.length - 1];
  const winner = end?.kind === 'end' ? end.winner : null;
  assert.equal(record.result.winner, winner);
  assert.equal(record.result.won, winner === 0, '本地是 0 号：0 号赢才算赢');
  // 名帖摘要换成中文名（不是 id）
  assert.equal(record.cards[0].name, record.fighters[0].name);
  assert.equal(record.cards[0].skills.length, record.fighters[0].skills.length);
  assert.ok(
    record.cards[0].skills.every((name) => !name.includes('-')),
    '招式名不是 id',
  );
});

test('battleLogOf：换成本地 1 号时输赢跟着换边', () => {
  const events = fightOnce('local-one');
  const zeroView = battleLogOf(input({ events, local: 0 }));
  const oneView = battleLogOf(input({ events, local: 1 }));
  assert.equal(oneView.result.won, !zeroView.result.won, '同一场从两边看输赢相反');
});

test('battleLogOf：认输那一场按 forfeit 记', () => {
  const events = fightOnce('forfeit');
  const last = events[events.length - 1];
  const patched: BattleEvent[] = [
    ...events.slice(0, -1),
    { actor: 0, kind: 'end', winner: 1, reason: 'forfeit', hp: last?.hp ?? [1, 1] },
  ];
  const record = battleLogOf(input({ events: patched, mode: 'manual' }));
  assert.equal(record.result.forfeit, true);
  assert.equal(record.result.reason, 'forfeit');
  assert.equal(record.result.won, false, '认输记负');
});

test('writeBattleLog：落盘可读，超出上限只留最新的几份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-battle-log-'));
  try {
    for (let i = 0; i < 5; i++) {
      const record = battleLogOf(input({ at: 1_793_591_500_000 + i }));
      writeBattleLog(dir, record, 3);
    }
    const names = readdirSync(dir).filter((name) => name.startsWith('battle-'));
    assert.equal(names.length, 3, `只留 3 份，实际 ${names.length}`);
    assert.deepEqual(names.slice().sort(), names.slice().sort().slice(-3), '留下的是时间戳最大的三份');
    const first = JSON.parse(readFileSync(join(dir, names.slice().sort()[0]), 'utf8')) as { turns: unknown[] };
    assert.ok(first.turns.length > 0, '存下来的战报能读回来');
    // 手滑写进去的杂物不该被清掉 / 也不该算进上限
    writeFileSync(join(dir, 'notes.txt'), 'hello', 'utf8');
    pruneBattleLogs(dir, 1);
    assert.ok(existsSync(join(dir, 'notes.txt')), '只清 battle-*.json，别动别的文件');
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('battle-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatBattleLog：摊开时能看到双方名帖、每一手和结果', () => {
  const record = battleLogOf(input());
  const text = formatBattleLog(record);
  assert.match(text, /切磋 · guide · 种子 guest:host/);
  assert.ok(text.includes(record.cards[0].name) && text.includes(record.cards[1].name), '两边名字都在');
  assert.match(text, /结果：(赢|输)/);
  assert.equal(text.split('\n').filter((line) => /^\s*\d+ [→←]/.test(line)).length, record.turns.length, '每一手一行');
  // 限制手数时给出「还有 N 手」
  const head = formatBattleLog(record, 1);
  assert.match(head, /…还有 \d+ 手/);
  assert.ok(BATTLE_LOG_LIMIT >= 10, '默认上限至少留 10 场，方便事后翻');
});
