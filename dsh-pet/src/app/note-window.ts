/**
 * 捎话的小输入窗（T7）：右键「捎话给 X」后，宠物旁边弹出一个带一行输入框的小窗，主人亲手写要捎的话。
 *
 * 窗口要能拿焦点（用户主动点出来的，中文输入法要能用），这与客人窗口（不抢焦点）相反。
 * 不开 preload、不开 IPC：主进程 await win.webContents.executeJavaScript('note.wait()') 拿结果——
 * 页面返回一个 Promise，回车时 resolve 成文本，Esc / 2 分钟不动时 resolve 成 null，窗口被关掉时 reject，都当取消。
 * 页面由本机服务的 GET /app/note 提供（和 /app/guest 同法，见 app-routes.ts）。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

/** 输入框的字数上限（和台词的 LINE_MAX 同一口径） */
export const NOTE_MAX_CHARS = 60;
/** 这么久不动就当取消，自动关 */
export const NOTE_IDLE_MS = 120_000;
const NOTE_WIDTH = 360;
const NOTE_HEIGHT = 96;

/** 小输入窗的位置：宠物上方靠左，放不下换右边；不知道宠物在哪就放在光标旁边 */
export function noteBounds(home: PetBox | null, workArea: Rect, cursor: { x: number; y: number }): Rect {
  const clampX = (x: number) => Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - NOTE_WIDTH);
  const clampY = (y: number) => Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - NOTE_HEIGHT);
  if (!home)
    return {
      x: clampX(cursor.x - NOTE_WIDTH / 2),
      y: clampY(cursor.y - NOTE_HEIGHT - 16),
      width: NOTE_WIDTH,
      height: NOTE_HEIGHT,
    };
  const left = home.left - NOTE_WIDTH - 16;
  const right = home.left + home.size + 16;
  const x = left >= workArea.x ? left : right;
  // 放在宠物头顶上一点，别挡着它
  return { x: clampX(x), y: clampY(home.top - NOTE_HEIGHT - 8), width: NOTE_WIDTH, height: NOTE_HEIGHT };
}

export interface NoteOpener {
  /** 弹出小输入窗等主人写话；取消 / 超时 / 没写都回 null。同一时间只开一个：已经开着时再点只把它提到前面，这次当没写（null） */
  ask(target: string): Promise<string | null>;
  /** 关掉开着的那个（退出时） */
  dispose(): void;
}

/**
 * 建一个小输入窗的开口（features.ts 接线用）
 * @param pageUrl 本机服务的 /app/note
 * @param home 取自家宠物现在的位置（watchHomePet 的 box），小窗弹在它旁边
 */
export function createNoteOpener(electron: WindowElectron, pageUrl: string, home: () => PetBox | null): NoteOpener {
  let current: { win: WindowLike; result: Promise<string | null> } | null = null;

  function ask(target: string): Promise<string | null> {
    if (current) {
      // 已经开着：提到前面就行；这第二次点击当没写（回 null）——话只由第一次点击的那个流程发，
      // 不然两次点击拿到同一句话各发一次，第二次还会被 10 秒间隔拦出一句「发太多了」
      if (!current.win.isDestroyed()) {
        current.win.show();
        current.win.focus();
      }
      return Promise.resolve(null);
    }
    const homeNow = home();
    const point = homeNow
      ? { x: homeNow.left + homeNow.size / 2, y: homeNow.top + homeNow.size / 4 }
      : electron.screen.getCursorScreenPoint();
    const bounds = noteBounds(homeNow, electron.screen.getDisplayNearestPoint(point).workArea, point);
    const win = new electron.BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: true,
      // 用户主动点出来的：要能拿焦点，中文输入法才用得了
      focusable: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const result = new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (text: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(text);
      };
      // 窗口被关掉（executeJavaScript 会 reject）：当取消
      win.once('closed', () => finish(null));
      void win
        .loadURL(pageUrl)
        .then(async () => {
          if (win.isDestroyed()) return finish(null);
          win.show();
          win.focus();
          // 要带给谁（对方主人的昵称）：JSON.stringify 成字面量，页面里用 textContent 显示
          await win.webContents.executeJavaScript(`note.start(${JSON.stringify(target)})`).catch(() => undefined);
          const text = await win.webContents.executeJavaScript('note.wait()').catch(() => null);
          finish(typeof text === 'string' && text ? text : null);
        })
        .catch(() => finish(null));
    });
    current = { win, result };
    void result.then(() => {
      current = null;
      if (!win.isDestroyed()) win.destroy();
    });
    return result;
  }

  return {
    ask,
    dispose() {
      const open = current;
      current = null;
      if (open && !open.win.isDestroyed()) open.win.destroy();
    },
  };
}

/** 小输入窗的页面（静态；带给谁由 createNoteOpener 经 executeJavaScript 送进来） */
export const notePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>捎话</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:#fff;overflow:hidden;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
body{display:flex;flex-direction:column;justify-content:center;gap:7px;padding:12px 14px;box-sizing:border-box;-webkit-app-region:no-drag}
#target{font-size:13px;color:#526a78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#text{width:100%;box-sizing:border-box;border:1px solid #a5bdcb;border-radius:6px;padding:8px 10px;font:15px/1.5 inherit;color:#203b50;background:#fff}
#text:focus{outline:2px solid #3a94c4;outline-offset:1px}
</style></head>
<body><div id="target"></div><input id="text" type="text" maxlength="${NOTE_MAX_CHARS}" spellcheck="false" autocomplete="off">
<script>
'use strict';
const input = document.getElementById('text');
const target = document.getElementById('target');
let settle = null;
let idleTimer = null;
// 只认一次：回车给文本，Esc、超时给 null；之后页面就等着主进程关窗口
function done(value) {
  if (!settle) return;
  const finish = settle;
  settle = null;
  clearTimeout(idleTimer);
  finish(value);
}
function armIdle() {
  clearTimeout(idleTimer);
  if (settle) idleTimer = setTimeout(() => done(null), ${NOTE_IDLE_MS});
}
window.note = {
  start(name) {
    // 提示行：带给谁 + 怎么发怎么取消（名字是对方发来的昵称，只用 textContent 拼进这一行）
    target.textContent = '捎话给 ' + String(name) + ' · 回车发送，Esc 取消';
    input.focus();
  },
  wait() {
    return new Promise((resolve) => {
      if (settle) return;
      settle = resolve;
      armIdle();
    });
  },
};
input.addEventListener('input', armIdle);
input.addEventListener('keydown', (event) => {
  // 输入法组字中的回车 / Esc 是在操作候选框（回车把字母上屏、Esc 取消组字），都不是对我们的操作
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    const text = input.value.trim().slice(0, ${NOTE_MAX_CHARS});
    if (text) done(text);
  } else if (event.key === 'Escape') {
    done(null);
  }
  armIdle();
});
</script></body></html>
`;
