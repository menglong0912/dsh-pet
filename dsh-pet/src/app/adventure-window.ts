/**
 * 历练小窗（历练路线 Y3）：右键「修炼/历练」打开，从选秘境、压境入关、走五层、倒带、结局到入账都在这里点完。
 *
 * 窗口照 `note-window.ts`：能拿焦点（主人主动点出来的），约 760×520（工作区装不下按等比缩小），
 * 页面走本机服务的 `GET /app/adventure`。
 * 主进程用 `executeJavaScript('adv.render(<JSON 字面量>)')` 送数据、`adv.wait()` 等主人点——
 * 页面只认一个答案，窗口关掉时当没选。页面显示一律 `textContent`；图片地址由主进程按数据里的名字拼成
 * `/pic/adventure/…`（逐段 `encodeURIComponent`），页面不拼路径。
 *
 * 版面（Y5）：左右两栏，左栏场景图 → 场景文字 → 选项，右栏地图 → 气血 → 加持 → 战利品；整页不滚，
 * 只有选项特别多时选项区自己滚。等奇遇 / 加持 / 法宝 / 春秋蝉 / 两问时地图不接点击。
 * 过场（Y5）：场景图位置播视频，原话一句一句淡入，播完或者主人点一下跳过再往下走。
 *
 * 位置在宠物旁边，和对手窗口相反的那一边；打起来时缩成屏顶一条（名字、气血、快进），打完再展开。
 * 标题栏可拖动（Y4）：拖过以后这次打开 app 期间都停在拖到的位置；拖出屏幕至少留标题栏可见。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

export const ADVENTURE_WIDTH = 760;
export const ADVENTURE_HEIGHT = 520;
/** 打起来缩成的那一条 */
export const ADVENTURE_COMPACT_WIDTH = 320;
export const ADVENTURE_COMPACT_HEIGHT = 88;
/** 拖出屏幕时至少留在可见范围里的标题栏尺寸 */
export const ADVENTURE_BAR_HEIGHT = 44;
export const ADVENTURE_BAR_MIN_WIDTH = 120;
/** 小窗和宠物之间留的缝 */
const GAP = 12;

/** 用到的 BrowserWindow 成员（`hide`、`moved` 不在共用的 WindowLike 里，按需探测） */
type ManagedWindow = WindowLike & {
  hide?(): void;
  on?(event: 'moved', listener: () => void): void;
};

/** 小窗里画的场景：节点插画、过场视频，或封面兜底 */
export interface AdventureSceneView {
  /** 三王传承里的场景图（相对 `assets/pic/adventure/三王传承/` 的带扩展名名字） */
  art?: string;
  /** 过场视频（相对同一目录） */
  video?: string;
  /** 视频缺了 / 播完停在这里的封面 */
  poster?: string;
  /** 节点插画缺了显示这个秘境的地图（任务书 §2.1 的兜底） */
  fallback?: string;
  text: string[];
}

export type AdventureMapNodeState = 'done' | 'now' | 'next' | 'revealed' | 'hidden';

export interface AdventureMapNodeView {
  id: string;
  name: string;
  /** 节点图标（相对 `assets/pic/adventure/通用/` 的带扩展名名字） */
  icon: string;
  state: AdventureMapNodeState;
}

export interface AdventureMapLayerView {
  index: number;
  name: string;
  state: 'done' | 'current' | 'next' | 'revealed' | 'hidden';
  nodes: AdventureMapNodeView[];
}

export interface AdventureTravelView {
  from: number;
  to: number;
  /** 这一趟赶路还剩多久（毫秒）：头像走过去的 CSS 动画用它 */
  ms: number;
}

/** 操作区的一个选项 */
export interface AdventureChoiceView {
  kind: 'node' | 'choice' | 'blessing' | 'rewind' | 'end' | 'retreat';
  label: string;
  note?: string;
  /** node 用 */
  id?: string;
  /** choice / blessing / loadout 用（节点编号） */
  node?: string;
  /** 奇遇选项在节点里的下标 */
  index?: number;
  /** 加持编号 */
  blessing?: string;
  /** 节点图标 / 加持卡面 */
  icon?: string;
  card?: string;
}

export interface AdventureLoadoutView {
  node: string;
  max: number;
  weapons: Array<{ id: string; name: string }>;
  foe: { name: string; tactics: string; moves: string[] };
}

export interface AdventureRunView {
  scene: AdventureSceneView;
  hp: { now: number; max: number };
  map: { current: number; layers: AdventureMapLayerView[]; travel: AdventureTravelView | null };
  /** 地图底图（相对 `assets/pic/adventure/三王传承/` 的带扩展名名字） */
  mapArt: string;
  /** 宠物 Q 版头像（相对 `assets/pic/adventure/通用/`） */
  avatar: string;
  blessings: Array<{ name: string; card: string }>;
  loot: string[];
  gu: string;
  cicada: string;
  day: { label: string; cracks: number } | null;
  text: string[];
  choices: AdventureChoiceView[];
  /** 只有在选下一个节点时地图才亮成能点的；等奇遇、加持、法宝、春秋蝉、两问时不接点击（Y5） */
  mapClickable: boolean;
  /** 小窗正在播过场：场景图位置播视频，原话一句一句淡入（Y5） */
  cutscene: { lines: string[] } | null;
  loadout: AdventureLoadoutView | null;
  fullShow: boolean;
  /** 有能完整演的小怪 / 精英时，才给这个开关 */
  fullToggle: boolean;
  compact: boolean;
  canSkip: boolean;
}

export interface AdventureEntryView {
  cover: string;
  /** 封面缺了也退回地图 */
  fallback?: string;
  opening: string[];
  sealed: boolean;
  best: string;
  endings: Array<{ name: string; seen: boolean }>;
  suppressed: boolean;
}

export interface AdventureEndingView {
  name: string;
  title: string;
  text: string[];
  loot: string[];
}

/** 小窗要显示的一页（入口 / 一趟里 / 结局） */
export interface AdventureView {
  kind: 'entry' | 'run' | 'ending';
  title: string;
  subtitle?: string;
  /** 「自动走」开关的状态（这次打开 app 期间记住，不进存档） */
  auto?: boolean;
  entry?: AdventureEntryView;
  run?: AdventureRunView;
  ending?: AdventureEndingView;
}

/** 主人的一个点击（页面传给主进程的答案） */
export type AdventureAnswer =
  | { kind: 'enter'; suppressed: boolean }
  | { kind: 'close' }
  | { kind: 'hide' }
  | { kind: 'toggle-auto'; on: boolean }
  | { kind: 'node'; node: string }
  | { kind: 'choice'; node: string; index: number }
  | { kind: 'blessing'; node: string; blessing: string }
  | { kind: 'loadout'; node: string; weapons: string[] }
  | { kind: 'rewind' }
  | { kind: 'end' }
  | { kind: 'retreat' }
  | { kind: 'toggle-full'; on: boolean }
  | { kind: 'again' }
  | { kind: 'skip' }
  /** 过场播完了（页面发的，不算主人的点击） */
  | { kind: 'cutscene-done' };

export interface AdventureWindow {
  /** 送一页数据进页面（JSON 字面量） */
  render(view: AdventureView): void;
  /** 等主人点一下；窗口关掉时回 null */
  wait(): Promise<AdventureAnswer | null>;
  /** 不再等这一下（开打时的快进监听用） */
  cancelWait(): void;
  /** 打起来缩成屏顶一条，打完展开 */
  setCompact(compact: boolean): void;
  /** 收起（只藏起来，流程不停） */
  hide(): void;
  /** 从菜单叫回来 */
  show(): void;
  /** 主人拖过以后停的位置；没拖过是 null（跟着宠物旁边走） */
  position(): Rect | null;
  bounds(): Rect;
  close(afterMs: number): void;
}

/**
 * 小窗的位置：宠物旁边，优先 `prefer` 那一边（调用方传与对手窗口相反的一边）；放不下换另一边。
 * 纵向贴着宠物脚底，放不下就夹进工作区。Y5 加宽到 760×520，工作区装不下时按等比缩小。
 */
export function adventureBounds(home: PetBox | null, workArea: Rect, prefer: 'left' | 'right'): Rect {
  const scale = Math.min(1, workArea.width / ADVENTURE_WIDTH, workArea.height / ADVENTURE_HEIGHT);
  const width = Math.max(1, Math.round(ADVENTURE_WIDTH * scale));
  const height = Math.max(1, Math.round(ADVENTURE_HEIGHT * scale));
  const clampX = (x: number): number => Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  const clampY = (y: number): number => Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
  if (!home)
    return {
      x: Math.round(clampX(workArea.x + workArea.width - width - GAP)),
      y: Math.round(clampY(workArea.y + GAP)),
      width,
      height,
    };
  const left = home.left - width - GAP;
  const right = home.left + home.size + GAP;
  const leftFits = left >= workArea.x;
  const rightFits = right + width <= workArea.x + workArea.width;
  const x = prefer === 'right' ? (rightFits ? right : left) : leftFits ? left : right;
  const feet = home.top + home.bottomPad + (home.size * 9) / 16;
  return { x: Math.round(clampX(x)), y: Math.round(clampY(feet - height)), width, height };
}

/** 打起来缩成的那一条：屏顶、和对手相反的一侧 */
export function adventureCompactBounds(workArea: Rect, prefer: 'left' | 'right'): Rect {
  const width = Math.min(ADVENTURE_COMPACT_WIDTH, workArea.width);
  const height = Math.min(ADVENTURE_COMPACT_HEIGHT, workArea.height);
  const x = prefer === 'right' ? workArea.x + workArea.width - width - GAP : workArea.x + GAP;
  return { x: Math.round(x), y: Math.round(workArea.y + GAP), width, height };
}

/** 拖出屏幕以后拉回来：至少让标题栏留在可见范围里（宽度留一段、高度留整条标题栏） */
export function clampAdventureBounds(rect: Rect, workArea: Rect): Rect {
  const width = Math.min(rect.width, workArea.width);
  const height = Math.min(rect.height, workArea.height);
  const keepX = Math.min(ADVENTURE_BAR_MIN_WIDTH, width);
  const keepY = Math.min(ADVENTURE_BAR_HEIGHT, height);
  const minX = workArea.x + keepX - width;
  const maxX = workArea.x + workArea.width - keepX;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - keepY;
  return {
    x: Math.round(Math.min(Math.max(rect.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(rect.y, minY), maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** 把素材名拼成图片 / 视频地址（逐段编码；页面不拼路径） */
export function adventureAssetUrl(petBase: string, relative: string): string {
  const base = petBase.endsWith('/') ? petBase.slice(0, -1) : petBase;
  return `${base}/pic/adventure/${relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/** 数据里的素材名 → 完整地址：入口页、场景、地图、加持卡面都走这里 */
export function adventureViewWithUrls(view: AdventureView, petBase: string): AdventureView {
  const url = (name: string): string => adventureAssetUrl(petBase, name);
  return {
    ...view,
    ...(view.entry
      ? {
          entry: {
            ...view.entry,
            cover: url(view.entry.cover),
            ...(view.entry.fallback ? { fallback: url(view.entry.fallback) } : {}),
          },
        }
      : {}),
    ...(view.run
      ? {
          run: {
            ...view.run,
            avatar: url(view.run.avatar),
            mapArt: url(view.run.mapArt),
            scene: {
              ...view.run.scene,
              ...(view.run.scene.art ? { art: url(view.run.scene.art) } : {}),
              ...(view.run.scene.video ? { video: url(view.run.scene.video) } : {}),
              ...(view.run.scene.poster ? { poster: url(view.run.scene.poster) } : {}),
              ...(view.run.scene.fallback ? { fallback: url(view.run.scene.fallback) } : {}),
            },
            map: {
              ...view.run.map,
              layers: view.run.map.layers.map((layer) => ({
                ...layer,
                nodes: layer.nodes.map((node) => ({ ...node, icon: url(node.icon) })),
              })),
            },
            blessings: view.run.blessings.map((blessing) => ({ ...blessing, card: url(blessing.card) })),
            choices: view.run.choices.map((choice) => ({
              ...choice,
              ...(choice.icon ? { icon: url(choice.icon) } : {}),
              ...(choice.card ? { card: url(choice.card) } : {}),
            })),
          },
        }
      : {}),
  };
}

/** 页面递回来的答案只认成形的对象（其余当没选） */
function isAnswer(value: unknown): value is AdventureAnswer {
  return !!value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string';
}

/**
 * 开历练小窗。
 * @param electron 只用到 BrowserWindow / screen
 * @param pageUrl 本机服务的 /app/adventure
 * @param petBase 插件路由前缀（拼 `/pic/adventure/…` 用）
 * @param home 取自家宠物现在的位置（watchHomePet 的 box）
 * @param options.prefer 小窗放宠物哪一边（调用方传与对手窗口相反的一边）
 * @param options.bounds 上次主人拖到的位置（这次打开 app 期间记住；不给就贴着宠物）
 */
export function openAdventureWindow(
  electron: WindowElectron,
  pageUrl: string,
  petBase: string,
  home: () => PetBox | null,
  options: { prefer: 'left' | 'right'; bounds?: Rect | null },
): AdventureWindow {
  const homeNow = home();
  const point = homeNow
    ? { x: homeNow.left + homeNow.size / 2, y: homeNow.top + homeNow.size / 4 }
    : electron.screen.getCursorScreenPoint();
  const workArea = electron.screen.getDisplayNearestPoint(point).workArea;
  const normal = adventureBounds(homeNow, workArea, options.prefer);
  const compact = adventureCompactBounds(workArea, options.prefer);
  /** 拖到别的屏幕上也按那边的工作区夹：至少留标题栏可见 */
  const clampOnDisplay = (rect: Rect): Rect => {
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    return clampAdventureBounds(rect, electron.screen.getDisplayNearestPoint(center).workArea);
  };
  let dragged: Rect | null = options.bounds ? clampOnDisplay(options.bounds) : null;
  let compactMode = false;
  let bounds = dragged ?? normal;
  let closed = false;
  let waiter: ((value: AdventureAnswer | null) => void) | null = null;
  const win: ManagedWindow = new electron.BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    // 主人主动点出来的：要能拿焦点
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
  const loaded = win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    })
    .catch(() => win.destroy());
  const run = (code: string): void => {
    if (closed || win.isDestroyed()) return;
    void loaded
      .then(() => {
        if (closed || win.isDestroyed()) return undefined;
        return win.webContents.executeJavaScript(code);
      })
      .catch(() => undefined);
  };
  win.once('closed', () => {
    closed = true;
    const done = waiter;
    waiter = null;
    done?.(null);
  });
  // 标题栏拖动是系统行为：拖完读一次位置，夹回屏幕里并记住。
  // 自己挪的（缩起来、展开、重新渲染）位置和 `bounds` 一样，不算主人拖过。
  win.on?.('moved', () => {
    if (closed || win.isDestroyed() || compactMode) return;
    const current = win.getBounds();
    if (sameRect(current, bounds)) return;
    const clamped = clampOnDisplay(current);
    dragged = clamped;
    bounds = clamped;
    if (!sameRect(current, clamped)) win.setBounds(clamped);
  });
  return {
    render(view) {
      // 拖过以后重新渲染也停在拖到的位置（缩成一条时除外）
      if (!compactMode && dragged && !closed && !win.isDestroyed() && !sameRect(win.getBounds(), dragged)) {
        win.setBounds(dragged);
      }
      run(`adv.render(${JSON.stringify(adventureViewWithUrls(view, petBase))})`);
    },
    wait() {
      if (closed || win.isDestroyed()) return Promise.resolve(null);
      return new Promise<AdventureAnswer | null>((resolve) => {
        waiter = resolve;
        void loaded.then(async () => {
          if (closed || waiter !== resolve) return;
          const value = await win.webContents.executeJavaScript('adv.wait()').catch(() => null);
          if (waiter !== resolve) return;
          waiter = null;
          resolve(isAnswer(value) ? value : null);
        });
      });
    },
    cancelWait() {
      if (waiter === null) return;
      waiter = null;
      run('adv.cancel()');
    },
    setCompact(on) {
      compactMode = on;
      bounds = on ? compact : (dragged ?? normal);
      if (!win.isDestroyed()) win.setBounds(bounds);
      run(`adv.compact(${on ? 'true' : 'false'})`);
    },
    hide() {
      if (!win.isDestroyed()) win.hide?.();
    },
    show() {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    },
    position: () => dragged,
    bounds: () => bounds,
    close(afterMs) {
      setTimeout(
        () => {
          if (!win.isDestroyed()) win.destroy();
        },
        Math.max(0, afterMs),
      );
    },
  };
}

/** 历练小窗的页面（静态；每一页的数据由 openAdventureWindow 经 executeJavaScript 送进来） */
export const adventurePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>历练</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:#f7f2e7;color:#2b2a26;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif;-webkit-app-region:no-drag;user-select:none}
body{display:flex;flex-direction:column}
#bar{display:flex;align-items:center;gap:8px;padding:8px 14px;background:linear-gradient(#3c4a44,#2f3a35);color:#f7f2e7;flex:none;-webkit-app-region:drag}
#bar button{-webkit-app-region:no-drag}
#head{flex:1;min-width:0}
#title{font-size:15px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#subtitle{font-size:11px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hide,#close{flex:none;width:24px;height:24px;border:0;border-radius:12px;background:rgba(255,255,255,.14);color:#f7f2e7;font-size:16px;line-height:24px;padding:0;cursor:pointer}
#hide:hover,#close:hover{background:rgba(255,255,255,.26)}
#autoRow{flex:none;padding:5px 14px;background:#efe6d4;border-bottom:1px solid #d9cdb5}
#autoRow[hidden]{display:none}
#autoRow .switch{margin:0;font-size:12.5px;color:#4c463b}
.page{flex:1;min-height:0;overflow:hidden;padding:10px 14px 12px}
#run{display:flex;flex-direction:column}
#entry[hidden],#ending[hidden],#run[hidden]{display:none}
h2{margin:2px 0 2px;font-size:20px}
.title{margin:0 0 8px;color:#8a6d3b;font-size:13px}
.cover{width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#2f3a35}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.opening{font-size:13px;line-height:1.65;margin:8px 0 0;white-space:pre-line}
.seal{display:inline-block;margin:2px 0 8px;padding:3px 9px;border:2px solid #b23b32;border-radius:5px;color:#b23b32;font-size:12px;letter-spacing:2px;transform:rotate(-3deg)}
.best{margin:5px 0;color:#4a5b52;font-size:12px}
.endings{list-style:none;margin:4px 0 8px;padding:0;display:flex;gap:10px;flex-wrap:wrap;font-size:12px}
.endings .seen{color:#2f6b46}
.endings .unseen{color:#9a9384}
.switch{display:flex;align-items:center;gap:7px;font-size:13px;margin:7px 0}
.hint{font-size:11px;line-height:1.5;color:#7b7466;margin:2px 0 9px}
button{font-family:inherit}
.primary{width:100%;padding:9px 12px;border:0;border-radius:9px;background:#3f7d5a;color:#fff;font-size:14px;cursor:pointer}
.primary:hover{background:#356b4c}
#entry{display:flex;gap:14px;align-items:flex-start}
.entryLeft{flex:1.18;min-width:0}
.entryRight{flex:.82;min-width:0}
#entry button.primary{margin-top:6px}
#scene{position:relative;width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#2f3a35;flex:none}
body:not(.cutscene) #run:has(#loadout:not([hidden])) #scene{max-height:110px}
#scene img,#scene video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
#scene img{opacity:0;transition:opacity .45s}
#scene img.on{opacity:1}
#travel{position:absolute;left:0;right:0;bottom:0;padding:5px 10px;background:rgba(20,28,24,.62);color:#f4eddb;font-size:12px;display:flex;align-items:center;gap:8px}
#travel[hidden]{display:none}
#travel i{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.24);overflow:hidden;position:relative}
#travel i::after{content:"";position:absolute;inset:0;background:#e9c46a;transform-origin:left;animation:travel 15s linear forwards}
@keyframes travel{from{transform:scaleX(0)}to{transform:scaleX(1)}}
#cutSkip{position:absolute;right:8px;bottom:8px;z-index:3;display:none;padding:4px 10px;border:0;border-radius:7px;background:rgba(20,28,24,.72);color:#f4eddb;font-size:12px;cursor:pointer}
body.cutscene #cutSkip{display:block}
body.cutscene #scene{cursor:pointer}
body.cutscene #choices,body.cutscene #loadout,body.cutscene #fullShowRow,body.cutscene #travel,body.cutscene #autoRow{display:none}
body.cutscene #sceneText{flex:1;min-height:0;max-height:none;overflow:hidden;margin-top:2px}
.cutLine{display:block;opacity:0;transition:opacity .45s}
.cutLine.on{opacity:1}
#full{display:flex;gap:10px;flex:1;min-height:0}
#left{flex:0 0 54%;min-width:0;min-height:0;display:flex;flex-direction:column;gap:5px}
#right{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:3px;overflow:hidden}
#map{position:relative;margin:0;padding:8px 2px 12px;background-color:#eee5d3;background-size:cover;background-position:center;border:1px solid #d9cdb5;border-radius:10px;flex:none}
#map::before{content:"";position:absolute;inset:0;border-radius:10px;background:rgba(247,242,231,.66);pointer-events:none}
#mapLayers{display:flex;align-items:flex-start;justify-content:space-between;position:relative;z-index:1}
.layer{flex:1;min-width:0;text-align:center;position:relative}
.layer .layerName{font-size:9.5px;color:#8d8472;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.layer.done .layerName{color:#3f7d5a}
.layer.current .layerName{color:#b23b32;font-weight:600}
.layer.hidden .layerName{opacity:.5}
.icons{display:flex;flex-direction:column;align-items:center;gap:4px;min-height:38px}
.icon{width:28px;height:28px;padding:0;border:2px solid transparent;border-radius:8px;background:rgba(255,255,255,.72);cursor:default;overflow:hidden}
.icon img{width:100%;height:100%;object-fit:contain;display:block}
.icon.done{border-color:#8fbf9f;opacity:.72}
.icon.now{border-color:#b23b32;cursor:pointer;box-shadow:0 0 0 2px rgba(178,59,50,.16)}
.icon.now:hover{transform:translateY(-1px)}
.icon.next{border-color:#c9b891}
.icon.revealed{border-style:dashed;border-color:#b8a986}
.icon.hidden{display:flex;align-items:center;justify-content:center;background:transparent;border:1px dashed #b9ae98;color:#9a8f7a;font-size:14px}
#avatar{position:absolute;left:0;bottom:2px;width:22px;height:22px;object-fit:contain;filter:drop-shadow(0 1px 2px rgba(0,0,0,.25));pointer-events:none}
.hp{margin:1px 0}
.hpline{display:flex;justify-content:space-between;font-size:11px;color:#5c5548;margin-bottom:3px}
.hpbar{height:8px;border-radius:5px;background:#ddd2bd;overflow:hidden}
#hpFill{height:100%;width:100%;background:linear-gradient(#78c08a,#3f7d5a);transition:width .3s}
.chips{display:flex;gap:4px;flex-wrap:wrap;min-height:0}
.chip{display:flex;align-items:center;gap:3px;padding:1px 5px 1px 1px;border-radius:12px;background:#efe6d4;font-size:10.5px;color:#5c5548}
.chip img{width:18px;height:18px;border-radius:5px;object-fit:cover}
.rows{font-size:11.5px;color:#4c463b;min-height:0}
.rows>div{display:flex;gap:6px;line-height:1.45}
.rows .k{flex:none;color:#8d8472;min-width:40px}
.rows .v{flex:1;min-width:0;word-break:break-all}
.cracks{display:flex;gap:3px;height:4px;flex:none}
.cracks span{flex:1;height:4px;border-radius:2px;background:#c9b891;transform:skewX(-18deg)}
.sceneText{font-size:12.5px;line-height:1.55;margin:0;white-space:pre-line;min-height:2.2em;max-height:9.3em;overflow-y:auto;flex:none}
.choices{display:flex;flex-direction:column;gap:5px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:3px}
.choices:empty{display:none}
.choices .choice{display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;border:1px solid #cdbfa6;border-radius:9px;background:#fffaf0;color:#332f28;font-size:12.5px;line-height:1.35;text-align:left;cursor:pointer;flex:none}
.choices .choice:hover{border-color:#3f7d5a;background:#fff}
.choices .choice img{width:24px;height:24px;object-fit:contain;flex:none}
.choices .choice .label{flex:1;min-width:0}
.choices .choice .note{display:block;color:#8a816f;font-size:11px;margin-top:1px}
.choices .choice.rewind{border-color:#b23b32;color:#8c2f28;background:#fff3ef}
.choices .choice.end{color:#6b6254}
.card{display:flex;gap:8px;align-items:center;width:100%;padding:6px;border:1px solid #cdbfa6;border-radius:10px;background:#fffaf0;text-align:left;cursor:pointer;flex:none}
.card img{width:42px;height:30px;object-fit:cover;border-radius:6px;flex:none}
.card .label{font-size:12px}
.card .note{display:block;color:#8a816f;font-size:10.5px;line-height:1.4;margin-top:2px}
.loadout{margin:0;padding:8px;border:1px solid #cdbfa6;border-radius:10px;background:#fffaf0;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
#loadout[hidden]{display:none}
#weapons{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:3px;padding-bottom:2px}
.tactics{font-size:12px;line-height:1.5;color:#6b4b3a;margin:0 0 6px;flex:none}
.weapon{display:flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 0}
.weapon input{accent-color:#3f7d5a}
.loadout .primary{margin-top:7px;font-size:13px;padding:7px;flex:none}
#fullShowRow{margin-top:2px;flex:none}
.buttons{display:flex;gap:8px;margin-top:14px}
.buttons button{flex:1;padding:9px 12px;border-radius:9px;border:1px solid #cdbfa6;background:#fffaf0;color:#332f28;font-size:13px;cursor:pointer}
.buttons button.primary{background:#3f7d5a;border-color:#3f7d5a;color:#fff}
.loot{list-style:none;margin:4px 0 0;padding:0;font-size:12.5px;line-height:1.8}
#ending{display:flex;gap:16px;align-items:flex-start}
.endingLeft{flex:1.1;min-width:0}
.endingRight{flex:.9;min-width:0;display:flex;flex-direction:column}
#compactbar{display:none;align-items:center;gap:8px;padding:8px 12px;background:#2f3a35;color:#f7f2e7;font-size:12.5px}
#compactTitle{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#compactHp{flex:none;color:#e9c46a}
#skip{flex:none;padding:4px 10px;border:0;border-radius:7px;background:#b23b32;color:#fff;font-size:12px;cursor:pointer}
body.compact #bar,body.compact #autoRow,body.compact #entry,body.compact #ending,body.compact #full{display:none}
body.compact{padding-top:0}
body.compact #run{display:flex;flex-direction:column}
body.compact #compactbar{display:flex}
body.compact #full{display:none}
</style></head>
<body>
<header id="bar"><div id="head"><div id="title"></div><div id="subtitle"></div></div><button id="hide" type="button" aria-label="收起">—</button><button id="close" type="button" aria-label="关掉">×</button></header>
<div id="autoRow"><label class="switch"><input id="autoWalk" type="checkbox"> 自动走（每步替你选）</label></div>
<div id="entry" class="page" hidden>
  <div class="entryLeft">
    <div class="cover"><img id="cover" alt=""></div>
    <p id="opening" class="opening"></p>
  </div>
  <div class="entryRight">
    <div id="sealed" class="seal" hidden>原著印章</div>
    <p id="best" class="best"></p>
    <ul id="endings" class="endings"></ul>
    <label class="switch"><input id="suppressed" type="checkbox"> 压境入内（修为 ×1.5）</label>
    <p class="hint">照原著把法宝和招式全封住，只用这一王的一转蛊；四项属性最多到原著境界。</p>
    <button id="enter" class="primary" type="button">进入</button>
  </div>
</div>
<div id="run" class="page" hidden>
  <div id="compactbar"><span id="compactTitle"></span><span id="compactHp"></span><button id="skip" type="button">快进</button></div>
  <div id="full">
    <div id="left">
      <div id="scene"><img id="sceneImg" alt=""><video id="sceneVideo" muted playsinline autoplay></video><div id="travel" hidden><span id="travelText">赶路中…</span><i></i></div><button id="cutSkip" type="button">跳过</button></div>
      <p id="sceneText" class="sceneText"></p>
      <div id="choices" class="choices"></div>
      <div id="loadout" class="loadout" hidden>
        <p id="foeTactics" class="tactics"></p>
        <div id="weapons"></div>
        <button id="loadoutOk" class="primary" type="button">带上这几件</button>
      </div>
      <label class="switch" id="fullShowRow"><input id="fullShow" type="checkbox"> 完整演出（小怪、精英）</label>
    </div>
    <div id="right">
      <div id="cracks" class="cracks"></div>
      <div id="map"><div id="mapLayers"></div><img id="avatar" alt=""></div>
      <div class="hp"><div class="hpline"><span>气血</span><span id="hpText"></span></div><div class="hpbar"><div id="hpFill"></div></div></div>
      <div id="blessings" class="chips"></div>
      <div class="rows">
        <div><span class="k">战利品</span><span id="loot" class="v"></span></div>
        <div><span class="k">一转蛊</span><span id="gu" class="v"></span></div>
        <div><span class="k">春秋蝉</span><span id="cicada" class="v"></span></div>
        <div><span class="k">福地</span><span id="day" class="v"></span></div>
      </div>
    </div>
  </div>
</div>
<div id="ending" class="page" hidden>
  <div class="endingLeft">
    <h2 id="endingName"></h2>
    <p id="endingTitle" class="title"></p>
    <p id="endingText" class="opening"></p>
  </div>
  <div class="endingRight">
    <p class="best">这一趟的收获</p>
    <ul id="endingLoot" class="loot"></ul>
    <div class="buttons"><button id="again" class="primary" type="button">再来一趟</button><button id="endingClose" type="button">关掉</button></div>
  </div>
</div>
<script>
'use strict';
var settle = null;
var travelTimer = null;
var cutLineTimer = null;
var cutEndTimer = null;
var cutGeneration = 0;
var lastChoices = '';
function byId(id){ return document.getElementById(id); }
function setText(id, text){ byId(id).textContent = text === undefined || text === null ? '' : String(text); }
function clear(node){ node.replaceChildren(); }
function el(tag, cls, text){ var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; }
function answer(value){ if (!settle) return; var done = settle; settle = null; done(value); }
function show(which){
  byId('entry').hidden = which !== 'entry';
  byId('run').hidden = which !== 'run';
  byId('ending').hidden = which !== 'ending';
}
function stopCutscene(){
  cutGeneration += 1;
  if (cutLineTimer) { clearTimeout(cutLineTimer); cutLineTimer = null; }
  if (cutEndTimer) { clearTimeout(cutEndTimer); cutEndTimer = null; }
  document.body.classList.remove('cutscene');
  var video = byId('sceneVideo');
  video.onended = null;
  video.onerror = null;
  var skip = byId('cutSkip');
  skip.hidden = true;
  skip.onclick = null;
  byId('scene').onclick = null;
}
function renderEntry(view){
  var entry = view.entry;
  var cover = byId('cover');
  cover.src = entry.cover;
  cover.onerror = function(){ if (entry.fallback && cover.src !== entry.fallback) cover.src = entry.fallback; };
  setText('opening', entry.opening.join('\\n'));
  byId('sealed').hidden = !entry.sealed;
  setText('best', entry.best);
  var list = byId('endings'); clear(list);
  for (var i = 0; i < entry.endings.length; i += 1) {
    var item = entry.endings[i];
    list.append(el('li', item.seen ? 'seen' : 'unseen', item.name + (item.seen ? ' · 见过' : ' · 没见过')));
  }
  byId('suppressed').checked = entry.suppressed === true;
}
function renderMap(run, clickable){
  var map = run.map;
  byId('map').style.backgroundImage = run.mapArt ? 'url("' + run.mapArt + '")' : '';
  var wrap = byId('mapLayers'); clear(wrap);
  for (var i = 0; i < map.layers.length; i += 1) {
    var layer = map.layers[i];
    var box = el('div', 'layer ' + layer.state);
    box.dataset.index = String(layer.index);
    box.append(el('div', 'layerName', '第 ' + layer.index + ' 层'));
    var icons = el('div', 'icons');
    for (var j = 0; j < layer.nodes.length; j += 1) {
      var node = layer.nodes[j];
      if (node.state === 'hidden') { icons.append(el('div', 'icon hidden', '？')); continue; }
      // 等选项的时候地图不亮成能点的样子，也不接点击（Y5）；只有真在选下一个节点时才亮
      var canClick = node.state === 'now' && clickable;
      var cls = 'icon ' + (node.state === 'now' && !clickable ? 'next' : node.state);
      var button = el('button', cls);
      button.type = 'button';
      button.title = node.name;
      var img = el('img'); img.src = node.icon; img.alt = node.name; button.append(img);
      if (canClick) {
        (function(id){ button.addEventListener('click', function(){ answer({ kind: 'node', node: id }); }); })(node.id);
      }
      icons.append(button);
    }
    box.append(icons);
    wrap.append(box);
  }
  var avatar = byId('avatar');
  avatar.src = run.avatar;
  var layers = wrap.children;
  function centerOf(index){
    var mapBox = byId('map').getBoundingClientRect();
    for (var k = 0; k < layers.length; k += 1) {
      if (Number(layers[k].dataset.index) !== index) continue;
      var rect = layers[k].getBoundingClientRect();
      return rect.left - mapBox.left + rect.width / 2;
    }
    return 0;
  }
  var current = map.travel ? map.travel.to : map.current;
  avatar.style.width = '22px'; avatar.style.height = '22px';
  if (map.travel && map.travel.ms > 0) {
    avatar.style.transition = 'none';
    avatar.style.left = (centerOf(map.travel.from) - 11) + 'px';
    void avatar.offsetWidth;
    avatar.style.transition = 'left ' + map.travel.ms + 'ms linear';
    avatar.style.left = (centerOf(map.travel.to) - 11) + 'px';
  } else {
    avatar.style.transition = 'none';
    avatar.style.left = (centerOf(current) - 11) + 'px';
  }
}
function renderTravel(run){
  var box = byId('travel');
  if (travelTimer) { clearInterval(travelTimer); travelTimer = null; }
  var ms = run.map.travel ? run.map.travel.ms : 0;
  if (ms <= 0) { box.hidden = true; return; }
  box.hidden = false;
  var left = Math.max(1, Math.ceil(ms / 1000));
  setText('travelText', '赶路中… ' + left + ' 秒');
  travelTimer = setInterval(function(){
    left -= 1;
    if (left <= 0) { clearInterval(travelTimer); travelTimer = null; setText('travelText', '到了'); return; }
    setText('travelText', '赶路中… ' + left + ' 秒');
  }, 1000);
}
function renderCutscene(run, cut){
  var gen = ++cutGeneration;
  var lines = cut.lines || [];
  var video = byId('sceneVideo');
  var img = byId('sceneImg');
  var scene = byId('scene');
  var skip = byId('cutSkip');
  var text = byId('sceneText');
  var shown = 0;
  var videoDone = false;
  var finished = false;
  document.body.classList.add('cutscene');
  clear(text);
  if (run.scene.poster) {
    img.src = run.scene.poster;
    img.hidden = false;
    img.classList.add('on');
  } else img.hidden = true;
  skip.hidden = false;
  // 视频卡住也不把流程永远挂在过场里：30 秒后当播完
  cutEndTimer = setTimeout(function(){ finish('cutscene-done'); }, 30000);
  function finish(kind){
    if (finished || gen !== cutGeneration) return;
    finished = true;
    if (cutLineTimer) { clearTimeout(cutLineTimer); cutLineTimer = null; }
    if (cutEndTimer) { clearTimeout(cutEndTimer); cutEndTimer = null; }
    answer({ kind: kind });
  }
  function maybeFinish(delay){
    if (finished || gen !== cutGeneration) return;
    if (!videoDone || shown < lines.length) return;
    if (cutEndTimer) clearTimeout(cutEndTimer);
    cutEndTimer = setTimeout(function(){ finish('cutscene-done'); }, delay);
  }
  function videoDoneNow(){
    if (videoDone) return;
    videoDone = true;
    video.hidden = true;
    maybeFinish(500);
  }
  function showNext(){
    if (finished || gen !== cutGeneration) return;
    if (shown >= lines.length) { maybeFinish(600); return; }
    var line = el('span', 'cutLine', lines[shown]);
    text.append(line);
    requestAnimationFrame(function(){ line.classList.add('on'); });
    shown += 1;
    if (shown < lines.length) cutLineTimer = setTimeout(showNext, 1100);
    else maybeFinish(700);
  }
  if (run.scene.video) {
    video.hidden = false;
    video.onended = function(){ if (gen !== cutGeneration) return; videoDoneNow(); };
    video.onerror = function(){ if (gen !== cutGeneration) return; videoDoneNow(); };
    video.src = run.scene.video;
    video.play().catch(function(){ if (gen === cutGeneration) videoDoneNow(); });
  } else {
    video.pause();
    video.removeAttribute('src');
    videoDoneNow();
  }
  if (lines.length) cutLineTimer = setTimeout(showNext, 200);
  else maybeFinish(200);
  skip.onclick = function(event){ if (event) event.stopPropagation(); finish('skip'); };
  scene.onclick = function(){ finish('skip'); };
}
function renderRun(view){
  var run = view.run;
  stopCutscene();
  setText('compactTitle', view.title + (view.subtitle ? ' · ' + view.subtitle : ''));
  setText('compactHp', '气血 ' + run.hp.now + ' / ' + run.hp.max);
  byId('skip').hidden = !run.canSkip;
  byId('skip').onclick = function(){ answer({ kind: 'skip' }); };
  var img = byId('sceneImg');
  var video = byId('sceneVideo');
  img.onerror = function(){
    if (run.scene.fallback && img.src !== run.scene.fallback) img.src = run.scene.fallback;
  };
  if (run.cutscene) {
    renderCutscene(run, run.cutscene);
  } else {
    video.onerror = function(){
      video.hidden = true;
      var poster = run.scene.poster || run.scene.fallback;
      if (poster) { img.src = poster; img.hidden = false; img.classList.add('on'); }
    };
    if (run.scene.video) {
      video.hidden = false;
      video.onended = function(){
        video.hidden = true;
        if (run.scene.poster) { img.src = run.scene.poster; img.hidden = false; img.classList.add('on'); }
      };
      video.src = run.scene.video;
      video.play().catch(function(){});
      if (run.scene.poster) { img.src = run.scene.poster; img.hidden = false; img.classList.add('on'); }
      else { img.hidden = true; }
    } else {
      video.onended = null;
      video.pause();
      video.hidden = true;
      video.removeAttribute('src');
      img.hidden = !run.scene.art;
      if (run.scene.art) {
        if (img.getAttribute('src') !== run.scene.art) {
          img.classList.remove('on');
          img.src = run.scene.art;
          requestAnimationFrame(function(){ img.classList.add('on'); });
        } else img.classList.add('on');
      }
    }
    setText('sceneText', run.text.join('\\n'));
  }
  renderMap(run, run.mapClickable === true);
  renderTravel(run);
  setText('hpText', run.hp.now + ' / ' + run.hp.max);
  byId('hpFill').style.width = Math.max(0, Math.min(100, Math.round(run.hp.now / Math.max(1, run.hp.max) * 100))) + '%';
  var blessings = byId('blessings'); clear(blessings);
  for (var i = 0; i < run.blessings.length; i += 1) {
    var b = run.blessings[i];
    var chip = el('span', 'chip');
    var bimg = el('img'); bimg.src = b.card; bimg.alt = b.name; chip.append(bimg, document.createTextNode(b.name));
    blessings.append(chip);
  }
  setText('loot', run.loot.join('、') || '还没有收获');
  setText('gu', run.gu);
  setText('cicada', run.cicada);
  setText('day', run.day ? run.day.label : '');
  var cracks = byId('cracks'); clear(cracks);
  for (var c = 0; c < (run.day ? run.day.cracks : 0); c += 1) cracks.append(el('span'));
  var choices = byId('choices'); clear(choices);
  for (var q = 0; q < run.choices.length; q += 1) {
    var choice = run.choices[q];
    if (choice.kind === 'blessing') {
      var card = el('button', 'card'); card.type = 'button';
      var cimg = el('img'); cimg.src = choice.card; cimg.alt = choice.label; card.append(cimg);
      var cbox = el('span', 'label'); cbox.textContent = choice.label;
      if (choice.note) cbox.append(el('span', 'note', choice.note));
      card.append(cbox);
      (function(view2){
        card.addEventListener('click', function(){ answer({ kind: 'blessing', node: view2.node, blessing: view2.blessing }); });
      })({ node: choice.node, blessing: choice.blessing });
      choices.append(card);
      continue;
    }
    var row = el('button', 'choice ' + choice.kind); row.type = 'button';
    if (choice.icon) { var nimg = el('img'); nimg.src = choice.icon; nimg.alt = choice.label; row.append(nimg); }
    var label = el('span', 'label', choice.label);
    if (choice.note) label.append(el('span', 'note', choice.note));
    row.append(label);
    (function(view2){
      row.addEventListener('click', function(){
        if (view2.kind === 'node') answer({ kind: 'node', node: view2.id });
        else if (view2.kind === 'choice') answer({ kind: 'choice', node: view2.node, index: view2.index });
        else answer({ kind: view2.kind });
      });
    })({ kind: choice.kind, id: choice.id, node: choice.node, index: choice.index });
    choices.append(row);
  }
  // 新选项出现时自动滚到第一个（挑法宝这种选项特别多的才需要滚）
  var signature = run.choices.map(function(item){
    return item.kind + ':' + (item.id || '') + ':' + (item.node || '') + ':' + (item.index === undefined ? '' : item.index) + ':' + (item.blessing || '');
  }).join('|');
  if (signature !== lastChoices) { byId('choices').scrollTop = 0; lastChoices = signature; }
  var loadout = byId('loadout');
  if (run.loadout) {
    loadout.hidden = false;
    var foe = run.loadout.foe;
    setText('foeTactics', foe.name + '：' + foe.tactics + '（' + foe.moves.join('、') + '）');
    var weapons = byId('weapons'); clear(weapons);
    var boxes = [];
    for (var w = 0; w < run.loadout.weapons.length; w += 1) {
      var weapon = run.loadout.weapons[w];
      var row2 = el('label', 'weapon');
      var check = document.createElement('input'); check.type = 'checkbox'; check.value = weapon.id;
      check.addEventListener('change', function(){
        var checked = boxes.filter(function(box){ return box.checked; });
        if (checked.length > run.loadout.max) this.checked = false;
      });
      boxes.push(check);
      row2.append(check, document.createTextNode(weapon.name));
      weapons.append(row2);
    }
    byId('loadoutOk').onclick = function(){
      answer({ kind: 'loadout', node: run.loadout.node, weapons: boxes.filter(function(box){ return box.checked; }).map(function(box){ return box.value; }) });
    };
  } else loadout.hidden = true;
  byId('fullShowRow').hidden = !run.fullToggle;
  byId('fullShow').checked = run.fullShow === true;
  byId('fullShow').onchange = function(){ answer({ kind: 'toggle-full', on: this.checked }); };
  document.body.classList.toggle('compact', run.compact === true);
}
function renderEnding(view){
  var ending = view.ending;
  setText('endingName', ending.name);
  setText('endingTitle', ending.title);
  setText('endingText', ending.text.join('\\n'));
  var list = byId('endingLoot'); clear(list);
  for (var i = 0; i < ending.loot.length; i += 1) list.append(el('li', '', ending.loot[i]));
  if (!ending.loot.length) list.append(el('li', 'unseen', '空手而归'));
}
window.adv = {
  render: function(view){
    setText('title', view.title);
    setText('subtitle', view.subtitle || '');
    show(view.kind);
    document.body.classList.remove('compact');
    stopCutscene();
    byId('autoRow').hidden = view.kind === 'ending';
    byId('autoWalk').checked = view.auto === true;
    if (view.kind === 'entry') { lastChoices = ''; renderEntry(view); }
    else if (view.kind === 'run') renderRun(view);
    else { lastChoices = ''; renderEnding(view); }
  },
  wait: function(){ return new Promise(function(resolve){ settle = resolve; }); },
  cancel: function(){ settle = null; },
  compact: function(on){ document.body.classList.toggle('compact', !!on); },
};
byId('close').addEventListener('click', function(){ answer({ kind: 'close' }); });
byId('hide').addEventListener('click', function(){ answer({ kind: 'hide' }); });
byId('autoWalk').addEventListener('change', function(){ answer({ kind: 'toggle-auto', on: this.checked }); });
byId('enter').addEventListener('click', function(){ answer({ kind: 'enter', suppressed: byId('suppressed').checked }); });
byId('endingClose').addEventListener('click', function(){ answer({ kind: 'close' }); });
byId('again').addEventListener('click', function(){ answer({ kind: 'again' }); });
</script></body></html>
`;
