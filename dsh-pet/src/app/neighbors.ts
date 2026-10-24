/**
 * 邻居簿：记住来往过的邻居，下次见面打招呼能提到上次聊了什么（features.ts 接线）。
 * 记录只存本机，不出网；摘要本身是 compose 按人设生成的句子，才能拼回串门提示词。
 *
 * 存在 $DSH_HOME/dsh-pet/neighbors.json，先写临时文件再改名（同 saveAppConfig）。
 * 文件读不了或内容坏了 → 把原文件改名为 .bad-<时间>、明确 warn，从空簿子重新记（不静默覆盖）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { durationText } from './activity';
import { cleanName, cleanText, LINE_MAX } from './visit';

/** 一条邻居记录 */
export interface NeighborRecord {
  id: string;
  /** 每次见面更新成最新的（已清理） */
  owner: string;
  pet: string;
  /** 熟人（T5 用；T4 里恒为 false） */
  friend: boolean;
  /** 来我家做客的次数 */
  hosted: number;
  /** 我去它家的次数 */
  visited: number;
  firstMet: number;
  lastMet: number;
  /** 最近一次见面的摘要，≤ LINE_MAX */
  summary: string;
}

/** 最多记多少位邻居 */
export const NEIGHBORS_MAX = 50;

const recordSchema = z.object({
  id: z.string().min(8).max(64),
  owner: z.string(),
  pet: z.string(),
  friend: z.boolean(),
  hosted: z.number().int().min(0),
  visited: z.number().int().min(0),
  firstMet: z.number(),
  lastMet: z.number(),
  summary: z.string(),
});

export class NeighborBook {
  private readonly records = new Map<string, NeighborRecord>();
  private readonly path: string;
  private readonly warn: (message: string) => void;

  /** @param warn 文件读不了 / 写不了时的告警出口 */
  constructor(path: string, warn: (message: string) => void) {
    this.path = path;
    this.warn = warn;
    if (!existsSync(path)) return;
    try {
      const saved = z.object({ neighbors: z.array(recordSchema) }).parse(JSON.parse(readFileSync(path, 'utf8')));
      for (const record of saved.neighbors) this.records.set(record.id, record);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const bad = `${path}.bad-${Date.now()}`;
      try {
        renameSync(path, bad);
        this.warn(`邻居簿读不了（${reason}），已改名 ${bad}，从头重新记`);
      } catch (renameError) {
        const renameReason = renameError instanceof Error ? renameError.message : String(renameError);
        // 改名也没成：不动那个文件，只在内存里从头记，下次启动再试
        this.warn(`邻居簿读不了（${reason}），改名 ${bad} 也没成（${renameReason}）：文件留着没动，这次从头记`);
      }
    }
  }

  get(id: string): NeighborRecord | undefined {
    return this.records.get(id);
  }

  /** 熟人在前，其余按 lastMet 倒序 */
  list(): NeighborRecord[] {
    const byMet = (a: NeighborRecord, b: NeighborRecord) => b.lastMet - a.lastMet;
    const records = [...this.records.values()].sort(byMet);
    return [...records.filter((record) => record.friend), ...records.filter((record) => !record.friend)];
  }

  /** 见了一面：没记过的记下来，记过的更新名字和 lastMet、次数 +1 */
  met(id: string, names: { owner: string; pet: string }, kind: 'hosted' | 'visited', now: number): void {
    const owner = cleanName(names.owner);
    const pet = cleanName(names.pet);
    if (!owner || !pet) return;
    const record = this.records.get(id);
    if (record) {
      record.owner = owner;
      record.pet = pet;
      record[kind] += 1;
      record.lastMet = now;
    } else {
      // 满了先丢最久没见的非熟人；全是熟人（50 个）就不再记新的
      if (this.records.size >= NEIGHBORS_MAX) {
        const oldest = this.list()
          .filter((item) => !item.friend)
          .pop();
        if (!oldest) return;
        this.records.delete(oldest.id);
      }
      this.records.set(id, {
        id,
        owner,
        pet,
        friend: false,
        hosted: kind === 'hosted' ? 1 : 0,
        visited: kind === 'visited' ? 1 : 0,
        firstMet: now,
        lastMet: now,
        summary: '',
      });
    }
    this.save();
  }

  /**
   * 进门时用：先按「记这次之前」的记录算好这趟的上次见面备忘（没有就 null），再记下这次见面。
   * 整趟串门都用返回的这份数据，不能每句台词现读记录（那会读到这次自己：次数已 +1、lastMet 是刚刚）。
   */
  meet(id: string, names: { owner: string; pet: string }, kind: 'hosted' | 'visited', now: number): string | null {
    const before = memoryLine(this.records.get(id), now);
    this.met(id, names, kind, now);
    return before;
  }

  /** 记下这次见面的摘要；生成不了就不调这里（保留旧摘要） */
  setSummary(id: string, summary: string): void {
    const record = this.records.get(id);
    if (!record) return;
    const text = cleanText(summary, LINE_MAX);
    if (!text) return;
    record.summary = text;
    this.save();
  }

  setFriend(id: string, friend: boolean): void {
    const record = this.records.get(id);
    if (!record) return;
    record.friend = friend;
    this.save();
  }

  forget(id: string): void {
    if (this.records.delete(id)) this.save();
  }

  clear(): void {
    this.records.clear();
    this.save();
  }

  private save(): void {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ neighbors: this.list() }, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.path);
    } catch (error) {
      this.warn(`邻居簿存不下：${this.path}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
}

/** 客人走后这么久内，「串门」子菜单最上面放一项「回访 X 家」 */
export const REVISIT_MS = 2 * 3_600_000;

/** orderNeighbors 里用到的邻居形状（信标邻居 Neighbor 的子集，测试好造） */
export interface NeighborLike {
  id: string;
  owner: string;
}

/** 最近一位来家里做过客的客人（只记验证过身份的：见 features.ts 的 seeGuestOff） */
export interface LastGuest {
  id: string;
  /** 它走的时间 */
  at: number;
}

/**
 * 「串门」子菜单的排序与回访项（features.ts 接线）：
 * 熟人在前（内部也按 lastMet 倒序）、见过面的按 lastMet 倒序、陌生邻居按昵称排序；
 * 走了还没超过 REVISIT_MS 的那位客人，只要它还在邻居列表（信标）里，就作为回访项放在最上面（没验证过身份的压根不会记成 lastGuest），下面的列表里不再重复出现它。
 */
export function orderNeighbors<T extends NeighborLike>(
  neighbors: T[],
  book: { get(id: string): NeighborRecord | undefined },
  lastGuest: LastGuest | null,
  now: number,
): { revisit: T | null; list: T[] } {
  const record = (neighbor: T) => book.get(neighbor.id);
  const byLastMet = (a: T, b: T) => (record(b)?.lastMet ?? 0) - (record(a)?.lastMet ?? 0);
  const revisit =
    lastGuest && now - lastGuest.at <= REVISIT_MS
      ? (neighbors.find((neighbor) => neighbor.id === lastGuest.id) ?? null)
      : null;
  // 已经作为回访项的那位不再进列表：同一家不能在子菜单里出现两项
  const rest = revisit ? neighbors.filter((neighbor) => neighbor.id !== revisit.id) : neighbors;
  const friends = rest.filter((neighbor) => record(neighbor)?.friend === true).sort(byLastMet);
  const met = rest
    .filter((neighbor) => {
      const saved = record(neighbor);
      return saved !== undefined && saved.friend !== true;
    })
    .sort(byLastMet);
  const strangers = rest
    .filter((neighbor) => record(neighbor) === undefined)
    .sort((a, b) => a.owner.localeCompare(b.owner));
  return { revisit, list: [...friends, ...met, ...strangers] };
}

/**
 * 距今文案：隔 1 天以上按「N 天」（durationText 只到小时，别处在用，不改它）。
 */
function agoText(ms: number): string {
  const days = Math.floor(Math.max(0, ms) / 86_400_000);
  return days >= 1 ? `${days} 天` : durationText(ms);
}

/**
 * 拼进串门提示词的「上次见面」一句（guestPrompt / hostPrompt 的 memory）。
 * 没记录、还没写过摘要时返回 null（提示词里不提）。
 */
export function memoryLine(record: NeighborRecord | undefined, now: number): string | null {
  if (!record) return null;
  const met = record.hosted + record.visited;
  const when = `你们之前见过 ${met} 次，上次是 ${agoText(now - record.lastMet)}前`;
  return record.summary ? `${when}，上次聊了：「${record.summary}」。` : `${when}。`;
}

/**
 * 熟人来敲门要不要直接请进（features.ts 的 hostHandlers.knocked 用）：
 * 验证过身份（有 id）、确实是熟人、开了「熟人来敲门直接请进」、主人此刻在电脑前，四者同时满足才自动开门——
 * 没验证过的一律当陌生人等主人点头；没人看着，就不让两只宠物对着空屏幕调模型。
 * @param present 主人此刻在电脑前（tracker.snapshot()?.present）
 */
export function shouldAutoAdmit(
  book: { get(id: string): NeighborRecord | undefined },
  visitor: { id?: string },
  autoAdmitFriends: boolean,
  present: boolean | undefined,
): boolean {
  if (!visitor.id || !autoAdmitFriends || present !== true) return false;
  return book.get(visitor.id)?.friend === true;
}

/**
 * 这一位能不能和本机互相捎话（T7，features.ts 收发两个方向都用）：
 * 验过身份（做客时是主人家的应答签名、接待时是客人的敲门签名）、确实是熟人、开着「和熟人互相捎话」，
 * 三者同时满足才行——没验过身份的一律当陌生人，捎的话一句都不收。
 */
export function notesAllowed(
  book: { get(id: string): NeighborRecord | undefined },
  id: string | undefined,
  verified: boolean,
  notesEnabled: boolean,
): boolean {
  if (!id || !verified || !notesEnabled) return false;
  return book.get(id)?.friend === true;
}
