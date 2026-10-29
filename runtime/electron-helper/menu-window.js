/**
 * 脱离宠物窗口的右键菜单：把菜单窗口放到宠物身体**旁边**（右优先、放不下换左），
 * 纵向以宠物中心对齐，再夹进当前显示器工作区。纯函数，不 require('electron')，可单测。
 *
 * 坐标全部是 DIP：pet / workArea / 返回的 x,y 与 BrowserWindow 的 bounds 同一套。
 */
'use strict';

/**
 * @param {{x:number,y:number,w:number,h:number}} pet 宠物身体屏幕矩形
 * @param {number} width 菜单窗口宽度
 * @param {number} height 菜单窗口高度
 * @param {{x:number,y:number,w:number,h:number}} workArea 当前显示器工作区
 * @returns {{x:number,y:number}}
 */
function placeMenuWindow(pet, width, height, workArea) {
  const gap = 8;
  // Electron 的 display.workArea 用 width/height；内部调用也允许简写 w/h，避免两套形状混用出 NaN
  const wa = {
    x: workArea?.x,
    y: workArea?.y,
    w: workArea?.w ?? workArea?.width,
    h: workArea?.h ?? workArea?.height,
  };
  const finite = [pet?.x, pet?.y, pet?.w, pet?.h, width, height, wa.x, wa.y, wa.w, wa.h];
  if (!finite.every(Number.isFinite)) {
    return { x: Math.round((wa.x ?? 0) + gap), y: Math.round((wa.y ?? 0) + gap) };
  }
  const right = pet.x + pet.w + gap;
  const left = pet.x - gap - width;
  const minX = wa.x + gap;
  const maxX = Math.max(minX, wa.x + wa.w - width - gap);
  let x;
  if (right <= maxX) x = right;
  else if (left >= minX) x = left;
  else x = Math.max(minX, Math.min(right, maxX));

  const minY = wa.y + gap;
  const maxY = Math.max(minY, wa.y + wa.h - height - gap);
  const y = Math.max(minY, Math.min(pet.y + pet.h / 2 - height / 2, maxY));
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = { placeMenuWindow };
