/**
 * 串门的窗口这一半（Electron）：
 *   - 客人来了：在自家宠物旁边开一个小窗显示客人——内置皮肤的蓝色换成粉色、面朝自家宠物、脚下挂名牌、
 *     头上冒它说的话。不抢焦点；只有宠物身上那一块能点（摸它一下），别处点击穿透，不挡主人干活；
 *     请它回家、一起玩走右键菜单（features.ts）。
 *   - 自己出门了：自家宠物窗口变半透明，表示「人不在家」，右键菜单照常能点（叫它回家）；
 *     转播别人家的聊天时临时调亮，看得清气泡。
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
import { BUBBLE_OVERLAP_RATIO } from '../shared/fonts';

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
  setBounds(rect: Rect): void;
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean, level: 'floating'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean }): void;
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  show(): void;
  focus(): void;
  once(event: 'closed', listener: () => void): void;
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
export const AWAY_OPACITY = 0.3;
/** 转播别人家的聊天时（冒气泡那几秒）的不透明度 */
export const RELAY_OPACITY = 0.9;
/** 客人窗口宽度占自家宠物宽度的比例（客人小一号） */
const GUEST_SCALE = 0.7;
/** 客人窗口里，宠物上方留给气泡的高度 */
const BUBBLE_ROOM = 96;
/** 名牌的高度 */
const TAG_ROOM = 26;
/** 看光标在不在客人身上的间隔 */
const HOVER_MS = 100;
/** 跟着自家宠物走的间隔 */
const FOLLOW_MS = 50;
/** 脚底在舞台高度上的位置 */
const FEET_RATIO = FEET_Y / CANVAS_H;
/** 舞台底部脚下的透明边占舞台高的比例（脚底垫高） */
const FEET_PAD_RATIO = (CANVAS_H - FEET_Y) / CANVAS_H;
/**
 * 客人气泡底边伸进舞台的比例：自家宠物的气泡伸进的是「宠物盒」（BUBBLE_OVERLAP_RATIO × 宠物宽），
 * 但舞台在宠物盒里往下错开了一段脚底垫高（舞台高 × 30/360），要扣掉这一段才是伸进舞台的深度。
 */
export const GUEST_BUBBLE_OVERLAP_RATIO = BUBBLE_OVERLAP_RATIO - (9 / 16) * FEET_PAD_RATIO;

/** 自家宠物的窗口：helper 建的那几个（页面是 runtime/electron-helper/index.html） */
function homeWindows(electron: WindowElectron): WindowLike[] {
  return electron.BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.webContents.getURL().includes('electron-helper'),
  );
}

/** 出门 / 转播 / 回家：自家宠物窗口的不透明度（AWAY_OPACITY / RELAY_OPACITY / 1） */
export function fadeHome(electron: WindowElectron, opacity: number): void {
  for (const win of homeWindows(electron)) win.setOpacity(opacity);
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
 * 客人的配色：把蓝色系（色相 170°–270°，头发、裙子、眼睛）转到粉色，稍微提亮、降一点饱和度；
 * 皮肤、白色花边、描边不动（整张图一起 hue-rotate 的话脸会发绿）。带边 20° 渐变，免得出现色块分界。
 * 逐像素改 RGBA；客人页面里每帧对视频画面跑一遍（函数源码原样嵌进页面，所以只能用自己的局部变量）。
 */
export function pinkPixels(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    if (max === 0 || delta / max < 0.12) continue;
    const hue =
      ((max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
    const weight = Math.min(1, Math.max(0, (hue - 170) / 20), Math.max(0, (270 - hue) / 20));
    if (weight === 0) continue;
    const h = (hue + 110 * weight) % 360;
    const s = (delta / max) * (1 - 0.15 * weight);
    const v = max + (1 - max) * 0.25 * weight;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const [rr, gg, bb] =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    data[i] = (rr + m) * 255;
    data[i + 1] = (gg + m) * 255;
    data[i + 2] = (bb + m) * 255;
  }
}

/**
 * 客人窗口的位置与大小：站在自家宠物左边（左边放不下站右边），脚底对齐，客人小一号；
 * 不知道自家宠物在哪就放到这块屏的左下角。
 */
export function guestBounds(home: PetBox | null, workArea: Rect, prefer?: 'left' | 'right'): Rect {
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
  const right = center + apart - width / 2;
  // 优先 prefer 那一边，放不下才换；不传 prefer 时先试左边（原有行为）
  const leftFits = left >= workArea.x;
  const rightFits = right + width <= workArea.x + workArea.width;
  const x = prefer === 'right' && rightFits ? right : leftFits ? left : right;
  // 客人的脚：窗口顶 + 气泡空间 + 舞台里脚底的位置
  const y = feet - BUBBLE_ROOM - videoHeight * FEET_RATIO;
  return { x: Math.round(clampX(x)), y: Math.round(clampY(y)), width, height };
}

/** 客人站在自家宠物哪一边（不知道自家宠物在哪时当左边） */
export function guestSide(bounds: Rect, home: PetBox | null): 'left' | 'right' {
  return home && bounds.x + bounds.width / 2 > home.left + home.size / 2 ? 'right' : 'left';
}

/**
 * 客人跟着自家宠物走一拍：按 guestBounds 的规则算目标位置，优先留在当前这一边；
 * 和现在位置相差不到 1px（也没换边）时返回 null，表示不用动。
 */
export function followGuest(
  current: Rect,
  side: 'left' | 'right',
  home: PetBox | null,
  workArea: Rect,
): { bounds: Rect; side: 'left' | 'right' } | null {
  const bounds = guestBounds(home, workArea, side);
  const nextSide = guestSide(bounds, home);
  if (
    nextSide === side &&
    Math.abs(bounds.x - current.x) < 1 &&
    Math.abs(bounds.y - current.y) < 1 &&
    bounds.width === current.width &&
    bounds.height === current.height
  ) {
    return null;
  }
  return { bounds, side: nextSide };
}

/** 客人窗口里宠物身体那一块（屏幕坐标）：光标在这里时窗口才接点击，别处照样穿透 */
export function petHitRect(bounds: Rect): Rect {
  const videoHeight = (bounds.width * 9) / 16;
  const top = bounds.y + BUBBLE_ROOM + videoHeight * 0.15;
  return {
    x: Math.round(bounds.x + bounds.width * 0.32),
    y: Math.round(top),
    width: Math.round(bounds.width * 0.36),
    height: Math.round(bounds.y + BUBBLE_ROOM + videoHeight * FEET_RATIO - top),
  };
}

export interface GuestWindow {
  /** 客人站在自家宠物哪一边 */
  side: 'left' | 'right';
  /** 客人说一句（气泡默认显示 10 秒；捎话要看得久一点，可另给时长） */
  say(text: string, durationMs?: number): void;
  /** 挥手（进门、告辞时） */
  wave(): void;
  /** 播一段内置皮肤的动画（一起玩），播完回到待机 */
  play(anim: string): void;
  /** 过一会儿关掉（先让告别的话和挥手放完） */
  close(afterMs: number): void;
}

/**
 * 开客人窗口
 * @param pageUrl 本机服务的 /app/guest
 * @param tag 名牌（「小王家的 小鱼」）
 * @param home 取自家宠物现在的位置（watchHomePet 的 box）；客人跟着它走
 * @param onPoke 主人点了客人一下
 */
export function openGuestWindow(
  electron: WindowElectron,
  pageUrl: string,
  tag: string,
  home: () => PetBox | null,
  onPoke: () => void,
): GuestWindow {
  const homeNow = home();
  const point = homeNow
    ? { x: homeNow.left + homeNow.size / 2, y: homeNow.top + homeNow.size / 4 }
    : electron.screen.getCursorScreenPoint();
  let bounds = guestBounds(homeNow, electron.screen.getDisplayNearestPoint(point).workArea);
  let side = guestSide(bounds, homeNow);
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
    // 主人在别的应用里时，点客人的第一下也要算数（不然第一下只用来激活窗口）
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 客人是逐帧画出来的（requestAnimationFrame）：被自家宠物窗口挡住时也不能停
      backgroundThrottling: false,
    },
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
  // 窗口没有 preload、不开 IPC：主进程每 HOVER_MS 看一眼光标——在客人身上就让窗口接点击，
  // 再顺手问页面这段时间被点了几下（页面自己先播被摸的反应动画）
  let hit = petHitRect(bounds);
  let clickable = false;
  const hover = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(hover);
      return;
    }
    const cursor = electron.screen.getCursorScreenPoint();
    const inside =
      cursor.x >= hit.x && cursor.x < hit.x + hit.width && cursor.y >= hit.y && cursor.y < hit.y + hit.height;
    if (inside !== clickable) {
      clickable = inside;
      win.setIgnoreMouseEvents(!inside);
    }
    if (inside && ready) {
      void win.webContents
        .executeJavaScript('guest.takePokes()')
        .then((pokes) => {
          if (Number(pokes) > 0) onPoke();
        })
        .catch(() => undefined);
    }
  }, HOVER_MS);
  // 跟着自家宠物走：每拍取一次 home()，位置变了就挪窗口、重算命中区；没收到位置（null）就不动。
  // workArea 取自家宠物中心所在的那块屏：宠物被拖到另一块屏时，客人跟过去。
  const follow = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(follow);
      return;
    }
    const box = home();
    if (!box) return;
    const workArea = electron.screen.getDisplayNearestPoint({
      x: box.left + box.size / 2,
      y: box.top + box.size / 2,
    }).workArea;
    const next = followGuest(bounds, side, box, workArea);
    if (!next) return;
    const turned = next.side !== side;
    bounds = next.bounds;
    side = next.side;
    hit = petHitRect(bounds);
    win.setBounds(bounds);
    if (turned) run(`guest.face(${JSON.stringify(side === 'left' ? 'right' : 'left')})`);
  }, FOLLOW_MS);
  // 参数一律 JSON.stringify 成字面量：对方发来的名字和话只当字符串数据，页面里用 textContent 显示
  run(`guest.arrive(${JSON.stringify(tag)}, ${JSON.stringify(side === 'left' ? 'right' : 'left')})`);
  return {
    get side() {
      return side;
    },
    say: (text, durationMs) => run(`guest.say(${JSON.stringify(text)}, ${Number(durationMs) || 10000})`),
    wave: () => run('guest.wave()'),
    play: (anim) => run(`guest.play(${JSON.stringify(anim)})`),
    close(afterMs) {
      setTimeout(() => {
        clearInterval(hover);
        clearInterval(follow);
        if (!win.isDestroyed()) win.destroy();
      }, afterMs);
    },
  };
}

/** 客人窗口的页面（静态；名牌、朝向、台词由 openGuestWindow 经 executeJavaScript 送进来） */
export const guestPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>客人</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
/* 气泡底边伸进舞台 BUBBLE_OVERLAP_RATIO 那么深（和自家宠物的气泡一个口径）；盖在画布上但不接点击，
   光标在身体命中区里点到气泡时仍算摸到客人 */
#bubble{position:relative;z-index:1;pointer-events:none;max-width:88%;box-sizing:border-box;padding:7px 12px;margin-bottom:calc(-100vw * ${GUEST_BUBBLE_OVERLAP_RATIO});background:#fff;color:#22313f;border:2px solid #4a5b6c;border-radius:14px;font-size:14px;line-height:1.45;word-break:break-all;opacity:0;transition:opacity .25s}
#bubble.on{opacity:1}
#src{display:none}
#pet{width:100%;aspect-ratio:16/9;display:block;cursor:pointer}
/* 朝右 = 素材镜像（素材原样朝左） */
#pet.right{transform:scaleX(-1)}
/* 名牌往上提一截：舞台底部 30/360 是脚下的透明边（舞台高 = 窗口宽 × 9/16） */
#tag{height:20px;margin:calc(-100vw * 9 / 16 * 30 / 360 + 2px) 0 4px;padding:0 9px;border-radius:10px;background:rgba(34,49,63,.72);color:#fff;font-size:12px;line-height:20px;white-space:nowrap}
</style></head>
<body><div id="bubble"></div><canvas id="pet"></canvas><div id="tag"></div><video id="src" muted playsinline autoplay></video>
<script>
'use strict';
const ANIM = '/dsh-pet-7340/thumb/main/';
const IDLE = '待机呼吸休闲';
const REACTIONS = ['点击回应-开心跃动', '点击回应-挠痒咯咯笑', '点击回应-害羞惊讶'];
const pink = ${pinkPixels.toString()};
const video = document.getElementById('src');
const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const bubble = document.getElementById('bubble');
let hideTimer = null;
let pokes = 0;
let shown = -1;
function play(name, loop) {
  video.loop = loop;
  video.src = ANIM + encodeURIComponent(name) + '.webm';
  video.play().catch(() => undefined);
}
// 每出一帧新画面就画到画布上、换成粉色
function draw() {
  requestAnimationFrame(draw);
  if (video.readyState < 2 || video.currentTime === shown) return;
  shown = video.currentTime;
  const width = Math.round(canvas.clientWidth * devicePixelRatio);
  const height = Math.round((width * 9) / 16);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(video, 0, 0, width, height);
  const frame = ctx.getImageData(0, 0, width, height);
  pink(frame.data);
  ctx.putImageData(frame, 0, 0);
}
requestAnimationFrame(draw);
// 挥完手、玩完回到待机
video.addEventListener('ended', () => play(IDLE, true));
// 被主人摸了一下：先自己笑一下，主进程过会儿来取次数，再让客人家那边回句话
canvas.addEventListener('click', () => {
  pokes += 1;
  play(REACTIONS[Math.floor(Math.random() * REACTIONS.length)], false);
});
window.guest = {
  arrive(tag, facing) {
    document.getElementById('tag').textContent = tag;
    guest.face(facing);
    play('点击回应-元气挥手', false);
  },
  face(facing) {
    canvas.classList.toggle('right', facing === 'right');
  },
  say(text, duration) {
    bubble.textContent = String(text);
    bubble.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove('on'), Number(duration) || 10000);
  },
  wave() {
    play('点击回应-元气挥手', false);
  },
  play(name) {
    play(String(name), false);
  },
  takePokes() {
    const count = pokes;
    pokes = 0;
    return count;
  },
};
</script></body></html>
`;
