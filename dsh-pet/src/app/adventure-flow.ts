/**
 * 历练流程（历练路线 Y3）：小窗 → 等主人点 → `advance`（纯逻辑）→ 存档 → 演这一步 → 下一轮。
 *
 * 流程全在这里，`features.ts` 只把真东西（小窗、演出、存档、时钟）注入进来，测试用假窗口和假时钟。
 * **先记账再演出**：每一步都由 `dungeon.advance` 先算完、`saveRun` 写进存档，再去演；演到一半退出 app，
 * 重开时这一步已经算完，直接到下一个决定，不会重算、不会换结果。
 *
 * 赶路 15 秒从做决定那一刻算起（`run.readyAt`），小窗倒数、宠物播一次 `秘境-赶路`；
 * 演出比赶路长就等演完，赶路比演出长就等赶路走完。打起来时小窗缩成屏顶一条（名字、气血、快进）。
 */
import {
  BLESSINGS,
  advance,
  choicesOf,
  dayLabel,
  layerNodeIdsOf,
  reachableNodes,
  resolveText,
  startRun,
  typicalStats,
  visibleLayers,
} from './dungeon';
import type {
  BlessingId,
  Choice,
  Decision,
  DungeonDef,
  EndingDef,
  FightResult,
  FinishReason,
  Loot,
  OutcomeResult,
  Run,
  StepOutcome,
} from './dungeon';
import { roadLabel } from './dungeon-sanwang';
import { WEAPONS } from './battle';
import type { Fighter, WeaponId } from './battle';
import type { CultivationEvent } from './cultivation';
import type {
  AdventureAnswer,
  AdventureChoiceView,
  AdventureMapLayerView,
  AdventureMapNodeState,
  AdventureRunView,
  AdventureSceneView,
  AdventureView,
  AdventureWindow,
} from './adventure-window';

/** 秘境存档里这一趟的通关记录（`Cultivation.adventureProgress` 的返回） */
export interface AdventureProgress {
  runs: number;
  bestLayer: number;
  bossWins: number;
  endings: string[];
  sealed: boolean;
}

export interface AdventureFightRequest {
  result: FightResult;
  /** 完整演出（守护必开；小怪、精英看开关） */
  full: boolean;
}

/** 流程用到的全部外部能力：features.ts 把真的传进来，测试传假的 */
export interface AdventureFlowDeps {
  def: DungeonDef;
  /** 开一扇小窗（页面走 /app/adventure） */
  openWindow: () => AdventureWindow;
  /** 演一场（速战或完整；返回时窗口、擂台、特效层已经收好） */
  fight: (request: AdventureFightRequest) => Promise<void>;
  /** 菜单「修炼/快进」或小窗上的快进 */
  skipFight: () => void;
  /** 宠物播一段秘境动作（`秘境-*`） */
  play: (anim: string) => void;
  say: (text: string, options?: { anim?: boolean }) => void;
  /** 游记式总结（每趟只调一次） */
  compose: (instruction: string, fallback: string) => Promise<string>;
  getRun: () => Run | null;
  saveRun: (run: Run) => void;
  /** 战利品入账（`Cultivation.adventureDone`） */
  done: (run: Run, reason: FinishReason) => CultivationEvent[];
  /** 把事件交给 onCultivation（冒泡、日记） */
  onEvents: (events: CultivationEvent[], now: number) => void;
  diary: (text: string) => void;
  progress: () => AdventureProgress | null;
  fighter: () => Fighter;
  stage: () => number;
  petName: () => string;
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  random: () => number;
  /** 小窗开关、忙闲变化（features 重新注册菜单） */
  onChange?: () => void;
}

/** 秘境素材目录：名字都相对 `assets/pic/adventure/<目录>/` */
const ASSET_DIR: Record<string, string> = { sanwang: '三王传承' };

function withExt(name: string): string {
  return name.includes('.') ? name : `${name}.png`;
}

function dungeonAsset(def: DungeonDef, name: string): string {
  return `${ASSET_DIR[def.id] ?? def.name}/${withExt(name)}`;
}

function genericAsset(name: string): string {
  return `通用/${withExt(name)}`;
}

function tierLabel(tier: string): string {
  return tier === 'mob' ? '小怪' : tier === 'elite' ? '精英' : '守护';
}

function statLabel(stat: 'power' | 'agility'): string {
  return stat === 'power' ? '灵力' : '身法';
}

function lootLines(loot: Loot): string[] {
  const lines: string[] = [];
  if (loot.xp > 0) lines.push(`修为 +${loot.xp}`);
  if (loot.pills > 0) lines.push(`破境丹 ×${loot.pills}`);
  if (loot.weapons.length > 0) lines.push(`法宝：${loot.weapons.map((id) => WEAPONS[id].name).join('、')}`);
  if (loot.scrolls > 0) lines.push(`功法玉简 ×${loot.scrolls}`);
  if (loot.titles.length > 0) lines.push(`称号：${loot.titles.join('、')}`);
  return lines;
}

/**
 * 历练流程：菜单点「修炼/历练」开小窗，从入口页或存档里接着走。
 * 一次 `open()` 跑到窗口关掉（入口页关掉、结局页「关掉」、主人中途关窗、敲门收起）才 resolve。
 */
export class AdventureFlow {
  private win: AdventureWindow | null = null;
  private loop: Promise<void> | null = null;
  private activeFlag = false;
  private disposed = false;
  private suspended = false;
  private fullShow = false;
  /** 上一次做决定时在哪一层：地图上头像从这一层走向新一层 */
  private travelFrom: number | null = null;
  private scene: AdventureSceneView = { text: [] };
  private travelling = false;
  private fighting = false;
  private travelTimer: unknown = null;
  /** 赶路的定时器被撤掉时，让等待赶路的那一头也醒过来（敲门收起、退出） */
  private travelResolve: (() => void) | null = null;

  private readonly deps: AdventureFlowDeps;

  constructor(deps: AdventureFlowDeps) {
    this.deps = deps;
    this.fullShow = false;
  }

  /** 小窗开着（入口页、一趟里、结局页都算） */
  get active(): boolean {
    return this.activeFlag;
  }

  /** 正在打或者正在赶路：这时候不能出门串门 */
  get busy(): boolean {
    return this.fighting || this.travelling;
  }

  /** 菜单点了：开小窗；存档里有没走完的一趟就直接接着走 */
  open(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.activeFlag) return this.loop ?? Promise.resolve();
    this.win = this.deps.openWindow();
    this.activeFlag = true;
    this.suspended = false;
    this.deps.onChange?.();
    const win = this.win;
    const session = this.runSession(win).finally(() => {
      if (this.win === win) {
        this.win = null;
        this.activeFlag = false;
        this.loop = null;
        win.close(0);
        this.deps.onChange?.();
      }
    });
    this.loop = session;
    return session;
  }

  /** 有人敲门 / 出门前收起小窗：进度都在存档里，客人走了再从菜单接着走 */
  suspend(): void {
    if (!this.activeFlag) return;
    this.suspended = true;
    this.deps.skipFight();
    this.stopTravel();
    this.win?.close(0);
    this.deps.onChange?.();
  }

  /** 出门串门前：正在打 / 赶路时不能走（false）；否则收起小窗再走（true） */
  beforeTrip(): boolean {
    if (!this.activeFlag) return true;
    if (this.busy) return false;
    this.suspend();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.suspended = true;
    this.stopTravel();
    this.win?.close(0);
  }

  /** 赶路的等待提前结束（定时器撤掉，等待那头 resolve） */
  private stopTravel(): void {
    if (this.travelTimer !== null) {
      this.deps.clearTimeout(this.travelTimer);
      this.travelTimer = null;
    }
    const resolve = this.travelResolve;
    this.travelResolve = null;
    resolve?.();
  }

  /** 小窗一开：存档里有一趟就接着走，否则先看入口页 */
  private async runSession(win: AdventureWindow): Promise<void> {
    const saved = this.deps.getRun();
    if (saved && saved.status !== 'over') {
      this.scene = this.defaultScene(saved);
      await this.continueLoop(win);
      return;
    }
    await this.showEntry(win);
    if (this.stopped()) return;
    await this.continueLoop(win);
  }

  /** 入口页：秘境卡片、压境开关、进入 */
  private async showEntry(win: AdventureWindow): Promise<void> {
    const def = this.deps.def;
    const progress = this.deps.progress();
    win.render({
      kind: 'entry',
      title: def.name,
      subtitle: def.opening[0] ?? '',
      entry: {
        cover: dungeonAsset(def, def.cover),
        fallback: dungeonAsset(def, def.map),
        opening: def.opening,
        sealed: progress?.sealed === true,
        best: progress
          ? `走完 ${progress.runs} 趟 · 最高第 ${progress.bestLayer} 层 · 赢过守护 ${progress.bossWins} 次`
          : '还没走过这一趟',
        endings: (def.endings ?? []).map((ending) => ({
          name: ending.name,
          seen: progress?.endings.includes(ending.id) === true,
        })),
        suppressed: false,
      },
    });
    while (!this.stopped()) {
      const answer = await win.wait();
      if (answer === null || answer.kind === 'close') {
        this.suspended = true;
        return;
      }
      if (answer.kind !== 'enter') continue;
      this.beginRun(answer.suppressed === true);
      return;
    }
  }

  /** 新开一趟：定种子、存盘、播入阵，赶路交给主循环 */
  private beginRun(suppressed: boolean): void {
    const def = this.deps.def;
    const now = this.deps.now();
    const run = startRunWith(this.deps, def, suppressed, now);
    this.deps.saveRun(run);
    this.travelFrom = 1;
    this.scene = {
      video: dungeonAsset(def, def.video.enter),
      poster: dungeonAsset(def, def.cover),
      text: def.opening,
    };
    this.deps.play('秘境-入阵');
  }

  /** 一趟的主循环：赶路 → 等选择 → advance → 存档 → 演出 → 下一轮 */
  private async continueLoop(win: AdventureWindow): Promise<void> {
    const def = this.deps.def;
    while (!this.stopped()) {
      const run = this.deps.getRun();
      if (!run || run.status === 'over') return;
      this.updatePendingScene(run);
      const choices = choicesOf(def, run, this.deps.fighter());
      const remaining = run.readyAt - this.deps.now();
      if (remaining > 0) {
        const from = this.travelFrom ?? Math.max(1, run.layer - 1);
        this.travelling = true;
        this.deps.onChange?.();
        // 赶路时不给选项（点不出来），只留小窗右上角的「关掉」：关掉也在这趟存档里，回菜单接着走
        win.render(this.runView(run, [], { from, to: run.layer, ms: remaining }, false));
        const arrived = this.waitTravel(remaining).then(() => true);
        const closed = win.wait().then((answer) => answer === null || answer.kind === 'close');
        const ok = await Promise.race([arrived, closed.then((isClosed) => !isClosed)]);
        win.cancelWait();
        if (!ok) this.stopTravel();
        this.travelling = false;
        this.travelFrom = null;
        this.deps.onChange?.();
        if (this.stopped() || !ok) {
          this.suspended = true;
          return;
        }
        continue;
      }
      win.render(this.runView(run, choices, null, false));
      const answer = await win.wait();
      if (answer === null || answer.kind === 'close') {
        this.suspended = true;
        return;
      }
      if (answer.kind === 'toggle-full') {
        this.fullShow = answer.on === true;
        continue;
      }
      const decision = this.decisionOf(choices, answer);
      if (!decision) continue;
      const before = run;
      let next: { run: Run; outcome: StepOutcome };
      try {
        next = advance(def, run, this.deps.fighter(), decision, this.deps.now());
      } catch {
        // 页面递回来的决定不在 `choicesOf` 里（正常点不出来）：重新画一遍，别让这一趟卡死
        continue;
      }
      this.deps.saveRun(next.run);
      if (next.run.readyAt > this.deps.now()) this.travelFrom = before.layer;
      await this.showOutcome(next.run, next.outcome, this.nodeOf(decision));
      if (this.stopped()) return;
      const end = this.endOf(next.outcome);
      if (!end) continue;
      const again = await this.finish(next.run, end, win);
      if (!again) return;
      this.beginRun(next.run.suppressed);
      if (this.stopped()) return;
    }
  }

  /** 本层还等主人点的那一下：场景换成这个节点的插画和文字 */
  private updatePendingScene(run: Run): void {
    if (!run.pending) return;
    const node = this.deps.def.nodes[run.pending.node];
    if (!node) return;
    this.scene = {
      art: dungeonAsset(this.deps.def, node.art ?? this.layerArt(run.layer)),
      text: resolveText(node.text, run),
    };
  }

  private layerArt(layer: number): string {
    const found = this.deps.def.layers.find((item) => item.index === layer);
    return found?.art ?? this.deps.def.map;
  }

  private defaultScene(run: Run): AdventureSceneView {
    if (run.pending) {
      const node = this.deps.def.nodes[run.pending.node];
      if (node) {
        return {
          art: dungeonAsset(this.deps.def, node.art ?? this.layerArt(run.layer)),
          text: resolveText(node.text, run),
        };
      }
    }
    const layer = this.deps.def.layers.find((item) => item.index === run.layer);
    return {
      art: dungeonAsset(this.deps.def, layer?.art ?? this.deps.def.map),
      text: layer ? [`第 ${run.layer} 层 · ${layer.name}`] : [this.deps.def.name],
    };
  }

  /** 这一步要演什么：换场景、播宠物动作、打一场 */
  private async showOutcome(run: Run, outcome: StepOutcome, nodeId: string | null): Promise<void> {
    const result: OutcomeResult = outcome.result;
    const node = nodeId ? this.deps.def.nodes[nodeId] : undefined;
    const art = nodeId ? dungeonAsset(this.deps.def, node?.art ?? this.layerArt(run.layer)) : undefined;
    const text = nodeId && node ? resolveText(node.text, run) : this.scene.text;
    switch (result.kind) {
      case 'enter':
        this.scene = { ...(art ? { art } : {}), text: result.text };
        if (result.anim) this.deps.play(result.anim);
        return;
      case 'fight':
        this.scene = { ...(art ? { art } : {}), text };
        await this.showFight(run, result);
        return;
      case 'chest':
        this.scene = { ...(art ? { art } : {}), text: result.text };
        if (result.anim) this.deps.play(result.anim);
        return;
      case 'spring':
        this.scene = { ...(art ? { art } : {}), text: [`调息，气血 +${result.healed}（${result.hp}）`] };
        if (result.anim) this.deps.play(result.anim);
        return;
      case 'event':
        this.scene = { ...(art ? { art } : {}), text: result.text };
        if (result.fought) await this.showFight(run, result.fought);
        if (result.anim) this.deps.play(result.anim);
        return;
      case 'blessing':
        this.scene = { ...(art ? { art } : {}), text: [`${result.name}：${result.text}`] };
        if (result.anim) this.deps.play(result.anim);
        return;
      case 'rewind':
        this.scene = {
          video: dungeonAsset(this.deps.def, result.video),
          poster: dungeonAsset(this.deps.def, this.deps.def.cover),
          text: result.text,
        };
        return;
      case 'end':
        this.scene = { text: result.text };
        return;
    }
  }

  /** 打一场：小窗缩成屏顶一条，快进按钮也能收场（结果早已记账） */
  private async showFight(run: Run, result: FightResult): Promise<void> {
    const win = this.win;
    if (!win) return;
    this.fighting = true;
    this.deps.onChange?.();
    win.setCompact(true);
    win.render(this.runView(run, [], null, true));
    const skipWatcher = win.wait().then((answer) => {
      if (answer?.kind === 'skip') this.deps.skipFight();
    });
    try {
      await this.deps.fight({ result, full: this.fullShow });
    } finally {
      win.cancelWait();
      win.setCompact(false);
      this.fighting = false;
      this.deps.onChange?.();
    }
    void skipWatcher;
  }

  /** 收场：入账、冒泡、日记、宠物动作、游记总结，最后是结局页 */
  private async finish(run: Run, end: NonNullable<StepOutcome['end']>, win: AdventureWindow): Promise<boolean> {
    const events = this.deps.done(run, end.reason);
    this.deps.onEvents(events, this.deps.now());
    this.deps.diary(this.diaryText(run, end));
    const ending = end.ending ?? null;
    if (end.reason === 'clear' && ending) this.deps.play(ending.anim ?? '秘境-得宝');
    this.deps.play('秘境-出阵');
    win.render(this.endingView(run, end));
    const answered = win.wait();
    const fallback =
      end.reason === 'clear' && ending
        ? `闯${this.deps.def.name}回来啦，拿到了「${ending.name}」～`
        : '这一趟历练回来啦～';
    const instruction = this.summaryInstruction(run, end);
    const text = (await this.deps.compose(instruction, fallback).catch(() => fallback)) || fallback;
    this.deps.say(text, { anim: false });
    const answer = await answered;
    if (answer?.kind === 'again') return true;
    this.suspended = true;
    return false;
  }

  private summaryInstruction(run: Run, end: NonNullable<StepOutcome['end']>): string {
    const road = this.roadOf(run);
    const rewind = run.attempt > 1 ? '春秋蝉倒回了一次' : '没用春秋蝉';
    const result =
      end.reason === 'clear' && end.ending
        ? `拿到了「${end.ending.name}」结局`
        : end.reason === 'lose'
          ? '最后没打赢'
          : end.reason === 'retreat'
            ? '半路撤了'
            : '进了 24 小时被送出来了';
    return `你刚闯完${this.deps.def.name}（${road}一路，${rewind}，${result}）。跟主人说一句游记式的总结，别提数字。`;
  }

  private diaryText(run: Run, end: NonNullable<StepOutcome['end']>): string {
    const road = this.roadOf(run);
    const rewind = run.attempt > 1 ? '春秋蝉倒回一次' : '没用春秋蝉';
    const result =
      end.reason === 'clear'
        ? `${end.ending?.name ?? '走完'}脱身`
        : end.reason === 'lose'
          ? '没走出来'
          : end.reason === 'retreat'
            ? '半路撤了'
            : '超时被送出来';
    return `闯${this.deps.def.name}：${road}一路，${rewind}，${result}`;
  }

  private roadOf(run: Run): string {
    if (this.deps.def.id === 'sanwang') return roadLabel(run);
    return this.deps.def.name;
  }

  private endingView(run: Run, end: NonNullable<StepOutcome['end']>): AdventureView {
    const ending: EndingDef | null = end.ending ?? null;
    const fallbackName = end.reason === 'lose' ? '这一趟到此为止' : end.reason === 'retreat' ? '撤退' : '超时';
    return {
      kind: 'ending',
      title: this.deps.def.name,
      subtitle: this.roadOf(run),
      ending: {
        name: ending?.name ?? fallbackName,
        title: ending?.titles.join(' · ') ?? '',
        text: end.text,
        loot: lootLines(end.loot),
      },
    };
  }

  /** 小窗上的一趟：场景、地图、状态条、操作区 */
  private runView(
    run: Run,
    choices: Choice[],
    travel: { from: number; to: number; ms: number } | null,
    compact: boolean,
  ): AdventureView {
    const def = this.deps.def;
    const self = run.members.find((member) => member.id === run.leader) ?? run.members[0];
    const pet = this.deps.fighter();
    // 压境入内时气血上限也压到原著境界（和 buildParty 同一口径）
    const maxHp = Math.max(1, run.suppressed ? Math.min(pet.hp, typicalStats(def.originStage).hp) : pet.hp);
    const day = dayLabel(def, run);
    const loadout = choices.find((choice): choice is Extract<Choice, { kind: 'loadout' }> => choice.kind === 'loadout');
    const view: AdventureRunView = {
      scene: {
        ...this.scene,
        ...(this.scene.art ? { fallback: dungeonAsset(def, def.map) } : {}),
      },
      hp: { now: Math.max(0, self.hp), max: maxHp },
      map: {
        current: run.layer,
        layers: this.mapLayers(run),
        travel,
      },
      mapArt: dungeonAsset(def, def.map),
      avatar: genericAsset('头像.png'),
      blessings: run.blessings.map((id) => ({ name: BLESSINGS[id].name, card: genericAsset(BLESSINGS[id].card) })),
      loot: lootLines(self.loot),
      gu: this.guText(run),
      cicada: run.flags.rewound === true ? '春秋蝉 · 已沉眠' : '春秋蝉 · 还在',
      day,
      text: this.scene.text,
      choices: choices.filter((choice) => choice.kind !== 'loadout').map((choice) => this.choiceView(def, choice)),
      loadout: loadout
        ? {
            node: loadout.node,
            max: loadout.max,
            weapons: loadout.weapons.map((id) => ({ id, name: WEAPONS[id].name })),
            foe: {
              name: loadout.foe.name,
              tactics: loadout.foe.tactics,
              moves: loadout.foe.moves,
            },
          }
        : null,
      fullShow: this.fullShow,
      fullToggle: choices.some(
        (choice) => choice.kind === 'node' && choice.foe !== undefined && choice.foe.tier !== 'boss',
      ),
      compact,
      canSkip: compact,
    };
    return {
      kind: 'run',
      title: def.name,
      subtitle: day?.label ?? def.name,
      run: view,
    };
  }

  private mapLayers(run: Run): AdventureMapLayerView[] {
    const def = this.deps.def;
    const visible = new Set(visibleLayers(def, run));
    const reachable = new Set(reachableNodes(def, run));
    return def.layers.map((layer) => {
      const state: AdventureMapLayerView['state'] =
        layer.index < run.layer
          ? 'done'
          : layer.index === run.layer
            ? 'current'
            : visible.has(layer.index)
              ? layer.index === run.layer + 1
                ? 'next'
                : 'revealed'
              : 'hidden';
      const ids = state === 'hidden' ? [] : layerNodeIdsOf(def, run, layer.index);
      const nodes: AdventureMapLayerView['nodes'] = ids.length
        ? ids.map((id) => {
            const node = def.nodes[id];
            const nodeState: AdventureMapNodeState =
              layer.index < run.layer
                ? 'done'
                : layer.index === run.layer
                  ? reachable.has(id)
                    ? 'now'
                    : 'done'
                  : state === 'next'
                    ? 'next'
                    : 'revealed';
            return { id, name: node?.name ?? id, icon: genericAsset(node?.icon ?? '图标-奇遇'), state: nodeState };
          })
        : [{ id: `hidden-${layer.index}`, name: '？', icon: genericAsset('图标-奇遇'), state: 'hidden' }];
      return { index: layer.index, name: layer.name, state, nodes };
    });
  }

  private choiceView(def: DungeonDef, choice: Exclude<Choice, { kind: 'loadout' }>): AdventureChoiceView {
    if (choice.kind === 'node') {
      const note = choice.foe ? `${tierLabel(choice.foe.tier)} · ${choice.foe.name}` : undefined;
      return {
        kind: 'node',
        id: choice.node.id,
        label: choice.node.name,
        ...(note ? { note } : {}),
        icon: genericAsset(choice.node.icon),
      };
    }
    if (choice.kind === 'choice') {
      const config = def.nodes[choice.node]?.event?.choices?.[choice.index];
      const rate = choice.rate === undefined ? '' : `，约 ${Math.round(choice.rate * 100)}%`;
      const check = config?.check ? `（${statLabel(config.check.stat)}${rate}）` : '';
      const note = [choice.note, check].filter(Boolean).join(' · ');
      return { kind: 'choice', node: choice.node, index: choice.index, label: choice.label, ...(note ? { note } : {}) };
    }
    if (choice.kind === 'blessing') {
      return {
        kind: 'blessing',
        node: choice.node,
        blessing: choice.blessing,
        label: choice.name,
        note: choice.text,
        card: genericAsset(choice.card),
      };
    }
    return { kind: choice.kind, label: choice.label };
  }

  private guText(run: Run): string {
    const road = run.flags.road;
    if (road === 'letter') return '纸鹤蛊 · 已替你看过路';
    if (road === 'blast') return '爆蛋蛊 · 一场 3 颗';
    if (road === 'dog') {
      const dogs = typeof run.flags.dogs === 'number' ? run.flags.dogs : 2;
      return `驭犬蛊 · ${dogs} 只（${dogs} 条狗）`;
    }
    return '还没拿到一转蛊';
  }

  private decisionOf(choices: Choice[], answer: AdventureAnswer): Decision | null {
    if (answer.kind === 'node') {
      return choices.some((choice) => choice.kind === 'node' && choice.node.id === answer.node)
        ? { kind: 'node', node: answer.node }
        : null;
    }
    if (answer.kind === 'choice') {
      const found = choices.find(
        (choice) => choice.kind === 'choice' && choice.node === answer.node && choice.index === answer.index,
      );
      return found ? { kind: 'choice', node: answer.node, index: answer.index } : null;
    }
    if (answer.kind === 'blessing') {
      const found = choices.find(
        (choice) => choice.kind === 'blessing' && choice.node === answer.node && choice.blessing === answer.blessing,
      );
      return found ? { kind: 'blessing', node: answer.node, blessing: answer.blessing as BlessingId } : null;
    }
    if (answer.kind === 'loadout') {
      const found = choices.find((choice) => choice.kind === 'loadout' && choice.node === answer.node);
      if (!found || found.kind !== 'loadout') return null;
      const allowed = found.weapons as string[];
      const weapons = answer.weapons.filter((id) => allowed.includes(id)).slice(0, found.max) as WeaponId[];
      return { kind: 'loadout', node: answer.node, weapons };
    }
    if (answer.kind === 'rewind') return choices.some((choice) => choice.kind === 'rewind') ? { kind: 'rewind' } : null;
    if (answer.kind === 'end') return choices.some((choice) => choice.kind === 'end') ? { kind: 'end' } : null;
    if (answer.kind === 'retreat')
      return choices.some((choice) => choice.kind === 'retreat') ? { kind: 'retreat' } : null;
    return null;
  }

  private nodeOf(decision: Decision): string | null {
    if (decision.kind === 'node') return decision.node;
    if (decision.kind === 'choice' || decision.kind === 'blessing' || decision.kind === 'loadout') return decision.node;
    const action = decision.kind === 'action' ? decision.node : null;
    return action;
  }

  private endOf(outcome: StepOutcome): NonNullable<StepOutcome['end']> | null {
    if (outcome.end) return outcome.end;
    const result = outcome.result;
    if (result.kind === 'end')
      return { reason: result.reason, loot: result.loot, text: result.text, ending: result.ending };
    return null;
  }

  private waitTravel(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.travelResolve = resolve;
      this.travelTimer = this.deps.setTimeout(
        () => {
          this.travelTimer = null;
          this.travelResolve = null;
          resolve();
        },
        Math.max(0, ms),
      );
    });
  }

  private stopped(): boolean {
    return this.disposed || this.suspended;
  }
}

/** `startRun` 的窄封装：种子、宠物、境界都从注入的依赖取 */
function startRunWith(deps: AdventureFlowDeps, def: DungeonDef, suppressed: boolean, now: number): Run {
  const nonce = `${now.toString(36)}-${Math.floor(deps.random() * 0xffffffff).toString(36)}`;
  return startRun(def, { pet: deps.fighter(), stage: deps.stage(), suppressed, nonce, now });
}
