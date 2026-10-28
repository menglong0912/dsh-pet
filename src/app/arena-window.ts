/**
 * 擂台窗口（修炼路线 X3）：一只透明、置顶、不可聚焦、鼠标穿透的小窗，浮在两只宠物头顶，
 * 只画两条气血条、名字和境界——谁打谁、打到多少血，隔着半个屏幕也看得见。
 *
 * 页面走本机服务的 `GET /app/arena`（和 /app/note、/app/guest 同法，见 app-routes.ts）；数据由这里经
 * `executeJavaScript` 送进页面，一律 `JSON.stringify` 成字面量，页面只用 textContent 与 style.width 显示。
 *
 * 窗口自己不动：`place()` 按两只宠物的位置重算（宠物会走位），调用方隔一小段时间叫一回。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

/** 小窗高度（两条血 + 两行名字 + 上下边距） */
export const ARENA_HEIGHT = 62;
/** 上下边距 */
const PAD = 8;
/** 名字那一行的高度 */
const LABEL = 15;
/** 血条高度 */
const BAR = 9;
/** 两条之间的间隔 */
const GAP = 9;
/** 窗口横向比两只宠物的外沿各多让开这么多（血条不压在宠物身上） */
const SIDE_ROOM = 12;
/** 宽度夹在 200–520：太窄名字放不下，太宽就飞到别的屏上去了 */
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;

/** 一条血显示什么：名字 · 境界，加上还剩几成 */
export interface ArenaBar {
  label: string;
  hp: number;
  maxHp: number;
}

/** `arena.update(...)` 的载荷：左、右两条（谁在左由调用方按两只宠物的实际位置定） */
export interface ArenaUpdate {
  left: { label: string; percent: number };
  right: { label: string; percent: number };
}

/**
 * 血条的百分比：上限非法（0、NaN）或血没了当空血，绝不画成满的。
 * 赢的一方 100，躺下的那位 0。
 */
export function hpPercent(hp: number, maxHp: number): number {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0 || hp <= 0) return 0;
  return Math.min(100, Math.round((hp / maxHp) * 100));
}

/** 两条血 → 页面要的载荷（百分比在这里算好，页面只管画宽度，不重复一套数学） */
export function arenaUpdate(left: ArenaBar, right: ArenaBar): ArenaUpdate {
  return {
    left: { label: left.label, percent: hpPercent(left.hp, left.maxHp) },
    right: { label: right.label, percent: hpPercent(right.hp, right.maxHp) },
  };
}

/**
 * 擂台小窗的位置：横向盖住两只宠物（自家宠物的包围盒 + 对手窗口的位置），纵向在它们头顶上方。
 * 不知道自家宠物在哪时放屏幕上方中间；对手窗口还没位置（还没开）时按自家宠物那一侧排。
 */
export function arenaBounds(home: PetBox | null, foe: Rect | null, workArea: Rect): Rect {
  const span: number[] = [];
  if (home) span.push(home.left, home.left + home.size);
  if (foe) span.push(foe.x, foe.x + foe.width);
  if (span.length === 0) span.push(workArea.x + workArea.width / 2 - 150, workArea.x + workArea.width / 2 + 150);
  const center = (Math.min(...span) + Math.max(...span)) / 2;
  const width = Math.round(
    Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.max(...span) - Math.min(...span) + 2 * SIDE_ROOM)),
  );
  const x = Math.round(Math.min(Math.max(center - width / 2, workArea.x), workArea.x + workArea.width - width));
  const top = home ? home.top : workArea.y + 100;
  const y = Math.round(
    Math.min(Math.max(top - ARENA_HEIGHT - 6, workArea.y), workArea.y + workArea.height - ARENA_HEIGHT),
  );
  return { x, y, width, height: ARENA_HEIGHT };
}

/**
 * 一场的血条：两只的名字、境界与气血上限整场不变，每步只喂引擎的 hp 数组。
 * `foeOnLeft` = 对手（心魔 / 客人）站在自家宠物左边：那它那条血在左边。
 * 百分比和左右排布都在这算，features.ts 只把它接到执行器的 arena 那一只手。
 */
export function arenaScoreboard(info: {
  self: { label: string; maxHp: number };
  foe: { label: string; maxHp: number };
}): (hp: [number, number], foeOnLeft: boolean) => ArenaUpdate {
  return (hp, foeOnLeft) => {
    const self = { label: info.self.label, hp: hp[0], maxHp: info.self.maxHp };
    const foe = { label: info.foe.label, hp: hp[1], maxHp: info.foe.maxHp };
    return foeOnLeft ? arenaUpdate(foe, self) : arenaUpdate(self, foe);
  };
}

/** 送进页面的数据一律 JSON.stringify 成字面量：擂台上的名字只当字符串，页面用 textContent 显示 */
export function arenaUpdateCode(update: ArenaUpdate): string {
  return `arena.update(${JSON.stringify(update)})`;
}

export interface ArenaWindow {
  /** 重摆位置（宠物走位了、对手窗口挪了）；算出来没变就什么都不发 */
  place(home: PetBox | null, foe: Rect | null): void;
  /** 刷新两条血 */
  update(update: ArenaUpdate): void;
  /** 现在的位置与大小（对手窗口按它排血条左右） */
  bounds(): Rect;
  /** 过一会儿关掉（先让结果那几步放完） */
  close(afterMs: number): void;
  /** 钉住 / 放开（X16 冲刺）：钉住时按开场站位摆，不跟着两只的实时位置走 */
  pin(on: boolean): void;
}

/**
 * 开擂台窗口。
 * @param electron 只用到 BrowserWindow / screen
 * @param pageUrl 本机服务的 /app/arena
 * @param home 取自家宠物现在的位置（watchHomePet 的 box）
 * @param foe 取对手窗口现在的位置（没开或不知道就只按自家宠物排）
 */
export function openArenaWindow(
  electron: WindowElectron,
  pageUrl: string,
  home: () => PetBox | null,
  foe: () => Rect | null,
): ArenaWindow {
  const workAreaOf = (box: PetBox | null): Rect => {
    const point = box
      ? { x: box.left + box.size / 2, y: box.top + box.size / 4 }
      : electron.screen.getCursorScreenPoint();
    return electron.screen.getDisplayNearestPoint(point).workArea;
  };
  let bounds = arenaBounds(home(), foe(), workAreaOf(home()));
  const win: WindowLike = new electron.BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 被宠物窗口挡住时也不能停：血条要跟着动
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 纯显示：整窗鼠标穿透，点它跟点桌面一样（不抢主人干活）
  win.setIgnoreMouseEvents(true);
  let ready = false;
  let pinned = false;
  const queued: string[] = [];
  const run = (code: string): void => {
    if (win.isDestroyed()) return;
    if (!ready) queued.push(code);
    else void win.webContents.executeJavaScript(code).catch(() => undefined);
  };
  void win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      // 透明窗口没有可闪的底色，加载完再显示即可（不抢焦点）
      win.showInactive();
      ready = true;
      for (const code of queued.splice(0)) run(code);
    })
    .catch(() => win.destroy());
  return {
    place(nextHome, nextFoe) {
      if (pinned) return;
      const next = arenaBounds(nextHome, nextFoe ?? null, workAreaOf(nextHome));
      if (next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height)
        return;
      bounds = next;
      if (!win.isDestroyed()) win.setBounds(bounds);
    },
    update: (update) => run(arenaUpdateCode(update)),
    bounds: () => bounds,
    pin(on) {
      pinned = on;
    },
    close(afterMs) {
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, afterMs);
    },
  };
}

/** 擂台窗口的页面（静态；两条血的名字与百分比由 openArenaWindow 经 executeJavaScript 送进来） */
export const arenaPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>擂台</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;flex-direction:column;justify-content:center;gap:${GAP}px;padding:${PAD}px;box-sizing:border-box;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
/* 左边那条名字靠左、血从左边涨；右边那条整个反过来 */
.row{display:flex;flex-direction:column;gap:2px;width:100%}
.row.right{align-items:flex-end}
.label{height:${LABEL}px;font-size:12px;line-height:${LABEL}px;color:#fff;text-shadow:0 1px 2px rgba(20,24,32,.9);white-space:nowrap;overflow:hidden;max-width:100%}
.bar{width:100%;height:${BAR}px;box-sizing:border-box;border:1px solid rgba(255,255,255,.85);border-radius:5px;background:rgba(20,24,32,.45);overflow:hidden;display:flex}
.fill{height:100%;width:100%;background:linear-gradient(#7fe08a,#2f9e4b);transition:width .3s}
.row.right .fill{margin-left:auto}
/* 血少于两成变红：隔半个屏幕也看得出谁快撑不住了 */
.fill.low{background:linear-gradient(#ff9a8a,#dd3333)}
</style></head>
<body>
<div class="row left"><div class="label" id="l0"></div><div class="bar"><div class="fill" id="f0"></div></div></div>
<div class="row right"><div class="label" id="l1"></div><div class="bar"><div class="fill" id="f1"></div></div></div>
<script>
'use strict';
// 只认 textContent 与 style.width：送进来的名字和数字都当字符串数据，绝不拼进 HTML
window.arena = {
  update(state) {
    const sides = [state.left, state.right];
    for (let i = 0; i < 2; i++) {
      const side = sides[i] || { label: '', percent: 0 };
      const percent = Math.max(0, Math.min(100, Number(side.percent)));
      document.getElementById('l' + i).textContent = String(side.label);
      const fill = document.getElementById('f' + i);
      fill.style.width = percent + '%';
      fill.classList.toggle('low', percent < 20);
    }
  },
};
</script></body></html>
`;
