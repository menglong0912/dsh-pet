/**
 * 模型选择单元测试 —— 独立应用只有「设置页配的那一个模型」。
 *
 * 钉住的规则：
 *  - 有配置（provider 与 model 都非空）→ 候选链上就是它；
 *  - 未配置 / 抛错 / ctx 不完整 → 空链（生成侧回「当前对话未配置模型」，不发请求）。
 *
 * 本模块不 import 模型传输层（纯逻辑），故能在 node:test 里直接跑——
 * 与 chat.test.ts 只测 memes.ts 同一个理由。
 *
 * 跑法：node --experimental-strip-types --test src/host/model-selection.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { currentModel, modelCandidates, modelLabel, type ModelRef } from './model-selection.ts';

/** 造一个模型服务：currentSelection 返回给定选择（undefined = 未配置，'throw' = 抛错） */
function aiOf(sel: ModelRef | undefined | 'throw'): { currentSelection(): ModelRef } {
  return {
    currentSelection: () => {
      if (sel === 'throw') throw new Error('当前对话未配置模型');
      return sel as unknown as ModelRef;
    },
  };
}

describe('currentModel —— 当前模型', () => {
  test('有选择 → 原样返回', () => {
    assert.deepEqual(currentModel(aiOf({ provider: 'standalone', model: 'deepseek-chat' })), {
      provider: 'standalone',
      model: 'deepseek-chat',
    });
  });

  test('model 为空 → undefined（未配置不能当成有效模型）', () => {
    assert.equal(currentModel(aiOf({ provider: 'standalone', model: '' })), undefined);
  });

  test('未配置 / 抛错 / 服务不完整 → undefined（绝不向上抛）', () => {
    assert.equal(currentModel(aiOf(undefined)), undefined);
    assert.equal(currentModel(aiOf('throw')), undefined);
    assert.equal(currentModel({}), undefined);
  });
});

describe('modelCandidates —— 候选链', () => {
  test('配了模型 → 链上只有它', () => {
    const current: ModelRef = { provider: 'standalone', model: 'deepseek-chat' };
    assert.deepEqual(modelCandidates(aiOf(current)), [current]);
  });

  test('没配模型 → 空链（生成侧据此回「当前对话未配置模型」）', () => {
    assert.deepEqual(modelCandidates(aiOf(undefined)), []);
    assert.deepEqual(modelCandidates(aiOf({ provider: 'standalone', model: '' })), []);
  });
});

describe('modelLabel —— 报错/日志标签', () => {
  test('provider/model', () => {
    assert.equal(modelLabel({ provider: 'standalone', model: 'deepseek-chat' }), 'standalone/deepseek-chat');
  });
});
