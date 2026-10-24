import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSettings, publicSettings } from './settings.ts';
import { settingsPage, settingsScript, settingsStyle } from './settings-page.ts';

test('settings validation accepts explicit costs and write-only blank/clear key semantics', () => {
  const input = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKey: '',
    enabled: false,
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 512,
  };
  assert.deepEqual(validateSettings(input), input);
  assert.deepEqual(validateSettings({ clearApiKey: true }), { clearApiKey: true });
  for (const input of [
    null,
    [],
    { protocol: 'other' },
    { enabled: 'true' },
    { whisperIntervalSec: 59 },
    { whisperIntervalSec: 1.5 },
    { maxTokens: 99999 },
    { apiKey: 123 },
    { hasKey: true },
    { baseUrl: 'file:///a' },
    { baseUrl: 'https://user:secret@example.test/v1' },
    { baseUrl: 'https://example.test/?key=secret' },
  ]) {
    assert.throws(() => validateSettings(input), Error, JSON.stringify(input));
  }
});
test('public settings are an allowlist even if backend accidentally includes credentials', () => {
  const actual = publicSettings({
    protocol: 'anthropic',
    apiKey: 'never expose',
    token: 'never expose',
    hasKey: true,
    model: 'x',
    enabled: false,
  });
  assert.deepEqual(actual, { protocol: 'anthropic', hasKey: true, model: 'x', enabled: false });
  assert.equal(JSON.stringify(actual).includes('never expose'), false);
});
test('settings shell is accessible, self contained, and never saves browser secrets', () => {
  assert.match(settingsPage, /lang="zh-CN"/);
  assert.match(settingsPage, /type="password"/);
  assert.match(settingsPage, /aria-live="polite"/);
  assert.match(settingsPage, /automaticWhispers/);
  assert.match(settingsPage, /费用/);
  assert.match(settingsPage, /min="60"/);
  assert.match(settingsScript, /history\.replaceState/);
  assert.match(settingsScript, /X-DSH-Pet-Token/);
  assert.doesNotMatch(settingsScript, /localStorage|sessionStorage|document\.cookie|innerHTML/);
  assert.doesNotMatch(settingsPage, /https?:\/\/(?!example)/);
  assert.match(settingsStyle, /focus-visible/);
});

test('settings browser script strips fragment, keeps key write-only and explicitly clears without AI requests', async () => {
  const { runInNewContext } = await import('node:vm');
  type Element = {
    value: string;
    checked: boolean;
    disabled: boolean;
    textContent: string;
    dataset: Record<string, string>;
    listeners: Record<string, (event?: unknown) => Promise<void> | void>;
    addEventListener: (name: string, fn: (event?: unknown) => Promise<void> | void) => void;
    reportValidity: () => boolean;
  };
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        textContent: '',
        dataset: {},
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        reportValidity: () => true,
      });
    return elements.get(id)!;
  };
  const requests: Array<{ url: string; options: { method: string; body?: string; headers: Record<string, string> } }> =
    [];
  let stripped = '';
  runInNewContext(settingsScript, {
    URLSearchParams,
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: {
      replaceState: (_a: unknown, _b: unknown, path: string) => {
        stripped = path;
      },
    },
    document: { getElementById: element },
    fetch: async (url: string, options: { method: string; body?: string; headers: Record<string, string> }) => {
      requests.push({ url, options });
      // CLI 没有「陪伴与提醒」「宠物」「邻居」几节：app-settings / pet-settings / app-neighbors 是 404，页面既不显示也不保存它们
      if (
        url === '/standalone-ai/app-settings' ||
        url === '/standalone-ai/pet-settings' ||
        url === '/standalone-ai/app-neighbors'
      ) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          protocol: 'anthropic',
          baseUrl: 'https://example.test',
          model: 'x',
          hasKey: true,
          enabled: true,
          automaticWhispers: false,
          whisperIntervalSec: 300,
          maxTokens: 1024,
        }),
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stripped, '/standalone-ai/');
  assert.equal(element('apiKey').value, '');
  assert.equal(element('key-state').textContent, '已保存 · 不回显');
  element('apiKey').value = 'write-only-fake-key';
  await element('settings').listeners.submit({ preventDefault() {} });
  assert.equal(element('apiKey').value, '');
  const saves = () => requests.filter(({ url }) => url === '/standalone-ai/settings');
  assert.equal(JSON.parse(saves()[1].options.body ?? '{}').apiKey, 'write-only-fake-key');
  element('clearApiKey').checked = true;
  element('clearApiKey').listeners.change();
  assert.equal(element('enabled').checked, false);
  assert.equal(element('apiKey').disabled, true);
  await element('settings').listeners.submit({ preventDefault() {} });
  assert.equal(JSON.parse(saves()[2].options.body ?? '{}').clearApiKey, true);
  assert.equal(JSON.parse(saves()[2].options.body ?? '{}').enabled, false);
  assert.equal(element('apiKey').disabled, false);
  // 只碰本机设置接口（AI 设置 + 应用的几节），且都带令牌；CLI 下应用的几节只探测一次、不保存
  assert.ok(
    requests.every(
      ({ url, options }) =>
        [
          '/standalone-ai/settings',
          '/standalone-ai/app-settings',
          '/standalone-ai/pet-settings',
          '/standalone-ai/app-neighbors',
        ].includes(url) && options.headers['X-DSH-Pet-Token'] === 'process-capability',
    ),
  );
  for (const section of [
    '/standalone-ai/app-settings',
    '/standalone-ai/pet-settings',
    '/standalone-ai/app-neighbors',
  ]) {
    assert.deepEqual(
      requests.filter(({ url }) => url === section).map(({ options }) => options.method),
      ['GET'],
    );
  }
});

test('settings browser script shows and saves the app section when the app serves it', async () => {
  const { runInNewContext } = await import('node:vm');
  type Element = {
    value: string;
    checked: boolean;
    disabled: boolean;
    hidden: boolean;
    textContent: string;
    dataset: Record<string, string>;
    listeners: Record<string, (event?: unknown) => Promise<void> | void>;
    addEventListener: (name: string, fn: (event?: unknown) => Promise<void> | void) => void;
    reportValidity: () => boolean;
  };
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        hidden: id === 'app-settings' || id === 'visit-settings',
        textContent: '',
        dataset: {},
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        reportValidity: () => true,
      });
    return elements.get(id)!;
  };
  const requests: Array<{ url: string; options: { method: string; body?: string } }> = [];
  const app = {
    greetAfterAwayMin: 10,
    screen: { enabled: true, intervalMin: 15 },
    sitting: { enabled: true, afterMin: 50, repeatMin: 20 },
    water: { enabled: true, everyMin: 60 },
    offWork: { enabled: true, time: '18:00', weekdaysOnly: true, leadMin: 10 },
    visit: {
      enabled: false,
      hosting: true,
      visiting: true,
      chat: true,
      nickname: '',
      stayMin: 10,
      autoAdmitFriends: false,
    },
  };
  runInNewContext(settingsScript, {
    URLSearchParams,
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: { replaceState: () => undefined },
    document: { getElementById: element },
    fetch: async (url: string, options: { method: string; body?: string }) => {
      requests.push({ url, options });
      // 「邻居」一节另有专门测试；这里只当它不存在（不显示）
      if (url === '/standalone-ai/app-neighbors') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => (url === '/standalone-ai/app-settings' ? app : { hasKey: false }) };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('app-settings').hidden, false);
  assert.equal(element('screenEnabled').checked, true);
  assert.equal(element('screenIntervalMin').value, '15');
  assert.equal(element('sittingAfterMin').value, '50');
  assert.equal(element('greetAfterAwayMin').value, '10');
  assert.equal(element('offWorkTime').value, '18:00');
  assert.equal(element('offWorkLeadMin').value, '10');
  assert.equal(element('offWorkWeekdaysOnly').checked, true);
  assert.equal(element('visit-settings').hidden, false);
  assert.equal(element('visitEnabled').checked, false);
  assert.equal(element('visitHosting').checked, true);
  assert.equal(element('visitStayMin').value, '10');
  // 总开关关着：细节开关置灰；打开总开关就能改
  assert.equal(element('visitHosting').disabled, true);
  assert.equal(element('visitStayMin').disabled, true);
  element('screenIntervalMin').value = '30';
  element('waterEnabled').checked = false;
  element('offWorkTime').value = '17:30';
  element('offWorkLeadMin').value = '15';
  element('visitEnabled').checked = true;
  element('visitEnabled').listeners.change();
  assert.equal(element('visitHosting').disabled, false);
  assert.equal(element('visitStayMin').disabled, false);
  element('visitHosting').checked = false;
  element('visitChat').checked = false;
  element('visitNickname').value = ' 小王 ';
  element('visitStayMin').value = '20';
  await element('settings').listeners.submit({ preventDefault() {} });
  const post = requests.find(({ url, options }) => url === '/standalone-ai/app-settings' && options.method === 'POST');
  assert.deepEqual(JSON.parse(post?.options.body ?? '{}'), {
    ...app,
    screen: { enabled: true, intervalMin: 30 },
    water: { enabled: false, everyMin: 60 },
    offWork: { enabled: true, time: '17:30', weekdaysOnly: true, leadMin: 15 },
    visit: {
      enabled: true,
      hosting: false,
      visiting: true,
      chat: false,
      nickname: '小王',
      stayMin: 20,
      autoAdmitFriends: false,
    },
  });
});

test('settings browser script edits the first desktop pet and shows one automatic-whisper switch', async () => {
  const { runInNewContext } = await import('node:vm');
  type Element = Record<string, unknown> & {
    value: string;
    checked: boolean;
    hidden: boolean;
    textContent: string;
    listeners: Record<string, (event?: unknown) => Promise<void> | void>;
  };
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        hidden: id.endsWith('-settings'),
        textContent: '',
        dataset: {},
        listeners: {},
        addEventListener(name: string, fn: () => void) {
          (this as Element).listeners[name] = fn;
        },
        reportValidity: () => true,
      });
    return elements.get(id)!;
  };
  const position = { corner: 'top-left', marginX: 24, marginY: 100 };
  const webPet = { id: 'web1', name: '网页', size: 300, display: 'web', balanceEnabled: false, position };
  const config = {
    main: {
      whisperPrompt: '默认人设',
      whisperImageEnabled: true,
      chatImageEnabled: false,
      chatMemoryRounds: 5,
      pets: [
        webPet,
        {
          id: 'main',
          name: '吃白饭的',
          size: 500,
          display: 'desktop',
          balanceEnabled: false,
          whisperEnabled: false,
          workStatusEnabled: true,
          fixedEnabled: false,
          position,
        },
      ],
    },
  };
  const file = '/data/dsh-pet/main-config.jsonc';
  const requests: Array<{ url: string; options: { method: string; body?: string } }> = [];
  runInNewContext(settingsScript, {
    URLSearchParams,
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: { replaceState: () => undefined },
    document: { getElementById: element },
    fetch: async (url: string, options: { method: string; body?: string }) => {
      requests.push({ url, options });
      if (url === '/standalone-ai/pet-settings') return { ok: true, json: async () => ({ config, file }) };
      if (url === '/standalone-ai/app-settings' || url === '/standalone-ai/app-neighbors') {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ hasKey: true, enabled: true, automaticWhispers: true }) };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('pet-settings').hidden, false);
  // 改的是第一只桌面宠物，不是列表里的第一只
  assert.equal(element('petName').value, '吃白饭的');
  assert.equal(element('petSize').value, '500');
  assert.equal(element('petPersona').value, '', '没有自己的人设：框里留空，灰字是默认人设');
  assert.equal(element('petPersona').placeholder, '默认人设');
  assert.equal(element('chatMemoryRounds').value, '5');
  assert.equal(element('petConfigFile').textContent, file);
  // 设置里开着自动碎碎念，但这只宠物的 whisperEnabled 关着：合起来就是没开
  assert.equal(element('automaticWhispers').checked, false);

  element('automaticWhispers').checked = true;
  element('petPersona').value = '傲娇的小女仆';
  element('petFixed').checked = true;
  element('chatMemoryRounds').value = '8';
  await element('settings').listeners.submit({ preventDefault() {} });
  const posts = (url: string) =>
    requests.filter((r) => r.url === url && r.options.method === 'POST').map((r) => JSON.parse(r.options.body ?? '{}'));
  assert.equal(posts('/standalone-ai/settings')[0].automaticWhispers, true);
  assert.deepEqual(posts('/standalone-ai/pet-settings')[0], {
    pets: [
      webPet,
      {
        ...config.main.pets[1],
        whisperPrompt: '傲娇的小女仆',
        fixedEnabled: true,
        // 打开自动碎碎念时顺带把这只宠物的碎碎念打开
        whisperEnabled: true,
      },
    ],
    whisperImageEnabled: true,
    chatImageEnabled: false,
    chatMemoryRounds: 8,
  });
  assert.equal(element('status').textContent, '已保存到本机。');

  element('petSize').value = '600';
  await element('settings').listeners.submit({ preventDefault() {} });
  assert.equal(posts('/standalone-ai/pet-settings')[1].pets[1].size, 600);
  assert.match(String(element('status').textContent), /桌宠正在重启/);
});

test('settings browser script renders the neighbors section and fires immediate per-row actions', async () => {
  const { runInNewContext } = await import('node:vm');
  type Element = Record<string, unknown> & {
    value: string;
    checked: boolean;
    hidden: boolean;
    textContent: string;
    children: unknown[];
    listeners: Record<string, (event?: unknown) => Promise<void> | void>;
    addEventListener: (name: string, fn: () => void) => void;
    appendChild: (child: unknown) => void;
    remove: () => void;
  };
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id)) {
      const stub: Element = {
        value: '',
        checked: false,
        disabled: false,
        hidden: id.endsWith('-settings'),
        textContent: '',
        children: [],
        className: '',
        dataset: {},
        type: '',
        listeners: {},
        addEventListener(name, fn) {
          stub.listeners[name] = fn;
        },
        reportValidity: () => true,
        appendChild(child) {
          stub.children.push(child);
        },
        remove: () => undefined,
      };
      elements.set(id, stub);
    }
    return elements.get(id)!;
  };
  const made: Element[] = [];
  const document = {
    getElementById: element,
    createElement: () => {
      const fresh = element(`made-${made.length}`);
      made.push(fresh);
      return fresh;
    },
    createTextNode: (text: string) => ({ text }),
  };
  const records = [
    {
      id: 'a'.repeat(32),
      owner: '小李',
      pet: '阿花',
      friend: true,
      hosted: 2,
      visited: 1,
      firstMet: 0,
      lastMet: Date.parse('2026-10-24T10:00:00+08:00'),
      summary: '',
    },
    {
      id: 'b'.repeat(32),
      owner: '老王',
      pet: '旺财',
      friend: false,
      hosted: 0,
      visited: 1,
      firstMet: 0,
      lastMet: 1_000,
      summary: '',
    },
  ];
  const requests: Array<{ url: string; options: { method: string; body?: string } }> = [];
  let confirmAnswer = false;
  runInNewContext(settingsScript, {
    URLSearchParams,
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: { replaceState: () => undefined },
    document,
    confirm: () => confirmAnswer,
    fetch: async (url: string, options: { method: string; body?: string }) => {
      requests.push({ url, options });
      if (url === '/standalone-ai/app-neighbors') {
        return {
          ok: true,
          json: async () => (options.method === 'GET' ? { id: 'abcd1234', neighbors: records } : { ok: true }),
        };
      }
      if (url === '/standalone-ai/settings') return { ok: true, json: async () => ({ hasKey: false }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('neighbors-settings').hidden, false);
  assert.equal(element('identityId').textContent, 'abcd1234');
  const rows = element('neighbor-list').children;
  assert.equal(rows.length, 2);
  // 行文案：昵称 · 宠物名 · 来过 n 次 / 去过 n 次 · 上次见面（时间格式不卡）
  const child = (el: Element, n: number): Element => el.children[n] as Element;
  assert.match(child(rows[0] as Element, 0).textContent, /小李 · 阿花 · 来过 2 次 \/ 去过 1 次 · 上次见面 \d/);
  const posts = () =>
    requests
      .filter((r) => r.url === '/standalone-ai/app-neighbors' && r.options.method === 'POST')
      .map((r) => JSON.parse(r.options.body ?? '{}'));
  // 熟人勾选框与「忘掉」：立即生效，不跟整页保存走
  const box = child(rows[1] as Element, 1);
  assert.equal(child(box, 0).checked, false);
  child(box, 0).checked = true;
  child(box, 0).listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts()[0], { action: 'friend', id: 'b'.repeat(32), friend: true });
  child(rows[0] as Element, 2).listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts()[1], { action: 'forget', id: 'a'.repeat(32) });
  // 「全部忘掉」「重置身份」先 confirm；点了取消就不发请求
  element('neighborsClear').listeners.click();
  assert.equal(posts().length, 2);
  confirmAnswer = true;
  element('neighborsClear').listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts()[2], { action: 'clear' });
  element('identityReset').listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts()[3], { action: 'reset-identity' });
});
