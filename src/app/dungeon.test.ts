import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUNGEON_VERSION,
  RUN_TTL_MS,
  TRAVEL_MS,
  advance,
  autoDecide,
  buildFoe,
  buildParty,
  choicesOf,
  completeLiveFight,
  fightSeed,
  expired,
  maxHpOf,
  prepareLiveFight,
  reachableNodes,
  replayFight,
  resolveFight,
  runSchema,
  scriptedController,
  seedOf,
  settle,
  settleByReason,
  startRun,
  typicalStats,
  weaponChoices,
  type DungeonDef,
  type Run,
} from './dungeon.ts';
import { SANWANG } from './dungeon-sanwang.ts';
import { MOVES, fallbackAction, fightUntilDecision } from './battle.ts';
import { fighterAt, seededRng } from './battle-testkit.ts';
import type { Action, BattleEvent, Fighter } from './battle.ts';

const NOW = 0;
const DEF: DungeonDef = SANWANG;

/** 新开一趟（now 固定 0，赶路要走 5 秒） */
function fresh(
  seed = 0,
  options: { suppressed?: boolean; pet?: Fighter; stage?: number } = {},
): {
  pet: Fighter;
  run: Run;
} {
  const pet = options.pet ?? { ...fighterAt(options.stage ?? DEF.originStage, seededRng(seed)), name: '小鱼' };
  const run = startRun(DEF, {
    pet,
    stage: options.stage ?? DEF.originStage,
    suppressed: options.suppressed ?? false,
    nonce: `test-${seed}`,
    now: NOW,
  });
  return { pet, run };
}

/** 一路托管走到底，记下每一步的结局 */
function playOut(
  seed: number,
  stage = DEF.originStage,
): {
  pet: Fighter;
  run: Run;
  kinds: string[];
  last: ReturnType<typeof advance>['outcome'];
} {
  const { pet, run: start } = fresh(seed, { stage });
  let run = start;
  let now = NOW;
  const kinds: string[] = [];
  let last: ReturnType<typeof advance>['outcome'] | undefined;
  for (let i = 0; i < 200 && run.status !== 'over'; i++) {
    if (choicesOf(DEF, run, pet).length === 0) break;
    now = Math.max(now, run.readyAt);
    const step = advance(DEF, run, pet, autoDecide(DEF, run, pet), now);
    run = step.run;
    now += 1;
    kinds.push(step.outcome.result.kind);
    last = step.outcome;
  }
  assert.ok(last, '一趟该走出至少一步');
  return { pet, run, kinds, last };
}

test('Y0 跑图：同一组决定加同一个种子，两次跑出一模一样的一趟', () => {
  const a = playOut(7);
  const b = playOut(7);
  assert.deepEqual(a.run, b.run);
  assert.deepEqual(a.kinds, b.kinds);
  assert.deepEqual(a.last.result, b.last.result);
  // 随机数真的进了账：不同种子该走出不同的路
  assert.notDeepEqual(playOut(8).kinds, a.kinds);
});

test('Y0 跑图：赶路没走完时 advance 拒绝', () => {
  const { pet, run } = fresh(1);
  const node = reachableNodes(DEF, run)[0];
  assert.throws(() => advance(DEF, run, pet, { kind: 'node', node }, NOW + TRAVEL_MS - 1), /赶路还没走完/);
  const ok = advance(DEF, run, pet, { kind: 'node', node }, NOW + TRAVEL_MS);
  assert.equal(ok.outcome.travel, true);
  assert.equal(ok.outcome.readyAt, NOW + TRAVEL_MS * 2);
});

test('Y0 跑图：气血跨场（赢了带着剩下的血走，输了清零）', () => {
  // 找一趟走到第二层小怪、并且打赢的
  for (let seed = 0; seed < 40; seed++) {
    const { pet, run: start } = fresh(seed);
    let run = start;
    let now = NOW;
    let lastFight: { foe: string; won: boolean; hp: [number, number] } | null = null;
    for (let i = 0; i < 60 && run.status === 'running'; i++) {
      now = Math.max(now, run.readyAt);
      const step = advance(DEF, run, pet, autoDecide(DEF, run, pet), now);
      run = step.run;
      now += 1;
      const res = step.outcome.result;
      if (res.kind === 'fight') lastFight = { foe: res.foe, won: res.won, hp: res.hp };
      if (run.layer >= 2 && lastFight?.won) break;
    }
    if (lastFight?.won) {
      assert.equal(run.members[0].hp, lastFight.hp[0], '跨场气血就是打完剩下的');
      return;
    }
  }
  assert.fail('该找到一趟在第二层之前赢过的');
});

test('Y0 跑图：撤退带走已经拿到的，输了不扣东西', () => {
  // 先拿点东西（奇遇/宝箱/打赢都行），再撤退
  for (let seed = 0; seed < 40; seed++) {
    const { pet, run: start } = fresh(seed);
    let run = start;
    let now = NOW;
    for (let i = 0; i < 40 && run.status === 'running'; i++) {
      now = Math.max(now, run.readyAt);
      const step = advance(DEF, run, pet, autoDecide(DEF, run, pet), now);
      run = step.run;
      now += 1;
      const loot = settle(DEF, run, 'retreat');
      if (loot.xp > 0 && run.status === 'running' && run.layer < 5) {
        const back = advance(DEF, run, pet, { kind: 'retreat' }, now);
        assert.equal(back.outcome.result.kind, 'end');
        assert.equal(back.outcome.result.kind === 'end' && back.outcome.result.reason, 'retreat');
        assert.deepEqual(back.outcome.result.kind === 'end' && back.outcome.result.loot, loot);
        return;
      }
    }
  }
  assert.fail('该找到一趟拿到过修为的');
});

test('Y0 跑图：24 小时超时按撤退算', () => {
  const { run } = fresh(3);
  assert.equal(expired(run, NOW + RUN_TTL_MS - 1), false);
  assert.equal(expired(run, NOW + RUN_TTL_MS), true);
  assert.deepEqual(settleByReason(DEF, run, 'expired'), settleByReason(DEF, run, 'retreat'));
  assert.equal(run.status, 'running', 'settleByReason 不该改传进来的状态');
});

test('Y0 跑图：压境时修为 ×1.5、法宝招式被封住', () => {
  const pet = { ...fighterAt(20, seededRng(5)), name: '小鱼' };
  assert.ok(pet.weapons.length > 0 && pet.skills.length > 0, '这个境界该有法宝招式');
  const run = startRun(DEF, { pet, stage: DEF.originStage, suppressed: true, nonce: 'sup', now: NOW });
  const party = buildParty(DEF, run, pet);
  assert.deepEqual(party[0].weapons, []);
  assert.deepEqual(party[0].skills, []);
  assert.deepEqual(weaponChoices(DEF, run, pet), []);
  const normal = startRun(DEF, { pet, stage: DEF.originStage, suppressed: false, nonce: 'sup', now: NOW });
  assert.ok(weaponChoices(DEF, normal, pet).length > 0);
  const total = settle(DEF, run, 'retreat');
  const plain = settle(DEF, normal, 'retreat');
  assert.equal(total.xp, Math.floor(plain.xp * 1.5));
});

test('压境入内：开场气血就是压过的上限，回血也不超过它（真机：显示「136 / 118」）', () => {
  const pet = { ...fighterAt(20, seededRng(5)), name: '小鱼' };
  const cap = typicalStats(DEF.originStage).hp;
  assert.ok(pet.hp > cap, '这只宠物的气血要高过原著境界，才测得出来');
  const run = startRun(DEF, { pet, stage: DEF.originStage, suppressed: true, nonce: 'sup-hp', now: NOW });
  assert.equal(maxHpOf(DEF, run, pet), cap);
  assert.equal(run.members[0].hp, cap, '开场满血是压过的上限，不是自己的');
  assert.equal(buildParty(DEF, run, pet)[0].hp, cap, '和战斗里的上限同一口径');
  const normal = startRun(DEF, { pet, stage: DEF.originStage, suppressed: false, nonce: 'sup-hp', now: NOW });
  assert.equal(normal.members[0].hp, pet.hp);
  assert.equal(maxHpOf(DEF, normal, pet), pet.hp);
});

test('Y0 春秋蝉：第二、三层倒回这一层开头，状态和快照一样', () => {
  // 用一个必输的软脚虾：第二层小怪就能死
  const soft: Fighter = { name: '小鱼', hp: 1, power: 1, agility: 1, speed: 1, weapons: [], skills: [] };
  const { run: start } = fresh(11, { pet: soft });
  let run = start;
  let now = NOW;
  let lost = false;
  for (let i = 0; i < 40 && run.status !== 'over'; i++) {
    now = Math.max(now, run.readyAt);
    const step = advance(DEF, run, soft, autoDecide(DEF, run, soft), now);
    run = step.run;
    now += 1;
    if (run.status === 'lost') {
      lost = true;
      break;
    }
  }
  assert.ok(lost, '软脚虾该在第二层输');
  const layer = run.layer;
  assert.ok(layer === 2 || layer === 3, `该死在第二/三层，实际 ${layer}`);
  const target = DEF.rules.rewindTarget?.(run, layer);
  assert.deepEqual(target, { layer });
  const snapshot = run.snapshot;
  assert.ok(snapshot, '死之前该有快照');
  const step = advance(DEF, run, soft, { kind: 'rewind' }, now);
  assert.equal(step.outcome.result.kind, 'rewind');
  assert.equal(step.run.layer, layer);
  assert.equal(step.run.step, 0);
  assert.equal(step.run.attempt, 2);
  assert.equal(step.run.flags.rewound, true);
  assert.equal(step.run.members[0].hp, snapshot.members[0].hp, '气血回到快照');
  assert.deepEqual(step.run.members[0].loot, snapshot.members[0].loot, '战利品回到快照');
  assert.deepEqual(step.run.blessings, snapshot.blessings, '加持回到快照');
  // 重打的那场不是同一个结果：战斗种子带上了第几轮
  const seed1 = `${start.seed}:${layer}:${reachableNodes(DEF, start)[0] ?? ''}:1`;
  const seed2 = `${start.seed}:${layer}:${reachableNodes(DEF, start)[0] ?? ''}:2`;
  assert.notEqual(seed1, seed2);
});

test('Y0 春秋蝉：开炉以后、第五层倒带打上「记得」，红蛋人那一场不打', () => {
  const { run: base, pet } = fresh(13);

  // 红蛋人那一场（第 4 层第 2 步）输：不算记得
  const redEgg = structuredClone(base);
  redEgg.layer = 4;
  redEgg.step = 1;
  redEgg.status = 'lost';
  assert.deepEqual(DEF.rules.rewindTarget?.(redEgg, 4), { layer: 4 });

  // 开炉以后（第 3 步）输：记得
  const afterSmelt = structuredClone(base);
  afterSmelt.layer = 4;
  afterSmelt.step = 3;
  afterSmelt.status = 'lost';
  assert.deepEqual(DEF.rules.rewindTarget?.(afterSmelt, 4), { layer: 4, flags: { remember: true } });

  // 第五层输：回大殿开头 + 记得
  const fifth = structuredClone(base);
  fifth.layer = 5;
  fifth.step = 1;
  fifth.status = 'lost';
  assert.deepEqual(DEF.rules.rewindTarget?.(fifth, 5), { layer: 4, flags: { remember: true } });

  // 第五层倒带：走一遍真的 advance
  const run = structuredClone(fifth);
  run.snapshot = structuredClone({ ...base, layer: 4, step: 0 });
  run.readyAt = 0;
  const step = advance(DEF, run, pet, { kind: 'rewind' }, 0);
  assert.equal(step.run.layer, 4);
  assert.equal(step.run.flags.remember, true);
  // 记得以后大殿的步子：红蛋人不再打，只留两问
  const steps = DEF.rules.steps?.(step.run, DEF.layers[3]) ?? [];
  assert.ok(!steps.includes('hall-eggs'), '倒带回来红蛋人那一场不打');
  assert.deepEqual(steps, ['earth-spirit', 'ask-bing', 'ask-smelt']);
  assert.equal(
    step.outcome.result.kind === 'rewind' && step.outcome.result.text[step.outcome.result.text.length - 1],
    DEF.lines.remember,
  );
});

test('Y0 春秋蝉：两问只在「记得」时出现', () => {
  const { run } = fresh(17);
  run.layer = 4;
  run.step = 1;
  const blind = DEF.rules.steps?.(run, DEF.layers[3]) ?? [];
  assert.deepEqual(blind, ['earth-spirit', 'hall-eggs', 'smelt-blind']);
  const remembered = structuredClone(run);
  remembered.flags.remember = true;
  const seen = DEF.rules.steps?.(remembered, DEF.layers[3]) ?? [];
  assert.deepEqual(seen, ['earth-spirit', 'ask-bing', 'ask-smelt']);
  const ask = DEF.nodes['ask-bing'];
  const labels = (ask.event?.choices ?? []).map((c) => c.label);
  assert.ok(
    labels.some((l) => l.includes('演够了')),
    labels.join('/'),
  );
  const smelt = DEF.nodes['ask-smelt'];
  const smeltLabels = (smelt.event?.choices ?? []).map((c) => c.label);
  assert.ok(
    smeltLabels.some((l) => l.includes('定仙游')),
    smeltLabels.join('/'),
  );
});

test('Y0 春秋蝉：只能用一次', () => {
  const { run } = fresh(19);
  run.flags.rewound = true;
  run.layer = 5;
  run.status = 'lost';
  assert.equal(DEF.rules.rewindTarget?.(run, 5), null);
  const kinds = choicesOf(DEF, run, fighterAt(DEF.originStage, seededRng(0))).map((c) => c.kind);
  assert.ok(!kinds.includes('rewind'), '用过以后选项里没有再倒带');
  assert.ok(kinds.includes('end'));
});

test('Y0 口子：记下的出手加 scriptedController 原样重放一场', () => {
  const pet = { ...fighterAt(9, seededRng(23)), name: '小鱼' };
  const run = startRun(DEF, { pet, stage: 9, suppressed: false, nonce: 'replay', now: 0 });
  run.layer = 5;
  run.step = 1;
  run.flags.road = 'dog';
  const foe = buildFoe(DEF, run, 'bing-ninbing');
  const party = buildParty(DEF, run, pet);
  const first = resolveFight(party, foe, 'replay-seed');
  const own: Action[] = [];
  for (const e of first.events) if (e.kind === 'decide' && e.actor === 0) own.push(e.action);
  const theirs: Action[] = [];
  for (const e of first.events) if (e.kind === 'decide' && e.actor === 1) theirs.push(e.action);
  const again = replayFight(buildParty(DEF, run, pet), buildFoe(DEF, run, 'bing-ninbing'), 'replay-seed', own, theirs);
  assert.deepEqual(again.events, first.events);
  assert.deepEqual(again.hpAfter, first.hpAfter);
  assert.equal(again.won, first.won);
  // scriptedController 用完了按空手
  const ctrl = scriptedController([{ kind: 'unarmed' }]);
  assert.deepEqual(ctrl.decide({} as never), { kind: 'unarmed' });
  assert.deepEqual(ctrl.decide({} as never), { kind: 'unarmed' });
});

test('X18 逐手局：重放到缺决策处，补一手从头算，事件前缀不变；补齐后和整场一致', () => {
  const pet: Fighter = { ...fighterAt(9, seededRng(23)), name: '小鱼' };
  const run = startRun(DEF, { pet, stage: 9, suppressed: false, nonce: 'live-replay', now: 0 });
  run.layer = 5;
  run.step = 1;
  run.flags.road = 'dog';
  const node = DEF.nodes.collapse;
  const prepared = prepareLiveFight(DEF, run, node, pet, []);
  assert.equal(prepared.seed, fightSeed(run, node.id));

  // 整场：每一手都用后备挑法，把完整事件和出手串都记下来（每次从头算，最后一份就是整场）
  const actions: Action[] = [];
  let result = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [actions, 'auto']);
  while (result.need) {
    actions.push(fallbackAction(result.need.view, prepared.seed, actions.length));
    result = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [actions, 'auto']);
  }
  const full: BattleEvent[] = result.events;

  // 中断：只有前两手的串，重放出来的事件必须是整场的前缀
  const prefix = actions.slice(0, 2);
  const partial = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [prefix, 'auto']);
  assert.ok(partial.need, '还缺决策');
  assert.deepEqual(partial.events, full.slice(0, partial.events.length));
  // 同一个前缀再算一次，逐条一样（从头重算不漂）
  const again = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [prefix, 'auto']);
  assert.deepEqual(again.events, partial.events);

  // 补齐剩下的手：和整场逐条一样
  const rest = [...prefix];
  let continued = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [rest, 'auto']);
  while (continued.need) {
    rest.push(fallbackAction(continued.need.view, prepared.seed, rest.length));
    continued = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [rest, 'auto']);
  }
  assert.deepEqual(continued.events, full);
});

test('X18 逐手局：completeLiveFight 用同一套气血 / 掉落 / 收场结算', () => {
  const pet: Fighter = {
    name: '小鱼',
    hp: 5_000,
    power: 1_000,
    agility: 500,
    speed: 500,
    weapons: ['water-gun'],
    skills: [],
  };
  const run = startRun(DEF, { pet, stage: 9, suppressed: false, nonce: 'live-done', now: 0 });
  run.layer = 5;
  run.step = 1;
  run.flags.road = 'dog';
  const node = DEF.nodes.collapse;
  const prepared = prepareLiveFight(DEF, run, node, pet, ['water-gun']);
  const actions: Action[] = [];
  let result = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [actions, 'auto']);
  while (result.need) {
    actions.push(fallbackAction(result.need.view, prepared.seed, actions.length));
    result = fightUntilDecision(prepared.party[0], prepared.foe, prepared.seed, [actions, 'auto']);
  }
  const step = completeLiveFight(DEF, run, node, prepared, result.events, 1_000);
  assert.equal(run.pending, null, '收尾时清掉等待');
  assert.equal(step.outcome.result.kind, 'fight');
  const fought = step.outcome.result.kind === 'fight' ? step.outcome.result : null;
  assert.ok(fought);
  assert.equal(fought.events.length, result.events.length);
  assert.equal(run.members[0].hp, fought.hp[0]);
  assert.equal(step.outcome.end?.reason, 'clear', '这是最后一层，打完就收场');
  assert.equal(run.status, 'over');
  assert.ok(step.outcome.end && step.outcome.end.loot.xp > 0);
  assert.equal(run.decisions.length, 0, '逐手局由流程边打边记，complete 不再记一遍');
});

test('Y0 口子：seedOf 一份随机数时结果稳定', () => {
  assert.equal(seedOf(['a']), seedOf(['a']));
  assert.match(seedOf(['a']), /^[0-9a-f]{64}$/);
  assert.notEqual(seedOf(['a']), seedOf(['b']));
  const { run: a } = fresh(29);
  const { run: b } = fresh(29);
  assert.equal(a.seed, b.seed);
});

test('Y0 数据：每个节点、对手、奇遇、加持都有文案', () => {
  for (const [id, node] of Object.entries(DEF.nodes)) {
    const text = node.text;
    const lines = typeof text === 'function' ? text(fresh(0).run) : text;
    assert.ok(lines.length > 0, `${id} 没有文案`);
    if (node.event) {
      for (const c of node.event.choices ?? []) {
        assert.ok(c.label.length > 0, `${id} 的选项没标签`);
        assert.ok(c.outcome.text.length >= 0);
      }
    }
  }
  for (const [id, foe] of Object.entries(DEF.foes)) {
    assert.ok(foe.text.length > 0, `${id} 没有文案`);
    assert.ok(foe.tactics.length > 0, `${id} 没有打法`);
    for (const move of foe.moves) assert.ok(MOVES[move], `${id} 的招式 ${move} 不在 MOVES 里`);
  }
  for (const id of DEF.blessings) {
    assert.ok(id.length > 0, '加持名不能空');
  }
});

test('Y0 平衡：小怪 85–90%、精英 65–75%、守护 55–65%（同境界典型成长、满血打）', () => {
  const N = 240;
  const stage = DEF.originStage;
  const rate = (foeId: string): number => {
    let win = 0;
    for (let i = 0; i < N; i++) {
      const pet = { ...fighterAt(stage, seededRng(i)), name: '小鱼' };
      const run = startRun(DEF, { pet, stage, suppressed: false, nonce: 'tier', now: 0 });
      run.layer = 5;
      run.step = 1;
      run.flags.road = 'dog';
      const foe = buildFoe(DEF, run, foeId);
      if (resolveFight(buildParty(DEF, run, pet), foe, `tier-${foeId}-${i}`).won) win++;
    }
    return win / N;
  };
  const band = (ids: string[], lo: number, hi: number, label: string): void => {
    for (const id of ids) {
      const got = rate(id);
      assert.ok(got >= lo && got <= hi, `${label} ${id} ${got.toFixed(3)}，目标 ${lo}–${hi}`);
    }
  };
  band(['wild-dog', 'red-egg'], 0.85, 0.9, '小怪');
  band(['han-buliu', 'mastiff', 'lava-croc', 'rival-gu-master'], 0.65, 0.75, '精英');
  band(['bing-ninbing', 'tie-ruonan'], 0.55, 0.65, '守护');
});

test('Y0 平衡：三王一趟通关 55–65%', () => {
  const N = 200;
  let clear = 0;
  for (let i = 0; i < N; i++) {
    const { run } = playOut(i);
    if (run.status === 'over' && run.members[0].loot.titles.length > 0) clear++;
  }
  const rate = clear / N;
  assert.ok(rate >= 0.55 && rate <= 0.65, `通关率 ${rate.toFixed(3)}`);
});

test('Y0 平衡：四种组合落在目标区间（各给 ±10% 容差）', () => {
  const N = 240;
  const stage = DEF.originStage;
  const combo = (k: number, seen: boolean, ding: boolean): number => {
    let win = 0;
    for (let i = 0; i < N; i++) {
      const pet = { ...fighterAt(stage, seededRng(i)), name: '小鱼' };
      const run = startRun(DEF, { pet, stage, suppressed: false, nonce: 'combo', now: 0 });
      run.layer = 5;
      run.step = 1;
      run.flags.road = 'dog';
      run.flags.seen = seen;
      run.flags.smelt = ding ? 'dingxian' : 'second';
      const foeId = ding ? 'tie-ruonan' : 'bing-ninbing';
      const foe = buildFoe(DEF, run, foeId);
      const party = buildParty(DEF, run, pet);
      DEF.rules.patchFight?.({
        def: DEF,
        run,
        node: DEF.nodes.collapse,
        party,
        foe,
        foeDef: DEF.foes[foeId],
        rng: () => 0.5,
      });
      if (resolveFight(party, foe, `combo-${k}-${i}`).won) win++;
    }
    return win / N;
  };
  const within = (name: string, got: number, lo: number, hi: number): void => {
    assert.ok(got >= lo * 0.9 && got <= hi * 1.1, `${name} ${got.toFixed(3)}，目标 ${lo}–${hi}`);
  };
  within('否/第二空窍', combo(1, false, false), 0.25, 0.35);
  within('是/第二空窍', combo(2, true, false), 0.45, 0.55);
  within('是/定仙游', combo(3, true, true), 0.7, 0.8);
  within('否/定仙游', combo(4, false, true), 0.35, 0.45);
});

test('Y0 数据：runSchema 能校验走了一趟的状态', () => {
  const { run } = playOut(31);
  const parsed = runSchema.parse(JSON.parse(JSON.stringify(run)));
  assert.equal(parsed.version, DUNGEON_VERSION);
  assert.ok(parsed.decisions.length > 0);
  assert.ok(parsed.seed.length === 64);
});

test('Y5 高光：改炼定仙游的 outcome 带过场和客串，结算和状态不变', () => {
  const { pet, run } = fresh(41);
  run.layer = 4;
  run.step = 3;
  run.attempt = 2;
  run.readyAt = 0;
  run.flags = { ...run.flags, road: 'dog', dogs: 4, remember: true };
  run.pending = { node: 'ask-smelt', need: 'choice', options: [] };
  run.snapshot = null;
  const step = advance(DEF, run, pet, { kind: 'choice', node: 'ask-smelt', index: 0 }, 0);
  assert.equal(step.outcome.result.kind, 'event');
  if (step.outcome.result.kind !== 'event') assert.fail('该是一个奇遇结果');
  assert.equal(step.outcome.result.cutscene?.video, '过场-天瀑光河.mp4');
  assert.ok(step.outcome.result.cutscene?.lines[1].includes(pet.name), '原著里的「方源」换成宠物的名字');
  assert.equal(step.outcome.result.cameo?.foe, 'feng-tianyu');
  assert.equal(step.outcome.result.cameo?.art, '奇遇-风天语.png');
  assert.equal(step.outcome.result.cameo?.lines.length, 3);
  assert.equal(step.run.flags.smelt, 'dingxian');

  // 把这两个字段摘掉再推进一步：状态和结算不该有任何变化
  const node = SANWANG.nodes['ask-smelt'];
  const choices = node.event?.choices ?? [];
  const plain: DungeonDef = {
    ...SANWANG,
    nodes: {
      ...SANWANG.nodes,
      'ask-smelt': {
        ...node,
        event: {
          ...node.event,
          choices: choices.map((choice, index) =>
            index === 0 ? { ...choice, outcome: { ...choice.outcome, cutscene: undefined, cameo: undefined } } : choice,
          ),
        },
      },
    },
  };
  const plainStep = advance(plain, structuredClone(run), pet, { kind: 'choice', node: 'ask-smelt', index: 0 }, 0);
  assert.equal(JSON.stringify(plainStep.run), JSON.stringify(step.run), '过场只影响演出，不进状态');
  assert.equal(plainStep.outcome.result.kind, 'event');
});

test('Y5 高光：定仙游结局带结局过场，第二空窍没有', () => {
  const pet: Fighter = {
    name: '小鱼',
    hp: 100_000,
    power: 100_000,
    agility: 100_000,
    speed: 100_000,
    weapons: [],
    skills: [],
  };
  const base = startRun(DEF, { pet, stage: 9, suppressed: false, nonce: 'ending', now: 0 });
  base.layer = 5;
  base.step = 0;
  base.readyAt = 0;
  base.flags = { ...base.flags, road: 'dog', dogs: 4, seen: true, smelt: 'dingxian' };
  base.snapshot = null;
  const ding = advance(DEF, base, pet, { kind: 'node', node: 'collapse' }, 0);
  assert.equal(ding.outcome.result.kind, 'fight');
  assert.equal(ding.outcome.end?.ending?.id, 'ding-xian-you');
  assert.equal(ding.outcome.end?.ending?.cutscene?.video, '过场-定仙游.mp4');
  assert.equal(ding.outcome.end?.ending?.cutscene?.lines.length, 3);

  const second = structuredClone(base);
  second.flags = { ...second.flags, seen: true, smelt: 'second' };
  const done = advance(DEF, second, pet, { kind: 'node', node: 'collapse' }, 0);
  assert.equal(done.outcome.end?.ending?.id, 'second-void');
  assert.equal(done.outcome.end?.ending?.cutscene, undefined, '第二空窍没有过场');
});
