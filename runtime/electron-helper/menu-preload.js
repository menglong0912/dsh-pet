'use strict';

// 脱离宠物窗口的右键菜单 preload：只暴露菜单窗口与主进程之间的最小原语。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuBridge', {
  /** 主进程送来菜单树：渲染端挂载面板 */
  onRender(cb) {
    ipcRenderer.on('menu:render', (_event, data) => cb(data));
  },
  /** 选中菜单项：把 leaf 交回主进程，由主进程转发给菜单所属的宠物窗口 */
  action(leaf) {
    ipcRenderer.send('menu:action', leaf);
  },
  /** 点外 / Esc / 失焦关闭（非菜单项路径） */
  closed() {
    ipcRenderer.send('menu:closed');
  },
  /** 面板量好后上报窗口尺寸：主进程按内容收紧菜单窗口（高一些、不留透明大块） */
  size(size) {
    ipcRenderer.send('menu:size', size);
  },
  /** 拖标题移动整个菜单窗口：phase = start / move / end，坐标是屏幕坐标 */
  drag(phase, screenX, screenY) {
    ipcRenderer.send('menu:drag', { phase, screenX, screenY });
  },
});
