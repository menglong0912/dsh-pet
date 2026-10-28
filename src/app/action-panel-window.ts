/**
 * 出招面板（修炼路线 X17）：擂台下面一只透明、置顶、不抢焦点但**能点**的小窗。
 *
 * 只在两个时候出现，其余时间关掉：
 *   - 开打前选方式：「自动 / AI 出招 / 手动」，10 秒不点按自动；
 *   - 手动出招轮到自家：「法宝名 / 招式名（有次数的标剩几次）」，20 秒不点按后备挑法出。
 *
 * 页面走本机服务的 `GET /app/panel`（同 /app/arena 的做法，见 app-routes.ts），数据由这里经
 * `executeJavaScript` 送进页面，一律 `JSON.stringify` 成字面量，页面只用 textContent 建按钮。
 * 页面里的点击 POST 本机接口 `/app/battle/choose` —— 同一个接口也能用 curl 驱动（真机核验用），
 * 所以这里不开 preload、不开 IPC。
 *
 * 可点但不抢焦点：`focusable: false` + `acceptFirstMouse: true` + `showInactive()`；鼠标点按钮不会把主人正在打字的输入框顶掉。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

/** 出招方式（X17）：自动照旧整场算好；AI / 手动 / 攻略（固定打法，见 battle.ts guideAction）逐手出招 */
export type TurnMode = 'auto' | 'ai' | 'manual' | 'guide';

/** 一行按钮的高度与行距（对齐 panelPage 的 CSS：12px 字 + 上下 5px 内边距 + 边框，留一点余量） */
const ROW_HEIGHT = 30;
const ROW_GAP = 5;
/** 按钮之外的部分：上下内边距 7 + 标题 16 + 两处间距 5 + 倒计时 12（见 panelPage 的 CSS） */
const CHROME_HEIGHT = 7 + 16 + 5 + 5 + 12 + 7;
/** 面板高度：标题 + 一行按钮 + 倒计时（还没问、或只有一行时） */
export const PANEL_HEIGHT = CHROME_HEIGHT + ROW_HEIGHT + 4;
/** 招多的时候最多这么高，再多就在窗内滚动 */
export const PANEL_MAX_HEIGHT = 260;
/** 面板和擂台之间留一点缝 */
const GAP = 4;

/** 估一段字在面板里有多宽：汉字按整个字号，其余按六成 */
function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0xff ? size : size * 0.6;
  return width;
}

/**
 * 面板要多高（X17）：按页面的 CSS 估每个按钮的宽（字宽 + 左右内边距 9 + 边框），
 * 一行一行排满，算出几行。固定一行高的话招一多就被截掉（真机 21 招只露出两行）。
 */
export function panelHeight(view: PanelView | null, width: number): number {
  if (!view || view.options.length === 0) return PANEL_HEIGHT;
  const usable = Math.max(1, width - 18);
  let rows = 1;
  let line = 0;
  for (const option of view.options) {
    const button = Math.ceil(textWidth(option.label, 12) + (option.note ? 4 + textWidth(option.note, 11) : 0) + 18 + 2);
    const next = line === 0 ? button : line + ROW_GAP + button;
    if (line > 0 && next > usable) {
      rows += 1;
      line = button;
    } else {
      line = next;
    }
  }
  const height = CHROME_HEIGHT + rows * ROW_HEIGHT + (rows - 1) * ROW_GAP + 4;
  return Math.min(Math.max(height, PANEL_HEIGHT), PANEL_MAX_HEIGHT);
}

/** 两个矩形有没有重叠 */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 一个按钮：`pick` 从 1 数（和 AI 回的 JSON、curl 的 pick 同一口径） */
export interface PanelOption {
  pick: number;
  label: string;
  /** 有次数的招式标剩几次 */
  note?: string;
  /** 模型没配好时「AI 出招」灰掉 */
  disabled?: boolean;
}

/** 送进页面的整份状态 */
export interface PanelView {
  kind: 'mode' | 'action';
  title: string;
  seconds: number;
  options: PanelOption[];
}

/** 手动出招时的一项（面板按钮与 AI 的编号清单共用一份） */
export interface PanelAction {
  label: string;
  note?: string;
}

interface Question {
  kind: 'mode' | 'action';
  view: PanelView;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 点了 / 超时 / 关窗时结算；`null` = 没选（关窗） */
  resolve: (pick: number | null) => void;
}

export interface ActionPanelWindow {
  /** 重摆位置（擂台跟着宠物挪了）：算出来没变就什么都不发 */
  place(arena: Rect): void;
  /** 开打前选方式；10 秒（`timeoutMs`）不点回 `'auto'`，面板被关掉回 `null` */
  chooseMode(aiReady: boolean, timeoutMs: number): Promise<TurnMode | null>;
  /** 手动出招：等到点了回 `pick - 1`（0 起的下标），超时（`timeoutMs`）/ 关窗回 `null` */
  chooseAction(actions: PanelAction[], timeoutMs: number): Promise<number | null>;
  /** 模拟一次点击（curl 与本机接口用）：`pick` 从 1 数；现在没有等待的选择回 false */
  choose(pick: number): boolean;
  /** 当前等待的选择（GET /app/battle 调试用）；没有就 null */
  state(): PanelView | null;
  /** 收摊 / 退出：关窗，等着的选择按「没选」结算 */
  close(): void;
}

/**
 * 面板的位置：横向跟擂台一样宽，纵向挂在擂台下面；下面放不下就贴着工作区底边。
 * 不知道擂台在哪（还没开）时放在工作区上方居中。
 * 这样放会压到宠物（宠物在屏幕顶上时擂台也只能贴顶，面板正好盖住两只）：改放到两只宠物下面，
 * 再不行放到擂台上面；都放不下才照原样（`pets` 是两只宠物现在的位置）。
 */
export function panelBounds(
  arena: Rect | null,
  workArea: Rect,
  height: number = PANEL_HEIGHT,
  pets: readonly Rect[] = [],
): Rect {
  const width = Math.min(arena?.width ?? 320, workArea.width);
  const x = Math.round(
    Math.min(
      Math.max(arena ? arena.x + (arena.width - width) / 2 : workArea.x + workArea.width / 2 - width / 2, workArea.x),
      workArea.x + workArea.width - width,
    ),
  );
  const below = arena ? arena.y + arena.height + GAP : workArea.y + 120;
  const y = Math.round(Math.min(Math.max(below, workArea.y), workArea.y + workArea.height - height));
  const at = (top: number): Rect => ({ x, y: Math.round(top), width, height });
  const clear = (rect: Rect): boolean => pets.every((pet) => !overlaps(rect, pet));
  const fits = (rect: Rect): boolean => rect.y >= workArea.y && rect.y + rect.height <= workArea.y + workArea.height;
  if (clear(at(y))) return at(y);
  const alternatives = [
    ...(pets.length > 0 ? [Math.max(...pets.map((pet) => pet.y + pet.height)) + GAP] : []),
    ...(arena ? [arena.y - GAP - height] : []),
  ].map(at);
  return alternatives.find((rect) => fits(rect) && clear(rect)) ?? at(y);
}

/** 建面板窗口；`arena` 取擂台现在的位置（还没开时回 null） */
export function openActionPanel(
  electron: WindowElectron,
  pageUrl: string,
  arena: () => Rect | null,
  home: () => PetBox | null,
  foe: () => Rect | null = () => null,
): ActionPanelWindow {
  const workAreaOf = (): Rect => {
    const box = home();
    const point = box
      ? { x: box.left + box.size / 2, y: box.top + box.size / 4 }
      : electron.screen.getCursorScreenPoint();
    return electron.screen.getDisplayNearestPoint(point).workArea;
  };
  /** 两只宠物现在的位置：面板别压在它们身上 */
  const pets = (): Rect[] => {
    const box = home();
    const rects: Rect[] = box ? [{ x: box.left, y: box.top, width: box.size, height: box.size }] : [];
    const other = foe();
    if (other) rects.push(other);
    return rects;
  };
  /** 面板现在该多高（跟着这一问的按钮数），以及最近一次擂台的位置 */
  let height = PANEL_HEIGHT;
  let lastArena = arena();
  let bounds = panelBounds(lastArena, workAreaOf(), height, pets());
  const win: WindowLike = new electron.BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 可点，但不拿焦点：主人正在打字时弹出来也不抢输入框
    focusable: false,
    // 窗口拿不到焦点，macOS 上点下去只当「激活窗口」、不传给页面：没有这项按钮永远点不上（选方式超时落回自动）
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
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
  let ready = false;
  const queued: string[] = [];
  const run = (code: string): void => {
    if (win.isDestroyed()) return;
    if (!ready) queued.push(code);
    else void win.webContents.executeJavaScript(code).catch(() => undefined);
  };
  let current: Question | null = null;
  const settle = (pick: number | null): void => {
    const question = current;
    if (!question) return;
    current = null;
    if (question.timer !== null) clearTimeout(question.timer);
    run('panel.hide()');
    if (!win.isDestroyed()) win.hide?.();
    question.resolve(pick);
  };
  /**
   * 按页面实际排出来的高度校正：按钮的字体、字号以页面为准，`panelHeight` 的估算只当初值。
   * 量回来时这一问已经换了（点了 / 超时）就不动。
   */
  const measure = (): void => {
    const view = current?.view;
    if (!view || !ready || win.isDestroyed()) return;
    void win.webContents
      // 宽度直接传进去：刚 setBounds 时页面可能还没收到新尺寸，按旧宽度排出来的高度不对（真机踩过）
      .executeJavaScript(`panel.contentHeight(${bounds.width})`)
      .then((value) => {
        if (current?.view !== view || win.isDestroyed() || typeof value !== 'number' || !Number.isFinite(value)) return;
        const next = Math.min(Math.max(Math.ceil(value), PANEL_HEIGHT), PANEL_MAX_HEIGHT);
        if (next === height) return;
        height = next;
        bounds = panelBounds(lastArena, workAreaOf(), height, pets());
        win.setBounds(bounds);
      })
      .catch(() => undefined);
  };
  const ask = (
    view: PanelView,
    timeoutMs: number,
    missing: number | null,
    timeoutPick: number | null,
  ): Promise<number | null> => {
    settle(null); // 上一问还没收尾（正常不会）：先按没选结算，免得两个 Promise 都挂着
    // 宽跟着擂台走；高先按这一问的按钮数估，避开两只宠物摆好位置再亮出来，亮出来以后再量实际高度
    const work = workAreaOf();
    height = panelHeight(view, panelBounds(lastArena, work).width);
    bounds = panelBounds(lastArena, work, height, pets());
    if (!win.isDestroyed()) win.setBounds(bounds);
    const wait = Math.max(1, timeoutMs);
    return new Promise<number | null>((resolve) => {
      const question: Question = {
        kind: view.kind,
        view,
        deadline: Date.now() + wait,
        timer: null,
        resolve: (pick) => resolve(pick ?? missing),
      };
      current = question;
      question.timer = setTimeout(() => {
        if (current !== question) return;
        current = null;
        run('panel.hide()');
        resolve(timeoutPick);
      }, wait);
      run(`panel.show(${JSON.stringify(view)})`);
      if (ready && !win.isDestroyed()) win.showInactive();
      measure();
    });
  };
  void win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      win.showInactive();
      ready = true;
      for (const code of queued.splice(0)) run(code);
      measure();
    })
    .catch(() => win.destroy());
  return {
    place(nextArena) {
      lastArena = nextArena;
      const next = panelBounds(nextArena, workAreaOf(), height, pets());
      if (next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height)
        return;
      const widened = next.width !== bounds.width;
      bounds = next;
      if (!win.isDestroyed()) win.setBounds(bounds);
      // 擂台变宽 / 变窄了：按钮会重新换行，再量一次
      if (widened) measure();
    },
    chooseMode(aiReady, timeoutMs) {
      const view: PanelView = {
        kind: 'mode',
        title: aiReady ? '这一场怎么出招？' : '这一场怎么出招？（模型没配好）',
        seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        options: [
          { pick: 1, label: '自动' },
          { pick: 2, label: 'AI 出招', ...(aiReady ? {} : { disabled: true, note: '模型没配好' }) },
          { pick: 3, label: '手动' },
          { pick: 4, label: '攻略' },
        ],
      };
      return ask(view, timeoutMs, null, 1).then((pick) =>
        pick === 1 ? 'auto' : pick === 2 ? 'ai' : pick === 3 ? 'manual' : pick === 4 ? 'guide' : null,
      );
    },
    chooseAction(actions, timeoutMs) {
      const view: PanelView = {
        kind: 'action',
        title: '轮到你了，出一手',
        seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        options: actions.map((action, index) => ({
          pick: index + 1,
          label: action.label,
          ...(action.note === undefined ? {} : { note: action.note }),
        })),
      };
      return ask(view, timeoutMs, null, null).then((pick) => (pick === null ? null : pick - 1));
    },
    choose(pick) {
      const question = current;
      if (!question) return false;
      const option = question.view.options.find((item) => item.pick === pick);
      if (!option || option.disabled) return false;
      settle(pick);
      return true;
    },
    state: () => current?.view ?? null,
    close() {
      settle(null);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** 出招面板的页面（静态；选项与倒计时由 openActionPanel 经 executeJavaScript 送进来） */
export const panelPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>出招</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
body{box-sizing:border-box;padding:7px 9px;border-radius:10px;background:rgba(20,24,32,.82);box-shadow:0 3px 10px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:5px;color:#fff}
#title{font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f3e9d2}
#buttons{display:flex;flex-wrap:wrap;gap:5px;overflow-y:auto}
button{font:12px/1.2 inherit;color:#203b50;background:linear-gradient(#fff,#dfeaf1);border:1px solid rgba(255,255,255,.9);border-radius:7px;padding:5px 9px;cursor:pointer}
button:hover{background:#fff}
button:disabled{color:#8a99a3;background:#c7d2d9;cursor:default}
button .note{margin-left:4px;font-size:11px;color:#526a78}
#timer{font-size:10px;line-height:12px;color:rgba(255,255,255,.65);white-space:nowrap;overflow:hidden}
</style></head>
<body>
<div id="title"></div>
<div id="buttons"></div>
<div id="timer"></div>
<script>
'use strict';
const title = document.getElementById('title');
const buttons = document.getElementById('buttons');
const timer = document.getElementById('timer');
let deadline = 0;
let tick = null;
// 点击只发一个编号给本机接口：同一个接口 curl 也能调（真机核验不点鼠标）
function send(pick) {
  return fetch('/app/battle/choose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pick }),
  }).catch(() => undefined);
}
function updateTimer(seconds) {
  const left = deadline > 0 ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : seconds;
  timer.textContent = '还剩 ' + left + ' 秒';
}
window.panel = {
  show(state) {
    title.textContent = String(state.title || '');
    buttons.textContent = '';
    const options = Array.isArray(state.options) ? state.options : [];
    for (const option of options) {
      const button = document.createElement('button');
      button.textContent = String(option.label || '');
      if (option.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = String(option.note);
        button.appendChild(note);
      }
      button.disabled = option.disabled === true;
      if (!button.disabled) button.addEventListener('click', () => void send(Number(option.pick)));
      buttons.appendChild(button);
    }
    deadline = Date.now() + Math.max(1, Number(state.seconds) || 0) * 1000;
    if (tick) clearInterval(tick);
    updateTimer(Number(state.seconds) || 0);
    tick = setInterval(() => updateTimer(Number(state.seconds) || 0), 250);
  },
  // 内容按 width 宽排开实际要多高（标题 + 全部按钮 + 倒计时 + 内边距与间距）：窗口按它校正高度。
  // 先把 body 临时定成目标宽度再量，不依赖窗口的新尺寸有没有传到页面
  contentHeight(width) {
    const previous = document.body.style.width;
    if (Number(width) > 0) document.body.style.width = Number(width) + 'px';
    const style = getComputedStyle(document.body);
    const gap = parseFloat(style.rowGap) || 0;
    const height = Math.ceil(
      title.offsetHeight + buttons.scrollHeight + timer.offsetHeight +
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2 * gap,
    );
    document.body.style.width = previous;
    return height;
  },
  hide() {
    buttons.textContent = '';
    title.textContent = '';
    timer.textContent = '';
    deadline = 0;
    if (tick) clearInterval(tick);
    tick = null;
  },
};
</script></body></html>
`;
