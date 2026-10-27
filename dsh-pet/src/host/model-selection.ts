/**
 * 对话的模型选择（host 半侧，纯逻辑、零依赖）。
 *
 * 独立应用只有设置页配的那一个模型（`StandaloneAiService.currentSelection()`），
 * 没有「当前对话的模型」与「条目配置 chatModel」两条来源，因此候选链就是当前模型本身：
 * 未配置（model 为空）→ 空链，生成侧回「当前对话未配置模型」，不会发请求。
 */

/** 一处「服务商 + 模型」选择 */
export interface ModelRef {
  provider: string;
  model: string;
}

/** 生成侧需要的最小模型服务（StandaloneAiService 满足它，单测可传普通对象） */
export interface ModelService {
  currentSelection(): { provider: string; model: string };
  stream(options: unknown): AsyncIterable<unknown>;
  resolveModelInfo?(provider?: string, model?: string, signal?: AbortSignal): Promise<unknown>;
}

/** 当前模型（ai.currentSelection）；未配置 / 抛错 → undefined */
export function currentModel(
  ai: { currentSelection?(): { provider: string; model: string } } | undefined,
): ModelRef | undefined {
  try {
    const sel = ai?.currentSelection?.();
    return sel?.provider && sel?.model ? { provider: sel.provider, model: sel.model } : undefined;
  } catch {
    return undefined;
  }
}

/** 候选链：独立应用只有当前模型一个来源。返回空数组 = 没配模型（生成侧据此回「当前对话未配置模型」）。 */
export function modelCandidates(
  ai: { currentSelection?(): { provider: string; model: string } } | undefined,
): ModelRef[] {
  const model = currentModel(ai);
  return model ? [model] : [];
}

/** 报错/日志用的选择标签：provider/model */
export function modelLabel(m: ModelRef): string {
  return m.provider + '/' + m.model;
}
