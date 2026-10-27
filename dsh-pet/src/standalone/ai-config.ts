import { z } from 'zod';
import { readAiSettings, writeAiSettings } from './ai-storage';

export interface StandaloneAiPublicSettings {
  protocol: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
  /** OpenAI 兼容协议下请求体带 chat_template_kwargs.enable_thinking=false（llama.cpp / vLLM 部署的 Qwen 等） */
  disableThinking: boolean;
  hasKey: boolean;
}
export type StandaloneAiSettings = Omit<StandaloneAiPublicSettings, 'hasKey'> & { apiKey: string };

export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze({
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  enabled: false,
  timeoutMs: 30_000,
  disableThinking: false,
  apiKey: '',
});

function safeEndpoint(value: string): boolean {
  if (!value) return true;
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      return false;
    }
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

const fields = {
  protocol: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string().max(2048).refine(safeEndpoint),
  model: z
    .string()
    .trim()
    .max(200)
    .refine((s) => !containsControlChar(s)),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(60_000),
  // 可选而非 default(false)：partial() 也会补默认值，那样每次补丁保存都会把它冲回 false。
  // 旧版设置文件没有这个字段，由 validateSettings 合并 previous 时补齐。
  disableThinking: z.boolean().optional(),
  apiKey: z
    .string()
    .max(4096)
    .refine((s) => !containsControlChar(s) && !/\s/.test(s)),
};
const persistedSchema = z.object(fields).strict();
const patchSchema = persistedSchema.partial().extend({ clearApiKey: z.boolean().optional() }).strict();

/**
 * D9 删掉的旧字段：automaticWhispers / whisperIntervalSec / maxTokens。
 * 旧 standalone-ai.json 里还会带着它们，读取时照常接受但直接丢弃（不告警、不参与校验、不再写回）。
 */
const LEGACY_KEYS = ['automaticWhispers', 'whisperIntervalSec', 'maxTokens'] as const;
const loadSchema = z
  .object({
    ...fields,
    automaticWhispers: z.unknown().optional(),
    whisperIntervalSec: z.unknown().optional(),
    maxTokens: z.unknown().optional(),
  })
  .strict();

function stripLegacy(value: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...value };
  for (const key of LEGACY_KEYS) delete rest[key];
  return rest;
}

export function validateSettings(input: unknown, previous: Readonly<StandaloneAiSettings>): StandaloneAiSettings {
  try {
    const patch = patchSchema.parse(input);
    if (patch.clearApiKey && patch.apiKey) throw new Error('Conflicting key changes');
    const { clearApiKey, ...values } = patch;
    const apiKey = clearApiKey ? '' : values.apiKey || previous.apiKey;
    const next = persistedSchema.parse({ ...previous, ...values, apiKey });
    if (next.enabled && (!next.model || !next.baseUrl || !next.apiKey)) throw new Error('Incomplete settings');
    return { ...next, disableThinking: next.disableThinking ?? false };
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, ...publicFields } = settings;
  return { ...publicFields, hasKey: apiKey.length > 0 };
}

export interface AiConfigStore {
  current(): Readonly<StandaloneAiSettings>;
  publicSettings(): StandaloneAiPublicSettings;
  save(input: unknown): Promise<StandaloneAiPublicSettings>;
}

export function createAiConfig(home: string): AiConfigStore {
  let settings: Readonly<StandaloneAiSettings> = DEFAULT_AI_SETTINGS;
  try {
    const loaded = readAiSettings(home);
    if (loaded !== undefined)
      settings = Object.freeze(
        validateSettings(stripLegacy(loadSchema.parse(loaded) as Record<string, unknown>), DEFAULT_AI_SETTINGS),
      );
  } catch {
    throw new Error('Cannot securely load standalone AI settings.');
  }
  return {
    current: () => settings,
    publicSettings: () => redact(settings),
    async save(input) {
      const next = validateSettings(input, settings);
      try {
        writeAiSettings(home, next);
      } catch {
        throw new Error('Cannot securely save standalone AI settings.');
      }
      settings = Object.freeze(next);
      return redact(settings);
    },
  };
}
