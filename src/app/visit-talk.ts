/**
 * 串门时两只宠物怎么聊（纯逻辑，接线在 features.ts）：提示词拼装、聊天节奏、能一起玩的项目。
 *
 * 聊天记录两边各记一份，都从自己的角度写：「你：…」是自己说的，「小鱼：…」是对方说的，
 * 「（一起吃西瓜）」是一起做的事。每句都带上最近的记录，回话才接得住前文。
 * 对方的话只当引用数据拼进提示词（visit.ts 已经去掉控制字符、截断），串门台词只用人设，不带「主人此刻」。
 */

/** 拼进提示词的最近几行聊天记录（整趟的记录还留着，回家讲见闻、写日记用） */
const HISTORY_MAX = 20;
/** 刚有人说过话就先别起新话题（毫秒）：免得两边同时开口、气泡互相顶掉 */
export const QUIET_MS = 12_000;
/** 主人家一趟最多主动起几次话题 */
export const HOST_OPENERS = 3;
/** 客人一趟最多回几次对方捎来的事（对方起的话题、摸一下、一起玩）：对方发再多也不跟着无限调模型 */
export const GUEST_ANSWERS = 4;
/** 摸一下、一起玩捎给客人的最小间隔（毫秒）：每件都要两边各调一次模型 */
export const NUDGE_GAP_MS = 15_000;

/** 能一起玩的项目：label 是菜单上和台词里的说法，anim 是内置皮肤里的动画（两只宠物同时播） */
export interface PlayThing {
  label: string;
  anim: string;
}

export const PLAY_THINGS: readonly PlayThing[] = [
  { label: '吃西瓜', anim: '吃西瓜' },
  { label: '放风筝', anim: '放风筝' },
  { label: '吹气球', anim: '吹气球' },
  { label: '荡秋千', anim: '荡秋千' },
  { label: '玩扑克魔术', anim: '扑克魔术' },
  { label: '放烟花', anim: '放烟花' },
  { label: '拉小提琴', anim: '小提琴演奏' },
  { label: '玩水枪', anim: '玩水枪' },
];

export function findPlayThing(label: string): PlayThing | undefined {
  return PLAY_THINGS.find((thing) => thing.label === label);
}

/** 客人一趟自己开口几句（含进门打招呼）：大约每 2 分钟一句，至少 2 句、最多 8 句 */
export function tripRounds(stayMin: number): number {
  return Math.min(8, Math.max(2, Math.round(stayMin / 2)));
}

/** 客人两次开口的间隔：30–90 秒随机 */
export function talkGap(random = Math.random): number {
  return 30_000 + Math.round(random() * 60_000);
}

/** 主人家起话题的时机：进门后 20–30 秒先来一次（凑成开头的两个来回），之后 60–120 秒一次 */
export function openerGap(first: boolean, random = Math.random): number {
  return first ? 20_000 + Math.round(random() * 10_000) : 60_000 + Math.round(random() * 60_000);
}

/** 客人这一侧要说的那句是什么 */
export const GUEST_ASK = {
  greet: '你刚进门，跟它打个招呼。',
  follow: '接着跟它聊一句。',
  answer: '回它刚才那句。',
  poke: '它家主人刚伸手摸了摸你，说一句。',
  play: (what: string) => `你们正一起${what}，说一句。`,
  treat: (what: string) => `它请你吃${what}，说一句。`,
  farewell: '该回家了，跟它道个别。',
};

/** 主人家这一侧要说的那句是什么 */
export const HOST_ASK = {
  answer: '回它刚才那句。',
  opener: '找个新话题跟它聊一句。',
};

/** 有上次见面的记录时，进门打招呼 / 头一回起话题可以带上这句提示 */
export const MEMORY_HINT = '可以提一句上次聊的。';

function withHistory(scene: string, lines: readonly string[], ask: string): string {
  if (lines.length === 0) return `${scene}${ask}`;
  return `${scene}刚才你们说了：\n${lines.slice(-HISTORY_MAX).join('\n')}\n${ask}`;
}

/**
 * 客人（自家宠物在别人家）说一句的指令
 * @param owner 对方主人的昵称
 * @param pet 对方宠物的名字
 * @param memory 上次见面的备忘（neighbors.ts 的 memoryLine；没有传 null）
 */
export function guestPrompt(
  owner: string,
  pet: string,
  lines: readonly string[],
  ask: string,
  memory: string | null = null,
): string {
  return withHistory(`你在 ${owner} 家串门，它家的宠物叫「${pet}」。${memory ?? ''}`, lines, ask);
}

/**
 * 主人家（客人在自家）说一句的指令
 * @param owner 客人主人的昵称
 * @param pet 客人的名字
 * @param memory 上次见面的备忘（neighbors.ts 的 memoryLine；没有传 null）
 */
export function hostPrompt(
  owner: string,
  pet: string,
  lines: readonly string[],
  ask: string,
  memory: string | null = null,
): string {
  return withHistory(`${owner} 家的宠物「${pet}」来你家串门。${memory ?? ''}`, lines, ask);
}

/**
 * 见面结束后给自己记的一句备忘（neighbors.ts 存的摘要）。只能走 compose 生成：
 * 摘要会拼进下次的串门提示词、间接发到对方电脑上，speak / generate 带「主人此刻」，会把主人在干嘛漏出去。
 */
export function memoPrompt(owner: string, pet: string, lines: readonly string[]): string {
  return `你刚和 ${owner} 家的宠物「${pet}」聊了这些：\n${lines.slice(-HISTORY_MAX).join('\n')}\n用一句话给自己记条备忘，概括这次聊了什么，下次见面好提起。`;
}

/** 回家后跟主人讲见闻的指令（只给最近的记录） */
export function travelPrompt(owner: string, pet: string, lines: readonly string[]): string {
  return `你刚去 ${owner} 家串门回来，和它家的宠物「${pet}」聊了这些：\n${lines.slice(-HISTORY_MAX).join('\n')}\n用一句话跟主人讲讲串门的见闻。`;
}
