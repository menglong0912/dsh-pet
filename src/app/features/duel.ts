import { stageLabel } from '../cultivation';
import { orderNeighbors, shouldAutoAdmit } from '../neighbors';
import {
  cardFighter,
  cleanText,
  LINE_MAX,
  randomSparNonce,
  sendDuel,
  sendDuelReveal,
  sparCardOf,
  sparCommit,
  sparFight,
  sparLineRng,
  SPAR_MODE,
} from '../visit';
import type { DuelAnswer, DuelFailure, DuelReply, DuelRevealReply, Neighbor, SparCard, Visitor } from '../visit';
import { MENU_CULTIVATION_GROUP, lazyFns } from './context';
import type { DuelAccepted, DuelChallenge, DuelWait, FeatureContext } from './context';
import { SPAR_REMARK_CAP_MS } from './spar';
import { errorText } from './util';

/** 「修炼/切磋/…」最多列几个邻居（X15；熟人在前，照邻居列表的排序） */
const DUEL_NEIGHBORS_MAX = 3;

/** 隔空切磋（X15）：挑战方与应战方两侧的协议、菜单与演出 */
export interface Duel {
  cancelDuels(): void;
  hostDuel(visitor: Visitor, card: SparCard, commit: string): Promise<DuelAnswer>;
  answerDuel(accept: boolean): void;
  hostDuelReveal(visitor: Visitor, nonce: string, line: string): void;
  hostDuelConceded(visitor: Visitor, why: 'mismatch' | 'late'): void;
  duelChallengeActions(): Map<string, () => unknown>;
}

export function createDuel(ctx: FeatureContext): Duel {
  const { compose, cultivationOn, nickname, onCultivation, petName, refreshMenu, runSparShow, say } = lazyFns(ctx);
  const { deps, log, tracker, diary, neighbors, sparWaitMs } = ctx;
  /** 收掉还挂着的隔空挑战（退出 / 收摊）：等主人答复的那次回 timeout，已应战的那场不再记账 */
  function cancelDuels(): void {
    const waiting = ctx.state.duelWait;
    if (waiting) {
      ctx.state.duelWait = null;
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, reason: 'timeout' });
    }
    ctx.state.duelAccepted = null;
    ctx.state.duel = null;
  }

  /** 主人答复 / 超时 / 自动应战都走这里：清掉等待状态，答应时把这边自己的名帖与随机数交回去 */
  function settleDuel(state: DuelWait, answer: DuelAnswer): void {
    if (ctx.state.duelWait !== state) return;
    ctx.state.duelWait = null;
    if (state.timer !== null) clearTimeout(state.timer);
    if (answer.ok) ctx.state.duelAccepted = { visitor: state.visitor, card: state.card, hostNonce: state.hostNonce };
    state.resolve(answer);
    void refreshMenu();
  }

  /**
   * 应战方这一侧收到 /v1/duel（X15）：off / busy 在这里答；能接就冒一句、挂出「应战 / 不应战」，
   * 熟人在「直接请进」打开且主人在电脑前时直接应战，不挂菜单。
   */
  function hostDuel(visitor: Visitor, card: SparCard, commit: string): Promise<DuelAnswer> {
    const practice = cultivationOn();
    if (!practice) return Promise.resolve({ ok: false, reason: 'off' });
    if (
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.spar ||
      ctx.state.hosting !== null ||
      ctx.state.trip !== null ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.adventure?.blocking === true
    )
      return Promise.resolve({ ok: false, reason: 'busy' });
    return new Promise<DuelAnswer>((resolve) => {
      const state: DuelWait = { visitor, card, commit, hostNonce: randomSparNonce(), resolve, timer: null };
      state.timer = setTimeout(() => settleDuel(state, { ok: false, reason: 'timeout' }), sparWaitMs);
      ctx.state.duelWait = state;
      if (shouldAutoAdmit(neighbors, visitor, deps.appConfig().visit.autoAdmitFriends, tracker.snapshot()?.present)) {
        void say(`熟人 ${visitor.owner} 家的 ${visitor.pet} 来隔空切磋，直接应战～`);
        settleDuel(state, {
          ok: true,
          card: sparCardOf(practice.fighter(petName()), practice.view().stage),
          nonce: state.hostNonce,
        });
        return;
      }
      void say(`${visitor.owner} 家的 ${visitor.pet} 想跟我切磋～`);
      void refreshMenu();
    });
  }

  /** 主人点了「应战 / 不应战」 */
  function answerDuel(accept: boolean): void {
    const state = ctx.state.duelWait;
    if (!state) return;
    if (!accept) {
      settleDuel(state, { ok: false, reason: 'declined' });
      void say(`好，那就不跟 ${state.visitor.pet} 切磋啦～`);
      return;
    }
    const practice = cultivationOn();
    if (!practice) {
      settleDuel(state, { ok: false, reason: 'off' });
      return;
    }
    settleDuel(state, {
      ok: true,
      card: sparCardOf(practice.fighter(petName()), practice.view().stage),
      nonce: state.hostNonce,
    });
    void say(`来，跟 ${state.visitor.pet} 过两招～`);
  }

  /** 应战方这一侧收到 /v1/duel/reveal：承诺已核过，记账、开演（挑战方同时也在记它的） */
  function hostDuelReveal(visitor: Visitor, nonce: string, line: string): void {
    const state = ctx.state.duelAccepted;
    if (!state || state.visitor.id !== visitor.id || state.visitor.address !== visitor.address) return;
    ctx.state.duelAccepted = null;
    void runDuelHost(state, nonce, line);
  }

  /** 挑战方没亮随机数（对不上 / 超时）：按它认输记一场，不开打 */
  function hostDuelConceded(visitor: Visitor, why: 'mismatch' | 'late'): void {
    const state = ctx.state.duelAccepted;
    if (!state || state.visitor.id !== visitor.id) return;
    ctx.state.duelAccepted = null;
    const practice = cultivationOn();
    const id = visitor.id;
    if (!practice || !id) return;
    onCultivation(Date.now(), practice.sparDone(Date.now(), id, true), { anim: false });
    neighbors.dueled(id, { owner: visitor.owner, pet: visitor.pet }, true, Date.now());
    diary.note(
      Date.now(),
      'cultivate',
      `和 ${visitor.owner} 家的 ${visitor.pet} 隔空切磋，赢了（它${
        why === 'late' ? '没按时亮随机数' : '随机数没对上'
      }，算它认输）`,
    );
    void say(`${visitor.pet} ${why === 'late' ? '没按时亮随机数' : '随机数没对上'}，这场算它认输啦～`, {
      anim: false,
    });
    void refreshMenu();
  }

  /** 应战方这一侧的隔空切磋演出：两边各自用同一对随机数算同一场，这边演全套 */
  async function runDuelHost(state: DuelAccepted, guestNonce: string, guestLine: string): Promise<void> {
    const practice = cultivationOn();
    const visitorId = state.visitor.id;
    if (!practice || !visitorId) return;
    const you = practice.fighter(petName());
    const foe = cardFighter(state.visitor.pet, state.card);
    const events = sparFight(you, foe, guestNonce, state.hostNonce);
    const end = events[events.length - 1];
    const won = end.kind === 'end' && end.winner === 0;
    // 记账（同 X5，在开打这一步记；演出只是回放）
    onCultivation(Date.now(), practice.sparDone(Date.now(), visitorId, won), { anim: false });
    neighbors.dueled(visitorId, { owner: state.visitor.owner, pet: state.visitor.pet }, won, Date.now());
    diary.note(
      Date.now(),
      'cultivate',
      `和 ${state.visitor.owner} 家的 ${state.visitor.pet} 隔空切磋，${won ? '赢了' : '输了'}`,
    );
    // 自家宠物在家：不碰 AWAY_OPACITY / fadeHome，台词直接走 say(..., { anim: false })
    await runSparShow({
      zero: you,
      one: foe,
      zeroStage: practice.view().label,
      oneStage: stageLabel(state.card.stage),
      events,
      lineRng: sparLineRng(guestNonce, state.hostNonce),
      local: 0,
      foeLabel: `${state.visitor.owner} 家的 ${state.visitor.pet}`,
      selfSay: (line, durationMs) => void say(line, { anim: false, durationMs }),
      foeLine: guestLine,
      cancelled: () => ctx.state.disposed,
    });
    if (ctx.state.disposed) return;
    void refreshMenu();
    const instruction =
      `你刚和隔空来切磋的${state.visitor.pet}（${state.visitor.owner} 家的）打了一场，${won ? '你赢了' : '你输了'}。` +
      '跟主人说一句赛后感言。' +
      (won ? '别提修为和法宝的数字。' : '切磋点到为止，输了不丢人，下次再战。');
    const text = cleanText(
      await compose(instruction, won ? '隔空切磋赢啦，承让承让～' : '隔空切磋输了，下次再战！'),
      LINE_MAX,
    );
    if (ctx.state.battle === null && ctx.state.liveBattle === null) void say(text, { anim: false });
  }

  /**
   * 挑战方发起隔空切磋（菜单「修炼/切磋/X 家的 Y」）：发名帖与承诺 → 对方应战后这一场就定了 →
   * 编好赛后感言跟着 reveal 带过去 → 记账 → 在自家屏幕上把这一场演全套。
   */
  async function startDuel(id: string): Promise<void> {
    const practice = cultivationOn();
    const neighbor = ctx.state.neighborhood?.get(id);
    if (!practice || !neighbor) {
      await say('它好像已经不在附近了～');
      return;
    }
    if (
      ctx.state.duel ||
      ctx.state.spar ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.trip ||
      ctx.state.hosting ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.adventure?.blocking === true
    )
      return;
    const state: DuelChallenge = { neighbor, stage: 'asking', since: Date.now(), nonce: randomSparNonce() };
    ctx.state.duel = state;
    void refreshMenu();
    await say(`去找 ${neighbor.pet} 切磋，等它应战～`);
    let reply: DuelReply;
    try {
      reply = await sendDuel(
        { address: neighbor.address, port: neighbor.port },
        neighbor.id,
        { owner: nickname(), pet: petName() },
        ctx.state.visitIdentity,
        {
          mode: SPAR_MODE,
          card: sparCardOf(practice.fighter(petName()), practice.view().stage),
          commit: sparCommit(state.nonce),
        },
      );
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      log(
        `串门：隔空切磋的请求没送到 ${neighbor.owner} 家：${errorText(error)}${cause ? `（${errorText(cause)}）` : ''}`,
      );
      if (ctx.state.duel === state) ctx.state.duel = null;
      await say(duelFailText(neighbor.owner, 'unreachable'));
      void refreshMenu();
      return;
    }
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    if (!reply.ok) {
      ctx.state.duel = null;
      await say(duelFailText(neighbor.owner, reply.reason));
      void refreshMenu();
      return;
    }
    const you = practice.fighter(petName());
    const foe = cardFighter(neighbor.pet, reply.card);
    // 引擎里应战方是 0 号、挑战方是 1 号：两边各自算同一场
    const events = sparFight(foe, you, state.nonce, reply.nonce);
    const end = events[events.length - 1];
    const won = end.kind === 'end' && end.winner === 1;
    // 感言先编好（跟着 reveal 带过去，在应战方的对手窗口里说）；编太久退回模板，别拖过对方的时限
    const remark = await duelRemark(neighbor, won);
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    let revealed: DuelRevealReply;
    try {
      revealed = await sendDuelReveal(
        { address: neighbor.address, port: neighbor.port },
        { token: reply.token, nonce: state.nonce, line: remark },
      );
    } catch (error) {
      log(`串门：隔空切磋的随机数没亮出去：${errorText(error)}`);
      if (ctx.state.duel !== state) return;
      ctx.state.duel = null;
      // 对面超时后会按它赢记账：这边同样按输记，两边才对得上
      onCultivation(Date.now(), practice.sparDone(Date.now(), neighbor.id, false), { anim: false });
      neighbors.dueled(neighbor.id, { owner: neighbor.owner, pet: neighbor.pet }, false, Date.now());
      diary.note(Date.now(), 'cultivate', `和 ${neighbor.owner} 家的 ${neighbor.pet} 隔空切磋，输了（没按时亮随机数）`);
      await say('亮随机数迟了，算我认输', { anim: false });
      void refreshMenu();
      return;
    }
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    if (!revealed.ok) {
      ctx.state.duel = null;
      if (revealed.reason === 'mismatch' || revealed.reason === 'late') {
        onCultivation(Date.now(), practice.sparDone(Date.now(), neighbor.id, false), { anim: false });
        neighbors.dueled(neighbor.id, { owner: neighbor.owner, pet: neighbor.pet }, false, Date.now());
        diary.note(
          Date.now(),
          'cultivate',
          `和 ${neighbor.owner} 家的 ${neighbor.pet} 隔空切磋，输了（${
            revealed.reason === 'late' ? '没按时亮随机数' : '随机数没对上'
          }）`,
        );
      }
      await say(duelFailText(neighbor.owner, revealed.reason), { anim: false });
      void refreshMenu();
      return;
    }
    // 记账（对面同时也在记它的）：修为进账、战绩、日记
    onCultivation(Date.now(), practice.sparDone(Date.now(), neighbor.id, won), { anim: false });
    neighbors.dueled(neighbor.id, { owner: neighbor.owner, pet: neighbor.pet }, won, Date.now());
    diary.note(Date.now(), 'cultivate', `和 ${neighbor.owner} 家的 ${neighbor.pet} 隔空切磋，${won ? '赢了' : '输了'}`);
    state.stage = 'showing';
    // 自家宠物在家：不碰 AWAY_OPACITY / fadeHome，台词直接走 say(..., { anim: false })
    await runSparShow({
      zero: foe,
      one: you,
      zeroStage: stageLabel(reply.card.stage),
      oneStage: practice.view().label,
      events,
      lineRng: sparLineRng(state.nonce, reply.nonce),
      local: 1,
      foeLabel: `${neighbor.owner} 家的 ${neighbor.pet}`,
      selfSay: (line, durationMs) => void say(line, { anim: false, durationMs }),
      cancelled: () => ctx.state.duel !== state,
    });
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    ctx.state.duel = null;
    void say(won ? '这场隔空切磋我赢啦！' : '这场隔空切磋输了，下次再战～', { anim: false });
    void say(remark, { anim: false });
    void refreshMenu();
  }

  /** 挑战方的赛后感言：按人设编一句（只带人设，§2.2 的口径），编太久退回模板（模型卡住别拖垮 reveal） */
  async function duelRemark(neighbor: Neighbor, won: boolean): Promise<string> {
    const instruction =
      `你正在跟${neighbor.owner}家的宠物${neighbor.pet}隔空切磋，${won ? '你赢了' : '你输了'}。说一句赛后感言。` +
      (won ? '别提修为和法宝的数字。' : '切磋点到为止，输了不丢人。');
    const fallback = won ? '隔空切磋赢啦，承让承让～' : '隔空切磋输了，下次再战！';
    const composed = compose(instruction, fallback);
    const capped = new Promise<string>((done) => setTimeout(() => done(fallback), SPAR_REMARK_CAP_MS));
    return Promise.race([composed, capped]);
  }

  /**
   * 挑战方的隔空切磋项（X15）：只列在线、带 id 的邻居，熟人在前（照邻居列表现有的排序），最多 3 个。
   * 放在 wantedLabels 的最后：菜单项挤不下时先截掉它们，串门的邻居项照旧。
   */
  function duelChallengeActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    const practice = cultivationOn();
    if (
      !practice ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.spar ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.trip ||
      ctx.state.hosting ||
      ctx.state.knockingOn ||
      ctx.state.visitHost?.knocking() ||
      ctx.state.adventure?.blocking === true
    )
      return actions;
    if (!deps.appConfig().visit.enabled || !deps.appConfig().visit.visiting) return actions;
    const ordered = orderNeighbors(ctx.state.neighborhood?.list() ?? [], neighbors, ctx.state.lastGuest, Date.now());
    const nearby = (ordered.revisit ? [ordered.revisit, ...ordered.list] : ordered.list)
      .filter((neighbor) => neighbor.id)
      .slice(0, DUEL_NEIGHBORS_MAX);
    for (const neighbor of nearby) {
      let label = `${MENU_CULTIVATION_GROUP}/切磋/${neighbor.owner} 家的 ${neighbor.pet}`;
      for (let n = 2; actions.has(label); n += 1)
        label = `${MENU_CULTIVATION_GROUP}/切磋/${neighbor.owner} 家的 ${neighbor.pet}（${n}）`;
      actions.set(label, () => void startDuel(neighbor.id));
    }
    return actions;
  }

  /** 隔空切磋没打成的原因，说给自家主人听（old-host / declined / timeout 是 X15 点名的几种） */
  function duelFailText(
    owner: string,
    reason: DuelFailure | 'mismatch' | 'late' | 'not-visiting' | 'unreachable',
  ): string {
    switch (reason) {
      case 'old-host':
        return '对方的桌宠还不会隔空切磋';
      case 'off':
        return '对方没开修炼，切不了';
      case 'busy':
        return `${owner} 家正忙着，等会儿再切～`;
      case 'version':
        return '两边版本不一样，切磋不了';
      case 'unsupported-mode':
        return '对方不支持这种打法';
      case 'bad-card':
        return '对方没看懂我的名帖';
      case 'bad-sig':
        return `${owner} 家没应战，下次再约～`;
      case 'bad-request':
        return '没打成';
      case 'declined':
      case 'timeout':
        return `${owner} 家没应战，下次再约～`;
      case 'too-soon':
        return `刚找过 ${owner} 家，等会儿再切～`;
      case 'mismatch':
        return '随机数没对上，算我认输';
      case 'late':
        return '亮随机数迟了，算我认输';
      case 'not-visiting':
        return '对方不认这场了';
      case 'unreachable':
        return `连不上 ${owner} 家，看看系统设置里有没有允许 dsh-pet 访问本地网络～`;
    }
  }

  return { cancelDuels, hostDuel, answerDuel, hostDuelReveal, hostDuelConceded, duelChallengeActions };
}
