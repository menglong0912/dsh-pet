/**
 * 冲刺（X16）的纯几何与状态机：归一化基准、停下来的距离、自家 / 对手两条位移路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areasUnion,
  createDashRig,
  dashApart,
  dashShift,
  dashTarget,
  foeDashShift,
  screenUnion,
} from './battle-dash.ts';
import type { DashFoe } from './battle-dash.ts';
import type { PetBox, Rect } from './visit-windows.ts';

const union = { x: 0, y: 0, width: 2000, height: 1000 };
/** 640 宽的自家宠物：舞台中心 (420, 480)（box.top 300 + 舞台高 360 的一半） */
const box: PetBox = { left: 100, top: 300, size: 640, bottomPad: 23 };
const foe: Rect = { x: 1000, y: 320, width: 640, height: 400 };

test('areasUnion：全部工作区的外接矩形（负坐标、上下双屏也算对）；空数组 null', () => {
  assert.equal(areasUnion([]), null);
  assert.equal(areasUnion([{ x: 0, y: 0, width: 0, height: 10 }]), null);
  assert.deepEqual(
    areasUnion([
      { x: 0, y: 25, width: 1440, height: 900 },
      { x: -1280, y: 0, width: 1280, height: 800 },
    ]),
    { x: -1280, y: 0, width: 2720, height: 925 },
  );
});

test('screenUnion：有 getAllDisplays 就用全部显示器，没有就退回当前那块', () => {
  const all = screenUnion({
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1000, height: 800 } },
      { workArea: { x: 1000, y: 0, width: 800, height: 600 } },
    ],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 9, y: 9, width: 10, height: 10 } }),
  });
  assert.deepEqual(all, { x: 0, y: 0, width: 1800, height: 800 });
  const one = screenUnion({
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 900 } }),
  });
  assert.deepEqual(one, { x: 0, y: 25, width: 1440, height: 900 });
  // macOS：helper 的 buildDeskGeometry 把工作区顶从菜单栏下沿抬到屏幕顶（Dock 那一侧的扣除保留）
  const mac = screenUnion(
    {
      getAllDisplays: () => [
        { workArea: { x: 0, y: 25, width: 1440, height: 875 }, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
      ],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
    },
    'darwin',
  );
  assert.deepEqual(mac, { x: 0, y: 0, width: 1440, height: 900 });
  const win = screenUnion(
    {
      getAllDisplays: () => [
        { workArea: { x: 0, y: 25, width: 1440, height: 875 }, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
      ],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
    },
    'win32',
  );
  assert.deepEqual(win, { x: 0, y: 25, width: 1440, height: 875 }, '别的系统照旧用工作区');
});

test('dashApart / dashShift：停在离对方半个身位，本来更近就不后退', () => {
  // 640 + 640：两个半身（0.334375 × 640）加半个自己身体（0.334375 × 320）
  assert.equal(Math.round(dashApart(640, 640) * 1000) / 1000, 321);
  assert.equal(dashShift(420, 640, 1320, 640), 579, '两边中心隔 900，冲近到 321');
  assert.equal(dashShift(420, 640, 700, 640), 0, '已经比半个身位还近：不动');
  assert.equal(dashShift(1320, 640, 420, 640), -579, '对手在左边就往左冲');
  // 对手小一号（切磋客人 0.7 倍）：目标距离也跟着变短
  assert.ok(Math.abs(dashShift(420, 640, 1100, 448) - 391.1) < 0.01, '对手小一号时冲得远一点');
});

test('dashTarget：自家宠物中心换算成 /position 的归一化坐标', () => {
  const target = dashTarget(box, foe, union);
  // 自家中心 420 → 往右 579 到 999；y 是舞台中心 480
  assert.ok(Math.abs(target.x - 999 / 2000) < 1e-9, `x=${target.x}`);
  assert.ok(Math.abs(target.y - 480 / 1000) < 1e-9, `y=${target.y}`);
  // 对手在左边：目标在自家左边，不越界
  const left = dashTarget(box, { x: -900, y: 320, width: 640, height: 400 }, union);
  assert.ok(left.x >= 0 && left.x < 0.21);
});

test('foeDashShift：对手窗口按同一个半个身位冲过来，只改 x', () => {
  const shift = foeDashShift(foe, box);
  assert.equal(shift, -579, '客人从右边冲过来，窗口往左挪');
  const near = foeDashShift({ ...foe, x: 300 }, box);
  assert.equal(near, 0, '本来就更近就不动');
});

/** 假对手窗口：记下 pin 与 moveTo */
function fakeFoe(initial: Rect): DashFoe & { rect: Rect; pinned: boolean; moves: Rect[] } {
  const state = {
    rect: { ...initial },
    pinned: false,
    moves: [] as Rect[],
    side: 'right' as const,
    bounds: () => state.rect,
    pin: (on: boolean) => {
      state.pinned = on;
    },
    moveTo: (rect: Rect) => {
      state.rect = { ...rect };
      state.moves.push(rect);
    },
  };
  return state;
}

test('createDashRig：自家冲过去 / 退回来，钉住擂台特效层，收尾复位', () => {
  const moves: Array<[number, number, number]> = [];
  const stagePins: boolean[] = [];
  const foe = fakeFoe({ x: 1000, y: 320, width: 640, height: 400 });
  const rig = createDashRig({
    box: () => box,
    union: () => union,
    foe,
    pinStage: (on) => void stagePins.push(on),
    moveSelf: (x, y, ms) => void moves.push([x, y, ms]),
  });
  rig.run(0, 'out', 260);
  assert.deepEqual(stagePins, [true], '冲出去时钉住擂台与特效层');
  assert.equal(foe.pinned, true, '对手窗口也钉住');
  assert.equal(moves.length, 1);
  assert.equal(moves[0][2], 260);
  assert.ok(Math.abs(moves[0][0] - 999 / 2000) < 1e-9);
  rig.run(0, 'back', 320);
  assert.equal(moves.length, 2);
  assert.equal(moves[1][2], 320);
  assert.ok(Math.abs(moves[1][0] - 420 / 2000) < 1e-9, '退回开场位置');
  rig.end(true);
  assert.equal(rig.active(), false);
  assert.deepEqual(stagePins, [true, false], '退回来以后恢复');
  assert.equal(foe.pinned, false);
});

test('createDashRig：对手冲过来按帧挪窗口；快进时立刻复位', () => {
  const foe = fakeFoe({ x: 1000, y: 320, width: 640, height: 400 });
  const rig = createDashRig({
    box: () => box,
    union: () => union,
    foe,
    pinStage: () => undefined,
    moveSelf: () => undefined,
  });
  rig.run(1, 'out', 0);
  assert.equal(foe.pinned, true);
  assert.equal(foe.rect.x, 1000 - 579, '对手窗口挪到自家宠物身前');
  rig.end(true);
  assert.equal(foe.rect.x, 1000, '快进 / 收摊：窗口回开场站位');
  assert.equal(foe.pinned, false);
});
