/**
 * 生成侧的调用形状测试 —— 独立应用只有一个模型来源（设置页配的那一个）。
 *
 * 用假模型服务驱动（不碰真服务商、不联网）：按 provider 决定这次是抛错、返回空流还是正常文本，
 * 并记录每次调用的 provider/model 与完整参数。钉住：
 *  - 碎碎念 / 对话都只调当前模型一次；
 *  - 没配模型 → provider-missing，一次都不调用；
 *  - 每次调用都带调用身份 sessionId；流里抛错时带回真实失败原因。
 *
 * 跑法：node --experimental-strip-types --test src/host/model-fallback.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateWhisper } from './whisper.ts';
import { generateChat } from './chat.ts';
import { PET_CALL_IDENTITY } from './llm-call.ts';
import type { ModelRef } from './model-selection.ts';

/** 一次调用的行为：ok = 正常出文本；throw = 流里抛错；empty = 空流；fail = 带具体原因的抛错 */
type Behavior = 'ok' | 'throw' | 'empty' | 'fail';

const CURRENT: ModelRef = { provider: 'standalone', model: 'main-model' };

/** 造一个假模型服务：currentSelection 返回 current（'throw' = 抛错），stream 按 provider 决定行为 */
function fakeAi(current: ModelRef | 'throw', behavior: Record<string, Behavior>) {
  const calls: ModelRef[] = [];
  /** 每次调用的完整参数（含 sessionId） */
  const options: Record<string, unknown>[] = [];
  const ai = {
    currentSelection: (): ModelRef => {
      if (current === 'throw') throw new Error('当前对话未配置模型');
      return current;
    },
    // 声明"无 reasoning 元数据"：supportsReasoningOff 返回 false，不附加 reasoningEffort
    resolveModelInfo: async () => ({}),
    stream: (o: ModelRef) => {
      calls.push({ provider: o.provider, model: o.model });
      options.push(o as unknown as Record<string, unknown>);
      const b = behavior[o.provider] ?? 'throw';
      return (async function* () {
        if (b === 'throw') throw new Error(o.provider + ' 不可用');
        if (b === 'empty') return;
        if (b === 'fail') throw new Error(o.provider + ' 400：缺少必需的路由头');
        yield { type: 'text', text: '你好呀' };
      })();
    },
  };
  return { ai, calls, options };
}

describe('generateWhisper —— 固定用当前模型', () => {
  test('只调当前模型一次', async () => {
    const { ai, calls } = fakeAi(CURRENT, { standalone: 'ok' });
    const r = await generateWhisper(ai, '人设');
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CURRENT]);
  });

  test('拿不到模型 → provider-missing，且一次都不调用 LLM', async () => {
    const { ai, calls } = fakeAi('throw', {});
    const r = await generateWhisper(ai, '人设');
    assert.deepEqual(r, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
    assert.deepEqual(calls, []);
  });
});

describe('generateChat —— 同一个模型来源', () => {
  test('只调当前模型一次', async () => {
    const { ai, calls } = fakeAi(CURRENT, { standalone: 'ok' });
    const r = await generateChat(ai, '人设', [], '在吗');
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CURRENT]);
  });

  test('拿不到模型 → provider-missing，且一次都不调用 LLM', async () => {
    const { ai, calls } = fakeAi('throw', {});
    const r = await generateChat(ai, '人设', [], '在吗');
    assert.deepEqual(r, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
    assert.deepEqual(calls, []);
  });
});

describe('调用形状 —— 调用身份与真实失败原因', () => {
  test('对话调用带调用身份 sessionId', async () => {
    const { ai, options } = fakeAi(CURRENT, { standalone: 'ok' });
    await generateChat(ai, '人设', [], '在吗');
    assert.equal(options.length, 1);
    assert.equal(options[0].sessionId, PET_CALL_IDENTITY);
  });

  test('碎碎念调用带同一身份', async () => {
    const { ai, options } = fakeAi(CURRENT, { standalone: 'ok' });
    await generateWhisper(ai, '人设');
    assert.deepEqual(
      options.map((o) => o.sessionId),
      [PET_CALL_IDENTITY],
    );
  });

  test('流里抛错 → 把真实失败原因带回', async () => {
    const { ai } = fakeAi(CURRENT, { standalone: 'fail' });
    const r = await generateChat(ai, '人设', [], '在吗');
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.message, 'standalone 400：缺少必需的路由头');
  });

  test('空流 → 仍是"模型未返回文本"（旧行为逐字不变）', async () => {
    const { ai } = fakeAi(CURRENT, { standalone: 'empty' });
    const r = await generateChat(ai, '人设', [], '在吗');
    assert.equal(r.ok === false && r.message, '模型未返回文本');
  });
});
