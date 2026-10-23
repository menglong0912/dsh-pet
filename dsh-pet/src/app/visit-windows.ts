/**
 * 串门的窗口这一半（Electron）：
 *   - 客人来了：在自家宠物旁边开一个小窗显示客人——内置皮肤换个色、脚下挂名牌、头上冒它说的话。
 *     整窗点击穿透、不抢焦点，不挡主人干活；请它回家走右键菜单（features.ts）。
 *   - 自己出门了：自家宠物窗口变半透明，表示「人不在家」，右键菜单照常能点（叫它回家）。
 *
 * 客人窗口的页面由本机服务的 GET /app/guest 提供（guestPage），动画与字体走插件路由
 * （/dsh-pet-7340/thumb/main/… 与 /font/…），与页面同源，不用另开文件通道。
 * 客人一律用内置皮肤：对方的自定义 pet pack 素材不过网络。
 *
 * 客人站哪儿要知道自家宠物的确切位置：helper 的宠物窗口四周有余量，macOS 上贴屏边时左右余量还会收缩，
 * 从窗口边框反推不准，所以旁听 helper 渲染端逐帧上报的 pet:set-bounds（runtime/electron-helper/preload.js），
 * 那里有窗口坐标、余量、宠物尺寸与脚底垫高。
 */
import { CANVAS_H, FEET_Y } from '../shared/constants';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 用到的 BrowserWindow 成员（只声明用到的：静态 import 'electron' 会让 tsc 整仓找不到类型） */
export interface WindowLike {
  isDestroyed(): boolean;
  getBounds(): Rect;
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean, level: 'floating'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean }): void;
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  destroy(): void;
  webContents: { getURL(): string; executeJavaScript(code: string): Promise<unknown> };
}

export interface WindowElectron {
  BrowserWindow: {
    new (options: Record<string, unknown>): WindowLike;
    getAllWindows(): WindowLike[];
  };
  screen: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): { workArea: Rect };
  };
  ipcMain: {
    on(channel: 'pet:set-bounds', listener: (event: unknown, payload: unknown) => void): void;
    removeListener(channel: 'pet:set-bounds', listener: (event: unknown, payload: unknown) => void): void;
  };
}

/** 自家宠物的包围盒（屏幕坐标）：left/top = 640×360 舞台的左上角，舞台在盒里下移了 bottomPad */
export interface PetBox {
  left: number;
  top: number;
  size: number;
  bottomPad: number;
}

/** 出门时自家宠物的不透明度 */
const AWAY_OPACITY = 0.3;
/** 客人窗口宽度占自家宠物宽度的比例（客人小一号） */
const GUEST_SCALE = 0.7;
/** 客人窗口里，宠物上方留给气泡的高度 */
const BUBBLE_ROOM = 96;
/** 名牌的高度 */
const TAG_ROOM = 26;
/** 脚底在舞台高度上的位置 */
const FEET_RATIO = FEET_Y / CANVAS_H;

/** 自家宠物的窗口：helper 建的那几个（页面是 runtime/electron-helper/index.html） */
function homeWindows(electron: WindowElectron): WindowLike[] {
  return electron.BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.webContents.getURL().includes('electron-helper'),
  );
}

/** 出门 / 回家：自家宠物变半透明 / 恢复 */
export function fadeHome(electron: WindowElectron, away: boolean): void {
  for (const win of homeWindows(electron)) win.setOpacity(away ? AWAY_OPACITY : 1);
}

/** pet:set-bounds 的载荷 → 包围盒（窗口坐标 + 左 / 上余量 = 包围盒）；字段不全时 null */
export function petBoxFrom(payload: unknown): PetBox | null {
  const field = (key: string) => Number((payload as Record<string, unknown> | null)?.[key]);
  const [x, y, marginL, marginT, size, bottomPad] = ['x', 'y', 'marginL', 'marginT', 'size', 'bottomPad'].map(field);
  if (![x, y, marginL, marginT, size, bottomPad].every(Number.isFinite) || size <= 0) return null;
  return { left: x + marginL, top: y + marginT, size, bottomPad };
}

/** 记下自家宠物最近一次上报的位置（只有 helper 的宠物窗口发这条） */
export function watchHomePet(electron: WindowElectron): { box(): PetBox | null; dispose(): void } {
  let latest: PetBox | null = null;
  const listener = (_event: unknown, payload: unknown): void => {
    latest = petBoxFrom(payload) ?? latest;
  };
  electron.ipcMain.on('pet:set-bounds', listener);
  return { box: () => latest, dispose: () => electron.ipcMain.removeListener('pet:set-bounds', listener) };
}

/**
 * 名字 → 色相偏移（同一位客人每次来颜色一样）。只在 240°–300° 之间转：整只宠物一起转色，
 * 这一段头发变绿 / 青、肤色还是粉的；转到别的角度脸会发绿发蓝（拿待机帧按 CSS hue-rotate 矩阵逐档比过）。
 */
export function guestHue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 100_000;
  return 240 + (hash % 61);
}

/**
 * 客人窗口的位置与大小：站在自家宠物左边（左边放不下站右边），脚底对齐，客人小一号；
 * 不知道自家宠物在哪就放到这块屏的左下角。
 */
export function guestBounds(home: PetBox | null, workArea: Rect): Rect {
  const width = Math.round(Math.min(400, Math.max(200, (home?.size ?? 300) * GUEST_SCALE)));
  const videoHeight = (width * 9) / 16;
  const height = Math.round(videoHeight) + BUBBLE_ROOM + TAG_ROOM;
  const clampX = (x: number) => Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  const clampY = (y: number) => Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
  if (!home) return { x: workArea.x, y: workArea.y + workArea.height - height, width, height };
  const center = home.left + home.size / 2;
  const feet = home.top + home.bottomPad + ((home.size * 9) / 16) * FEET_RATIO;
  // 两只宠物中心隔开半只自家宠物多一点：身体不挨着，两边的气泡也不打架
  const apart = home.size / 2 + width * 0.35;
  const left = center - apart - width / 2;
  const x = left >= workArea.x ? left : center + apart - width / 2;
  // 客人的脚：窗口顶 + 气泡空间 + 舞台里脚底的位置
  const y = feet - BUBBLE_ROOM - videoHeight * FEET_RATIO;
  return { x: Math.round(clampX(x)), y: Math.round(clampY(y)), width, height };
}

export interface GuestWindow {
  /** 客人说一句（气泡显示 10 秒） */
  say(text: string): void;
  /** 挥手（进门、告辞时） */
  wave(): void;
  /** 过一会儿关掉（先让告别的话和挥手放完） */
  close(afterMs: number): void;
}

/**
 * 开客人窗口
 * @param pageUrl 本机服务的 /app/guest
 * @param tag 名牌（「小王家的 小鱼」）
 * @param home 自家宠物现在的位置（watchHomePet）
 */
export function openGuestWindow(
  electron: WindowElectron,
  pageUrl: string,
  tag: string,
  home: PetBox | null,
): GuestWindow {
  const point = home
    ? { x: home.left + home.size / 2, y: home.top + home.size / 4 }
    : electron.screen.getCursorScreenPoint();
  const bounds = guestBounds(home, electron.screen.getDisplayNearestPoint(point).workArea);
  const win = new electron.BrowserWindow({
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  // 页面加载完之前的调用排队，加载完按顺序补上
  let ready = false;
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
  // 参数一律 JSON.stringify 成字面量：对方发来的名字和话只当字符串数据，页面里用 textContent 显示
  run(`guest.arrive(${JSON.stringify(tag)}, ${guestHue(tag)})`);
  return {
    say: (text) => run(`guest.say(${JSON.stringify(text)})`),
    wave: () => run('guest.wave()'),
    close(afterMs) {
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, afterMs);
    },
  };
}

/** 客人窗口的页面（静态；名牌、色相、台词由 openGuestWindow 经 executeJavaScript 送进来） */
export const guestPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>客人</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
#bubble{max-width:88%;box-sizing:border-box;padding:7px 12px;margin-bottom:-4px;background:#fff;color:#22313f;border:2px solid #4a5b6c;border-radius:14px;font-size:14px;line-height:1.45;word-break:break-all;opacity:0;transition:opacity .25s}
#bubble.on{opacity:1}
video{width:100%;display:block}
/* 名牌往上提一截：舞台底部 30/360 是脚下的透明边（舞台高 = 窗口宽 × 9/16） */
#tag{height:20px;margin:calc(-100vw * 9 / 16 * 30 / 360 + 2px) 0 4px;padding:0 9px;border-radius:10px;background:rgba(34,49,63,.72);color:#fff;font-size:12px;line-height:20px;white-space:nowrap}
</style></head>
<body><div id="bubble"></div><video id="pet" muted playsinline autoplay></video><div id="tag"></div>
<script>
'use strict';
const ANIM = '/dsh-pet-7340/thumb/main/';
const video = document.getElementById('pet');
const bubble = document.getElementById('bubble');
let hideTimer = null;
function play(name, loop) {
  video.loop = loop;
  video.src = ANIM + encodeURIComponent(name) + '.webm';
  video.play().catch(() => undefined);
}
// 挥完手回到待机
video.addEventListener('ended', () => play('待机呼吸休闲', true));
window.guest = {
  arrive(tag, hue) {
    document.getElementById('tag').textContent = tag;
    video.style.filter = 'hue-rotate(' + Number(hue) + 'deg)';
    play('点击回应-元气挥手', false);
  },
  say(text) {
    bubble.textContent = String(text);
    bubble.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove('on'), 10000);
  },
  wave() {
    play('点击回应-元气挥手', false);
  },
};
</script></body></html>
`;
