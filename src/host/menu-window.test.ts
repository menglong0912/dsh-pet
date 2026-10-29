import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { placeMenuWindow } = require(helper + 'menu-window.js');

const workArea = { x: 0, y: 25, w: 1470, h: 900 };

test('placeMenuWindow opens to the right of the pet when there is room', () => {
  const pet = { x: 100, y: 200, w: 200, h: 200 };
  assert.deepEqual(placeMenuWindow(pet, 352, 400, workArea), { x: 308, y: 100 });
});

test('placeMenuWindow flips to the left when the right side would leave the work area', () => {
  const pet = { x: 1200, y: 200, w: 200, h: 200 };
  assert.deepEqual(placeMenuWindow(pet, 352, 400, workArea), { x: 840, y: 100 });
});

test('placeMenuWindow clamps both axes when neither side / vertical center fits', () => {
  const pet = { x: 300, y: 700, w: 900, h: 200 };
  const placed = placeMenuWindow(pet, 352, 700, workArea);
  assert.equal(placed.x, 1110);
  assert.equal(placed.y, 217);
});

test('placeMenuWindow accepts Electron display.workArea width/height', () => {
  const pet = { x: 100, y: 200, w: 200, h: 200 };
  assert.deepEqual(placeMenuWindow(pet, 352, 400, { x: 0, y: 25, width: 1470, height: 900 }), {
    x: 308,
    y: 100,
  });
});

test('placeMenuWindow still returns an in-area point when the window is larger than the work area', () => {
  const pet = { x: 100, y: 100, w: 200, h: 200 };
  assert.deepEqual(placeMenuWindow(pet, 2000, 1200, workArea), { x: 8, y: 33 });
});
