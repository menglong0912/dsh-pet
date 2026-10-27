import { findPetInstance, readAllConfig } from '../../host/config';
import { composeSystemPrompt, petPersona } from '../../host/persona';
import type { FeatureContext, SayOptions } from './context';
import { lazyFns } from './context';
import { delay } from './util';
import { errorText } from './util';

export const LINE_RULE = '只说一句话，20 字以内，不加引号，不解释，不提你是 AI。';

/** 生成：say / speak / compose 和说话队列 */
export interface Speech {
  say(text: string, options?: SayOptions): Promise<boolean>;
  personaPrompt(): string;
  systemPrompt(): string;
  collect(stream: AsyncIterable<{ text: string }>): Promise<string>;
  generate(instruction: string, rule?: string, system?: string): Promise<string | null>;
  compose(instruction: string, fallback: string): Promise<string>;
  speak(instruction: string, fallback: string, options?: SayOptions): Promise<void>;
  sayLine(text: string, options?: SayOptions): Promise<void>;
}

export function createSpeech(ctx: FeatureContext): Speech {
  const { activityContext, comeHome, petId, petRequest } = lazyFns(ctx);
  const { deps, log, ai } = ctx;
  async function say(text: string, options: SayOptions = {}): Promise<boolean> {
    // 出门在外时家里有话要说（提醒、看屏幕、Claude……）：先回家再说
    if (ctx.state.trip) await comeHome('called');
    const image = options.image;
    const duration = options.durationMs;
    try {
      const result = await petRequest('POST', '/broadcast', {
        text,
        anim: options.anim ?? true,
        ...(image ? { image } : {}),
        ...(duration === undefined ? {} : { duration }),
      });
      if (result.ok !== true) log(`说话失败：${JSON.stringify(result)}`);
      else ctx.state.lastSpokeAt = Date.now();
      return result.ok === true;
    } catch (error) {
      log(`说话失败：${errorText(error)}`);
      return false;
    }
  }

  // ---------- 生成 ----------

  /** 人设 + 名字 + 时间（插件同一套拼装） */
  function personaPrompt(): string {
    const cfg = readAllConfig(deps.configPaths);
    const found = findPetInstance(cfg, petId());
    return found
      ? composeSystemPrompt({
          prompt: petPersona(found.conf, found.pet),
          name: String(found.pet.name ?? ''),
          id: String(found.pet.id ?? ''),
          now: new Date(),
        })
      : '';
  }

  /** 人设 + 主人此刻 */
  function systemPrompt(): string {
    const base = personaPrompt();
    const context = activityContext();
    return context ? `${base}\n${context}` : base;
  }

  async function collect(stream: AsyncIterable<{ text: string }>): Promise<string> {
    let text = '';
    for await (const chunk of stream) text += chunk.text;
    return text.trim();
  }

  /**
   * 生成一句；模型没配 / 忙 / 失败时返回 null（忙就等一会儿再试一次：插件的碎碎念可能正占着）
   * @param rule 接在指令后的写法要求（默认「只说一句话」）
   * @param system 系统提示词（默认人设 + 主人此刻）
   */
  async function generate(instruction: string, rule = LINE_RULE, system?: string): Promise<string | null> {
    if (!ai.isReady()) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const options = {
          provider: ai.currentSelection().provider,
          model: ai.currentSelection().model,
          system: system ?? systemPrompt(),
          messages: [{ role: 'user', content: [{ type: 'text', text: `${instruction}${rule}` }] }],
        };
        return (await collect(ai.stream(options))) || null;
      } catch (error) {
        if (attempt === 0 && /busy/i.test(errorText(error))) {
          await delay(4_000);
          continue;
        }
        log(`生成失败：${errorText(error)}`);
        return null;
      }
    }
    return null;
  }

  /**
   * 按人设生成一句、不说出来，排进说话队列（与说话串行用模型）；生成不了用兜底句。
   * 串门的台词会发到别人电脑上：只用人设，不带「主人此刻」。
   */
  function compose(instruction: string, fallback: string): Promise<string> {
    const next = ctx.state.speaking.then(async () => {
      ctx.state.generating = true;
      try {
        return (await generate(instruction, LINE_RULE, personaPrompt())) ?? fallback;
      } catch (error) {
        log(`生成失败：${errorText(error)}`);
        return fallback;
      } finally {
        ctx.state.generating = false;
      }
    });
    ctx.state.speaking = next.catch(() => undefined);
    return next;
  }

  /** 按指令生成一句并说出来；生成不了就说兜底句 */
  function speak(instruction: string, fallback: string, options: SayOptions = {}): Promise<void> {
    const next = ctx.state.speaking.then(async () => {
      if (ctx.state.disposed) return;
      ctx.state.generating = true;
      let text: string | null;
      try {
        text = await generate(instruction);
      } finally {
        ctx.state.generating = false;
      }
      await say(text ?? fallback, options);
    });
    ctx.state.speaking = next.catch(() => undefined);
    return next;
  }

  /**
   * 排进说话队列说一句固定的话（不调模型）：修炼的升级 / 炼丹这类模板句也走队列，
   * 不和正在生成或显示的那句互相顶掉（say 不排队：主动点的、要立刻有回应的才直接说）
   */
  function sayLine(text: string, options: SayOptions = {}): Promise<void> {
    const next = ctx.state.speaking.then(async () => {
      if (!ctx.state.disposed) await say(text, options);
    });
    ctx.state.speaking = next.catch(() => undefined);
    return next;
  }
  return { say, personaPrompt, systemPrompt, collect, generate, compose, speak, sayLine };
}
