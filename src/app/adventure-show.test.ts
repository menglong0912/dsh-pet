import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdventureShows } from './adventure-show.ts';
import type { WindowElectron, WindowLike } from './visit-windows.ts';

const home = { left: 900, top: 400, size: 300, bottomPad: 18 };
const workArea = { x: 0, y: 25, width: 1440, height: 1200 };

/** 假 electron：只记开出来的窗口、加载的地址和 executeJavaScript 的调用 */
function fakeElectron() {
  const created: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const executed: string[] = [];
  let destroyed = false;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 300, height: 168 }),
    setBounds: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: (url) => {
      urls.push(url);
      return Promise.resolve();
    },
    showInactive: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      getURL: () => '',
      executeJavaScript: (code) => {
        executed.push(code);
        return Promise.resolve(0);
      },
    },
  };
  return {
    electron: {
      BrowserWindow: function FakeBrowserWindow(options: Record<string, unknown>) {
        created.push(options);
        return win;
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ workArea }),
      },
    } as unknown as WindowElectron,
    created,
    urls,
    executed,
    get destroyed() {
      return destroyed;
    },
  };
}

test('Y5 客串：只开对手窗口、冒三句、淡出关掉，不开擂台和特效层', async () => {
  const fake = fakeElectron();
  let fxOpened = 0;
  const shows = createAdventureShows({
    electron: fake.electron,
    petBase: 'http://127.0.0.1:1/dsh-pet-7340',
    home: () => home,
    openFx: () => {
      fxOpened += 1;
      throw new Error('客串不该开特效层');
    },
    holdPet: async () => {
      throw new Error('客串不该占住宠物');
    },
    releasePet: () => {
      throw new Error('客串不该收宠物的摊');
    },
    setBattle: () => {
      throw new Error('客串不该开擂台');
    },
    setLiveBattle: () => {
      throw new Error('客串不该开逐手局');
    },
    refreshMenu: () => undefined,
    playExtra: () => undefined,
    movePet: () => undefined,
    say: () => undefined,
    stageLabel: () => '',
    disposed: () => false,
    closeHoldMs: 0,
    cameoLineMs: 1,
  });
  await shows.cameo({
    foe: 'feng-tianyu',
    lines: ['这不可能！', '他用了宙道蛊虫来加速？', '定仙游！他真的在炼制定仙游蛊吗？'],
  });
  await new Promise((done) => setTimeout(done, 20));

  assert.equal(fake.created.length, 1, '只开一扇对手窗口');
  assert.deepEqual(fake.urls, ['http://127.0.0.1:1/app/foe'], '不开擂台（/app/arena）也不开特效层');
  assert.equal(fxOpened, 0);
  const setup = fake.executed.find((code) => code.startsWith('foe.setup('));
  assert.ok(setup, fake.executed.join('\n'));
  const payload = JSON.parse(setup.slice('foe.setup('.length, -1)) as Record<string, unknown>;
  assert.equal(payload.name, '风天语');
  assert.equal(payload.prefix, '对手-风天语');
  assert.ok(String(payload.portrait).includes(encodeURIComponent('对手-风天语.png')));
  assert.ok(fake.executed.includes('foe.play("起手", 1)'), '只露立绘，CSS 轻跳一下');
  const said = fake.executed.filter((code) => code.startsWith('foe.say('));
  assert.equal(said.length, 3, '三句台词各冒一次');
  assert.ok(said[0].includes('这不可能'));
  assert.ok(said[2].includes('定仙游'));
  assert.ok(fake.executed.includes('foe.fade()'), '说完淡出');
  assert.equal(fake.destroyed, true, '淡出后关窗');
});
