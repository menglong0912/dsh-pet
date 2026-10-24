/**
 * 局域网串门（网络这一半）：发现邻居、接待客人、出门做客时发的请求。只管协议与安全，
 * 不碰 Electron、不调模型；窗口与说话在 `features.ts` 里接线。
 *
 * 发现：允许别人来做客的桌宠每 BEACON_MS 往本机每块局域网网卡的广播地址发一条 UDP 信标（端口 BEACON_PORT），
 *   只带身份 id（每台电脑固定一对密钥，见 visit-identity.ts）、主人昵称、宠物名与接待端口；收到别人的信标就记成邻居，NEIGHBOR_TTL_MS 没再收到就忘掉。
 *   不接待客人时只听不发：别人看不到自己，自己照样能出门。
 * 接待：另开一个只处理串门协议的 HTTP 监听——127.0.0.1 上那个本机服务的接口一个也不放到局域网上：
 *   POST /v1/knock { owner, pet, id?, pub?, ts?, sig? }    敲门：挂着等主人在右键菜单里点「让进 / 不让进」，最多 KNOCK_WAIT_MS
 *                                    （带身份的客人另加签名四件套；应答也带上主人家的 id / pub / sig，见 visit-identity.ts）
 *   POST /v1/chat  { token, text }   客人说一句，回 { reply }（这边的宠物回的那句）
 *   POST /v1/note  { token, text }   客人捎话（它家主人写给这边的，只收熟人的，每趟最多 NOTE_MAX 条、
 *                                    两条隔 NOTE_GAP_MS；events 里的 note 事件捎回去是另一个方向）
 *   POST /v1/ping  { token }         客人每 PING_MS 报一次还在，回 { events }：这边攒下要告诉客人的事
 *                                    （这边宠物主动说的话、主人摸了它一下、一起玩什么、请它吃什么）；被请回家后回 reason: sent-home
 *   POST /v1/leave { token, text }   客人告辞（text 是告别的话，可空）
 *
 * 安全（对方发来的一律不可信）：
 *   - 只收私有网段 / 链路本地 / 本机来的连接；带 Origin 的一律拒绝（局域网里的网页不能借浏览器打进来）；
 *   - 请求体 ≤ MAX_BODY_BYTES；名字与台词去掉控制字符后截断（cleanText），只当纯文本显示；
 *   - 每次进门都要主人点头；同一时间只接待一位、只挂一个敲门；同一地址 KNOCK_COOLDOWN_MS 内只能敲一次；
 *   - 进门后发一次性令牌，后续请求要带令牌、且来自敲门的那个地址。
 * 主人的上下文（截图、前台应用、Claude 进度）不经过这里：features.ts 生成串门台词只用人设。
 *
 * macOS 15 起，发广播、主动连局域网地址要主人在系统弹框里允许「本地网络」；监听与接收单播不需要（Apple TN3179）。
 */
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { idOfPub, knockMessage, verifyWithPub, welcomeMessage } from './visit-identity';
import type { VisitIdentity } from './visit-identity';

/** 信标端口（7340 是插件路由前缀里的那个数） */
export const BEACON_PORT = 47340;
const BEACON_MS = 5_000;
const NEIGHBOR_TTL_MS = 20_000;
/** 敲门最多等主人这么久 */
export const KNOCK_WAIT_MS = 60_000;
const KNOCK_COOLDOWN_MS = 30_000;
/** 客人报平安的间隔 */
export const PING_MS = 5_000;
/** 客人这么久没动静就当它走了 */
const LOST_AFTER_MS = 30_000;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_BEACON_BYTES = 512;
/** 主人昵称、宠物名的长度上限（右键菜单项 ≤ 32 字，要拼进「不让 X 进来」） */
export const NAME_MAX = 12;
/** 一句台词的长度上限 */
export const LINE_MAX = 60;
/** 敲门签名里的时间戳允许和本机差多少（重放也是这个窗口） */
const KNOCK_TS_SKEW_MS = 120_000;
/** 防重放缓存里一条 (id, ts) 记多久、最多存几条 */
const REPLAY_MS = 120_000;
const REPLAY_MAX = 256;
/** 每趟每个方向最多捎几句话 */
export const NOTE_MAX = 5;
/** 捎话两条之间至少隔这么久 */
export const NOTE_GAP_MS = 10_000;

// 控制字符、零宽字符与双向文本控制符：换行会撑坏气泡，双向控制符能把显示顺序倒过来骗人
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 对方发来的文字：去掉控制字符、压掉多余空白、按字符截断；不是字符串就当空 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}

/** 对方的昵称、宠物名：同 cleanText，另把「/」换成全角——名字要拼进右键菜单项，半角「/」会被当成子菜单分隔 */
export function cleanName(value: unknown): string {
  return cleanText(value, NAME_MAX).replace(/\//g, '／');
}

// ---------- 发现 ----------

export interface Beacon {
  /** 串门身份 id（认出自己发的信标） */
  id: string;
  owner: string;
  pet: string;
  /** 接待端口 */
  port: number;
}

export interface Neighbor extends Beacon {
  address: string;
  seenAt: number;
}

const beaconSchema = z.object({
  app: z.literal('dsh-pet'),
  v: z.literal(1),
  id: z.string().min(8).max(64),
  owner: z.string(),
  pet: z.string(),
  port: z.number().int().min(1).max(65535),
});

export function encodeBeacon(beacon: Beacon): Buffer {
  return Buffer.from(JSON.stringify({ app: 'dsh-pet', v: 1, ...beacon }), 'utf8');
}

/** 解析一条信标；不是我们的、超长、字段不对或名字清理后为空 → null */
export function parseBeacon(raw: Buffer): Beacon | null {
  if (raw.length > MAX_BEACON_BYTES) return null;
  try {
    const beacon = beaconSchema.parse(JSON.parse(raw.toString('utf8')));
    const owner = cleanName(beacon.owner);
    const pet = cleanName(beacon.pet);
    return owner && pet ? { id: beacon.id, owner, pet, port: beacon.port } : null;
  } catch {
    return null;
  }
}

const ipv4ToInt = (address: string): number => address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
const intToIpv4 = (value: number): string => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');

/**
 * 本机每块 IPv4 局域网网卡的广播地址。只发 255.255.255.255 的话只走默认那块网卡，
 * 同时插着网线和连着 Wi-Fi 时另一边收不到（TN3179 建议在每块能广播的网卡上发）。
 * /31、/32（点对点、VPN 隧道）没有广播地址，跳过。
 */
export function broadcastAddresses(interfaces = networkInterfaces()): string[] {
  const result = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const mask = ipv4ToInt(item.netmask);
      if (mask >= 0xfffffffe) continue;
      result.add(intToIpv4(((ipv4ToInt(item.address) & mask) | ~mask) >>> 0));
    }
  }
  return [...result];
}

/** 私有网段 / 链路本地 / 运营商 NAT 段（Tailscale 用它）/ 本机：只收这些地址来的连接 */
export function isLanAddress(raw: string | undefined): boolean {
  const address = (raw ?? '').replace(/^::ffff:/, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return address === '::1';
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export interface NeighborhoodOptions {
  /** 串门身份 id（认出自己发的信标） */
  id: string;
  /**
   * 自己的信标内容（每次发时现取：昵称、宠物名改了下一条就是新的）；
   * null = 不接待客人，只听不发（别人看不到自己，自己照样能看到别人）
   */
  announce: () => Omit<Beacon, 'id'> | null;
  log: (message: string) => void;
  /** 监听的信标端口（测试用 0 = 随机） */
  port?: number;
  /** 信标发往哪些地址（默认每块网卡的广播地址 + BEACON_PORT） */
  targets?: () => Array<{ address: string; port: number }>;
  now?: () => number;
}

export class Neighborhood {
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSendError = '';
  private readonly neighbors = new Map<string, Neighbor>();
  private readonly options: NeighborhoodOptions;

  constructor(options: NeighborhoodOptions) {
    this.options = options;
  }

  /** 绑定信标端口并开始发；端口被占等错误直接抛给调用方 */
  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.options.port ?? BEACON_PORT, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.setBroadcast(true);
    socket.on('message', (raw, info) => this.receive(raw, info.address));
    socket.on('error', (error) => this.options.log(`串门：信标出错：${error.message}`));
    this.socket = socket;
    this.send();
    this.timer = setInterval(() => this.send(), BEACON_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.neighbors.clear();
  }

  /** 实际绑定的信标端口（测试用） */
  port(): number {
    return this.socket?.address().port ?? 0;
  }

  /** 最近 NEIGHBOR_TTL_MS 内收到过信标的邻居，按昵称排序 */
  list(): Neighbor[] {
    const now = this.now();
    for (const [id, neighbor] of this.neighbors) {
      if (now - neighbor.seenAt > NEIGHBOR_TTL_MS) this.neighbors.delete(id);
    }
    return [...this.neighbors.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.pet.localeCompare(b.pet));
  }

  get(id: string): Neighbor | undefined {
    return this.list().find((neighbor) => neighbor.id === id);
  }

  private send(): void {
    const socket = this.socket;
    const self = this.options.announce();
    if (!socket || !self) return;
    const payload = encodeBeacon({ id: this.options.id, ...self });
    const targets = this.options.targets?.() ?? broadcastAddresses().map((address) => ({ address, port: BEACON_PORT }));
    for (const target of targets) {
      socket.send(payload, target.port, target.address, (error) => {
        // 没授权「本地网络」时每一条都会失败：同样的错只记一次，恢复后再出错再记
        const message = error ? `${target.address}：${error.message}` : '';
        if (message && message !== this.lastSendError) this.options.log(`串门：信标发不出去 ${message}`);
        this.lastSendError = message;
      });
    }
  }

  private receive(raw: Buffer, address: string): void {
    const beacon = parseBeacon(raw);
    if (!beacon || beacon.id === this.options.id) return;
    this.neighbors.set(beacon.id, { ...beacon, address, seenAt: this.now() });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

// ---------- 接待 ----------

export interface Visitor {
  owner: string;
  pet: string;
  address: string;
  /** 敲门签名验证通过时的客人身份 id（visit-identity.ts）；没验证上（旧版本、签名不对）就没有 */
  id?: string;
}

export type KnockFailure = 'busy' | 'too-soon' | 'declined' | 'no-answer';

/** 这边要告诉客人的事（客人报平安时捎过去）：这边宠物主动说了句话 / 主人摸了客人一下 / 一起玩什么 / 请它吃什么 / 捎给客人主人的话 */
export type HostEvent =
  | { type: 'line'; text: string }
  | { type: 'poke' }
  | { type: 'play'; what: string }
  | { type: 'gift'; what: string }
  | { type: 'note'; text: string };
/** 一次最多捎几件事（攒多了丢最早的） */
const EVENTS_MAX = 8;

export interface HostHandlers {
  /** 现在能不能接待（自己的宠物出门在外、正在敲别人家的门时不行） */
  canHost(): boolean;
  /** 有人敲门了：等主人 answer() */
  knocked(visitor: Visitor): void;
  /** 敲门没等到答复就结束了：no-answer = 主人一直没点；gone = 对方不等了 */
  knockEnded(visitor: Visitor, reason: 'no-answer' | 'gone'): void;
  /** 客人说了一句，返回这边宠物回的话 */
  line(visitor: Visitor, text: string): Promise<string>;
  /** 客人捎来的话（它家主人写给这边的）：返回收不收——只收自己熟人的（T7，features.ts 查邻居簿） */
  note(visitor: Visitor, text: string): boolean;
  /** 客人走了：leave = 告辞（text 是告别的话，可空）；lost = 太久没动静 */
  left(visitor: Visitor, reason: 'leave' | 'lost', text: string): void;
}

interface Session {
  visitor: Visitor;
  token: string;
  lastSeen: number;
  /** 等客人下次报平安时捎过去的事 */
  outbox: HostEvent[];
  /** 这趟客人已经捎来几句话、上一条是什么时候（限额在接待端卡） */
  noteCount: number;
  lastNoteAt: number;
}

interface PendingKnock {
  visitor: Visitor;
  finish: (answer: boolean | 'no-answer' | 'gone') => void;
}

export interface HostOptions {
  log: (message: string) => void;
  /** 本机身份：有它才验客人的敲门签名、才给进门应答签名（旧对端 / 没身份时都当陌生人） */
  identity?: VisitIdentity | null;
  now?: () => number;
  knockWaitMs?: number;
  lostAfterMs?: number;
}

export class VisitHost {
  private server: Server | null = null;
  private session: Session | null = null;
  private pending: PendingKnock | null = null;
  /** 被主人请回家的那位的令牌：它下一次来报平安时告诉它 sent-home */
  private sentHomeToken: string | null = null;
  private lostTimer: ReturnType<typeof setInterval> | null = null;
  private readonly knockedAt = new Map<string, number>();
  /** 见过的 (客人 id, ts)：防有人把抄来的敲门请求原样再发一遍 */
  private readonly knocksSeen = new Map<string, number>();
  /** 接待监听的端口（验签名、给应答签名都要拼进内容） */
  private listenPort = 0;
  private readonly handlers: HostHandlers;
  private readonly options: HostOptions;

  constructor(handlers: HostHandlers, options: HostOptions) {
    this.handlers = handlers;
    this.options = options;
  }

  /**
   * 开始监听（默认所有网卡、随机端口），返回端口
   * @param host 测试用 127.0.0.1
   */
  async listen(host = '0.0.0.0'): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.options.log(`串门：接待出错：${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) send(res, 500, { ok: false, reason: 'error' });
        else res.end();
      });
    });
    // 只限「收完请求」的时间；敲门的应答要挂着等主人，不受它限制
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.listenPort = (server.address() as AddressInfo).port;
    this.lostTimer = setInterval(() => this.checkLost(), PING_MS);
    return this.listenPort;
  }

  async close(): Promise<void> {
    if (this.lostTimer !== null) clearInterval(this.lostTimer);
    this.lostTimer = null;
    this.pending?.finish('gone');
    this.session = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 正在敲门、等主人答复的那位 */
  knocking(): Visitor | null {
    return this.pending?.visitor ?? null;
  }

  /** 正在家里做客的那位 */
  guest(): Visitor | null {
    return this.session?.visitor ?? null;
  }

  /** 主人答复敲门；返回敲门的那位（没人在敲时 null） */
  answer(accept: boolean): Visitor | null {
    const pending = this.pending;
    pending?.finish(accept);
    return pending?.visitor ?? null;
  }

  /** 攒一件事，客人下次报平安时捎过去；没有客人时 false */
  tell(event: HostEvent): boolean {
    const session = this.session;
    if (!session) return false;
    session.outbox.push(event);
    if (session.outbox.length > EVENTS_MAX) session.outbox.shift();
    return true;
  }

  /** 主人请客人回家；返回那位（没有客人时 null） */
  sendHome(): Visitor | null {
    const session = this.session;
    if (!session) return null;
    this.session = null;
    this.sentHomeToken = session.token;
    return session.visitor;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (!isLanAddress(address) || req.headers.origin !== undefined) {
      return send(res, 403, { ok: false, reason: 'forbidden' });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method' });
    const body = await readJson(req);
    if (body === undefined) return send(res, 400, { ok: false, reason: 'bad-request' });
    const path = new URL(req.url ?? '/', 'http://visit').pathname;
    if (path === '/v1/knock') {
      // 验签名要用「本机收到这个连接的地址」：客人按它拨的地址签，两边得是同一个
      const local = (req.socket.localAddress ?? '').replace(/^::ffff:/, '');
      return this.knock(address, local, body, res);
    }

    const session = this.session;
    if (!session || body.token !== session.token || address !== session.visitor.address) {
      const reason = typeof body.token === 'string' && body.token === this.sentHomeToken ? 'sent-home' : 'not-visiting';
      return send(res, 200, { ok: false, reason });
    }
    session.lastSeen = this.now();
    switch (path) {
      case '/v1/ping':
        return send(res, 200, { ok: true, events: session.outbox.splice(0) });
      case '/v1/chat': {
        const text = cleanText(body.text, LINE_MAX);
        if (!text) return send(res, 400, { ok: false, reason: 'bad-request' });
        const reply = await this.handlers.line(session.visitor, text).catch((error: unknown) => {
          this.options.log(`串门：回话失败：${error instanceof Error ? error.message : String(error)}`);
          return '';
        });
        return send(res, 200, { ok: true, reply: cleanText(reply, LINE_MAX) });
      }
      case '/v1/note': {
        const text = cleanText(body.text, LINE_MAX);
        if (!text) return send(res, 400, { ok: false, reason: 'bad-request' });
        // 先卡限额（纯协议层），再问这边收不收（features.ts 查邻居簿）；收下的才算数
        const now = this.now();
        if (session.noteCount >= NOTE_MAX || (session.noteCount > 0 && now - session.lastNoteAt < NOTE_GAP_MS))
          return send(res, 200, { ok: false, reason: 'too-many' });
        if (!this.handlers.note(session.visitor, text)) return send(res, 200, { ok: false, reason: 'not-friend' });
        session.noteCount += 1;
        session.lastNoteAt = now;
        return send(res, 200, { ok: true });
      }
      case '/v1/leave':
        this.session = null;
        this.handlers.left(session.visitor, 'leave', cleanText(body.text, LINE_MAX));
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { ok: false, reason: 'not-found' });
    }
  }

  private async knock(
    address: string,
    local: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const owner = cleanName(body.owner);
    const pet = cleanName(body.pet);
    if (!owner || !pet) return send(res, 400, { ok: false, reason: 'bad-request' });
    if (this.session || this.pending || !this.handlers.canHost()) return send(res, 200, { ok: false, reason: 'busy' });
    const now = this.now();
    const last = this.knockedAt.get(address);
    if (last !== undefined && now - last < KNOCK_COOLDOWN_MS) return send(res, 200, { ok: false, reason: 'too-soon' });
    this.knockedAt.set(address, now);

    const visitor: Visitor = { owner, pet, address };
    const verifiedId = this.verifyGuest(body, owner, pet, local, now);
    if (verifiedId) visitor.id = verifiedId;
    const answer = await new Promise<boolean | 'no-answer' | 'gone'>((resolve) => {
      const pending: PendingKnock = {
        visitor,
        finish: (result) => {
          if (this.pending !== pending) return;
          this.pending = null;
          clearTimeout(timer);
          resolve(result);
        },
      };
      const timer = setTimeout(() => pending.finish('no-answer'), this.options.knockWaitMs ?? KNOCK_WAIT_MS);
      // 对方等不及断开了：撤掉这次敲门（应答写完后也会触发 close，那时 pending 已清，finish 不再生效）
      res.once('close', () => pending.finish('gone'));
      this.pending = pending;
      this.handlers.knocked(visitor);
    });
    if (answer === 'no-answer' || answer === 'gone') {
      this.handlers.knockEnded(visitor, answer);
      if (answer === 'no-answer') send(res, 200, { ok: false, reason: 'no-answer' });
      return;
    }
    if (!answer) return send(res, 200, { ok: false, reason: 'declined' });
    const token = randomBytes(16).toString('hex');
    this.session = { visitor, token, lastSeen: this.now(), outbox: [], noteCount: 0, lastNoteAt: 0 };
    this.sentHomeToken = null;
    // 给验明正身的客人签应答：客人拿它认下这家人（T4 记邻居、T7 捎话都以这个为准）
    const identity = this.options.identity;
    const guestId = visitor.id;
    if (identity && guestId) {
      const sig = identity.sign(welcomeMessage({ guestId, address: local, port: this.listenPort, token }));
      return send(res, 200, { ok: true, token, id: identity.id, pub: identity.pub, sig });
    }
    send(res, 200, { ok: true, token });
  }

  /**
   * 验客人的敲门签名。任何一步不过都**不拒绝**，只当陌生人（visitor 不带 id，照旧等主人点头），
   * 原因记进日志；全部通过返回客人的身份 id。
   */
  private verifyGuest(
    body: Record<string, unknown>,
    owner: string,
    pet: string,
    local: string,
    now: number,
  ): string | null {
    const stranger = (reason: string): null => {
      this.options.log(`串门：客人身份没验证上（${reason}），当陌生人`);
      return null;
    };
    const { id, pub, ts, sig } = body;
    if (
      typeof id !== 'string' ||
      typeof pub !== 'string' ||
      typeof ts !== 'string' ||
      typeof sig !== 'string' ||
      id.length > 32 ||
      pub.length > 100 ||
      sig.length > 100 ||
      !/^\d{1,16}$/.test(ts)
    ) {
      return stranger('字段不对');
    }
    const pubId = idOfPub(pub);
    if (!pubId || pubId !== id) return stranger('公钥对不上 id');
    const at = Number(ts);
    if (Math.abs(now - at) > KNOCK_TS_SKEW_MS) return stranger('时间戳太旧');
    // 防重放：同一个 (id, ts) 只认第一次。先记再验签名：签名错的也不许换一张签名重试同一个 ts
    for (const [seen, seenAt] of this.knocksSeen) if (now - seenAt > REPLAY_MS) this.knocksSeen.delete(seen);
    const replayKey = `${id}/${ts}`;
    if (this.knocksSeen.has(replayKey)) return stranger('重放');
    this.knocksSeen.set(replayKey, now);
    while (this.knocksSeen.size > REPLAY_MAX) this.knocksSeen.delete(this.knocksSeen.keys().next().value as string);
    const identity = this.options.identity;
    if (!identity) return stranger('本机没有身份');
    const message = knockMessage({ hostId: identity.id, address: local, port: this.listenPort, ts: at, owner, pet });
    if (!verifyWithPub(pub, message, sig)) return stranger('签名不对');
    return id;
  }

  private checkLost(): void {
    const session = this.session;
    if (!session || this.now() - session.lastSeen <= (this.options.lostAfterMs ?? LOST_AFTER_MS)) return;
    this.session = null;
    this.handlers.left(session.visitor, 'lost', '');
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

// ---------- 出门做客（客人这一侧的请求） ----------

export interface HostAddress {
  address: string;
  port: number;
}

async function post(
  host: HostAddress,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://${host.address}:${host.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('应答太大');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('应答不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

const KNOCK_FAILURES: readonly string[] = ['busy', 'too-soon', 'declined', 'no-answer'];

export type KnockAnswer = { ok: true; token: string; verified: boolean } | { ok: false; reason: KnockFailure };

/**
 * 敲门：挂着等对方主人答复；连不上时抛错。
 * 带上自家身份（和信标里的主人家的 id）时给敲门签名，并验应答里主人家的签名：
 * 对上了 verified = true；旧对端不带签名时照常进门，只是 verified = false。
 */
export async function knockOn(
  host: HostAddress,
  me: { owner: string; pet: string },
  identity?: VisitIdentity | null,
  hostId?: string | null,
): Promise<KnockAnswer> {
  const body: Record<string, unknown> = { ...me };
  if (identity && hostId) {
    const ts = Date.now();
    body.id = identity.id;
    body.pub = identity.pub;
    body.ts = String(ts);
    body.sig = identity.sign(
      knockMessage({ hostId, address: host.address, port: host.port, ts, owner: me.owner, pet: me.pet }),
    );
  }
  const result = await post(host, '/v1/knock', body, KNOCK_WAIT_MS + 10_000);
  if (result.ok === true && typeof result.token === 'string' && /^[0-9a-f]{32}$/.test(result.token)) {
    const { token } = result;
    // 应答签名也按「客人拨的地址」拼：假信标把请求转发给别家，这里的地址就对不上。
    // 公钥还得真是信标里那个 id 的：id 是明文广播的，谁都能往应答里填，pub 和签名可以是自己的钥匙
    const welcome =
      identity &&
      hostId &&
      result.id === hostId &&
      typeof result.pub === 'string' &&
      typeof result.sig === 'string' &&
      idOfPub(result.pub) === hostId
        ? verifyWithPub(
            result.pub,
            welcomeMessage({ guestId: identity.id, address: host.address, port: host.port, token }),
            result.sig,
          )
        : false;
    return { ok: true, token, verified: welcome };
  }
  const reason =
    typeof result.reason === 'string' && KNOCK_FAILURES.includes(result.reason) ? result.reason : 'no-answer';
  return { ok: false, reason: reason as KnockFailure };
}

export type TripReply =
  { ok: true; reply: string; events: HostEvent[] } | { ok: false; reason: 'sent-home' | 'not-visiting' };

/** 对方捎来的事：不认识的、字段不对的丢掉，文字照样清理截断；旧版本不带 events 时当没有 */
export function parseEvents(raw: unknown): HostEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: HostEvent[] = [];
  for (const item of raw.slice(0, EVENTS_MAX)) {
    const event = item as Record<string, unknown> | null;
    if (event?.type === 'poke') events.push({ type: 'poke' });
    const text = cleanText(event?.text, LINE_MAX);
    if (event?.type === 'line' && text) events.push({ type: 'line', text });
    // 捎给客人主人的话：只当文本显示，不进任何提示词（features.ts 的 onHostEvent）
    if (event?.type === 'note' && text) events.push({ type: 'note', text });
    const what = cleanText(event?.what, NAME_MAX);
    if (event?.type === 'play' && what) events.push({ type: 'play', what });
    if (event?.type === 'gift' && what) events.push({ type: 'gift', what });
  }
  return events;
}

/**
 * 做客期间的请求（chat / ping / leave）；连不上时抛错
 * @returns ok:false = 对方已经不当我是客人了（sent-home = 被请回家），该回家了
 */
export async function tripRequest(
  host: HostAddress,
  path: '/v1/chat' | '/v1/ping' | '/v1/leave',
  body: { token: string; text?: string },
): Promise<TripReply> {
  // 说一句要等对方模型回话，给足时间；报平安与告辞要快
  const result = await post(host, path, body, path === '/v1/chat' ? 60_000 : 5_000);
  if (result.ok === true)
    return { ok: true, reply: cleanText(result.reply, LINE_MAX), events: parseEvents(result.events) };
  return { ok: false, reason: result.reason === 'sent-home' ? 'sent-home' : 'not-visiting' };
}

export type NoteReply =
  { ok: true } | { ok: false; reason: 'not-friend' | 'too-many' | 'sent-home' | 'not-visiting' | 'old-host' };

/**
 * 捎话（客人 → 主人家）；连不上时抛错。
 * 旧主人家没有这条路径，回的是 404 + not-found：如实映射成 old-host，客人那边好说「对方的版本太旧」。
 */
export async function sendNote(host: HostAddress, body: { token: string; text: string }): Promise<NoteReply> {
  const result = await post(host, '/v1/note', body, 5_000);
  if (result.ok === true) return { ok: true };
  if (result.reason === 'not-friend' || result.reason === 'too-many' || result.reason === 'sent-home')
    return { ok: false, reason: result.reason };
  return { ok: false, reason: result.reason === 'not-found' ? 'old-host' : 'not-visiting' };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  // 事件式读取（与 app-routes.ts 同法）：tsconfig 的 lib 不认 Readable 的 async iterator
  const chunks: Buffer[] = [];
  let size = 0;
  const complete = await new Promise<boolean>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(false);
      } else chunks.push(Buffer.from(chunk));
    });
    req.once('end', () => resolve(true));
    req.once('error', reject);
  });
  if (!complete) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
