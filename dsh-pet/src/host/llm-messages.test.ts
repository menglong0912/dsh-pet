/**
 * 本地消息形状的单测：生成侧只依赖这几个纯函数/类，形状错了会在真实调用时才炸。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from './llm-messages.ts';

describe('消息工厂', () => {
  test('user / assistant 角色与来源原样保留', () => {
    assert.deepEqual(createUserMessage({ content: '在吗', source: { kind: 'user' } }), {
      role: 'user',
      content: '在吗',
      source: { kind: 'user' },
    });
    assert.deepEqual(createAssistantMessage({ content: '在', source: { provider: 'p', model: 'm' } }), {
      role: 'assistant',
      content: '在',
      source: { provider: 'p', model: 'm' },
    });
  });
});

describe('BlockAssembler', () => {
  test('只收集文本块并拼接；非文本块忽略', () => {
    const assembler = new BlockAssembler();
    assembler.push({ type: 'text', text: '你' });
    assembler.push({ type: 'tool-call', name: 'x' });
    assembler.push({ type: 'text', text: '好' });
    assert.deepEqual(assembler.blocks(), [{ type: 'text', text: '你好' }]);
  });

  test('没有任何文本 → 空列表；finish 默认未定义', () => {
    const assembler = new BlockAssembler();
    assembler.push({ type: 'finish', reason: { kind: 'error' } });
    assert.deepEqual(assembler.blocks(), []);
    assert.equal(assembler.finish, undefined);
  });
});

describe('ReasoningEffortId', () => {
  test('原样返回标识', () => {
    assert.equal(ReasoningEffortId('off'), 'off');
  });
});
