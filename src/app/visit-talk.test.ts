import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  findPlayThing,
  GUEST_ASK,
  guestPrompt,
  HOST_ASK,
  hostPrompt,
  memoPrompt,
  openerGap,
  PLAY_THINGS,
  talkGap,
  travelPrompt,
  tripRounds,
} from './visit-talk.ts';

test('both sides carry what was said so far, so a reply picks up the thread', () => {
  const lines = ['你：今天天气真好', '阿花：是呀，适合放风筝', '（一起放风筝）'];
  const guest = guestPrompt('小李', '阿花', lines, GUEST_ASK.follow);
  assert.match(guest, /^你在 小李 家串门，它家的宠物叫「阿花」。/);
  assert.ok(
    guest.includes('刚才你们说了：\n你：今天天气真好\n阿花：是呀，适合放风筝\n（一起放风筝）\n接着跟它聊一句。'),
  );
  const host = hostPrompt('小王', '小鱼', ['小鱼：你家好大呀'], HOST_ASK.answer);
  assert.equal(host, '小王 家的宠物「小鱼」来你家串门。刚才你们说了：\n小鱼：你家好大呀\n回它刚才那句。');
  // 刚进门还没说过话：不提「刚才你们说了」
  assert.equal(
    guestPrompt('小李', '阿花', [], GUEST_ASK.greet),
    '你在 小李 家串门，它家的宠物叫「阿花」。你刚进门，跟它打个招呼。',
  );
  assert.equal(GUEST_ASK.play('吃西瓜'), '你们正一起吃西瓜，说一句。');
});

test('prompts mention the last meeting only when there is a memo', () => {
  const memory = '你们之前见过 3 次，上次是 1 小时前，上次聊了：「聊了放风筝」。';
  const withMemo = guestPrompt('小李', '阿花', ['你：来啦'], GUEST_ASK.greet, memory);
  assert.ok(withMemo.startsWith(`你在 小李 家串门，它家的宠物叫「阿花」。${memory}`));
  const hostWithMemo = hostPrompt('小王', '小鱼', [], HOST_ASK.opener, memory);
  assert.ok(hostWithMemo.startsWith(`小王 家的宠物「小鱼」来你家串门。${memory}`));
  // 没有记录时和原来一样，不提上次
  assert.equal(
    guestPrompt('小李', '阿花', [], GUEST_ASK.greet),
    '你在 小李 家串门，它家的宠物叫「阿花」。你刚进门，跟它打个招呼。',
  );
});

test('memoPrompt sums up the chat for the notebook', () => {
  const lines = ['你：今天天气真好', '阿花：是呀，适合放风筝', '（一起放风筝）'];
  const prompt = memoPrompt('小李', '阿花', lines);
  assert.match(prompt, /^你刚和 小李 家的宠物「阿花」聊了这些：\n/);
  assert.ok(prompt.includes('你：今天天气真好\n阿花：是呀，适合放风筝\n（一起放风筝）\n'));
  assert.ok(prompt.endsWith('用一句话给自己记条备忘，概括这次聊了什么，下次见面好提起。'));
});

test('long visits only send the latest lines to the model', () => {
  const lines = Array.from({ length: 30 }, (_, n) => `你：第 ${n} 句`);
  const prompt = guestPrompt('小李', '阿花', lines, GUEST_ASK.follow);
  assert.ok(!prompt.includes('第 9 句'));
  assert.ok(prompt.includes('第 10 句') && prompt.includes('第 29 句'));
  assert.ok(!travelPrompt('小李', '阿花', lines).includes('第 9 句'));
});

test('how much a guest says grows with the stay, and the pauses are random within bounds', () => {
  assert.equal(tripRounds(1), 2);
  assert.equal(tripRounds(10), 5);
  assert.equal(tripRounds(60), 8);
  assert.equal(
    talkGap(() => 0),
    30_000,
  );
  assert.equal(
    talkGap(() => 1),
    90_000,
  );
  assert.equal(
    openerGap(true, () => 0),
    20_000,
  );
  assert.equal(
    openerGap(true, () => 1),
    30_000,
  );
  assert.equal(
    openerGap(false, () => 0),
    60_000,
  );
  assert.equal(
    openerGap(false, () => 1),
    120_000,
  );
});

test('every play thing has a built-in animation the plugin will play, and its menu label fits', () => {
  const config = readFileSync(new URL('../../assets/config.jsonc', import.meta.url), 'utf8');
  for (const thing of PLAY_THINGS) {
    assert.ok(existsSync(new URL(`../../assets/webm/${thing.anim}.webm`, import.meta.url)), `${thing.anim}.webm`);
    assert.ok(config.includes(`"${thing.anim}"`), `${thing.anim} 在默认动画池里`);
    // 右键菜单项 ≤ 32 字：「和 <最长 12 字的名字> 一起玩/<项目>」
    assert.ok(Array.from(`和 ${'名'.repeat(12)} 一起玩/${thing.label}`).length <= 32, thing.label);
    assert.equal(findPlayThing(thing.label), thing);
  }
  assert.equal(findPlayThing('跳楼'), undefined);
});
