import { AdventureFlow } from '../adventure-flow';
import { createAdventureShows } from '../adventure-show';
import { openAdventureWindow } from '../adventure-window';
import { SANWANG } from '../dungeon-sanwang';
import { guestBounds, guestSide } from '../visit-windows';
import { CLOSE_HOLD_MS, lazyFns } from './context';
import type { FeatureContext } from './context';

/** 历练：小窗、流程与演出接线 */
export interface AdventureGlue {
  ensureAdventure(): AdventureFlow | null;
  runAdventure(): Promise<void>;
  closeAdventureShows(afterMs: number): void;
}

export function createAdventureGlue(ctx: FeatureContext): AdventureGlue {
  const {
    compose,
    cultivationOn,
    holdPet,
    onCultivation,
    openShowFx,
    petName,
    playExtra,
    refreshMenu,
    releasePet,
    say,
    skipTrial,
  } = lazyFns(ctx);
  const { deps, electron, diary, homePet } = ctx;
  /** 演一场（Y2 对手窗口 + 擂台 + 特效层，速战 / 完整）与收窗口；流程只拿到「演一场」这个 Promise */
  const adventureShows = createAdventureShows({
    electron,
    petBase: deps.petBase,
    home: homePet.box,
    openFx: openShowFx,
    holdPet,
    releasePet,
    setBattle: (show) => {
      ctx.state.battle = show;
    },
    refreshMenu: () => void refreshMenu(),
    playExtra: (anim, options) => void playExtra(anim, options),
    say: (text, options) => void say(text, options),
    stageLabel: () => cultivationOn()?.view().label ?? '',
    disposed: () => ctx.state.disposed,
    closeHoldMs: CLOSE_HOLD_MS,
  });

  /** 历练（Y3）：小窗与流程；存读档、演出、宠物动作、模型总结都从外面注入。修炼开着才建（设置里后开的也算） */
  function ensureAdventure(): AdventureFlow | null {
    if (ctx.state.adventure) return ctx.state.adventure;
    const practice = cultivationOn();
    if (!practice) return null;
    ctx.state.adventure = new AdventureFlow({
      def: SANWANG,
      openWindow: (parked) =>
        openAdventureWindow(electron, `${new URL(deps.petBase).origin}/app/adventure`, deps.petBase, homePet.box, {
          prefer: adventurePrefer(),
          bounds: parked,
        }),
      fight: adventureShows.fight,
      // 高光客串（Y5）：只开对手窗口，不打架
      cameo: adventureShows.cameo,
      skipFight: skipTrial,
      play: (anim) => void playExtra(anim),
      say: (text, options) => void say(text, options),
      compose,
      getRun: () => practice.adventureRun(),
      saveRun: (run) => practice.saveRun(Date.now(), run),
      done: (run, reason) => practice.adventureDone(Date.now(), run, reason),
      onEvents: (events, now) => onCultivation(now, events, { anim: false }),
      diary: (text) => diary.note(Date.now(), 'cultivate', text),
      progress: () => practice.adventureProgress(SANWANG.id),
      fighter: () => practice.fighter(petName()),
      stage: () => practice.view().stage,
      petName,
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      random: Math.random,
      onChange: () => void refreshMenu(),
    });
    return ctx.state.adventure;
  }

  /** 开小窗：存档里有没走完的一趟就接着走 */
  async function runAdventure(): Promise<void> {
    const flow = ensureAdventure();
    if (
      !flow ||
      ctx.state.trip !== null ||
      ctx.state.hosting !== null ||
      ctx.state.duelWait !== null ||
      ctx.state.duelAccepted !== null
    )
      return;
    await flow.open();
    void refreshMenu();
  }

  /** 小窗放宠物哪一边：和对手窗口相反（对手默认站左边，小窗就放右边） */
  function adventurePrefer(): 'left' | 'right' {
    const box = homePet.box();
    if (!box) return 'right';
    const workArea = electron.screen.getDisplayNearestPoint({
      x: box.left + box.size / 2,
      y: box.top + box.size / 4,
    }).workArea;
    return guestSide(guestBounds(box, workArea, undefined, { scale: 1, tight: true }), box) === 'left'
      ? 'right'
      : 'left';
  }
  return { ensureAdventure, runAdventure, closeAdventureShows: (afterMs) => adventureShows.closeAll(afterMs) };
}
