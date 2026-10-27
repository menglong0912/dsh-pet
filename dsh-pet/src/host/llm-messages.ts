/**
 * 模型调用的本地消息形状（消息工厂 / 文本块拼装 / reasoning 标识）。
 *
 * 独立应用不再引入 DSH 的 LLM 包：生成侧只需要「消息对象」与「流式文本拼装」，
 * 因此这里保留最小实现。传输层（StandaloneAiService）已经负责把服务商事件归一成文本块，
 * 不会产出工具调用等其它块，所以拼装器只收集文本。
 */

/** 消息的最小形状（只有角色、内容与来源标记） */
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 用户消息（`whisper.ts` / `chat.ts` 的入参形状） */
export function createUserMessage(input: { content: unknown; source: unknown }): LlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 助手消息（`chat.ts` 回放历史用） */
export function createAssistantMessage(input: { content: unknown; source: unknown }): LlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块（`BlockAssembler.blocks()` 的元素形状） */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * 流式文本拼装：只收集文本块（与调用方 `blocks().filter(b => b.type === 'text')` 的用法一致）。
 */
export class BlockAssembler {
  /** 流终止块。独立 AI 的传输层直接在流里抛错，不会产出终止块；保留字段供失败原因解析读取。 */
  finish: unknown = undefined;

  private readonly chunks: string[] = [];

  /** 收集一个块；非文本块被忽略 */
  push(chunk: unknown): void {
    if (chunk !== null && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'text') {
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === 'string') this.chunks.push(text);
    }
  }

  /** 当前已拼装的块列表 */
  blocks(): TextBlock[] {
    const text = this.chunks.join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
}

/** reasoning effort 标识工厂（调用方传什么就是什么） */
export function ReasoningEffortId(id: string): string {
  return id;
}
