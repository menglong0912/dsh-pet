/**
 * 历练的战斗演出（历练路线 Y3）：把 Y2 的对手窗口、现有的擂台和特效层接成 `AdventureFlow` 要的「演一场」。
 *
 * 小怪 / 精英默认完整演出（Y5），关了开关才走速战；守护和开了「完整演出」的走完整时间线；对手的皮用
 * `FoeDef.skin ?? prefix`，精英传 `elite`，开演前 `foe.preload(...)`。每一场自己开一组窗口，演完
 * `CLOSE_HOLD_MS` 收自己这组（§X14 那套）。
 * `cameo`（Y5）只开一扇对手窗口，让不打架的角色客串几句，不开擂台和特效层。
 * `features.ts` 只把这个工厂的 `fight` / `cameo` / `closeAll` 接进流程。
 */
import { rngFrom } from './battle';
import type { BattleEvent, SkillId } from './battle';
import { startLiveBattle } from './battle-live';
import type { LiveBattle } from './battle-live';
import { createDashRig, screenUnion } from './battle-dash';
import type { DashRig } from './battle-dash';
import { BattleShow, quickTimeline, timeline } from './battle-show';
import type { Shot, ShowSides, Step } from './battle-show';
import { arenaScoreboard, openArenaWindow } from './arena-window';
import type { ArenaUpdate, ArenaWindow } from './arena-window';
import { SANWANG } from './dungeon-sanwang';
import { openFoeWindow } from './foe-window';
import type { FoeWindow } from './foe-window';
import type { FxWindow } from './fx-window';
import type { PetBox, Rect, WindowElectron } from './visit-windows';
import type { AdventureCameoRequest, AdventureFightRequest, AdventureLiveFightRequest } from './adventure-flow';

/** 一场历练战斗开的三扇窗（每场记一组，收摊只关自己这组） */
interface FightWindows {
  foe: FoeWindow;
  arena: ArenaWindow;
  fx: FxWindow;
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, Math.max(0, ms)));
}

export interface AdventureShowDeps {
  electron: WindowElectron;
  /** 插件路由前缀（拼对手立绘用） */
  petBase: string;
  /** 自家宠物现在的位置 */
  home: () => PetBox | null;
  /** 开特效层（features 的 openShowFx） */
  openFx: (foeBounds: () => Rect | null, foeOnLeft: () => boolean) => FxWindow;
  holdPet: (steps: Step[], durationMs?: number) => Promise<void>;
  releasePet: (afterMs: number) => void;
  /** 把这一场的 BattleShow 交给 features（菜单的「快进」要能拿到它） */
  setBattle: (show: BattleShow | null) => void;
  /** 把逐手局交给 features（「快进」、退出时一起收；和心魔的 `state.liveBattle` 同一口径） */
  setLiveBattle: (live: LiveBattle | null) => void;
  refreshMenu: () => void;
  playExtra: (anim: string, options?: { facing?: 'left' | 'right'; rate?: number }) => void;
  /** 自家宠物按 `POST /position` 的 `line` 挪（X16 冲刺用；带演出锁由 features 的 petRequest 负责） */
  movePet: (x: number, y: number, durationMs: number) => void;
  say: (text: string, options: { anim: false; durationMs: number }) => void;
  /** 当前境界（擂台自家那条的标签） */
  stageLabel: () => string;
  disposed: () => boolean;
  closeHoldMs: number;
  /** 客串台词之间隔多久（默认 2.5 秒；测试传小一点） */
  cameoLineMs?: number;
}

export interface AdventureShows {
  fight(request: AdventureFightRequest): Promise<void>;
  /** 守护的逐手局：演完回事件（收摊 / 退出回 null，run 里已经记下的出手留着续打） */
  liveFight(request: AdventureLiveFightRequest): Promise<BattleEvent[] | null>;
  /** 桌面上让一个不打架的角色客串：只露立绘、冒几句（Y5） */
  cameo(request: AdventureCameoRequest): Promise<void>;
  /** 关掉所有还没收完的历练窗口（0 = 立刻，CLOSE_HOLD_MS = 演完停一会儿） */
  closeAll(afterMs: number): void;
}

/** 档位标签（擂台用） */
function tierName(tier: 'mob' | 'elite' | 'boss'): string {
  return tier === 'mob' ? '小怪' : tier === 'elite' ? '精英' : '守护';
}

export function createAdventureShows(deps: AdventureShowDeps): AdventureShows {
  const groups = new Set<FightWindows>();
  /** 客串窗口：不打架，收摊 / 退出时也要关掉 */
  const cameos = new Set<FoeWindow>();
  function closeOne(windows: FightWindows, afterMs: number): void {
    const close = (): void => {
      if (!groups.delete(windows)) return;
      windows.foe.close(0);
      windows.arena.close(0);
      windows.fx.close(0);
    };
    if (afterMs <= 0) close();
    else setTimeout(close, afterMs);
  }
  /** 打开这一场的三扇窗（对手、擂台、特效层），并预取对手动作；名册里没有就 null */
  function openScene(
    foeId: string,
  ): (FightWindows & { roster: NonNullable<(typeof SANWANG.foes)[string]>; prefix: string }) | null {
    const roster = SANWANG.foes[foeId];
    if (!roster) return null;
    const prefix = roster.skin ?? roster.prefix;
    /** 已经开出来的窗口：半路开不出下一扇就先关掉，别留下没人管的 */
    const opened: { close(afterMs: number): void }[] = [];
    try {
      const foe = openFoeWindow(
        deps.electron,
        `${new URL(deps.petBase).origin}/app/foe`,
        {
          name: roster.name,
          portrait: `${deps.petBase}/pic/adventure/${encodeURIComponent('三王传承')}/${encodeURIComponent(`${prefix}.png`)}`,
          prefix,
          ...(roster.filter ? { filter: roster.filter } : {}),
          ...(roster.eliteLook ? { elite: true } : {}),
        },
        deps.home,
      );
      opened.push(foe);
      const arena = openArenaWindow(deps.electron, `${new URL(deps.petBase).origin}/app/arena`, deps.home, () =>
        foe.bounds(),
      );
      opened.push(arena);
      // 开演前把对手要播的动作取到窗口里（Y2）：换源不等网络，出手才和飞行物对得上
      foe.preload(['起手', '出手', '绝招', '受击', '闪避', '倒地', '胜利']);
      const fx = deps.openFx(
        () => foe.bounds(),
        () => foe.side === 'left',
      );
      opened.push(fx);
      // 这一组窗口进 groups 的是 scene 本身：closeOne 按对象身份删，返回副本会删不掉、窗口全漏
      const scene: FightWindows & { roster: NonNullable<(typeof SANWANG.foes)[string]>; prefix: string } = {
        foe,
        arena,
        fx,
        roster,
        prefix,
      };
      groups.add(scene);
      return scene;
    } catch (error) {
      for (const win of opened) win.close(0);
      throw error;
    }
  }

  /** 这一场的几只手：自家播宠物动作、对手走它的皮，气血条与飞行物跟着两边挪 */
  function showSides(
    scene: FightWindows & { prefix: string },
    scoreboard: (hp: [number, number]) => ArenaUpdate,
    dash: DashRig,
  ): ShowSides {
    return {
      self: {
        play: (anim, rate) => deps.playExtra(anim, { facing: scene.foe.side === 'left' ? 'left' : 'right', rate }),
        say: (line, durationMs) => deps.say(line, { anim: false, durationMs }),
      },
      foe: {
        play: (anim, rate) => scene.foe.play(anim, rate),
        say: (line, durationMs) => scene.foe.say(line, durationMs),
      },
      arena: (hp) => {
        scene.arena.place(deps.home(), scene.foe.bounds());
        scene.arena.update(scoreboard(hp));
        scene.fx.place();
      },
      shoot: (shot: Shot, who: 0 | 1) => scene.fx.fire(shot, who),
      dash: (who, dir, ms) => dash.run(who, dir, ms),
      dashEnd: (force) => dash.end(force),
    };
  }

  /** 一场的冲刺（X16）：秘境对手窗口钉住按帧挪，擂台和特效层按开场站位摆 */
  function dashOf(scene: FightWindows): DashRig {
    return createDashRig({
      box: deps.home,
      union: () => screenUnion(deps.electron.screen),
      foe: scene.foe,
      pinStage: (on) => {
        scene.arena.pin(on);
        scene.fx.pin(on);
      },
      moveSelf: (x, y, ms) => deps.movePet(x, y, ms),
    });
  }

  async function fight(request: AdventureFightRequest): Promise<void> {
    const scene = openScene(request.result.foe);
    if (!scene) return;
    // 这一组窗口进 groups 的是 scene 本身：closeOne 按对象身份删，返回副本会删不掉、窗口全漏
    try {
      const you = request.result.fighters[0];
      const foeFighter = request.result.fighters[1];
      const scoreboard = arenaScoreboard({
        self: { label: `${you.name} · ${deps.stageLabel()}`, maxHp: you.hp },
        foe: { label: `${scene.roster.name} · ${tierName(scene.roster.tier)}`, maxHp: foeFighter.hp },
      });
      const rng = rngFrom(`${request.result.seed}:show`);
      const names: [string, string] = [you.name, foeFighter.name];
      const skills: [SkillId[], SkillId[]] = [you.skills, foeFighter.skills];
      const options = { foe: { prefix: scene.prefix } };
      const steps = request.full
        ? timeline(request.result.events, names, rng, skills, options)
        : quickTimeline(request.result.events, names, rng, skills, options);
      const show = new BattleShow(
        steps,
        showSides(scene, (hp) => scoreboard(hp, scene.foe.side === 'left'), dashOf(scene)),
      );
      deps.setBattle(show);
      deps.refreshMenu();
      await deps.holdPet(steps);
      await show.run();
    } finally {
      // 演完 / 中途出错都收：状态先放掉，窗口按 CLOSE_HOLD_MS 关
      deps.setBattle(null);
      deps.releasePet(deps.disposed() ? 0 : deps.closeHoldMs);
      closeOne(scene, deps.closeHoldMs);
      deps.refreshMenu();
    }
  }

  /**
   * 守护的逐手局（X18）：窗口、擂台、特效层照自动局，时间线交给 `startLiveBattle` 一段一段接；
   * 每一手由流程定（AI / 手动），定下来立刻回调写进存档。收摊 / 退出回 null。
   */
  async function liveFight(request: AdventureLiveFightRequest): Promise<BattleEvent[] | null> {
    const scene = openScene(request.foe);
    if (!scene) return null;
    let live: LiveBattle | null = null;
    try {
      const scoreboard = arenaScoreboard({
        self: { label: `${request.a.name} · ${deps.stageLabel()}`, maxHp: request.a.hp },
        foe: { label: `${scene.roster.name} · ${tierName(scene.roster.tier)}`, maxHp: request.b.hp },
      });
      // 逐手局一创建就开演第一手：先占住宠物，别让 /lock 的往返和第一段动画抢先后（同 spar）
      await deps.holdPet([], 20 * 60_000);
      if (deps.disposed()) return null;
      live = startLiveBattle({
        a: request.a,
        b: request.b,
        seed: request.seed,
        mode: request.mode,
        show: showSides(scene, (hp) => scoreboard(hp, scene.foe.side === 'left'), dashOf(scene)),
        lineRng: rngFrom(`${request.seed}:show`),
        timeline: { foe: { prefix: scene.prefix } },
        initialActions: request.initialActions,
        onDecision: request.onDecision,
        decide: request.decide,
        think: request.think,
        log: request.log,
      });
      deps.setLiveBattle(live);
      deps.refreshMenu();
      return await live.done;
    } finally {
      // 演完 / 中途出错都收：先停掉逐手局，再放状态、关这一组窗口
      live?.dispose();
      deps.setLiveBattle(null);
      deps.releasePet(deps.disposed() ? 0 : deps.closeHoldMs);
      closeOne(scene, deps.closeHoldMs);
      deps.refreshMenu();
    }
  }

  /**
   * 客串（Y5）：只开对手窗口，不打架、不开擂台和特效层。
   * 只露立绘，先播一下 CSS 轻跳（`起手` 缺视频时就是兜底动作），台词每隔 2.5 秒冒一句，说完淡出关窗。
   */
  async function cameo(request: AdventureCameoRequest): Promise<void> {
    const roster = SANWANG.foes[request.foe];
    if (!roster) throw new Error(`名册里没有客串角色 ${request.foe}`);
    const prefix = roster.skin ?? roster.prefix;
    const foe = openFoeWindow(
      deps.electron,
      `${new URL(deps.petBase).origin}/app/foe`,
      {
        name: roster.name,
        portrait: `${deps.petBase}/pic/adventure/${encodeURIComponent('三王传承')}/${encodeURIComponent(`${prefix}.png`)}`,
        prefix,
        ...(roster.filter ? { filter: roster.filter } : {}),
      },
      deps.home,
    );
    cameos.add(foe);
    try {
      foe.play('起手');
      const lineMs = Math.max(1, deps.cameoLineMs ?? 2_500);
      for (let i = 0; i < request.lines.length; i += 1) {
        if (!cameos.has(foe)) return;
        foe.say(request.lines[i], lineMs + 400);
        if (i < request.lines.length - 1) await wait(lineMs);
      }
      if (!cameos.has(foe)) return;
      await wait(Math.min(1_500, lineMs));
      if (!cameos.has(foe)) return;
      foe.fade();
      await wait(500);
    } finally {
      // 说完 / 中途出错：都别再留这扇窗（被 closeAll 先收掉的就不重复关）
      if (cameos.delete(foe)) foe.close(0);
    }
  }

  return {
    fight: fight,
    liveFight: liveFight,
    cameo: cameo,
    closeAll: (afterMs) => {
      for (const windows of [...groups]) closeOne(windows, afterMs);
      for (const foe of [...cameos]) {
        cameos.delete(foe);
        if (afterMs <= 0) foe.close(0);
        else setTimeout(() => foe.close(0), afterMs);
      }
    },
  };
}
