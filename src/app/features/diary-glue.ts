import { dateLabel, diaryDate } from '../diary';
import { composeWorkStatus, sameStatus } from '../status';
import type { FeatureContext } from './context';
import { lazyFns } from './context';
import { errorText } from './util';

/** 宠物日记 */
export interface DiaryGlue {
  catchUpDiary(date: string): Promise<void>;
  openDiary(now: number): Promise<void>;
  refreshStatus(now: number): Promise<void>;
}

export function createDiaryGlue(ctx: FeatureContext): DiaryGlue {
  const { generate, personaPrompt, petRequest, say, speak } = lazyFns(ctx);
  const { deps, log, electron, diary, claude } = ctx;
  /**
   * 写某一天的日记并存下（排进说话队列：与说话串行用模型，生成期间碎碎念让一让）
   * @returns written = 写好了；too-short = 这一天在电脑前太短不写；failed = 模型没配 / 失败
   */
  function writeDiary(date: string): Promise<'written' | 'too-short' | 'failed'> {
    const next = ctx.state.speaking.then(async () => {
      const instruction = diary.instruction(date);
      if (!instruction) return 'too-short' as const;
      ctx.state.generating = true;
      let text: string | null;
      try {
        // 日记写的是一整天：不带「主人此刻」
        text = await generate(instruction, '', personaPrompt());
      } finally {
        ctx.state.generating = false;
      }
      if (!text) return 'failed' as const;
      diary.write(date, text, Date.now());
      log(`宠物日记：写好了 ${date}`);
      return 'written' as const;
    });
    ctx.state.speaking = next.catch(() => undefined);
    return next;
  }

  async function catchUpDiary(date: string): Promise<void> {
    if ((await writeDiary(date)) !== 'written') {
      log(`宠物日记：补写 ${date} 没写成`);
      return;
    }
    const label = dateLabel(date);
    await speak(
      `你把${label}的日记写好了。告诉主人一声，让主人右键「宠物日记」翻翻看。`,
      `${label}的日记写好啦，右键「宠物日记」翻翻看～`,
    );
  }

  /** 右键「宠物日记」：先写一篇今天到目前为止的，再打开日记本 */
  async function openDiary(now: number): Promise<void> {
    void say('等我写写今天的日记～');
    const result = await writeDiary(diaryDate(now));
    if (result === 'failed') await say('今天的日记没写成，等会儿再试试～');
    if (!diary.hasIndex()) {
      if (result === 'too-short') await say('今天还没陪主人多久，没什么可写的～');
      return;
    }
    const error = await electron.shell.openPath(diary.indexPath());
    if (error) log(`打开日记失败：${error}`);
  }

  async function refreshStatus(now: number): Promise<void> {
    const stayMs = deps.appConfig().visit.stayMin * 60_000;
    const next = composeWorkStatus(
      claude.view(now),
      ctx.state.trip
        ? {
            owner: ctx.state.trip.host.owner,
            remainingMin: Math.max(1, Math.ceil((ctx.state.trip.since + stayMs - now) / 60_000)),
          }
        : null,
    );
    if (sameStatus(next, ctx.state.lastStatus)) return;
    try {
      if (next) await petRequest('POST', '/work-status', next);
      else await petRequest('DELETE', '/work-status');
      ctx.state.lastStatus = next;
    } catch (error) {
      log(`写工作状态失败：${errorText(error)}`);
    }
  }
  return { catchUpDiary, openDiary, refreshStatus };
}
