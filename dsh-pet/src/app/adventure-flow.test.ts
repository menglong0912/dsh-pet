import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdventureFlow } from './adventure-flow.ts';
import type { AdventureFlowDeps, AdventureProgress } from './adventure-flow.ts';
import type { AdventureAnswer, AdventureChoiceView, AdventureWindow, AdventureView } from './adventure-window.ts';
import { SANWANG } from './dungeon-sanwang.ts';
import { startRun } from './dungeon.ts';
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
