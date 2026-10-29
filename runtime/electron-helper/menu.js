'use strict';

// 脱离宠物窗口的右键菜单渲染端：整窗透明，只画一块窄面板；点项后把 leaf 交回主进程。
(() => {
  const S = window.PetShared;
  const bridge = window.menuBridge;
  /** 面板四周留白：容纳 CSS 阴影，同时是窗口边缘的点击/拖拽余量 */
  const MARGIN = 16;

  let closeMenu = null;
  let actionSent = false;
  let observedPanel = null;

  const reportSize = () => {
    const panel = document.querySelector('.dsh-pet-menu-panel');
    if (!panel) return;
    bridge.size({
      width: Math.ceil(panel.offsetWidth) + MARGIN * 2,
      height: Math.ceil(panel.offsetHeight) + MARGIN * 2,
    });
  };
  const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(reportSize) : null;

  const style = document.createElement('style');
  style.textContent = S.MENU_CSS;
  document.head.appendChild(style);

  bridge.onRender(({ tree, title }) => {
    actionSent = false;
    document.body.textContent = '';
    const mounted = S.mountContextMenu({
      tree,
      title,
      x: 0,
      y: 0,
      width: 320,
      maxHeight: Math.max(80, window.innerHeight - MARGIN * 2),
      position: { left: MARGIN, top: MARGIN },
      dragMode: 'window',
      collapsible: true,
      onDrag: (phase, screenX, screenY) => bridge.drag(phase, screenX, screenY),
      onAction: (leaf) => {
        actionSent = true;
        bridge.action(leaf);
      },
      onClose: () => {
        if (!actionSent) bridge.closed();
      },
    });
    closeMenu = mounted.close;
    const panel = document.querySelector('.dsh-pet-menu-panel');
    if (sizeObserver && panel) {
      if (observedPanel) sizeObserver.unobserve(observedPanel);
      observedPanel = panel;
      // 展开/收起分组后面板高度会变，窗口要跟着收紧/长高
      sizeObserver.observe(panel);
    }
    reportSize();
  });

  // 菜单窗口是独立的可聚焦窗口：点到别的应用 / Cmd+Tab 就屏蔽（主进程据此收起并通知宠物）
  window.addEventListener('blur', () => {
    if (closeMenu) closeMenu();
  });

  // 兜底：某些窗口管理器里 focus() 不生效（blur 永远不来），指针离开菜单窗口 250ms 也收起；
  // 拖标题时指针跟着窗口走、短暂越界不能误关。
  let leaveTimer = null;
  const cancelLeave = () => {
    if (leaveTimer !== null) {
      window.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  };
  window.addEventListener('mouseenter', cancelLeave);
  window.addEventListener('mouseleave', () => {
    cancelLeave();
    if (document.querySelector('.dsh-pet-menu-panel.is-dragging')) return;
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null;
      if (closeMenu) closeMenu();
    }, 250);
  });
})();
