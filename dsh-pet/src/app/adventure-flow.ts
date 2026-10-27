/**
 * 历练流程（历练路线 Y3）：小窗 → 等主人点 → `advance`（纯逻辑）→ 存档 → 演这一步 → 下一轮。
 *
 * 流程全在这里，`features.ts` 只把真东西（小窗、演出、存档、时钟）注入进来，测试用假窗口和假时钟。
 * **先记账再演出**：每一步都由 `dungeon.advance` 先算完、`saveRun` 写进存档，再去演；演到一半退出 app，
 * 重开时这一步已经算完，直接到下一个决定，不会重算、不会换结果。
 *
 * 赶路 15 秒从做决定那一刻算起（`run.readyAt`），小窗倒数、宠物播一次 `秘境-赶路`；
 * 演出比赶路长就等演完，赶路比演出长就等赶路走完。打起来时小窗缩成屏顶一条（名字、气血、快进）。
 *
 * 自动走（Y4）：开着时每个要选的地方等赶路走完再停 1.5 秒，然后照 `dungeon.autoDecide` 挑；这 1.5 秒里
 * 主人自己点了就按主人的。小窗可以收起（只藏起来，流程不停）和拖动（拖过的位置这次打开 app 期间记住）。
 *
 * 高光（Y5）：选了带 `cutscene` / `cameo` 的选项，小窗先播过场、桌面同时让客串角色冒几句，再往下走；
 * 结局的 `cutscene` 在结局页之前播。小窗收起着时不播过场，台词改成宠物冒泡。
 */
import {
  BLESSINGS,
  advance,
  autoDecide,
  choicesOf,
  dayLabel,
  layerNodeIdsOf,
  maxHpOf,
  reachableNodes,
  resolveText,
  startRun,
  visibleLayers,
} from './dungeon';
import type {
  BlessingId,
  CameoDef,
  Choice,
  CutsceneDef,
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
import type { Rect } from './visit-windows';
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
  /** 完整演出（守护必开；小怪、精英看开关，Y5 起默认开） */
  full: boolean;
}

/** 桌面客串：不打架的角色只露立绘、冒几句（Y5） */
export interface AdventureCameoRequest {
  foe: string;
  lines: string[];
}

/** 自动走在一个要选的地方停多久，让主人看清有哪些选项 */
export const AUTO_PICK_MS = 1_500;

/** 流程用到的全部外部能力：features.ts 把真的传进来，测试传假的 */
export interface AdventureFlowDeps {
  def: DungeonDef;
  /** 开一扇小窗（页面走 /app/adventure）；`parked` 是上次主人拖到的位置 */
  openWindow: (parked: Rect | null) => AdventureWindow;
  /** 演一场（速战或完整；返回时窗口、擂台、特效层已经收好） */
  fight: (request: AdventureFightRequest) => Promise<void>;
  /** 让一个不打架的角色在桌面上客串（只露立绘、冒几句，不开擂台） */
  cameo: (request: AdventureCameoRequest) => Promise<void>;
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
  /** 自动走：这次打开 app 期间记住，不进存档 */
  private auto = false;
  /** 小窗收起来了（只藏起来，这一趟还在走） */
  private collapsed = false;
  /** 主人拖到过哪里：这次打开 app 期间小窗都停在这儿 */
  private parked: Rect | null = null;
  /** 自动走的 1.5 秒计时 */
  private autoTimer: unknown = null;
  /** 菜单切了自动走：把等主人点的那一头叫醒，重新按新状态等 */
  private nudgeResolve: (() => void) | null = null;

  private readonly deps: AdventureFlowDeps;

  constructor(deps: AdventureFlowDeps) {
    this.deps = deps;
    // Y5：小怪、精英也默认完整演出；开关还在，关掉就是速战
    this.fullShow = true;
  }

  /** 小窗开着（入口页、一趟里、结局页都算；收起来了也算，流程没停） */
  get active(): boolean {
    return this.activeFlag;
  }

  /** 收起来了：不算「小窗开着」，但宠物还在秘境里 */
  get hidden(): boolean {
    return this.collapsed;
  }

  /** 这一趟还在走（不是入口页、结局页） */
  get running(): boolean {
    const run = this.deps.getRun();
    return run !== null && run.status !== 'over';
  }

  /** 要不要在菜单里藏起心魔试炼和渡劫：小窗可见时照 Y3，收起来时只看这一趟还在不在走 */
  get blocking(): boolean {
    return this.activeFlag && (!this.collapsed || this.running);
  }

  /** 自动走开着？ */
  get autoWalk(): boolean {
    return this.auto;
  }

  /** 菜单 / 小窗切自动走：状态变了叫醒等主人点的那一头，让它按新状态接着走 */
  setAutoWalk(on: boolean): void {
    if (this.auto === on) return;
    this.auto = on;
    this.deps.onChange?.();
    const resolve = this.nudgeResolve;
    this.nudgeResolve = null;
    resolve?.();
  }

  toggleAutoWalk(): void {
    this.setAutoWalk(!this.auto);
  }

  /** 正在打或者正在赶路：这时候不能出门串门 */
  get busy(): boolean {
    return this.fighting || this.travelling;
  }

  /** 菜单点了：开小窗；存档里有没走完的一趟就直接接着走；收起来的小窗叫回来 */
  open(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.activeFlag) {
      this.showWindow();
      return this.loop ?? Promise.resolve();
    }
    this.win = this.deps.openWindow(this.parked);
    this.activeFlag = true;
    this.suspended = false;
    this.collapsed = false;
    this.deps.onChange?.();
    const win = this.win;
    const session = this.runSession(win).finally(() => {
      if (this.win === win) {
        this.parked = win.position() ?? this.parked;
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
    this.stopAuto();
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
    this.stopAuto();
    this.stopTravel();
    this.win?.close(0);
  }

  /** 收起小窗：只藏起来，流程不停 */
  private collapseWindow(win: AdventureWindow): void {
    if (this.collapsed) return;
    this.collapsed = true;
    win.hide();
  }

  /** 从菜单叫回来：页面一直是按最新状态画的 */
  private showWindow(): void {
    const win = this.win;
    if (!win) return;
    this.collapsed = false;
    win.show();
    if (this.fighting) {
      const run = this.deps.getRun();
      if (run && run.status !== 'over') {
        win.setCompact(true);
        win.render(this.runView(run, [], null, true));
      }
    }
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

  private stopAuto(): void {
    if (this.autoTimer === null) return;
    this.deps.clearTimeout(this.autoTimer);
    this.autoTimer = null;
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
    win.render(this.entryView());
    while (!this.stopped()) {
      const answer = await this.waitAnswer(win);
      if (this.stopped()) return;
      if (answer === 'nudge') {
        win.cancelWait();
        continue;
      }
      if (answer === null || answer.kind === 'close') {
        this.suspended = true;
        return;
      }
      if (answer.kind === 'hide') {
        this.collapseWindow(win);
        continue;
      }
      if (answer.kind === 'toggle-auto') {
        this.auto = answer.on === true;
        this.deps.onChange?.();
        continue;
      }
      if (answer.kind !== 'enter') continue;
      this.beginRun(answer.suppressed === true);
      return;
    }
  }

  private entryView(): AdventureView {
    const def = this.deps.def;
    const progress = this.deps.progress();
    return {
      kind: 'entry',
      title: def.name,
      subtitle: def.opening[0] ?? '',
      auto: this.auto,
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
    };
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
        // 赶路时不给选项（点不出来），只留小窗右上角的「收起」「关掉」：关掉也在这趟存档里，回菜单接着走
        win.render(this.runView(run, [], { from, to: run.layer, ms: remaining }, false));
        const arrived = this.waitTravel(remaining).then(() => 'arrived' as const);
        const answered = this.waitAnswer(win);
        const first = await Promise.race([arrived, answered]);
        this.stopTravel();
        win.cancelWait();
        this.travelling = false;
        this.travelFrom = null;
        this.deps.onChange?.();
        if (this.stopped()) return;
        if (first === 'arrived') continue;
        if (first === 'nudge') continue;
        if (first === null || first.kind === 'close') {
          this.suspended = true;
          return;
        }
        if (first.kind === 'hide') {
          this.collapseWindow(win);
          continue;
        }
        if (first.kind === 'toggle-auto') {
          this.auto = first.on === true;
          this.deps.onChange?.();
          continue;
        }
        continue;
      }
      win.render(this.runView(run, choices, null, false));
      const picked = await this.waitChoice(win);
      if (this.stopped()) return;
      if (picked === 'nudge') continue;
      let decision: Decision | null;
      if (picked === 'auto') {
        decision = autoDecide(def, run, this.deps.fighter());
      } else {
        if (picked === null || picked.kind === 'close') {
          this.suspended = true;
          return;
        }
        if (picked.kind === 'hide') {
          this.collapseWindow(win);
          continue;
        }
        if (picked.kind === 'toggle-full') {
          this.fullShow = picked.on === true;
          continue;
        }
        if (picked.kind === 'toggle-auto') {
          this.auto = picked.on === true;
          this.deps.onChange?.();
          continue;
        }
        decision = this.decisionOf(choices, picked);
      }
      if (!decision) continue;
      const before = run;
      let next: { run: Run; outcome: StepOutcome };
      try {
        next = advance(def, run, this.deps.fighter(), decision, this.deps.now());
      } catch (error) {
        // 页面递回来的决定不在 `choicesOf` 里（正常点不出来）：重新画一遍，别让这一趟卡死。
        // 自动挑的走不通是逻辑 bug，别每 1.5 秒转一圈，直接抛出去。
        if (picked === 'auto') throw error;
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

  /** 等主人点一下或者自动走的时间到；菜单切了自动走（nudge）就回去重画重等 */
  private waitAnswer(win: AdventureWindow): Promise<AdventureAnswer | null | 'nudge'> {
    return new Promise((resolve) => {
      let done = false;
      this.nudgeResolve = () => {
        if (done) return;
        done = true;
        this.nudgeResolve = null;
        resolve('nudge');
      };
      void win.wait().then((answer) => {
        if (done) return;
        done = true;
        this.nudgeResolve = null;
        resolve(answer);
      });
    });
  }

  /**
   * 要选的地方：等主人点，自动走开着就等 1.5 秒后让 `autoDecide` 挑。
   * 这 1.5 秒里主人点了，按主人的（用户的那一脚照旧走 `advance` → `saveRun` → 演出）。
   */
  private async waitChoice(win: AdventureWindow): Promise<AdventureAnswer | null | 'nudge' | 'auto'> {
    const answered = this.waitAnswer(win);
    if (!this.auto) return answered;
    const due = new Promise<'auto'>((resolve) => {
      this.autoTimer = this.deps.setTimeout(
        () => {
          this.autoTimer = null;
          resolve('auto');
        },
        Math.max(0, AUTO_PICK_MS),
      );
    });
    const picked = await Promise.race([answered, due]);
    this.stopAuto();
    if (picked === 'auto' || picked === 'nudge') {
      win.cancelWait();
      return picked;
    }
    return picked;
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
      case 'event': {
        const base: AdventureSceneView = { ...(art ? { art } : {}), text: result.text };
        this.scene = base;
        // 过场和客串同时开始（Y5）：过场在小窗场景图位置播，客串在桌面上冒台词
        const cutscene = result.cutscene
          ? this.playCutscene(run, result.cutscene, result.cameo?.art)
          : Promise.resolve();
        const cameo = result.cameo ? this.playCameo(result.cameo) : Promise.resolve();
        await Promise.all([cutscene, cameo]);
        if (this.stopped()) return;
        this.scene = {
          ...base,
          ...(result.cameo?.art ? { art: dungeonAsset(this.deps.def, result.cameo.art) } : {}),
        };
        if (result.fought) await this.showFight(run, result.fought);
        if (result.anim) this.deps.play(result.anim);
        return;
      }
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

  /**
   * 过场（Y5）：小窗场景图位置播视频，原话一句一句淡入；播完或者主人点一下跳过再往下走。
   * 小窗收起着时不播过场，台词改成宠物冒泡（同 §2.1 的兜底）。
   */
  private async playCutscene(run: Run, cutscene: CutsceneDef, poster?: string): Promise<void> {
    if (this.collapsed) {
      this.speakLines(cutscene.lines);
      return;
    }
    const win = this.win;
    if (!win) return;
    const def = this.deps.def;
    this.scene = {
      video: dungeonAsset(def, cutscene.video),
      poster: dungeonAsset(def, poster ?? def.cover),
      fallback: dungeonAsset(def, def.map),
      text: [],
    };
    win.render(this.runView(run, [], null, false, cutscene.lines));
    if (cutscene.say) this.deps.say(cutscene.say, { anim: false });
    let answer = await win.wait();
    // 过场里切了自动走：记下状态，接着等这一段落演完
    while (answer?.kind === 'toggle-auto' && !this.stopped()) {
      this.auto = answer.on === true;
      this.deps.onChange?.();
      answer = await win.wait();
    }
    if (answer?.kind === 'hide') {
      this.collapseWindow(win);
      this.speakLines(cutscene.lines);
      return;
    }
    if (answer === null || answer.kind === 'close') {
      this.suspended = true;
      return;
    }
  }

  /** 桌面上让客串角色冒几句；窗口开不出来就把台词改成宠物冒泡（素材缺了不挡流程） */
  private async playCameo(cameo: CameoDef): Promise<void> {
    try {
      await this.deps.cameo({ foe: cameo.foe, lines: cameo.lines });
    } catch {
      this.speakLines(cameo.lines);
    }
  }

  /** 收起小窗 / 客串失败时：台词改成宠物冒泡，一句一行 */
  private speakLines(lines: string[]): void {
    if (lines.length === 0) return;
    this.deps.say(lines.join('\n'), { anim: false });
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
    // 这一趟走完了：菜单里的「自动走」收掉；藏着的窗口也不再挡心魔试炼和渡劫
    this.deps.onChange?.();
    const ending = end.ending ?? null;
    if (end.reason === 'clear' && ending) this.deps.play(ending.anim ?? '秘境-得宝');
    // 定仙游结局：先播结局过场（和宠物的碧芒一闪同时开始），再进结局页（Y5）
    if (ending?.cutscene) await this.playCutscene(run, ending.cutscene);
    if (this.stopped()) return false;
    this.deps.play('秘境-出阵');
    win.render(this.endingView(run, end));
    // 藏着走完：小窗不自己弹出来，只在桌面上说一声
    if (this.collapsed) this.deps.say(`${this.deps.def.name}走完了`, { anim: false });
    const answered = win.wait();
    const fallback =
      end.reason === 'clear' && ending
        ? `闯${this.deps.def.name}回来啦，拿到了「${ending.name}」～`
        : '这一趟历练回来啦～';
    const instruction = this.summaryInstruction(run, end);
    const text = (await this.deps.compose(instruction, fallback).catch(() => fallback)) || fallback;
    this.deps.say(text, { anim: false });
    let answer = await answered;
    // 结局页也能收起：藏起来等主人从菜单叫回来，不能当「关掉」把这一趟丢了
    while (answer?.kind === 'hide' && !this.stopped()) {
      this.collapseWindow(win);
      answer = await win.wait();
    }
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
    cutsceneLines: string[] | null = null,
  ): AdventureView {
    const def = this.deps.def;
    const self = run.members.find((member) => member.id === run.leader) ?? run.members[0];
    const pet = this.deps.fighter();
    // 压境入内时气血上限也压到原著境界（和 buildParty 同一口径）
    const maxHp = maxHpOf(def, run, pet);
    const day = dayLabel(def, run);
    const loadout = choices.find((choice): choice is Extract<Choice, { kind: 'loadout' }> => choice.kind === 'loadout');
    const view: AdventureRunView = {
      scene: {
        ...this.scene,
        ...(this.scene.art || this.scene.video ? { fallback: dungeonAsset(def, def.map) } : {}),
      },
      // 压境修正之前开的一趟，存档里的气血可能还高过上限：显示时夹住（战斗里引擎本来也会夹）
      hp: { now: Math.min(maxHp, Math.max(0, self.hp)), max: maxHp },
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
      // 只有在选下一个节点时地图才亮成能点的；等奇遇、加持、法宝、春秋蝉、两问时不接点击（Y5）
      mapClickable: choices.some((choice) => choice.kind === 'node'),
      cutscene: cutsceneLines ? { lines: cutsceneLines } : null,
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
      auto: this.auto,
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
