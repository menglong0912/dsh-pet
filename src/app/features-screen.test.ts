import { UNSUPPORTED_IMAGE_MESSAGE } from '../standalone/ai-provider.ts';
import { diaryDate } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import { withFeatures, env, last, memeAsks, visionPrompts, until, TEST_APP_CONFIG } from './features-testkit.ts';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('看屏幕：说出来了才算成功', async () => {
  await withFeatures({}, async (features) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀' });
  });
});

test('看屏幕：说出来的话记进今天的宠物日记，没说出来的不记', async () => {
  const screenEvents = (home: string) => {
    const path = join(home, 'diary', `${diaryDate(Date.now())}.json`);
    if (!existsSync(path)) return [];
    const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
    return day.events.filter((event) => event.kind === 'screen').map((event) => event.text);
  };
  await withFeatures({}, async (features, _said, _bodies, home) => {
    await features.lookAtScreen(true);
    assert.deepEqual(screenEvents(home), ['看了一眼主人的屏幕，说：「主人在写代码呀」']);
  });
  await withFeatures({ broadcast: { ok: false, reason: 'generate-error' } }, async (features, _said, _bodies, home) => {
    await features.lookAtScreen(true);
    assert.deepEqual(screenEvents(home), []);
  });
});

test('看屏幕：插件拒绝说话时如实报失败', async () => {
  await withFeatures({ broadcast: { ok: false, reason: 'generate-error' } }, async (features) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: false, text: '主人在写代码呀', reason: 'say-failed' });
  });
});

test('看屏幕：先说话，再按说出来的话从表情包池挑最搭的一张（看屏幕指令里不提表情包）', async () => {
  const memes = [
    { name: '就一碗', desc: '捧着一只碗' },
    { name: '大的', desc: '比划一个大' },
    { name: '大的要来啦', desc: '举着大喇叭喊' },
  ];
  env.memeAnswer = '「大的要来啦」。'; // 带引号句号、且包含短名「大的」：取完整的那张
  try {
    await withFeatures({ memes }, async (features, _said, bodies) => {
      assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀', image: '大的要来啦' });
      assert.equal(last(bodies)?.image, '大的要来啦');
      assert.match(last(memeAsks) ?? '', /这句话：主人在写代码呀/);
      assert.match(last(memeAsks) ?? '', /就一碗：捧着一只碗/);
      // 回归：图写进看屏幕指令时小模型会顺着表情包名字发挥，看屏幕就不说屏幕了
      assert.doesNotMatch(last(visionPrompts) ?? '', /就一碗|大的要来啦|表情包/);
    });
  } finally {
    env.memeAnswer = '无';
  }
});

test('看屏幕：模型说都不搭、或答的不在池里 → 随机配一张', async () => {
  const memes = [{ name: '就一碗', desc: '捧着一只碗' }];
  try {
    for (const answer of ['无', '我觉得哪张都行']) {
      env.memeAnswer = answer;
      await withFeatures({ memes }, async (features) => {
        assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀', image: '就一碗' });
      });
    }
  } finally {
    env.memeAnswer = '无';
  }
});

test('看屏幕：表情包池为空就不配图', async () => {
  await withFeatures({ memes: [] }, async (features, _said, bodies) => {
    assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '主人在写代码呀' });
    assert.equal('image' in (last(bodies) ?? {}), false);
    assert.doesNotMatch(last(visionPrompts) ?? '', /表情包/);
  });
});

test('右键菜单：耗时的动作不堵后面的点击（看屏幕还没看完，日记那项就先处理了）', async () => {
  // 让看屏幕的模型磨蹭 3 秒：比 until 的等待上限（2 秒）长，旧代码上第二项等不到
  Object.assign(env, { visionDelayMs: 3_000, visionDone: 0 });
  const clicks: string[] = [];
  try {
    await withFeatures({ clicks }, async (_features, said) => {
      clicks.push('看看我在干嘛', '宠物日记');
      // 「宠物日记」先说「等我写写今天的日记～」；这时看屏幕还在等模型，不许被它堵住
      await until(() => said.includes('等我写写今天的日记～'));
      assert.equal(env.visionDone, 0);
      // 看屏幕自己慢慢做完（要等满 3 秒的模型磨蹭，比 until 的上限长，单独等）
      for (let i = 0; i < 250 && !said.includes('主人在写代码呀'); i += 1)
        await new Promise((done) => setTimeout(done, 20));
      assert.ok(said.includes('主人在写代码呀'));
    });
  } finally {
    Object.assign(env, { visionDelayMs: 0, visionDone: 0 });
  }
});

test('看屏幕：模型不支持看图时降级成碎碎念（不截图）', async () => {
  Object.assign(env, { canSeeScreen: false, visionCalls: 0, getSourcesCalls: 0 });
  try {
    await withFeatures(
      { whisper: { ok: true, text: '随口说一句' } },
      async (features, _said, _bodies, _home, { requests }) => {
        assert.deepEqual(await features.lookAtScreen(false), { ok: true, text: '随口说一句' });
        assert.equal(env.visionCalls, 0);
        assert.equal(env.getSourcesCalls, 0);
        assert.ok(
          requests.some((request) => request.path === '/whisper'),
          '应调插件的 /whisper 降级',
        );
      },
    );
  } finally {
    Object.assign(env, { canSeeScreen: true, visionCalls: 0, getSourcesCalls: 0 });
  }
});

test('看屏幕：自动触发没授权屏幕录制时降级成碎碎念，不调 getSources', async () => {
  Object.assign(env, { permission: 'denied', visionCalls: 0, getSourcesCalls: 0 });
  try {
    await withFeatures(
      { whisper: { ok: true, text: '随口说一句' } },
      async (features, _said, _bodies, _home, { requests }) => {
        assert.deepEqual(await features.lookAtScreen(false), { ok: true, text: '随口说一句' });
        assert.equal(env.getSourcesCalls, 0);
        assert.equal(env.visionCalls, 0);
        assert.ok(requests.some((request) => request.path === '/whisper'));
      },
    );
  } finally {
    Object.assign(env, { permission: 'granted', visionCalls: 0, getSourcesCalls: 0 });
  }
});

test('看屏幕：手动触发没授权时照旧提示开权限，不降级', async () => {
  Object.assign(env, { permission: 'denied', visionCalls: 0, getSourcesCalls: 0 });
  try {
    await withFeatures(
      { whisper: { ok: true, text: '随口说一句' } },
      async (features, said, _bodies, _home, { requests }) => {
        assert.deepEqual(await features.lookAtScreen(true), { ok: false, reason: 'no-permission' });
        assert.match(said.join('\n'), /屏幕录制/);
        assert.equal(env.getSourcesCalls, 1);
        assert.equal(env.visionCalls, 0);
        assert.equal(
          requests.some((request) => request.path === '/whisper'),
          false,
        );
      },
    );
  } finally {
    Object.assign(env, { permission: 'granted', visionCalls: 0, getSourcesCalls: 0 });
  }
});

test('看屏幕：模型没配好时自动触发安静跳过，什么都不调', async () => {
  Object.assign(env, { ready: false, visionCalls: 0, getSourcesCalls: 0 });
  try {
    await withFeatures(
      { whisper: { ok: true, text: '随口说一句' } },
      async (features, _said, _bodies, _home, { requests }) => {
        assert.deepEqual(await features.lookAtScreen(false), { ok: false, reason: 'not-ready' });
        assert.equal(env.visionCalls, 0);
        assert.equal(env.getSourcesCalls, 0);
        assert.equal(
          requests.some((request) => request.path === '/whisper'),
          false,
        );
      },
    );
  } finally {
    Object.assign(env, { ready: true, visionCalls: 0, getSourcesCalls: 0 });
  }
});

test('看屏幕：识别出模型不支持看图的那一拍当场降级，之后不再发视觉请求', async () => {
  Object.assign(env, {
    canSeeScreen: true,
    visionError: new Error(UNSUPPORTED_IMAGE_MESSAGE),
    visionCalls: 0,
    getSourcesCalls: 0,
  });
  try {
    await withFeatures(
      { whisper: { ok: true, text: '随口说一句' } },
      async (features, _said, _bodies, _home, { requests }) => {
        assert.deepEqual(await features.lookAtScreen(false), { ok: true, text: '随口说一句' });
        assert.equal(env.visionCalls, 1);
        assert.equal(env.canSeeScreen, false, '识别出来后记住当前设置不支持看图');
        // 下一拍不再发视觉请求，直接降级
        assert.deepEqual(await features.lookAtScreen(false), { ok: true, text: '随口说一句' });
        assert.equal(env.visionCalls, 1);
        assert.equal(requests.filter((request) => request.path === '/whisper').length, 2);
      },
    );
  } finally {
    Object.assign(env, { canSeeScreen: true, visionError: null, visionCalls: 0, getSourcesCalls: 0 });
  }
});

test('看屏幕：手动「看看我在干嘛」在模型不支持看图时也降级', async () => {
  Object.assign(env, { canSeeScreen: false, visionCalls: 0, getSourcesCalls: 0 });
  try {
    await withFeatures({ whisper: { ok: true, text: '随口说一句' } }, async (features) => {
      assert.deepEqual(await features.lookAtScreen(true), { ok: true, text: '随口说一句' });
      assert.equal(env.visionCalls, 0);
      assert.equal(env.getSourcesCalls, 0);
    });
  } finally {
    Object.assign(env, { canSeeScreen: true, visionCalls: 0, getSourcesCalls: 0 });
  }
});

test('看屏幕：自动触发按秒判断到点（不是按分钟）', async () => {
  const config = structuredClone(TEST_APP_CONFIG);
  config.screen.intervalSec = 10;
  const realNow = Date.now;
  const base = realNow();
  let offset = 0;
  Date.now = () => base + offset;
  try {
    await withFeatures({ config }, async (_features, said) => {
      // 构造已过 11 秒：旧代码按 intervalMin * 60_000 算会差 600 秒，这条会超时
      offset = 11_000;
      // 首拍在 offset 改掉之前就取了 now；等下一拍（5 秒）按新的 now 判断
      await until(() => said.includes('主人在写代码呀'), '自动看屏幕按秒到点', 400);
    });
  } finally {
    Date.now = realNow;
  }
});

test('看屏幕：日记距上一条看屏幕记录至少 3 分钟才记', async () => {
  const realNow = Date.now;
  const base = realNow();
  const screenEvents = (home: string): string[] => {
    const path = join(home, 'diary', `${diaryDate(base)}.json`);
    if (!existsSync(path)) return [];
    const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
    return day.events.filter((event) => event.kind === 'screen').map((event) => event.text);
  };
  let offset = 0;
  Date.now = () => base + offset;
  try {
    await withFeatures({}, async (features, _said, _bodies, home) => {
      await features.lookAtScreen(true);
      await features.lookAtScreen(true);
      assert.equal(screenEvents(home).length, 1, '3 分钟内只记一条');
      offset = 3 * 60_000 + 1;
      await features.lookAtScreen(true);
      assert.equal(screenEvents(home).length, 2, '过了 3 分钟再记一条');
    });
  } finally {
    Date.now = realNow;
  }
});
