import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoteOpener, noteBounds, notePage } from './note-window.ts';
import type { WindowElectron, WindowLike } from './visit-windows.ts';

const workArea = { x: 0, y: 25, width: 1440, height: 1200 };
const home = { left: 1000, top: 400, size: 500, bottomPad: 23 };

test('notePage 页面契约：maxlength 60、textContent 显示、note.wait 的约定、回车 / Esc / 超时', () => {
  // 主人自己写的话也限 60 字（和台词同一个口径）
  assert.ok(notePage.includes('maxlength="60"'));
  // 带给谁只当纯文本显示：不拼进 HTML；同一行顺手告诉主人怎么发、怎么取消
  assert.ok(notePage.includes("target.textContent = '捎话给 ' + String(name) + ' · 回车发送，Esc 取消';"));
  // 输入法组字中的回车（字母上屏）和 Esc（取消组字）都不当对我们的操作
  assert.ok(notePage.includes('event.isComposing || event.keyCode === 229'));
  // 主进程拿结果靠这一个约定：页面挂出 window.note，wait() 返回 Promise，回车 resolve 文本，Esc / 超时 resolve null
  assert.ok(notePage.includes('window.note = {'));
  assert.ok(notePage.includes('wait()'));
  assert.ok(notePage.includes("'use strict';"));
  assert.match(notePage, /event\.key === 'Enter'/);
  assert.match(notePage, /event\.key === 'Escape'/);
  // 2 分钟不动自动当取消
  assert.ok(notePage.includes('setTimeout(() => done(null), 120000)'));
  // 没开 preload、不开 IPC：页面里没有别的通道
  assert.equal(notePage.includes('require('), false);
  assert.equal(notePage.includes('ipcRenderer'), false);
});

test('noteBounds：小窗落在宠物左上方，左边放不下换右边，都留在屏里', () => {
  const bounds = noteBounds(home, workArea, { x: 0, y: 0 });
  assert.equal(bounds.width, 360);
  assert.equal(bounds.height, 96);
  assert.equal(bounds.x + bounds.width, home.left - 16);
  assert.ok(bounds.y < home.top, '在宠物上方');
  // 宠物贴着左边：换到右边
  const right = noteBounds({ ...home, left: 0 }, workArea, { x: 0, y: 0 });
  assert.ok(right.x >= 500);
  assert.ok(right.x + right.width <= workArea.x + workArea.width);
  // 不知道宠物在哪：放在光标上方
  const cursor = noteBounds(null, workArea, { x: 700, y: 300 });
  assert.ok(Math.abs(cursor.x + 180 - 700) <= 1);
  assert.equal(cursor.y + 96 + 16, 300);
});

/** 假窗口：executeJavaScript('note.wait()') 的结果由测试控制，其余成员只记录有没有被调 */
function fakeElectron() {
  const shown: string[] = [];
  let destroyed = false;
  let waiter: ((value: unknown) => void) | null = null;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => undefined,
    show: () => shown.push('show'),
    focus: () => shown.push('focus'),
    once: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      getURL: () => '',
      executeJavaScript: (code: string) =>
        code === 'note.wait()' ? new Promise((resolve) => (waiter = resolve)) : Promise.resolve(undefined),
    },
  } as unknown as WindowLike;
  return {
    electron: {
      BrowserWindow: function FakeBrowserWindow() {
        return win;
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 700, y: 300 }),
        getDisplayNearestPoint: () => ({ id: 1, workArea }),
      },
    } as unknown as WindowElectron,
    shown,
    get destroyed() {
      return destroyed;
    },
    /** 页面上主人按了回车 / Esc */
    answer: (value: unknown) => waiter?.(value),
  };
}

test('ask：小窗开着时再点只提到前面，这次当没写（null），话只发第一次那趟', async () => {
  const fake = fakeElectron();
  const opener = createNoteOpener(fake.electron, 'http://127.0.0.1:1/app/note', () => null);
  const first = opener.ask('小李');
  await new Promise((done) => setImmediate(done)); // 等页面加载、wait() 挂上
  // 小窗还开着：第二次点击立即回 null（不跟第一次等同一句话），并把小窗提到前面
  assert.equal(await opener.ask('小李'), null);
  assert.deepEqual(fake.shown.slice(-2), ['show', 'focus']);
  // 第一次点击照常拿到主人写的话，拿到后窗口关掉
  fake.answer('晚饭吃火锅');
  assert.equal(await first, '晚饭吃火锅');
  assert.equal(fake.destroyed, true);
  // 关掉之后再点：重新开一个，照常等话
  const again = opener.ask('小李');
  await new Promise((done) => setImmediate(done));
  fake.answer(null);
  assert.equal(await again, null);
});
