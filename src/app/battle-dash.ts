/**
 * 冲刺（修炼路线 X16）：降龙十八掌出手前冲到对手身前、打完再退回原位。
 *
 * 位移靠挪窗口，不画在素材里：
 *   - **自家宠物**走 `POST /position` 的 `mode: 'line'`（带演出锁），坐标是宠物中心的归一化 0–1，
 *     基准是**全部显示器工作区并集**（和 helper 的 `moveToCenter` / `reportPose` 同一口径）；
 *   - **对手窗口**（心魔、秘境对手、串门客人、隔空切磋的对手）由主进程按帧 `setBounds` 挪。
 *
 * 这一批只有降龙十八掌带 `dash`；其余招式照旧原地出招。纯几何在 `dashShift` / `dashTarget` /
 * `foeDashShift` 里，配单测；真正挪窗口的 `createDashRig` 只做状态机与定时。
 */
import type { PetBox, Rect } from './visit-windows';

/** 舞台里身体的宽度占舞台宽的比例（同 `fx-window.ts` 的 BODY：x 212–426 / 640） */
export const BODY_WIDTH_RATIO = (426 - 212) / 640;
/** 停在离对方约半个身位：两个身体边缘之间留出半个自己身体那么宽 */
export const DASH_GAP_RATIO = 0.5;

/** 一块屏幕（或一整块工作区）的并集：没有就给 null */
export function areasUnion(areas: readonly Rect[]): Rect | null {
  const valid = areas.filter((area) => area.width > 0 && area.height > 0);
  if (valid.length === 0) return null;
  const x = Math.min(...valid.map((area) => area.x));
  const y = Math.min(...valid.map((area) => area.y));
  const right = Math.max(...valid.map((area) => area.x + area.width));
  const bottom = Math.max(...valid.map((area) => area.y + area.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 本机所有显示器工作区的并集（`/position` 的归一化基准）；注入的假 screen 没有 `getAllDisplays` 时退回当前那块。
 * macOS 上 helper 的 `buildDeskGeometry` 把工作区顶从菜单栏下沿抬到屏幕顶（保留 Dock 那一侧的扣除）：
 * 归一化以那个外接矩形为准，所以这里照同一口径算；没有 `bounds` 的假 screen 就退回 workArea。
 */
export function screenUnion(
  screen: {
    getAllDisplays?(): Array<{ workArea: Rect; bounds?: Rect }>;
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): { workArea: Rect };
  },
  platform: string = process.platform,
): Rect | null {
  const areasOf = (display: { workArea: Rect; bounds?: Rect }): Rect => {
    const work = display.workArea;
    if (platform !== 'darwin' || !display.bounds) return work;
    return { ...work, y: display.bounds.y, height: work.y + work.height - display.bounds.y };
  };
  const all = screen.getAllDisplays?.();
  if (all && all.length > 0) return areasUnion(all.map(areasOf));
  const point = screen.getCursorScreenPoint();
  return areasUnion([areasOf(screen.getDisplayNearestPoint(point))]);
}

/** 冲到离对方半个身位处，两边的身体中心该隔多远（屏幕像素） */
export function dashApart(selfWidth: number, foeWidth: number, gapRatio = DASH_GAP_RATIO): number {
  return BODY_WIDTH_RATIO * ((selfWidth + foeWidth) / 2 + gapRatio * selfWidth);
}

/**
 * 冲刺方要往对手方向挪多少屏幕像素（负 = 往左）：两边身体中心靠近到 `dashApart` 为止；
 * 本来就比这更近就不动（不往后退）。
 */
export function dashShift(
  selfCenterX: number,
  selfWidth: number,
  foeCenterX: number,
  foeWidth: number,
  gapRatio = DASH_GAP_RATIO,
): number {
  const apart = dashApart(selfWidth, foeWidth, gapRatio);
  const delta = foeCenterX - selfCenterX;
  const distance = Math.abs(delta);
  if (distance <= apart) return 0;
  return Math.sign(delta) * (distance - apart);
}

/** 自家宠物冲过去以后，中心该在的归一化坐标（`POST /position` 的口径） */
export function dashTarget(box: PetBox, foe: Rect, union: Rect, gapRatio = DASH_GAP_RATIO): { x: number; y: number } {
  const selfCenterX = box.left + box.size / 2;
  const selfCenterY = box.top + (box.size * 9) / 16 / 2;
  const foeCenterX = foe.x + foe.width / 2;
  const shift = dashShift(selfCenterX, box.size, foeCenterX, foe.width, gapRatio);
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return {
    x: clamp((selfCenterX + shift - union.x) / union.width),
    y: clamp((selfCenterY - union.y) / union.height),
  };
}

/** 对手窗口冲过来要挪的横向像素（加到窗口 x 上）：把对手身体中心送到离自家宠物半个身位处 */
export function foeDashShift(foe: Rect, home: PetBox, gapRatio = DASH_GAP_RATIO): number {
  const foeCenterX = foe.x + foe.width / 2;
  const homeCenterX = home.left + home.size / 2;
  return dashShift(foeCenterX, foe.width, homeCenterX, home.size, gapRatio);
}

/** 对手窗口：要能钉住跟随、按帧挪位置（`GuestWindow` / `FoeWindow` 都满足） */
export interface DashFoe {
  readonly side: 'left' | 'right';
  bounds(): Rect;
  pin(on: boolean): void;
  moveTo(rect: Rect): void;
}

export interface DashRigOptions {
  /** 自家宠物现在的位置（helper 逐帧上报） */
  box: () => PetBox | null;
  /** 全部显示器工作区并集（归一化基准） */
  union: () => Rect | null;
  /** 对手窗口 */
  foe: DashFoe;
  /** 钉住 / 放开擂台与特效层（按开场站位摆） */
  pinStage: (on: boolean) => void;
  /** 自家宠物按 `mode: 'line'` 挪到归一化中心（演出锁由调用方带上） */
  moveSelf: (x: number, y: number, durationMs: number) => void;
}

export interface DashRig {
  /** 时间线上的一步：冲过去 / 退回来 */
  run(who: 0 | 1, dir: 'out' | 'back', ms: number): void;
  /** 复位：快进 / 收摊时立刻回到开场站位；自然演完时只在没排退回时兜底 */
  end(force?: boolean): void;
  /** 正在冲（或正退回来）：调用方据此决定窗口要不要跟着实时位置走 */
  active(): boolean;
}

/** 冲刺的窗口状态机：开场站位快照、自家 / 对手两条位移路径、按帧挪对手窗口 */
export function createDashRig(options: DashRigOptions): DashRig {
  /** 开场站位（冲出去那一刻的自家盒子与对手窗口） */
  let origin: { box: PetBox; foe: Rect } | null = null;
  let state: 'idle' | 'out' | 'back' = 'idle';
  /** 退回那一步已经排过（自然演完的兜底据此判断要不要复位） */
  let backScheduled = false;
  let frame: ReturnType<typeof setInterval> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;

  const stopFrame = (): void => {
    if (frame !== null) clearInterval(frame);
    frame = null;
  };
  const stopSettle = (): void => {
    if (settle !== null) clearTimeout(settle);
    settle = null;
  };
  const release = (): void => {
    stopFrame();
    stopSettle();
    options.pinStage(false);
    options.foe.pin(false);
    state = 'idle';
    backScheduled = false;
    origin = null;
  };

  /** 按帧把对手窗口从 `from` 挪到 `to`（只改 x，脚底不动；缓出） */
  const slideFoe = (from: Rect, to: Rect, ms: number, done?: () => void): void => {
    stopFrame();
    if (ms <= 0) {
      options.foe.moveTo(to);
      done?.();
      return;
    }
    const t0 = Date.now();
    frame = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / ms);
      const eased = 1 - (1 - p) * (1 - p);
      options.foe.moveTo({
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
        width: to.width,
        height: to.height,
      });
      if (p >= 1) {
        stopFrame();
        done?.();
      }
    }, 16);
  };

  return {
    run(who, dir, ms) {
      if (dir === 'out') {
        const box = options.box();
        const union = options.union();
        if (!box || !union) return;
        const foe = options.foe.bounds();
        origin = { box, foe };
        state = 'out';
        backScheduled = false;
        options.pinStage(true);
        options.foe.pin(true);
        if (who === 0) {
          const target = dashTarget(box, foe, union);
          options.moveSelf(target.x, target.y, ms);
        } else {
          const shift = foeDashShift(foe, box);
          slideFoe(foe, { ...foe, x: Math.round(foe.x + shift) }, ms);
        }
        return;
      }
      if (!origin) return;
      state = 'back';
      backScheduled = true;
      const union = options.union();
      if (who === 0 && union) {
        const x = (origin.box.left + origin.box.size / 2 - union.x) / union.width;
        const y = (origin.box.top + (origin.box.size * 9) / 16 / 2 - union.y) / union.height;
        options.moveSelf(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), ms);
      } else if (who === 1) {
        slideFoe(options.foe.bounds(), origin.foe, ms);
      }
      stopSettle();
      settle = setTimeout(
        () => {
          settle = null;
          release();
        },
        Math.max(0, ms),
      );
    },
    end(force = false) {
      if (state === 'idle') return;
      // 快进 / 收摊：立刻复位；自然演完时已经排了退回就让它退完，没排才兜底复位
      if (!force && (state === 'back' || backScheduled)) return;
      const snapshot = origin;
      release();
      if (!snapshot) return;
      // 自家宠物回到开场站位（`line` + 0ms = 立即到位），对手窗口也放回去
      const union = options.union();
      if (union) {
        const x = (snapshot.box.left + snapshot.box.size / 2 - union.x) / union.width;
        const y = (snapshot.box.top + (snapshot.box.size * 9) / 16 / 2 - union.y) / union.height;
        options.moveSelf(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), 0);
      }
      options.foe.moveTo(snapshot.foe);
    },
    active() {
      return state !== 'idle';
    },
  };
}
