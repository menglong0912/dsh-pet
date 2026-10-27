import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describeActivity, durationText } from '../activity';
import { diaryDate } from '../diary';
import type { HealthEvent } from '../reminders';
import type { FeatureContext } from './context';
import { lazyFns } from './context';
import { errorText } from './util';

/** 采样间隔 */
const TICK_MS = 5_000;
/** 自动看屏幕要求键鼠最近活动过（秒）：人在看视频 / 发呆时不打扰 */
const SCREEN_ACTIVE_IDLE_SEC = 60;
/** 应用刚说过话这么久内，不插入打坐这类小动作（气泡默认显示 10 秒） */
const SPOKE_HOLD_MS = 15_000;
/** 平时打坐的间隔：40–60 分钟随机一次（在电脑前、没出门、没在说话时） */
const MEDITATE_GAP_MIN = 40;
const MEDITATE_JITTER_MIN = 20;

const run = promisify(execFile);
/** 前台是这些应用时视为「取不到」（桌宠自己的窗口被点到前台） */
const SELF_APP_NAMES = new Set(['dsh-pet', 'Electron']);

/** 平时打坐的间隔（40–60 分钟随机） */
function meditateGapMs(): number {
  return (MEDITATE_GAP_MIN + Math.floor(Math.random() * MEDITATE_JITTER_MIN)) * 60_000;
}

/** 采样与定时、提醒 */
export interface Ticks {
  activityContext(): string;
  tick(): Promise<void>;
  schedule(): void;
}

export function createTicks(ctx: FeatureContext): Ticks {
  const {
    catchUpDiary,
    cultivationOn,
    lookAtScreen,
    onCultivation,
    playExtra,
    refreshMenu,
    refreshStatus,
    speak,
    syncVisit,
  } = lazyFns(ctx);
  const { deps, log, electron, tracker, diary, pouch, health, offWork } = ctx;
  ctx.state.meditateAt = Date.now() + meditateGapMs();
  async function frontApp(): Promise<string | null> {
    try {
      const { stdout: asn } = await run('lsappinfo', ['front'], { timeout: 2_000 });
      const { stdout } = await run('lsappinfo', ['info', '-only', 'name', asn.trim()], { timeout: 2_000 });
      // 输出形如：「"Ghostty" ASN:0x0-0x1234: (in front)」，取第一段引号
      const name = /"([^"]+)"/.exec(stdout)?.[1] ?? null;
      return name && !SELF_APP_NAMES.has(name) ? name : null;
    } catch {
      return null;
    }
  }

  function activityContext(): string {
    return describeActivity(tracker.snapshot(), Date.now());
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    const config = deps.appConfig();
    const events = tracker.update({
      now,
      idleSec: electron.powerMonitor.getSystemIdleTime(),
      locked: electron.powerMonitor.getSystemIdleState(1) === 'locked',
      frontApp: await frontApp(),
    });
    const snap = tracker.snapshot();
    diary.tick(now, snap);
    for (const event of events) {
      if (event.type === 'return' && event.awayMs >= config.greetAfterAwayMin * 60_000) {
        diary.note(now, 'return', `主人离开电脑 ${durationText(event.awayMs)}后回来了`);
        void speak(`主人离开电脑 ${durationText(event.awayMs)}，刚刚回来。欢迎主人回来。`, '欢迎回来～');
      }
      // 修炼：主人离开电脑（解除心浮气躁，可能「调息」）
      if (event.type === 'leave') {
        const practice = cultivationOn();
        if (practice) onCultivation(now, practice.onLeave(now));
      }
    }
    for (const event of health.tick(now, snap)) {
      diary.note(now, event, event === 'sit' ? '提醒主人起来活动一下' : '提醒主人喝水');
      void announceHealth(event);
      // 修炼：久坐提醒响了（进入「心浮气躁」）
      if (event === 'sit') {
        const practice = cultivationOn();
        if (practice) practice.onSitReminder(now);
      }
    }
    const offWorkLeft = offWork.tick(now, snap?.present ?? false);
    if (offWorkLeft !== null) {
      diary.note(now, 'off-work', offWorkLeft > 0 ? '提醒主人快下班了' : '过了下班时间主人还在电脑前，提醒主人下班');
      void announceOffWork(offWorkLeft);
    }
    // 零食只用来请来串门的客人吃：开着串门才攒；出门在外时悄悄收进袋子，不为这个叫它回家
    const served = config.visit.enabled ? pouch.tick(now, snap?.present ?? false) : null;
    if (served) {
      const { meal, snack } = served;
      diary.note(now, 'snack', `${meal}时间分到一份${snack.label}，收进了零食袋`);
      if (!ctx.state.trip) {
        void speak(
          `到${meal}时间了，你也分到一份${snack.label}，收进零食袋，留着请来串门的小伙伴吃。跟主人说一声。`,
          `${meal}时间～我分到一份${snack.label}，留着请客人吃～`,
        );
      }
    }
    // 新的一天主人回到电脑前：补写前一天的日记
    if (snap?.present && ctx.state.diaryCheckedFor !== diaryDate(now)) {
      ctx.state.diaryCheckedFor = diaryDate(now);
      const date = diary.pending(now);
      if (date) void catchUpDiary(date).catch((error: unknown) => log(`宠物日记：补写失败：${errorText(error)}`));
    }

    // 修炼：在电脑前就涨修为（事件冒泡、记日记在 onCultivation）；平时在电脑前、没出门、没在说话时偶尔打坐
    const practice = cultivationOn();
    if (practice) {
      onCultivation(now, practice.tick(now, snap?.present ?? false));
      if (
        snap?.present &&
        ctx.state.trip === null &&
        ctx.state.battle === null &&
        ctx.state.liveBattle === null &&
        ctx.state.actionPanel === null &&
        now >= ctx.state.meditateAt &&
        !ctx.state.generating &&
        now - ctx.state.lastSpokeAt >= SPOKE_HOLD_MS
      ) {
        ctx.state.meditateAt = now + meditateGapMs();
        void playExtra('修炼-打坐');
      }
    }

    // 到点自动看屏幕；看不了（不支持看图 / 自动触发没授权）时 lookAtScreen 内部降级成碎碎念
    if (screenDue(now)) void lookAtScreen(false);
    await syncVisit();
    await refreshStatus(now);
    await refreshMenu();
  }

  /** 到点该自动看屏幕：开着、没出门、没在演一场、人在且一分钟内碰过键鼠、离上次够间隔 */
  function screenDue(now: number): boolean {
    const config = deps.appConfig();
    return (
      config.screen.enabled &&
      ctx.state.trip === null &&
      ctx.state.battle === null &&
      ctx.state.liveBattle === null &&
      ctx.state.actionPanel === null &&
      tracker.snapshot()?.present === true &&
      electron.powerMonitor.getSystemIdleTime() < SCREEN_ACTIVE_IDLE_SEC &&
      now - ctx.state.lastScreenAt >= config.screen.intervalSec * 1000 &&
      !ctx.state.screenBusy
    );
  }

  function schedule(): void {
    if (ctx.state.disposed) return;
    ctx.state.tickTimer = setTimeout(() => {
      tick()
        .catch((error: unknown) => log(`采样失败：${errorText(error)}`))
        .finally(schedule);
    }, TICK_MS);
  }

  function announceHealth(event: HealthEvent): Promise<void> {
    const snap = tracker.snapshot();
    const sat = snap?.activeSince ? durationText(Date.now() - snap.activeSince) : '很久';
    return event === 'sit'
      ? speak(`主人已经连续坐了 ${sat}。提醒主人站起来活动一下。`, '坐太久啦，起来动一动～')
      : speak('提醒主人喝口水。', '该喝水啦～');
  }

  /** @param left 离下班还剩几分钟（≤ 0 = 已经过了） */
  function announceOffWork(left: number): Promise<void> {
    const { time } = deps.appConfig().offWork;
    return left > 0
      ? speak(
          `再过 ${left} 分钟就到主人的下班时间 ${time} 了。提醒主人收拾收拾，准备下班。`,
          `还有 ${left} 分钟下班啦～`,
        )
      : speak(`已经过了主人的下班时间 ${time}，主人还在电脑前。提醒主人收拾一下准备下班。`, '到点啦，该下班啦～');
  }
  return { activityContext, tick, schedule };
}
