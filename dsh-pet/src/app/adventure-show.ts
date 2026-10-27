/**
 * 历练的战斗演出（历练路线 Y3）：把 Y2 的对手窗口、现有的擂台和特效层接成 `AdventureFlow` 要的「演一场」。
 *
 * 小怪 / 精英默认速战（约 10 秒），守护和开了「完整演出」的走完整时间线；对手的皮用 `FoeDef.skin ?? prefix`，
 * 精英传 `elite`，开演前 `foe.preload(...)`。每一场自己开一组窗口，演完 `CLOSE_HOLD_MS` 收自己这组（§X14 那套）。
 * `features.ts` 只把这个工厂的 `fight` / `closeAll` 接进流程。
 */
import { rngFrom } from './battle';
import type { SkillId } from './battle';
import { BattleShow, quickTimeline, timeline } from './battle-show';
import type { Shot, Step } from './battle-show';
import { arenaScoreboard, openArenaWindow } from './arena-window';
import type { ArenaWindow } from './arena-window';
import { SANWANG } from './dungeon-sanwang';
import { openFoeWindow } from './foe-window';
import type { FoeWindow } from './foe-window';
import type { FxWindow } from './fx-window';
import type { PetBox, Rect, WindowElectron } from './visit-windows';
import type { AdventureFightRequest } from './adventure-flow';

/** 一场历练战斗开的三扇窗（每场记一组，收摊只关自己这组） */
interface FightWindows {
  foe: FoeWindow;
  arena: ArenaWindow;
  fx: FxWindow;
}

export interface AdventureShowDeps {
  electron: WindowElectron;
  /** 插件路由前缀（拼对手立绘用） */
  petBase: string;
  /** 自家宠物现在的位置 */
  home: () => PetBox | null;
  /** 开特效层（features 的 openShowFx） */
  openFx: (foeBounds: () => Rect | null, foeOnLeft: () => boolean) => FxWindow;
  holdPet: (steps: Step[]) => Promise<void>;
  releasePet: (afterMs: number) => void;
  /** 把这一场的 BattleShow 交给 features（菜单的「快进」要能拿到它） */
  setBattle: (show: BattleShow | null) => void;
  refreshMenu: () => void;
  playExtra: (anim: string, options?: { facing?: 'left' | 'right'; rate?: number }) => void;
  say: (text: string, options: { anim: false; durationMs: number }) => void;
  /** 当前境界（擂台自家那条的标签） */
  stageLabel: () => string;
  disposed: () => boolean;
  closeHoldMs: number;
}

export interface AdventureShows {
  fight(request: AdventureFightRequest): Promise<void>;
  /** 关掉所有还没收完的历练窗口（0 = 立刻，CLOSE_HOLD_MS = 演完停一会儿） */
  closeAll(afterMs: number): void;
}

/** 档位标签（擂台用） */
function tierName(tier: 'mob' | 'elite' | 'boss'): string {
  return tier === 'mob' ? '小怪' : tier === 'elite' ? '精英' : '守护';
}

export function createAdventureShows(deps: AdventureShowDeps): AdventureShows {
  const groups = new Set<FightWindows>();
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
  async function fight(request: AdventureFightRequest): Promise<void> {
    const roster = SANWANG.foes[request.result.foe];
    if (!roster) return;
    const you = request.result.fighters[0];
    const foeFighter = request.result.fighters[1];
    const prefix = roster.skin ?? roster.prefix;
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
    const arena = openArenaWindow(deps.electron, `${new URL(deps.petBase).origin}/app/arena`, deps.home, () =>
      foe.bounds(),
    );
    // 开演前把对手要播的动作取到窗口里（Y2）：换源不等网络，出手才和飞行物对得上
    foe.preload(['起手', '出手', '绝招', '受击', '闪避', '倒地', '胜利']);
    const fx = deps.openFx(
      () => foe.bounds(),
      () => foe.side === 'left',
    );
    const windows: FightWindows = { foe, arena, fx };
    groups.add(windows);
    const scoreboard = arenaScoreboard({
      self: { label: `${you.name} · ${deps.stageLabel()}`, maxHp: you.hp },
      foe: { label: `${roster.name} · ${tierName(roster.tier)}`, maxHp: foeFighter.hp },
    });
    const rng = rngFrom(`${request.result.seed}:show`);
    const names: [string, string] = [you.name, foeFighter.name];
    const skills: [SkillId[], SkillId[]] = [you.skills, foeFighter.skills];
    const options = { foe: { prefix } };
    const steps = request.full
      ? timeline(request.result.events, names, rng, skills, options)
      : quickTimeline(request.result.events, names, rng, skills, options);
    const show = new BattleShow(steps, {
      self: {
        play: (anim, rate) => deps.playExtra(anim, { facing: foe.side === 'left' ? 'left' : 'right', rate }),
        say: (line, durationMs) => deps.say(line, { anim: false, durationMs }),
      },
      foe: {
        play: (anim, rate) => foe.play(anim, rate),
        say: (line, durationMs) => foe.say(line, durationMs),
      },
      arena: (hp) => {
        arena.place(deps.home(), foe.bounds());
        arena.update(scoreboard(hp, foe.side === 'left'));
        fx.place();
      },
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
    });
    deps.setBattle(show);
    deps.refreshMenu();
    await deps.holdPet(steps);
    await show.run();
    deps.setBattle(null);
    deps.releasePet(deps.disposed() ? 0 : deps.closeHoldMs);
    closeOne(windows, deps.closeHoldMs);
    deps.refreshMenu();
  }
  return {
    fight: fight,
    closeAll: (afterMs) => {
      for (const windows of [...groups]) closeOne(windows, afterMs);
    },
  };
}
