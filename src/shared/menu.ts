// 统一右键菜单组件 —— 桌面（renderer.js 经 shared-core）与浏览器（pet.ts 经 bundle）
// 共用**同一份**菜单树与**同一份**渲染实现（"全部同一个组件"，两端行为/外观严格一致）。
//
// 本文件是 src/shared 唯一的 DOM 渲染例外（共享约定：只含无 DOM 依赖的纯逻辑）：
//   - buildMenuTree / buildMenuPanel / isNoMirrorAnimation：纯函数，可单测，无 DOM；
//   - MENU_CSS / mountContextMenu：DOM 层，两端共用（菜单必须长成同一个样）。
// 菜单数据单一事实来源 = 合并后的 animations 配置（用户覆盖层自动生效）。
//
// 默认把工具项、应用快捷项和应用分组摊进一块面板；动作与「更多」仍保留原级联：
//   二级（动作的子级）= 分类：待机 / 转向 / 拖拽 / 点击回应 / 移动 / config 随机动作分类 / 事件档位
//   三级 = 具体动画名
//
// DOM 结构：主面板与各级级联子面板全部平级挂到根容器下；子面板按触发项贴边定位、独立滚动，
// 绝不嵌套进父面板/父项内部（同一容器包裹会让子菜单被父容器的滚动区裁切）。
//
// 级联保持模型（标准菜单行为，杜绝对齐缝隙/面板间移动导致的消失）：
//   - 只要指针还在这棵菜单树内（任意可见面板/项上），就**绝不自动收起**子面板；
//     悬停另一个分类时才切换其子面板（hideChain 旧链 + 展开新链）；
//   - 指针整体离开菜单树（root mouseleave，软 200ms）才关闭整个菜单；
//   - 点击项 / 点击菜单外 / Esc 关闭。
//   不再使用"逐项 mouseleave 延迟关闭定时器"——旧实现里鼠标从分类项移向三级面板时，
//   会同时给父项（动作）排下无人取消的关闭定时器，导致二级+三级一起消失。
import type { Animations, Category } from './types';

/** 叶子：可点击的菜单项 */
export interface MenuLeaf {
  label: string;
  /** 播放的动画名（点播动作）；action 优先于 anim */
  anim?: string;
  /** 自定义动作：open-site=打开网站；chat=打开对话弹窗；home=回到初始位置；
   * reload=重载配置（桌面端专属：重启桌面 Helper，全部桌面宠物窗口按最新配置重建——
   * 浏览器端刷新页面即可，不注入此项）；third-party=第三方注册的菜单项（见 buildMoreBranch）——
   * 点击只把 (owner, label) 上报给宿主，具体做什么由注册方自己决定。 */
  action?: 'open-site' | 'chat' | 'home' | 'reload' | 'third-party';
  /** third-party：注册它的 owner（身份键，**只用于回传，不显示**）。同一个 owner 的项收在同一个
   *  分组下；只有一项时跳过这层、直接平铺（见 buildMoreBranch）。 */
  owner?: string;
  /** third-party：回传给注册方的 label（缺省 = label）。独立应用分组项显示的是去掉前缀的短名，
   *  回传仍用注册时的完整 label（见 buildAppMenuNodes）。 */
  reportLabel?: string;
  /** 项目右侧的灰色小字（如快捷键「Ctrl+左键」）：纯视觉提示，不参与显示文本匹配，也不影响
   *  动作分发。缺省不占位（不显示任何东西）。 */
  hint?: string;
}

/** 分支：带子菜单的项 */
export interface MenuBranch {
  label: string;
  children: MenuNode[];
  /** 面板模式下仍使用级联子菜单，不把子项摊进主面板 */
  cascade?: boolean;
}

export type MenuNode = MenuLeaf | MenuBranch;

export interface MenuPanelSection {
  title: string;
  leaves: MenuLeaf[];
  subsections: Array<{ title: string; leaves: MenuLeaf[] }>;
}

export interface MenuPanelLayout {
  quick: MenuLeaf[];
  sections: MenuPanelSection[];
  footer: MenuLeaf[];
  cascades: MenuBranch[];
}

/** 第三方菜单项（宿主经 /state 的 sections.menu 下发的快照，一条 = 一个可点项）。 */
export interface MenuMoreItem {
  /** 注册方身份；同时也是一级分组名（显示用） */
  owner: string;
  /** 项名（显示用，也是回传给注册方的标识） */
  label: string;
}

/** 第三方菜单项统一收在这个一级菜单下（宿主自己的菜单项不进这里）。 */
export const MORE_MENU_LABEL = '更多';

/**
 * 从 `/state` 的 `sections.menu.data` 里读出第三方菜单项。
 *
 * 两侧（浏览器 / 桌面）共用同一份解析：快照来自网络，字段一律按"可能不存在"处理——
 * 非法条目静默丢弃，绝不让一条坏数据把整个右键菜单搞崩（菜单是高频交互入口）。
 */
export function readMenuItems(data: unknown): MenuMoreItem[] {
  if (!data || typeof data !== 'object') return [];
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: MenuMoreItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const owner = (item as Record<string, unknown>).owner;
    const label = (item as Record<string, unknown>).label;
    if (typeof owner === 'string' && owner !== '' && typeof label === 'string' && label !== '') {
      out.push({ owner, label });
    }
  }
  return out;
}

/**
 * 「更多」一级菜单：把第三方菜单项拼成菜单树的一枝；没有第三方项时返回 null（调用方不注入，
 * 菜单里就不会出现一个空的「更多」）。
 *
 * 层级规则就一条：**按项数决定要不要 owner 这一层**——
 *   - 该 owner 只有 1 项 → 直接 `更多 / 弹弓`（跳过分组，少一次点击）；
 *   - 2 项及以上      → `更多 / 小游戏 / 弹弓`、`钓鱼`。
 * 于是某个 owner 从 1 项变成 2 项时，它原来那一项会"缩进"进分组里——这是这条规则必然的副作用，
 * 换来的是只有一个项的插件不必多开一层。
 *
 * 同名不同 owner 的项允许共存（用户看到两个「弹弓」，点了各回各的 owner）：菜单文案由注册方负责，
 * 这里不做任何去重、编号或来源标注。
 */
export function buildMoreBranch(items: readonly MenuMoreItem[]): MenuBranch | null {
  // owner → 项名（Map 保序：注册顺序 = 分组顺序 = 组内顺序）
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const list = groups.get(item.owner);
    if (list) list.push(item.label);
    else groups.set(item.owner, [item.label]);
  }
  const children: MenuNode[] = [];
  for (const [owner, labels] of groups) {
    if (labels.length === 1) {
      children.push({ label: labels[0], action: 'third-party', owner });
    } else {
      children.push({
        label: owner,
        children: labels.map((label) => ({ label, action: 'third-party' as const, owner })),
      });
    }
  }
  return children.length > 0 ? { label: MORE_MENU_LABEL, children, cascade: true } : null;
}

/**
 * 独立应用自己的菜单项（APP_MENU_OWNER，不是第三方，直接放根菜单）：label 带「/」的按前缀收成一个子菜单，
 * 如「串门/去 小王 家」「串门/去 小李 家」→ 根上一个「串门」分支、里面两项；点了仍按完整 label 回传。
 * 只认第一个「/」；前缀为空的当普通项。分支出现在它第一项的位置，组内保持注册顺序。
 */
export function buildAppMenuNodes(items: readonly MenuMoreItem[]): MenuNode[] {
  const nodes: MenuNode[] = [];
  for (const item of items) {
    const slash = item.label.indexOf('/');
    if (slash <= 0) {
      nodes.push({ label: item.label, action: 'third-party', owner: item.owner });
      continue;
    }
    const group = item.label.slice(0, slash);
    let branch = nodes.find((node): node is MenuBranch => 'children' in node && node.label === group);
    if (!branch) {
      branch = { label: group, children: [] };
      nodes.push(branch);
    }
    branch.children.push({
      label: item.label.slice(slash + 1),
      action: 'third-party',
      owner: item.owner,
      reportLabel: item.label,
    });
  }
  return nodes;
}

/** 事件名 → 分类标签（无映射时用事件名本身） */
const EVENT_LABELS: Record<string, string> = {
  whisper: '碎碎念',
  workStatus: '工作状态',
};

const leaf = (anim: string): MenuLeaf => ({ label: anim, anim });

/**
 * 由合并后的 animations 配置推导菜单树 —— 输出 [{ 动作 → [ 分类 → [ 具体动画 ] ] }]：
 * 一级只有一个「动作」分支；二级 = 分类（待机/转向/拖拽/点击回应/移动 + config 随机动作
 * 分类 + 事件档位）；三级 = 具体动画名。空池/空分类自动省略。
 */
export function buildMenuTree(animations: Animations): MenuNode[] {
  const groups: MenuNode[] = [];
  const pools: Array<[string, string[]]> = [
    ['待机', animations.idle],
    ['转向', animations.turn],
    ['拖拽', animations.drag],
    ['点击回应', animations.clicks],
    ['移动', animations.moves.actions.map((m) => m.name)],
  ];
  for (const [label, pool] of pools) {
    if (pool.length) groups.push({ label, children: pool.map(leaf) });
  }
  // config 随机动作分类（noMirror 分类照样可点播，播放端朝右时强制朝左见 isNoMirrorAnimation）
  const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
  for (const c of cats) {
    groups.push({ label: c.id, children: c.actions.map(leaf) });
  }
  // 事件动画：每个事件为一个分类（不来自随机链，点播与代码触发同一池）。
  // 数组槽位（档内随机候选）展平为逐个叶子——所有候选都可右键点播预览。
  const events = animations.events ?? {};
  for (const key of Object.keys(events)) {
    const pool = events[key] ?? [];
    const names: string[] = [];
    for (const slot of pool) {
      if (typeof slot === 'string') names.push(slot);
      else names.push(...slot);
    }
    if (names.length) groups.push({ label: EVENT_LABELS[key] ?? key, children: names.map(leaf) });
  }
  if (!groups.length) return [];
  return [{ label: '动作', children: groups, cascade: true }];
}

/** 把顶层工具、应用分组和保留级联的分支分流到一块面板，组内顺序与菜单树一致。 */
export function buildMenuPanel(tree: MenuNode[]): MenuPanelLayout {
  const layout: MenuPanelLayout = { quick: [], sections: [], footer: [], cascades: [] };
  const collectLeaves = (nodes: MenuNode[]): MenuLeaf[] =>
    nodes.flatMap((node) => (isBranchNode(node) ? collectLeaves(node.children) : [node]));
  for (const node of tree) {
    if (!isBranchNode(node)) {
      if (node.action === 'third-party') layout.quick.push(node);
      // 工具项，以及以后可能出现的其它顶层叶子，都放底栏；不能静默丢掉
      else layout.footer.push(node);
      continue;
    }
    if (node.cascade) {
      layout.cascades.push(node);
      continue;
    }
    const section: MenuPanelSection = { title: node.label, leaves: [], subsections: [] };
    for (const child of node.children) {
      if (isBranchNode(child)) section.subsections.push({ title: child.label, leaves: collectLeaves(child.children) });
      else section.leaves.push(child);
    }
    layout.sections.push(section);
  }
  return layout;
}

/**
 * 把整棵树的 cascade 标记全部清掉：脱离宠物窗口的窄面板没有横向空间放子菜单，
 * 动作 / 更多都摊成面板里的 section + chips，超高时面板内滚动。
 */
export function flattenMenuTree(nodes: MenuNode[]): MenuNode[] {
  return nodes.map((node) =>
    isBranchNode(node) ? { ...node, cascade: false, children: flattenMenuTree(node.children) } : node,
  );
}

/**
 * 面板的首选落点：**先躲开宠物**——优先放在宠物正下方，放不下再放正上方（高度按剩余空间收紧，
 * 内容多了在面板里滚）。上下都不够时退回原来「从光标处展开、夹进可视矩形」。
 * 宠物矩形与 clamp 都用视口局部坐标；width/height 是面板的估算尺寸。
 */
export function placeMenuPanel(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  clamp: { x: number; y: number; w: number; h: number };
  avoid?: { x: number; y: number; w: number; h: number };
}): { left: number; top: number; maxHeight: number } {
  const { x, y, width, height, clamp, avoid } = input;
  const gap = 8;
  const minRoom = 120;
  const left = (value: number): number => Math.max(clamp.x + 4, Math.min(value, clamp.x + clamp.w - width - 4));
  const top = (value: number): number => Math.max(clamp.y + 4, Math.min(value, clamp.y + clamp.h - height - 4));
  const fallback = { left: left(x), top: top(y), maxHeight: Math.max(0, clamp.h - 8) };
  if (!avoid) return fallback;
  const centered = avoid.x + avoid.w / 2 - width / 2;
  const belowTop = avoid.y + avoid.h + gap;
  const belowRoom = clamp.y + clamp.h - 4 - belowTop;
  if (belowRoom >= minRoom) {
    return { left: left(centered), top: belowTop, maxHeight: Math.min(height, belowRoom) };
  }
  const aboveRoom = avoid.y - gap - (clamp.y + 4);
  if (aboveRoom >= minRoom) {
    const h = Math.min(height, aboveRoom);
    return { left: left(centered), top: Math.max(clamp.y + 4, avoid.y - gap - h), maxHeight: h };
  }
  return fallback;
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右（镜像）时点播前强制朝左，避免文字镜像 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}

/** 菜单样式 —— 两端注入同一份（浏览器并入 plugin css；桌面入窗口 head）。
 *  每一级面板是独立的绝对定位盒子（.dsh-pet-menu-column），位置由 JS 内联写入；
 *  面板与面板之间互不嵌套，各自独立滚动。 */
export const MENU_CSS = [
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2a26;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-panel,.dsh-pet-menu-column{position:absolute;background:#f7f2e7;border:1px solid #cdbfa6;',
  'border-radius:12px;box-shadow:0 8px 28px rgba(43,42,38,.22);overflow-y:auto;',
  'scrollbar-width:thin;scrollbar-color:rgba(138,122,92,.45) transparent}',
  '.dsh-pet-menu-panel{padding:10px;overflow-x:hidden}',
  '.dsh-pet-menu-column{min-width:150px;max-width:300px;padding:4px;max-height:min(62vh,460px)}',
  '.dsh-pet-menu-panel::-webkit-scrollbar,.dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-pet-menu-panel::-webkit-scrollbar-track,.dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}',
  '.dsh-pet-menu-panel::-webkit-scrollbar-thumb,.dsh-pet-menu-column::-webkit-scrollbar-thumb{',
  'background:rgba(138,122,92,.32);border-radius:4px;border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-panel::-webkit-scrollbar-thumb:hover,.dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{',
  'background:rgba(63,125,90,.55);border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-panel::-webkit-scrollbar-corner,.dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}',
  '.dsh-pet-menu-title{padding:2px 6px 9px;color:#3f7d5a;font-size:16px;font-weight:600;cursor:grab;',
  'touch-action:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-menu-panel.is-dragging .dsh-pet-menu-title{cursor:grabbing}',
  '.dsh-pet-menu-quick-grid,.dsh-pet-menu-chips{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}',
  '.dsh-pet-menu-quick-grid{margin-bottom:10px}',
  '.dsh-pet-menu-panel.is-narrow .dsh-pet-menu-quick-grid,.dsh-pet-menu-panel.is-narrow .dsh-pet-menu-chips{',
  'grid-template-columns:minmax(0,1fr)}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  '.dsh-pet-menu-item:hover{background:rgba(63,125,90,.14)}',
  '.dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-menu-quick{min-height:42px;justify-content:center;padding:8px 10px;border:1px solid #3f7d5a;',
  'border-radius:8px;background:#3f7d5a;color:#fffaf0;text-align:center}',
  '.dsh-pet-menu-quick:hover{background:#356b4c}',
  '.dsh-pet-menu-section{padding:7px 0 2px;border-top:1px solid rgba(205,191,166,.7)}',
  '.dsh-pet-menu-section-title{padding:2px 6px 5px;color:#8a7a5c;font-size:12px;font-weight:600}',
  '.dsh-pet-menu-section>summary,.dsh-pet-menu-subsection>summary{display:flex;align-items:center;gap:6px;',
  'padding:3px 6px;border-radius:6px;list-style:none;cursor:pointer}',
  '.dsh-pet-menu-section>summary::-webkit-details-marker,.dsh-pet-menu-subsection>summary::-webkit-details-marker{display:none}',
  '.dsh-pet-menu-section>summary:hover,.dsh-pet-menu-subsection>summary:hover{background:rgba(63,125,90,.10)}',
  '.dsh-pet-menu-section>summary::after,.dsh-pet-menu-subsection>summary::after{content:"▸";color:#8a7a5c;',
  'font-size:11px;line-height:1;transition:transform .12s}',
  '.dsh-pet-menu-section[open]>summary::after,.dsh-pet-menu-subsection[open]>summary::after{transform:rotate(90deg)}',
  '.dsh-pet-menu-count{margin-left:auto;color:#b0a188;font-size:11px;font-weight:400}',
  '.dsh-pet-menu-subsection{margin-top:5px}',
  '.dsh-pet-menu-chip{justify-content:center;min-width:0;padding:6px 8px;border:1px solid #cdbfa6;border-radius:8px;',
  'background:#fffaf0;text-align:center}',
  '.dsh-pet-menu-chip:hover{border-color:#3f7d5a;background:#fff}',
  '.dsh-pet-menu-footer{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid #cdbfa6}',
  '.dsh-pet-menu-footer .dsh-pet-menu-item{flex:1 1 42%;min-width:0;justify-content:center;gap:4px;padding:5px 4px;font-size:12px}',
  '.dsh-pet-menu-hint{color:#8a7a5c;font-size:12px;flex:none;white-space:nowrap}',
  '.dsh-pet-menu-arrow{color:#8a7a5c;font-size:12px;flex:none}',
].join('');

/** mountContextMenu 返回值 */
export interface ContextMenuMount {
  /** 已挂载的根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

function isBranchNode(n: MenuNode): n is MenuBranch {
  return 'children' in n && Array.isArray((n as MenuBranch).children);
}

/**
 * 挂载右键菜单到 document.body；默认摊开为单块面板，cascade 模式保留原多级菜单。
 * 位置为视口坐标（桌面=窗口视口，浏览器=页面视口）——两端一致。
 *
 * 所有子面板平级挂在根容器下，按触发项贴边定位（右/下边缘自动翻转夹取）；
 * 指针整体离开菜单树（root mouseleave）才关闭整棵菜单；点击项回调后自动关闭、
 * 点击菜单外或按 Esc 关闭；超高面板内独立滚动。
 *
 * clamp（可选，#41）：菜单允许占用的矩形（视口局部坐标，默认整个视口）。
 * 桌面模式传「窗口 ∩ 工作区」：宠物贴屏幕底/右时窗口外扩余量伸出屏幕，菜单走进
 * 伸出的部分会被 OS 裁掉——约束到该矩形内即可完整显示，**窗口/宠物零移动零闪帧**。
 */
export function mountContextMenu(opts: {
  tree: MenuNode[];
  x: number;
  y: number;
  onAction: (leaf: MenuLeaf) => void;
  /** 菜单被关闭（点项/点外/Esc）后的通知：挂载方据此复位自身状态（如桌面可交互标记） */
  onClose?: () => void;
  /** 菜单允许占用的矩形（视口局部坐标）；缺省 = 整个视口（浏览器既有行为） */
  clamp?: { x: number; y: number; w: number; h: number };
  /** 面板头部的宠物名；缺省显示「菜单」 */
  title?: string;
  /** 默认单块面板；cascade 保留旧三级级联菜单 */
  layout?: 'panel' | 'cascade';
  /** 宠物身体在视口里的矩形：面板优先落在它上下方，避免一开出来就盖住宠物 */
  avoid?: { x: number; y: number; w: number; h: number };
  /** 面板宽度上限（缺省 420）；脱离宠物窗口的窄面板传 320 */
  width?: number;
  /** 面板高度上限（缺省 clamp.h - 8）；脱离窗口时按窗口留白收紧 */
  maxHeight?: number;
  /** 显式落点（视口坐标）；传入后不再按 x/y/avoid 自动避让 */
  position?: { left: number; top: number };
  /** 拖拽标题时的行为：panel = 在窗口内移动面板（默认）；window = 交给宿主移动整个窗口 */
  dragMode?: 'panel' | 'window';
  /** dragMode='window' 时的回调；坐标是屏幕坐标（PointerEvent.screenX/screenY） */
  onDrag?: (phase: 'start' | 'move' | 'end', screenX: number, screenY: number) => void;
  /** 面板模式下把一级分组收成可展开的 <details>，二级分类默认收起；避免动作/串门一次铺满 */
  collapsible?: boolean;
}): ContextMenuMount {
  const {
    tree,
    x,
    y,
    onAction,
    onClose,
    clamp,
    title,
    layout = 'panel',
    avoid,
    width,
    maxHeight,
    position,
    dragMode = 'panel',
    onDrag,
    collapsible = false,
  } = opts;
  // 夹取基准：缺省整个视口；桌面传入「窗口 ∩ 工作区」后各级面板都只在这个矩形内落位/翻转。
  // 防御：clamp 含非有限值（如坐标来源缺失变成 NaN）时回落整个视口——否则面板会落到 (0,0)
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const root = document.createElement('div');
  root.className = 'dsh-pet-menu';
  root.style.left = '0px';
  root.style.top = '0px';
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  let closed = false;
  /** 正在拖面板：拖拽期间指针可能短暂离开菜单树，不能按 mouseleave 收起 */
  let dragging = false;

  /** 每个面板当前展开的子面板（无 = 未展开）；hideChain 会沿链清除 */
  const openChild = new Map<HTMLElement, HTMLElement>();
  /** 指针整体离开菜单树的兜底关闭定时器（root mouseover 重新进入即取消） */
  let leaveTimer: number | null = null;

  /** 关闭某面板及其后代面板整条链（display:none + 清 openChild 链） */
  const hideChain = (panel: HTMLElement): void => {
    panel.style.display = 'none';
    const child = openChild.get(panel);
    if (child) {
      openChild.delete(panel);
      hideChain(child);
    }
  };

  /** 把面板显示在触发项旁边：右缘展开，贴右/下边缘自动翻转夹取（在 clamp 矩形内） */
  const showPanel = (panel: HTMLElement, item: HTMLElement): void => {
    const rect = item.getBoundingClientRect();
    panel.style.left = '';
    panel.style.top = '';
    panel.style.display = 'block';
    let left = rect.right + 4;
    if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4;
    left = Math.max(c.x + 4, left);
    let top = rect.top;
    if (top + panel.offsetHeight > c.y + c.h - 4) top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  };

  /** 构建一层面板（nodes 列表）；分支项的子面板**平级**挂到 root 下，不嵌套。
   *  面板自身先入 DOM、子面板随后入 → 层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
  const buildPanel = (nodes: MenuNode[]): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'dsh-pet-menu-column';
    panel.style.display = 'none';
    // 桌面 clamp：把列高封顶到可视矩形内（否则 62vh 相对的是窗口高度，可视区更小时仍会溢出被裁）
    if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + 'px';
    root.appendChild(panel);
    for (const node of nodes) {
      const item = document.createElement('div');
      item.className = 'dsh-pet-menu-item';
      if (isBranchNode(node)) {
        item.classList.add('dsh-pet-menu-branch');
        const label = document.createElement('span');
        label.textContent = node.label;
        const arrow = document.createElement('span');
        arrow.className = 'dsh-pet-menu-arrow';
        arrow.textContent = '▸';
        item.appendChild(label);
        item.appendChild(arrow);
        const childPanel = buildPanel(node.children); // 递归：子面板已入树（晚于本面板）
        // 悬停分支：收掉本面板其它分支已展开的子面板链，再展开当前分支的儿子面板。
        // （指针在本菜单树内移动绝不自动收起——跨 4px 缝隙/面板间隙都不会触发关闭）
        item.addEventListener('mouseenter', () => {
          const prev = openChild.get(panel);
          if (prev && prev !== childPanel) hideChain(prev);
          openChild.set(panel, childPanel);
          showPanel(childPanel, item);
        });
      } else {
        const label = document.createElement('span');
        label.textContent = node.label;
        item.appendChild(label);
        // 右侧灰色提示（如快捷键）：与 label 同一 flex 行，space-between 自动贴右
        if (node.hint) {
          const hint = document.createElement('span');
          hint.className = 'dsh-pet-menu-hint';
          hint.textContent = node.hint;
          item.appendChild(hint);
        }
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onAction(node);
          close();
        });
      }
      panel.appendChild(item);
    }
    return panel;
  };

  const makeDisclosure = (title: string, kind: 'section' | 'subsection', open: boolean, count: number): HTMLElement => {
    const details = document.createElement('details');
    details.className = `dsh-pet-menu-${kind}`;
    details.open = open;
    const summary = document.createElement('summary');
    summary.className = 'dsh-pet-menu-section-title';
    const label = document.createElement('span');
    label.textContent = title;
    summary.appendChild(label);
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'dsh-pet-menu-count';
      badge.textContent = String(count);
      summary.appendChild(badge);
    }
    details.appendChild(summary);
    return details;
  };

  const buildMainPanel = (): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'dsh-pet-menu-panel';
    if (c.w < 300) panel.classList.add('is-narrow');
    panel.style.width = Math.max(0, Math.min(width ?? 420, c.w - 8)) + 'px';
    panel.style.maxHeight = Math.max(0, maxHeight ?? c.h - 8) + 'px';
    root.appendChild(panel);

    const appendLeaf = (parent: HTMLElement, node: MenuLeaf, className?: string): void => {
      const item = document.createElement('div');
      item.className = 'dsh-pet-menu-item';
      if (className) item.classList.add(className);
      const label = document.createElement('span');
      label.textContent = node.label;
      item.appendChild(label);
      if (node.hint) {
        const hint = document.createElement('span');
        hint.className = 'dsh-pet-menu-hint';
        hint.textContent = node.hint;
        item.appendChild(hint);
      }
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onAction(node);
        close();
      });
      parent.appendChild(item);
    };
    const appendChips = (parent: HTMLElement, leaves: MenuLeaf[]): void => {
      const chips = document.createElement('div');
      chips.className = 'dsh-pet-menu-chips';
      for (const node of leaves) appendLeaf(chips, node, 'dsh-pet-menu-chip');
      parent.appendChild(chips);
    };

    const panelLayout = buildMenuPanel(tree);
    const heading = document.createElement('div');
    heading.className = 'dsh-pet-menu-title';
    heading.textContent = title || '菜单';
    panel.appendChild(heading);
    // 按住标题拖：默认在窗口内挪面板；dragMode='window' 交给宿主挪整个窗口（脱离宠物窗口时用）
    heading.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || closed) return;
      e.preventDefault();
      dragging = true;
      panel.classList.add('is-dragging');
      for (const child of [...openChild.values()]) hideChain(child);
      openChild.clear();
      const windowDrag = dragMode === 'window' ? onDrag : undefined;
      if (windowDrag) {
        // 合成事件没有 active pointer，setPointerCapture 会抛；真实拖拽才需要捕获
        if (e.isTrusted) heading.setPointerCapture(e.pointerId);
        windowDrag('start', e.screenX, e.screenY);
      }
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = parseFloat(panel.style.left) || 0;
      const startTop = parseFloat(panel.style.top) || 0;
      const move = (event: PointerEvent): void => {
        if (closed) return;
        if (windowDrag) {
          windowDrag('move', event.screenX, event.screenY);
          return;
        }
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        panel.style.left = Math.max(c.x + 4, Math.min(startLeft + event.clientX - startX, c.x + c.w - w - 4)) + 'px';
        panel.style.top = Math.max(c.y + 4, Math.min(startTop + event.clientY - startY, c.y + c.h - h - 4)) + 'px';
      };
      const end = (event: PointerEvent): void => {
        dragging = false;
        panel.classList.remove('is-dragging');
        if (windowDrag) {
          windowDrag('end', event.screenX, event.screenY);
          if (event.isTrusted && heading.hasPointerCapture(event.pointerId)) {
            heading.releasePointerCapture(event.pointerId);
          }
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    if (panelLayout.quick.length) {
      const quick = document.createElement('div');
      quick.className = 'dsh-pet-menu-quick-grid';
      for (const node of panelLayout.quick) appendLeaf(quick, node, 'dsh-pet-menu-quick');
      panel.appendChild(quick);
    }
    for (const sectionLayout of panelLayout.sections) {
      const count =
        sectionLayout.leaves.length +
        sectionLayout.subsections.reduce((sum, subsection) => sum + subsection.leaves.length, 0);
      // 一级分组：小分组默认展开，动作/串门这类大分组先收起；组内滚动由面板负责
      const section = collapsible
        ? makeDisclosure(sectionLayout.title, 'section', count <= 6, count)
        : document.createElement('section');
      if (!collapsible) {
        section.className = 'dsh-pet-menu-section';
        const heading = document.createElement('div');
        heading.className = 'dsh-pet-menu-section-title';
        heading.textContent = sectionLayout.title;
        section.appendChild(heading);
      }
      if (sectionLayout.leaves.length > 6) appendChips(section, sectionLayout.leaves);
      else for (const node of sectionLayout.leaves) appendLeaf(section, node);
      for (const subsectionLayout of sectionLayout.subsections) {
        // 二级分类（动作的待机/移动……、修炼的切磋）默认收起：点开才铺开，避免菜单过长
        const subsection = collapsible
          ? makeDisclosure(subsectionLayout.title, 'subsection', false, subsectionLayout.leaves.length)
          : document.createElement('div');
        if (!collapsible) {
          subsection.className = 'dsh-pet-menu-subsection';
          const subheading = document.createElement('div');
          subheading.className = 'dsh-pet-menu-section-title';
          subheading.textContent = subsectionLayout.title;
          subsection.appendChild(subheading);
        }
        appendChips(subsection, subsectionLayout.leaves);
        section.appendChild(subsection);
      }
      panel.appendChild(section);
    }
    if (panelLayout.footer.length) {
      const footer = document.createElement('div');
      footer.className = 'dsh-pet-menu-footer';
      for (const node of panelLayout.footer) appendLeaf(footer, node);
      panel.appendChild(footer);
    }
    for (const branch of panelLayout.cascades) {
      const item = document.createElement('div');
      item.className = 'dsh-pet-menu-item dsh-pet-menu-branch';
      const label = document.createElement('span');
      label.textContent = branch.label;
      const arrow = document.createElement('span');
      arrow.className = 'dsh-pet-menu-arrow';
      arrow.textContent = '▸';
      item.appendChild(label);
      item.appendChild(arrow);
      const childPanel = buildPanel(branch.children);
      const open = (): void => {
        const prev = openChild.get(panel);
        if (prev && prev !== childPanel) hideChain(prev);
        openChild.set(panel, childPanel);
        showPanel(childPanel, item);
      };
      item.addEventListener('mouseenter', open);
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        open();
      });
      panel.appendChild(item);
    }
    return panel;
  };

  const rootPanel = layout === 'panel' ? buildMainPanel() : buildPanel(tree);
  rootPanel.style.display = 'block';

  // 关键：把菜单根容器真正挂进文档（v1→v2 重写时漏掉的挂载——不 append 则一切"静默无显示"）
  document.body.appendChild(root);

  // 根面板定位：显式落点优先；否则面板优先落在宠物上下方（不挡宠物），cascade 仍按 (x,y) 从光标处展开
  const rw = rootPanel.offsetWidth;
  const rh = rootPanel.offsetHeight;
  if (position) {
    rootPanel.style.left = Math.max(c.x + 4, Math.min(position.left, c.x + c.w - rw - 4)) + 'px';
    rootPanel.style.top = Math.max(c.y + 4, Math.min(position.top, c.y + c.h - rh - 4)) + 'px';
  } else if (layout === 'panel') {
    const placement = placeMenuPanel({ x, y, width: rw, height: rh, clamp: c, avoid });
    rootPanel.style.maxHeight = placement.maxHeight + 'px';
    rootPanel.style.left = placement.left + 'px';
    rootPanel.style.top = placement.top + 'px';
  } else {
    rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + 'px';
    rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + 'px';
  }

  // 指针整体离开菜单树（离开全部面板的并集）→ 200ms 后关闭整棵菜单；
  // 期间任何指针移动（mouseover 冒泡到 root）都视为仍在菜单内，取消关闭
  root.addEventListener('mouseleave', () => {
    if (dragging) return;
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null;
      close();
    }, 200);
  });
  root.addEventListener('mouseover', () => {
    if (leaveTimer !== null) {
      window.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  });

  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (onClose) onClose();
  };

  return { el: root, close };
}
