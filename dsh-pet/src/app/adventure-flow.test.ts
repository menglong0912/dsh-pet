import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdventureFlow, AUTO_PICK_MS } from './adventure-flow.ts';
import type { AdventureFlowDeps, AdventureProgress } from './adventure-flow.ts';
import type { AdventureAnswer, AdventureChoiceView, AdventureWindow, AdventureView } from './adventure-window.ts';
import { SANWANG } from './dungeon-sanwang.ts';
import { autoDecide, layerNodeIdsOf, startRun } from './dungeon.ts';
import type { DungeonDef, FightResult, FinishReason, Loot, Run } from './dungeon.ts';
import type { Fighter } from './battle.ts';
import type { CultivationEvent } from './cultivation.ts';

/** 假时钟：注入 setTimeout / clearTimeout，测试按需拨 */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(handle: unknown) {
      timers.delete(Number(handle));
    },
    async tick(ms: number) {
      now += Math.max(0, ms);
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
        await flush();
      }
      await flush();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((done) => setImmediate(done));
};

/** 假小窗：记下每一页，等测试给答案 */
class FakeAdventureWindow implements AdventureWindow {
  views: AdventureView[] = [];
  compacted = false;
  closed = false;
  hiddenNow = false;
  shows = 0;
  waiting = false;
  private waiter: ((value: AdventureAnswer | null) => void) | null = null;

  render(view: AdventureView): void {
    this.views.push(view);
  }
  wait(): Promise<AdventureAnswer | null> {
    this.waiting = true;
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
  cancelWait(): void {
    this.waiting = false;
    this.waiter = null;
  }
  setCompact(compact: boolean): void {
    this.compacted = compact;
  }
  hide(): void {
    this.hiddenNow = true;
  }
  show(): void {
    this.hiddenNow = false;
    this.shows += 1;
  }
  position() {
    return null;
  }
  bounds() {
    return { x: 0, y: 0, width: 420, height: 600 };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting = false;
    const done = this.waiter;
    this.waiter = null;
    done?.(null);
  }
  answer(answer: AdventureAnswer): void {
    const done = this.waiter;
    this.waiter = null;
    this.waiting = false;
    done?.(answer);
  }
  get last(): AdventureView | undefined {
    return this.views[this.views.length - 1];
  }
}

const BIG: Fighter = {
  name: '阿鱼',
  hp: 100_000,
  power: 100_000,
  agility: 100_000,
  speed: 100_000,
  weapons: ['water-gun'],
  skills: [],
};
const TINY: Fighter = { name: '阿鱼', hp: 1, power: 1, agility: 1, speed: 1, weapons: [], skills: [] };

interface Harness {
  flow: AdventureFlow;
  window: FakeAdventureWindow;
  clock: ReturnType<typeof fakeClock>;
  stored: () => Run | null;
  saves: Run[];
  fights: Array<{ result: FightResult; full: boolean }>;
  cameos: Array<{ foe: string; lines: string[] }>;
  done: Array<{ reason: FinishReason; loot: Loot }>;
  events: CultivationEvent[][];
  plays: string[];
  said: string[];
  diaries: string[];
  readonly composeCalls: number;
  maxHp: Fighter;
  gate?: { promise: Promise<void>; resolve: () => void };
  open: Promise<void>;
  dispose(): void;
}

function makeFlow(options: { fighter?: Fighter; run?: Run | null; gate?: boolean; def?: DungeonDef } = {}): Harness {
  const clock = fakeClock();
  const window = new FakeAdventureWindow();
  const fights: Harness['fights'] = [];
  const cameos: Harness['cameos'] = [];
  const saves: Run[] = [];
  const done: Harness['done'] = [];
  const events: CultivationEvent[][] = [];
  const plays: string[] = [];
  const said: string[] = [];
  const diaries: string[] = [];
  let composeCalls = 0;
  let stored: Run | null = options.run ?? null;
  let gate: Harness['gate'];
  if (options.gate) {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((doneGate) => {
      resolve = doneGate;
    });
    gate = { promise, resolve };
  }
  const maxHp = options.fighter ?? BIG;
  const deps: AdventureFlowDeps = {
    def: options.def ?? SANWANG,
    openWindow: () => window,
    fight: async (request) => {
      fights.push({ result: request.result, full: request.full });
      if (gate) await gate.promise;
    },
    cameo: async (request) => {
      cameos.push(request);
    },
    skipFight: () => undefined,
    play: (anim) => plays.push(anim),
    say: (text) => said.push(text),
    compose: async (_instruction, fallback) => {
      composeCalls += 1;
      return fallback;
    },
    getRun: () => stored,
    saveRun: (run) => {
      stored = run;
      saves.push(run);
    },
    done: (run, reason) => {
      done.push({ reason, loot: run.members[0].loot });
      stored = null;
      return [{ kind: 'xp', amount: run.members[0].loot.xp }];
    },
    onEvents: (list) => events.push(list),
    diary: (text) => diaries.push(text),
    progress: (): AdventureProgress | null => null,
    fighter: () => maxHp,
    stage: () => 20,
    petName: () => '阿鱼',
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.5,
  };
  const flow = new AdventureFlow(deps);
  const open = flow.open();
  return {
    flow,
    window,
    clock,
    stored: () => stored,
    saves,
    fights,
    cameos,
    done,
    events,
    plays,
    said,
    diaries,
    get composeCalls() {
      return composeCalls;
    },
    maxHp,
    gate,
    open,
    dispose: () => flow.dispose(),
  };
}

/** 按小窗上的选项挑：先光柱、再狗群 / 韩不留 / 红蛋人 / 关底；奇遇选第一个；输了先倒带 */
function answerFor(view: AdventureView): AdventureAnswer | null {
  if (view.kind === 'entry') return { kind: 'enter', suppressed: false };
  if (view.kind === 'ending') return { kind: 'close' };
  const run = view.run;
  if (!run) return null;
  if (run.loadout) return { kind: 'loadout', node: run.loadout.node, weapons: [] };
  if (run.choices.some((choice) => choice.kind === 'rewind')) return { kind: 'rewind' };
  const nodes = run.choices.filter(
    (choice): choice is AdventureChoiceView & { id: string } => choice.kind === 'node' && !!choice.id,
  );
  if (nodes.length > 0) {
    const prefer = ['beam-dog', 'dog-pack', 'han-liu', 'hall-eggs', 'collapse'];
    for (const id of prefer) {
      const found = nodes.find((node) => node.id === id);
      if (found) return { kind: 'node', node: found.id };
    }
    return { kind: 'node', node: nodes[0].id };
  }
  const choice = run.choices.find((item) => item.kind === 'choice');
  if (choice?.node !== undefined && choice.index !== undefined)
    return { kind: 'choice', node: choice.node, index: choice.index };
  const blessing = run.choices.find((item) => item.kind === 'blessing');
  if (blessing?.node !== undefined && blessing.blessing !== undefined)
    return { kind: 'blessing', node: blessing.node, blessing: blessing.blessing };
  const retreat = run.choices.find((item) => item.kind === 'retreat');
  if (retreat) return { kind: 'retreat' };
  const end = run.choices.find((item) => item.kind === 'end');
  if (end) return { kind: 'end' };
  return null;
}

/** 一路点下去，直到结局页；赶路的定时器用假时钟拨掉 */
async function drive(harness: Harness, options: { endingAnswer?: 'close' | 'again' } = {}): Promise<void> {
  for (let step = 0; step < 600; step += 1) {
    await flush();
    const view = harness.window.last;
    if (!view) {
      await harness.clock.tick(1_000);
      continue;
    }
    if (view.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view.kind === 'run' && view.run?.cutscene) {
      harness.window.answer({ kind: 'cutscene-done' });
      continue;
    }
    if (!harness.window.waiting) {
      await harness.clock.tick(1_000);
      continue;
    }
    if (view.kind === 'ending') {
      harness.window.answer({ kind: options.endingAnswer ?? 'close' });
      return;
    }
    const answer = answerFor(view);
    if (!answer) throw new Error(`不知道怎么答：${JSON.stringify(view).slice(0, 300)}`);
    harness.window.answer(answer);
  }
  throw new Error('一路点下去没走到结局');
}

test('走完一趟：修为和战利品进存档、宠物出阵、结局页、游记总结只调一次模型', async () => {
  const harness = makeFlow({ fighter: BIG });
  await drive(harness);
  await harness.open;
  assert.equal(harness.done.length, 1);
  assert.equal(harness.done[0].reason, 'clear');
  assert.ok(harness.done[0].loot.xp > 0, '这一趟攒了修为');
  assert.equal(harness.stored(), null, '入账以后存档里没有进行中的一趟');
  assert.ok(
    harness.events.some((list) => list.some((event) => event.kind === 'xp')),
    'onCultivation 收到了事件',
  );
  assert.ok(harness.plays.includes('秘境-入阵'));
  assert.ok(harness.plays.includes('秘境-得宝'));
  assert.ok(harness.plays.includes('秘境-出阵'));
  assert.equal(harness.composeCalls, 1, '每趟只多一次模型调用');
  assert.ok(harness.said.length === 1 && harness.said[0].length > 0);
  const ending = harness.window.views.find((view) => view.kind === 'ending');
  assert.ok(ending);
  assert.equal(ending.ending?.name, '第二空窍', '第一轮照原著炼第二空窍');
  assert.ok(harness.diaries.some((line) => /闯三王传承/.test(line)));
});

test('赶路没满 15 秒点不了下一步：小窗在赶路，等主人点的那一手没挂出来', async () => {
  const harness = makeFlow({ fighter: BIG });
  for (let step = 0; step < 50 && harness.window.last?.kind !== 'entry'; step += 1) await flush();
  assert.equal(harness.window.last?.kind, 'entry');
  harness.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) break;
    await harness.clock.tick(1_000);
  }
  let view = harness.window.last;
  assert.equal(view?.kind, 'run');
  assert.ok(view?.run?.map.travel, '进秘境就在赶路');
  assert.equal(view?.run?.choices.length, 0, '赶路的时候没有选项，点不了下一步');
  const firstRemain = view!.run!.map.travel!.ms;
  await harness.clock.tick(firstRemain - 1_000);
  assert.ok(harness.window.last?.run?.map.travel, '差一秒还在赶路');
  assert.equal(harness.window.last?.run?.choices.length, 0);
  await harness.clock.tick(1_000);
  await flush();
  view = harness.window.last;
  assert.equal(view?.run?.map.travel, null);
  assert.ok((view?.run?.choices.length ?? 0) > 0, '赶路走完才给选项');
  assert.equal(harness.window.waiting, true, '赶路走完才等主人点');
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('赶路时关掉小窗：进度留在存档里，重开还能接着走', async () => {
  const harness = makeFlow({ fighter: BIG });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (harness.window.waiting && harness.window.last?.kind === 'entry') break;
    await harness.clock.tick(1_000);
  }
  harness.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (harness.window.last?.kind === 'run' && harness.window.last.run?.map.travel) break;
    await harness.clock.tick(1_000);
  }
  assert.ok(harness.stored(), '进秘境时已经存了');
  harness.window.answer({ kind: 'close' });
  await harness.open;
  assert.equal(harness.flow.active, false);
  const saved = harness.stored();
  assert.ok(saved, '关窗不丢这一趟');

  const again = makeFlow({ fighter: BIG, run: saved });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (again.window.last?.kind === 'run') break;
    await again.clock.tick(1_000);
  }
  assert.equal(again.window.last?.kind, 'run');
  assert.ok(again.window.last?.run?.map.travel, '接着刚才的赶路');
  again.flow.dispose();
  await again.open.catch(() => undefined);
});

test('退出重开接着走：存档里的这一趟原样回来，这一步不重演、不重算', async () => {
  const harness = makeFlow({ fighter: BIG });
  await drive(harness).catch(() => undefined);
  harness.dispose();
  await harness.open.catch(() => undefined);
  // 再建一份：在刚进第 2 层、还没点的时候退出，重开
  const first = makeFlow({ fighter: BIG });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (first.window.waiting && first.window.last?.kind === 'entry') break;
    await first.clock.tick(1_000);
  }
  first.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 80; step += 1) {
    await flush();
    const view = first.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await first.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (first.window.waiting && view?.kind === 'run') break;
    await first.clock.tick(1_000);
  }
  first.window.answer({ kind: 'node', node: 'beam-dog' });
  for (let step = 0; step < 80; step += 1) {
    await flush();
    const view = first.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await first.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (first.window.waiting && view?.kind === 'run') break;
    await first.clock.tick(1_000);
  }
  const saved = first.stored();
  assert.ok(saved);
  const snapshot = JSON.stringify(saved);
  first.flow.dispose();
  await first.open.catch(() => undefined);

  const second = makeFlow({ fighter: BIG, run: saved });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (second.window.waiting) break;
    await second.clock.tick(1_000);
  }
  assert.equal(JSON.stringify(second.stored()), snapshot, '存档原样回来');
  assert.equal(second.saves.length, 0, '重开不重算这一步');
  assert.equal(second.fights.length, 0, '重开不重演这一场');
  assert.equal(second.window.last?.kind, 'run');
  second.flow.dispose();
  await second.open.catch(() => undefined);
});

test('倒带一次：输了先倒回本层开头，attempt +1，春秋蝉沉眠', async () => {
  const harness = makeFlow({ fighter: TINY });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (harness.window.waiting && harness.window.last?.kind === 'entry') break;
    await harness.clock.tick(1_000);
  }
  harness.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 200; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && view.run?.choices.some((choice) => choice.kind === 'rewind')) break;
    if (view?.kind === 'run' && view.run && harness.window.waiting) {
      const choices = view.run.choices;
      if (choices.some((choice) => choice.kind === 'node' && choice.id === 'beam-dog')) {
        harness.window.answer({ kind: 'node', node: 'beam-dog' });
        continue;
      }
      if (choices.some((choice) => choice.kind === 'node' && choice.id === 'dog-pack')) {
        harness.window.answer({ kind: 'node', node: 'dog-pack' });
        continue;
      }
    }
    await harness.clock.tick(1_000);
  }
  const run = harness.stored();
  assert.ok(run);
  assert.equal(run.status, 'lost');
  harness.window.answer({ kind: 'rewind' });
  // 倒带过场要播完才往下走（真机：自动走 1.5 秒就选，视频被切断在半截）
  for (let step = 0; step < 40; step += 1) {
    await flush();
    if (harness.window.last?.run?.cutscene) break;
    await harness.clock.tick(100);
  }
  const cut = harness.window.last;
  assert.ok(cut?.run?.scene.video?.includes('过场-春秋蝉'), JSON.stringify(cut?.run?.scene));
  await harness.clock.tick(20_000);
  await flush();
  assert.ok(harness.window.last?.run?.cutscene, '过场没播完之前，不往下走');
  assert.ok(!harness.window.last?.run?.choices.some((choice) => choice.kind === 'node'), '过场里不出选项');
  harness.window.answer({ kind: 'cutscene-done' });
  for (let step = 0; step < 80; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && view.run?.choices.some((choice) => choice.kind === 'node')) break;
    await harness.clock.tick(1_000);
  }
  assert.ok(
    harness.window.last?.run?.choices.some((choice) => choice.kind === 'node'),
    '过场播完以后接着选这一层的节点',
  );
  const rewritten = harness.stored();
  assert.ok(rewritten);
  assert.equal(rewritten.attempt, 2);
  assert.equal(rewritten.flags.rewound, true);
  assert.equal(rewritten.layer, 2);
  harness.dispose();
  await harness.open.catch(() => undefined);
});

/** 造一趟已经走到第五层的存档（两种结局各用一次） */
function layerFiveRun(options: { smelt: 'second' | 'dingxian'; seen: boolean; remember: boolean }): Run {
  const run = startRun(SANWANG, { pet: BIG, stage: 20, suppressed: false, nonce: 'n', now: 0 });
  run.layer = 5;
  run.step = 0;
  run.attempt = 2;
  run.readyAt = 1;
  run.flags = {
    stage: 20,
    road: 'dog',
    dogs: 4,
    ...(options.smelt === 'dingxian' ? { smelt: 'dingxian' } : { smelt: 'second' }),
    ...(options.seen ? { seen: true } : {}),
    ...(options.remember ? { remember: true } : {}),
  };
  run.decisions = [];
  run.snapshot = null;
  return run;
}

test('两种结局各走一遍：第二空窍（改写原著） / 定仙游（碧芒一闪）', async () => {
  const second = makeFlow({ fighter: BIG, run: layerFiveRun({ smelt: 'second', seen: true, remember: true }) });
  await drive(second);
  await second.open;
  assert.equal(second.window.views.find((view) => view.kind === 'ending')?.ending?.name, '第二空窍');
  assert.ok(second.plays.includes('秘境-得宝'));

  const ding = makeFlow({ fighter: BIG, run: layerFiveRun({ smelt: 'dingxian', seen: true, remember: true }) });
  await drive(ding);
  await ding.open;
  const ending = ding.window.views.find((view) => view.kind === 'ending');
  assert.equal(ending?.ending?.name, '定仙游');
  assert.ok(ending?.ending?.title.includes('春秋蝉主'));
  assert.ok(ding.plays.includes('秘境-定仙游'), '定仙游结局播碧芒一闪');
  assert.ok(ding.plays.includes('秘境-出阵'));
});

test('撤退：带走已经拿到的，结局页写撤退，不扣东西', async () => {
  const harness = makeFlow({ fighter: BIG });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (harness.window.waiting && harness.window.last?.kind === 'entry') break;
    await harness.clock.tick(1_000);
  }
  harness.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && harness.window.waiting) break;
    await harness.clock.tick(1_000);
  }
  // 先走一步光柱拿点东西，再撤
  harness.window.answer({ kind: 'node', node: 'beam-dog' });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && harness.window.waiting) break;
    await harness.clock.tick(1_000);
  }
  harness.window.answer({ kind: 'retreat' });
  await drive(harness, { endingAnswer: 'close' });
  await harness.open;
  assert.equal(harness.done.length, 1);
  assert.equal(harness.done[0].reason, 'retreat');
  assert.equal(harness.window.views.find((view) => view.kind === 'ending')?.ending?.name, '撤退');
  assert.ok(harness.plays.includes('秘境-出阵'));
});

test('有人敲门先快进收场：小窗收起来、这一趟留在存档里，客人走了从菜单接着走', async () => {
  const harness = makeFlow({ fighter: BIG, gate: true });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (harness.window.waiting && harness.window.last?.kind === 'entry') break;
    await harness.clock.tick(1_000);
  }
  harness.window.answer({ kind: 'enter', suppressed: false });
  let fightStarted = false;
  for (let step = 0; step < 200; step += 1) {
    await flush();
    const view = harness.window.last;
    if (harness.fights.length > 0) {
      fightStarted = true;
      break;
    }
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && view.run && harness.window.waiting) {
      const choices = view.run.choices;
      if (choices.some((choice) => choice.kind === 'node' && choice.id === 'beam-dog')) {
        harness.window.answer({ kind: 'node', node: 'beam-dog' });
        continue;
      }
      if (choices.some((choice) => choice.kind === 'node' && choice.id === 'dog-pack')) {
        harness.window.answer({ kind: 'node', node: 'dog-pack' });
        continue;
      }
    }
    await harness.clock.tick(1_000);
  }
  assert.equal(fightStarted, true, '开打了');
  assert.equal(harness.flow.busy, true);
  harness.flow.suspend();
  harness.gate?.resolve();
  await harness.open;
  assert.equal(harness.flow.active, false);
  assert.equal(harness.flow.busy, false);
  assert.ok(harness.stored(), '这一趟留在存档里');
  assert.equal(harness.done.length, 0, '还没收场，不结算');
});

test('出门前先收小窗：闲着能走；正在打或者正在赶路时不能走', async () => {
  const idle = makeFlow({ fighter: BIG });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (idle.window.waiting && idle.window.last?.kind === 'entry') break;
    await idle.clock.tick(1_000);
  }
  assert.equal(idle.flow.beforeTrip(), true);
  assert.equal(idle.window.closed, true);
  await idle.open;

  const travel = makeFlow({ fighter: BIG });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (travel.window.waiting && travel.window.last?.kind === 'entry') break;
    await travel.clock.tick(1_000);
  }
  travel.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (travel.window.last?.kind === 'run' && travel.window.last.run?.map.travel) break;
    await travel.clock.tick(1_000);
  }
  assert.equal(travel.flow.busy, true);
  assert.equal(travel.flow.beforeTrip(), false);
  travel.flow.dispose();
  await travel.open.catch(() => undefined);
});

/** 一路自动走：赶路用假时钟拨，要选的地方等 1.5 秒让 autoDecide 挑；结局页关掉 */
async function driveAuto(harness: Harness, endingAnswer: 'close' | 'again' = 'close'): Promise<void> {
  for (let step = 0; step < 2_000; step += 1) {
    await flush();
    const view = harness.window.last;
    if (!view) {
      await harness.clock.tick(1_000);
      continue;
    }
    if (view.kind === 'entry') {
      harness.window.answer({ kind: 'enter', suppressed: false });
      continue;
    }
    if (view.kind === 'ending') {
      harness.window.answer({ kind: endingAnswer });
      return;
    }
    if (view.kind === 'run' && view.run?.cutscene) {
      harness.window.answer({ kind: 'cutscene-done' });
      continue;
    }
    if (!harness.window.waiting) {
      await harness.clock.tick(1_000);
      continue;
    }
    if (view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    await harness.clock.tick(AUTO_PICK_MS);
  }
  throw new Error('自动走没走到结局');
}

/** 走到第一个要选的地方（赶路拨完、等主人点的那一手挂出来） */
async function toFirstChoice(harness: Harness): Promise<AdventureView> {
  for (let step = 0; step < 120; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'entry' && harness.window.waiting) {
      harness.window.answer({ kind: 'enter', suppressed: false });
      continue;
    }
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && harness.window.waiting) return view;
    await harness.clock.tick(1_000);
  }
  throw new Error('没走到第一个要选的地方');
}

test('自动走：赶路没满 15 秒不选；满了再过 1.5 秒按 autoDecide 选', async () => {
  const harness = makeFlow({ fighter: BIG });
  await flush();
  harness.window.answer({ kind: 'toggle-auto', on: true });
  await flush();
  harness.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 60; step += 1) {
    await flush();
    if (harness.window.last?.kind === 'run' && harness.window.last.run?.map.travel) break;
    await harness.clock.tick(1_000);
  }
  const travel = harness.window.last!.run!.map.travel!;
  const savesAfterEnter = harness.saves.length;
  await harness.clock.tick(travel.ms - 1);
  await flush();
  assert.ok(harness.window.last?.run?.map.travel, '差 1 秒还在赶路');
  assert.equal(harness.window.last?.run?.choices.length, 0, '赶路的时候没有选项');
  assert.equal(harness.saves.length, savesAfterEnter, '没满 15 秒不自动选');

  await harness.clock.tick(1);
  await flush();
  assert.equal(harness.window.last?.run?.map.travel, null, '赶路走完了');
  await harness.clock.tick(AUTO_PICK_MS - 1);
  await flush();
  assert.equal(harness.saves.length, savesAfterEnter, '让主人看清选项的 1.5 秒还没到');

  const before = harness.stored()!;
  const expected = autoDecide(SANWANG, before, BIG);
  assert.equal(expected.kind, 'node');
  await harness.clock.tick(1);
  await flush();
  assert.equal(harness.saves.length, savesAfterEnter + 1, '到点自动走了一步');
  const after = harness.saves[harness.saves.length - 1];
  const ids = layerNodeIdsOf(SANWANG, before, before.layer);
  assert.equal(after.path[after.path.length - 1], ids.indexOf(expected.node), '挑的就是 autoDecide 那一个');
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('自动走：这 1.5 秒里主人点了，就按主人点的走', async () => {
  const harness = makeFlow({ fighter: BIG });
  await flush();
  harness.window.answer({ kind: 'toggle-auto', on: true });
  await flush();
  await toFirstChoice(harness);
  // 光柱选犬王，走到第二层（这一层 autoDecide 会挑加持，主人改挑野狗群）
  harness.window.answer({ kind: 'node', node: 'beam-dog' });
  for (let step = 0; step < 300; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && harness.window.waiting) {
      if (view.run?.choices.some((choice) => choice.kind === 'node' && choice.id === 'dog-pack')) break;
      if (view.run?.choices.some((choice) => choice.kind === 'node' && choice.id === 'beam-dog')) {
        harness.window.answer({ kind: 'node', node: 'beam-dog' });
        continue;
      }
    }
    await harness.clock.tick(1_000);
  }
  const view = harness.window.last!;
  assert.ok(
    view.run?.choices.some((choice) => choice.kind === 'node' && choice.id === 'dog-pack'),
    '第二层等主人点',
  );
  const before = harness.stored()!;
  assert.equal(autoDecide(SANWANG, before, BIG).kind, 'node');
  const saves = harness.saves.length;
  harness.window.answer({ kind: 'node', node: 'dog-pack' });
  for (let step = 0; step < 30 && harness.saves.length === saves; step += 1) await flush();
  const after = harness.saves[harness.saves.length - 1];
  assert.equal(after.path[1], 0, '按主人点的野狗群走，不跟 autoDecide');
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('自动走：一趟走完停在结局页，不自动开下一趟', async () => {
  const harness = makeFlow({ fighter: BIG });
  await flush();
  harness.window.answer({ kind: 'toggle-auto', on: true });
  await flush();
  harness.window.answer({ kind: 'enter', suppressed: false });
  for (let step = 0; step < 2_000; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'ending') break;
    if (!harness.window.waiting) {
      await harness.clock.tick(1_000);
      continue;
    }
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    await harness.clock.tick(AUTO_PICK_MS);
  }
  assert.equal(harness.window.last?.kind, 'ending');
  assert.equal(harness.done.length, 1, '走完这一趟就入账');
  const saves = harness.saves.length;
  const fights = harness.fights.length;
  await harness.clock.tick(10_000);
  await flush();
  assert.equal(harness.window.last?.kind, 'ending', '还停在结局页');
  assert.equal(harness.saves.length, saves, '没有自动开下一趟');
  assert.equal(harness.fights.length, fights);
  assert.equal(harness.done.length, 1);
  harness.window.answer({ kind: 'close' });
  await harness.open;
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('自动走：倒带和大殿两问都按 autoDecide', async () => {
  // 第一轮输在第二层：autoDecide 催春秋蝉，倒回本层开头；第二次输就收场
  const lost = makeFlow({ fighter: TINY });
  await flush();
  lost.window.answer({ kind: 'toggle-auto', on: true });
  await flush();
  await driveAuto(lost, 'close').catch(() => undefined);
  const last = lost.saves[lost.saves.length - 1];
  assert.equal(last.attempt, 2, '春秋蝉倒回了一次');
  assert.equal(last.flags.rewound, true);
  assert.equal(lost.done.length, 1);
  assert.equal(lost.done[0].reason, 'lose', '第二次输就收场');
  lost.dispose();
  await lost.open.catch(() => undefined);

  // 大殿里「记得」的两问：autoDecide 挑最稳的那个（识破 + 改炼定仙游）
  const run = startRun(SANWANG, { pet: BIG, stage: 20, suppressed: false, nonce: 'hall', now: 0 });
  run.layer = 4;
  run.step = 1;
  run.attempt = 2;
  run.readyAt = 0;
  run.flags = { stage: 20, road: 'dog', dogs: 4, remember: true };
  run.decisions = [];
  run.snapshot = null;
  const hall = makeFlow({ fighter: BIG, run });
  hall.flow.setAutoWalk(true);
  await driveAuto(hall, 'close');
  const after = hall.saves[hall.saves.length - 1];
  assert.equal(after.flags.seen, true, '识破白凝冰');
  assert.equal(after.flags.smelt, 'dingxian', '改炼定仙游');
  assert.equal(hall.done.length, 1);
  assert.equal(hall.done[0].reason, 'clear');
  hall.dispose();
  await hall.open.catch(() => undefined);
});

test('收起：自动走开着时藏着也能走完一趟、入账，小窗不自己弹出来', async () => {
  const harness = makeFlow({ fighter: BIG });
  await flush();
  harness.window.answer({ kind: 'toggle-auto', on: true });
  await flush();
  await toFirstChoice(harness);
  harness.window.answer({ kind: 'hide' });
  await flush();
  assert.equal(harness.window.hiddenNow, true, '收起来了');
  // 收起来以后不再有页面点击，只拨假时钟：自动走一路走到入账
  for (let step = 0; step < 2_000 && harness.done.length === 0; step += 1) {
    const view = harness.window.last;
    if (view?.kind === 'entry') {
      harness.window.answer({ kind: 'enter', suppressed: false });
      continue;
    }
    if (view?.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    await harness.clock.tick(AUTO_PICK_MS);
    await flush();
  }
  assert.equal(harness.done.length, 1, '藏着也走完入账');
  assert.equal(harness.window.hiddenNow, true, '小窗没自己弹出来');
  assert.equal(harness.window.shows, 0);
  assert.ok(harness.said.includes('三王传承走完了'), '冒泡说一声走完了');
  harness.window.answer({ kind: 'close' });
  await harness.open;
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('收起：自动走关着时藏着停在当前这一步；从菜单叫回来还是最新状态', async () => {
  const harness = makeFlow({ fighter: BIG });
  await toFirstChoice(harness);
  harness.window.answer({ kind: 'hide' });
  await flush();
  assert.equal(harness.window.hiddenNow, true);
  const saves = harness.saves.length;
  await harness.clock.tick(60_000);
  await flush();
  assert.equal(harness.saves.length, saves, '没有自动往前跑');
  assert.equal(harness.window.last?.kind, 'run');
  assert.equal(harness.window.waiting, true, '还停在当前这一步');
  void harness.flow.open();
  await flush();
  assert.equal(harness.window.hiddenNow, false, '从菜单叫回来');
  assert.equal(harness.window.shows, 1);
  harness.window.answer({ kind: 'close' });
  await harness.open;
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('收起：菜单切自动走会把等主人点的那一头叫醒，按新状态接着走', async () => {
  const harness = makeFlow({ fighter: BIG });
  await toFirstChoice(harness);
  const saves = harness.saves.length;
  harness.flow.setAutoWalk(true);
  await flush();
  await harness.clock.tick(AUTO_PICK_MS - 1);
  await flush();
  assert.equal(harness.saves.length, saves, '1.5 秒没到');
  await harness.clock.tick(1);
  await flush();
  assert.equal(harness.saves.length, saves + 1, '菜单开了自动走以后按 autoDecide 走一步');
  harness.dispose();
  await harness.open.catch(() => undefined);
});

/** 造一趟在「改炼定仙游」那一问前等着的存档（Y5 高光） */
function askSmeltRun(): Run {
  const run = startRun(SANWANG, { pet: BIG, stage: 20, suppressed: false, nonce: 'smelt', now: 0 });
  run.layer = 4;
  run.step = 3;
  run.attempt = 2;
  run.readyAt = 0;
  run.flags = { stage: 20, road: 'dog', dogs: 4, remember: true };
  run.pending = { node: 'ask-smelt', need: 'choice', options: [] };
  run.snapshot = null;
  run.decisions = [];
  return run;
}

test('Y5 版面：完整演出默认开；真在选节点时地图能点，等选项时不能点', async () => {
  const first = makeFlow({ fighter: BIG });
  const view = await toFirstChoice(first);
  assert.equal(view.run?.fullShow, true, 'Y5 起默认完整演出');
  assert.equal(view.run?.mapClickable, true, '选节点时地图能点');
  first.dispose();
  await first.open.catch(() => undefined);

  const pending = makeFlow({ fighter: BIG, run: askSmeltRun() });
  const waiting = await toFirstChoice(pending);
  assert.equal(waiting.run?.mapClickable, false, '等奇遇选项时地图不接点击');
  pending.dispose();
  await pending.open.catch(() => undefined);
});

test('Y5 高光：改炼定仙游先播过场、客串冒三句，主人点跳过能提前结束', async () => {
  const harness = makeFlow({ fighter: BIG, run: askSmeltRun() });
  const before = await toFirstChoice(harness);
  assert.ok(before.run?.choices.some((choice) => choice.kind === 'choice' && choice.index === 0));
  harness.window.answer({ kind: 'choice', node: 'ask-smelt', index: 0 });
  for (let step = 0; step < 80; step += 1) {
    await flush();
    if (harness.window.last?.run?.cutscene) break;
    await harness.clock.tick(100);
  }
  const cut = harness.window.last;
  assert.equal(cut?.kind, 'run');
  assert.ok(cut?.run?.scene.video?.includes('过场-天瀑光河'), JSON.stringify(cut?.run?.scene));
  assert.ok(cut?.run?.cutscene?.lines[1].includes('阿鱼'), '原著里的「方源」换成宠物名');
  assert.equal(cut?.run?.mapClickable, false);
  assert.equal(harness.stored()?.flags.smelt, 'dingxian', '先记账再演出');
  assert.equal(harness.cameos.length, 1, '客串和过场同时开始');
  assert.equal(harness.cameos[0].foe, 'feng-tianyu');
  assert.equal(harness.cameos[0].lines.length, 3);
  assert.ok(
    cut?.run?.cutscene?.lines.some((line) => line.includes('千古地仙随风逝')),
    '定场诗在过场台词里',
  );
  assert.ok(
    harness.said.some((line) => line === '今日暂且展翼去，明朝登仙笞凤凰！'),
    `小窗开着时宠物冒定场诗最后一联：${JSON.stringify(harness.said)}`,
  );

  // 主人点跳过：不用等视频播完，直接往下走
  harness.window.answer({ kind: 'skip' });
  for (let step = 0; step < 80; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && view.run && harness.window.waiting && !view.run.cutscene) break;
    await harness.clock.tick(100);
  }
  const after = harness.window.last;
  assert.equal(after?.kind, 'run');
  assert.equal(after?.run?.map.current, 5, '跳到第五层福地崩溃');
  assert.ok(after?.run?.choices.some((choice) => choice.kind === 'node' && choice.id === 'collapse'));
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('Y5 高光：定仙游结局先播结局过场，再进结局页', async () => {
  const harness = makeFlow({
    fighter: BIG,
    run: layerFiveRun({ smelt: 'dingxian', seen: true, remember: true }),
  });
  await drive(harness);
  await harness.open;
  const views = harness.window.views;
  const cutIndex = views.findIndex((view) => view.kind === 'run' && view.run?.cutscene);
  const endingIndex = views.findIndex((view) => view.kind === 'ending');
  assert.ok(cutIndex >= 0, '先播了结局过场');
  assert.ok(endingIndex > cutIndex, '过场播完才进结局页');
  assert.ok(views[cutIndex].run?.cutscene?.lines.some((line) => line.includes('定仙游')));
  assert.ok(harness.plays.includes('秘境-定仙游'), '过场同时宠物播碧芒一闪');
  assert.equal(harness.cameos.length, 0, '结局没有客串');
  assert.equal(views[endingIndex].ending?.name, '定仙游');
});

test('Y5 高光：小窗收起着时不播过场，台词改成宠物冒泡', async () => {
  const harness = makeFlow({ fighter: BIG, run: askSmeltRun() });
  await toFirstChoice(harness);
  harness.window.answer({ kind: 'hide' });
  await flush();
  assert.equal(harness.window.hiddenNow, true);
  harness.flow.setAutoWalk(true);
  await flush();
  await harness.clock.tick(AUTO_PICK_MS);
  for (let step = 0; step < 80 && harness.stored()?.flags.smelt !== 'dingxian'; step += 1) {
    await flush();
    await harness.clock.tick(100);
  }
  assert.equal(harness.stored()?.flags.smelt, 'dingxian');
  assert.ok(
    harness.said.some((line) => line.includes('天瀑光河')),
    '台词改成冒泡',
  );
  assert.equal(
    harness.window.views.some((view) => view.kind === 'run' && view.run?.cutscene),
    false,
    '藏着的时候不播过场',
  );
  harness.dispose();
  await harness.open.catch(() => undefined);
});

test('收起：结局页也能藏起来，从菜单叫回来再关掉', async () => {
  const harness = makeFlow({
    fighter: BIG,
    run: layerFiveRun({ smelt: 'second', seen: true, remember: true }),
  });
  for (let step = 0; step < 300; step += 1) {
    await flush();
    const view = harness.window.last;
    if (view?.kind === 'ending') break;
    if (view?.kind === 'run' && view.run?.map.travel) {
      await harness.clock.tick(view.run.map.travel.ms);
      continue;
    }
    if (view?.kind === 'run' && harness.window.waiting) {
      const answer = answerFor(view);
      if (answer) {
        harness.window.answer(answer);
        continue;
      }
    }
    await harness.clock.tick(1_000);
  }
  assert.equal(harness.window.last?.kind, 'ending');
  harness.window.answer({ kind: 'hide' });
  await flush();
  assert.equal(harness.window.hiddenNow, true, '结局页收起来了');
  assert.equal(harness.window.closed, false, '收起来不是关掉');
  void harness.flow.open();
  await flush();
  assert.equal(harness.window.hiddenNow, false, '从菜单叫回来');
  harness.window.answer({ kind: 'close' });
  await harness.open;
  harness.dispose();
  await harness.open.catch(() => undefined);
});
