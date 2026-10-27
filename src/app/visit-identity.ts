/**
 * 串门身份：每台电脑一对 Ed25519 密钥，重启不变。信标里的名字和 id 都是明文广播，谁都能抄，
 * 所以「还是刚才那位」要靠签名说话——客人在敲门请求里签，应答由主人家签（visit.ts 里验）。
 *
 * 存放：$DSH_HOME/dsh-pet/visit-identity.json，权限 0600，内容 { "v": 1, "key": "<PKCS8 PEM>" }。
 *   不放进钥匙串，因为会弹授权框。文件读不了或内容坏了 → 把原文件改名为 .bad-<时间>、明确 warn，
 *   再生成新的（不静默覆盖）；文件不存在 → 直接生成。改名也失败（文件被占着等）→ 文件不动，
 *   只在内存里换一对新的，下次启动再试。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * 一台电脑的串门身份。
 *   id = 公钥 SPKI DER 的 sha256，取前 32 个十六进制字符（正好当信标 / 敲门里的 id 用）；
 *   pub = SPKI DER 的 base64（44 字节 DER，60 字符）。
 * 私钥不出去：外面只拿到 sign(message)。
 */
export interface VisitIdentity {
  id: string;
  pub: string;
  /** 给一段签名内容签名，返回 base64 */
  sign(message: string): string;
}

/** Ed25519 公钥的 SPKI DER：12 字节固定头 + 32 字节原始公钥，共 44 字节 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function identityOf(privateKey: KeyObject): VisitIdentity {
  // 公钥（SPKI DER）从私钥里导出来；id 与 pub 都是它
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    id: createHash('sha256').update(der).digest('hex').slice(0, 32),
    pub: der.toString('base64'),
    sign: (message: string) => cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
}

/** 生成一对新的密钥（写文件在 loadVisitIdentity 里） */
export function generateVisitIdentity(): VisitIdentity {
  return identityOf(generateKeyPairSync('ed25519').privateKey);
}

/** 身份文件的内容：只有这一对密钥的 PKCS8 PEM */
const fileOf = (privateKey: KeyObject): string =>
  JSON.stringify({ v: 1, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });

/**
 * 读取（没有就生成并写好）身份文件；坏文件先改名再换新的，不静默覆盖。
 * @param path 身份文件
 * @param warn 文件坏了要改名时的告警出口
 */
export function loadVisitIdentity(path: string, warn: (message: string) => void): VisitIdentity {
  if (existsSync(path)) {
    try {
      const saved: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const key = (saved as { v?: unknown; key?: unknown })?.key;
      if ((saved as { v?: unknown })?.v !== 1 || typeof key !== 'string' || !key) throw new Error('内容不对');
      // 别的算法 / 不是 PEM 的内容会让 createPrivateKey 抛错
      return identityOf(createPrivateKey(key));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const bad = `${path}.bad-${Date.now()}`;
      try {
        renameSync(path, bad);
        warn(`身份文件读不了（${reason}），已改名 ${bad}，换了一对新密钥（别的电脑要重新认这台电脑了）`);
      } catch (renameError) {
        const renameReason = renameError instanceof Error ? renameError.message : String(renameError);
        // 改名也没成：不动那个文件（不许静默覆盖），只在内存里换一对新的，下次启动再试
        warn(
          `身份文件读不了（${reason}），改名 ${bad} 也没成（${renameReason}）：这次只在内存里换一对新密钥，文件留着没动`,
        );
        return generateVisitIdentity();
      }
    }
  }
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  writeFileSync(path, fileOf(privateKey), { mode: 0o600 });
  // 显式 chmod：mode 只在新建文件时全生效，改过的文件（上面那条路）也要保证是 0600
  chmodSync(path, 0o600);
  return identityOf(privateKey);
}

/** 重置身份（T5 设置页的按钮用）：把旧文件挪开，下次 loadVisitIdentity 会生成新的 */
export function resetVisitIdentity(path: string): void {
  if (existsSync(path)) renameSync(path, `${path}.old-${Date.now()}`);
}

/**
 * 校验一段公钥确实是 Ed25519 的 SPKI DER（base64），是就返回它的身份 id，不是返回 null。
 * 验客人的公钥、验应答里主人家的公钥都走这里：别的算法、坏 base64 一律不认。
 */
export function idOfPub(pub: unknown): string | null {
  if (typeof pub !== 'string' || pub.length > 100) return null;
  const der = Buffer.from(pub, 'base64');
  // base64 有噪音（多打一个字符也能解出来）要挡掉：解出来再编回去得是原文
  if (der.toString('base64') !== pub || der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) {
    return null;
  }
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/** 用对方的公钥验一段签名内容的签名；公钥不对、签名不对都 false */
export function verifyWithPub(pub: string, message: string, sig: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(message, 'utf8'),
      createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}

// ---------- 两种签名内容的拼装（字段之间用 \n 连接） ----------

/** 敲门（客人签）：<主人家 id，来自信标> <客人拨的地址>:<端口> <ts，毫秒> <owner> <pet> */
export function knockMessage(input: {
  hostId: string;
  address: string;
  port: number;
  ts: number;
  owner: string;
  pet: string;
}): string {
  return [
    'dsh-pet/knock/v1',
    input.hostId,
    `${input.address}:${input.port}`,
    String(input.ts),
    input.owner,
    input.pet,
  ].join('\n');
}

/** 进门应答（主人家签）：<客人 id> <本机收到这个连接的地址>:<接待端口> <token> */
export function welcomeMessage(input: { guestId: string; address: string; port: number; token: string }): string {
  return ['dsh-pet/welcome/v1', input.guestId, `${input.address}:${input.port}`, input.token].join('\n');
}

/**
 * 隔空切磋的挑战（挑战方签，X15）：<应战方 id> <挑战方拨的地址>:<端口> <ts> <owner> <pet> <commit>。
 * 承诺签在里面，别人改不了；前缀和敲门不同，敲门的签名挪不过来用。
 */
export function duelMessage(input: {
  hostId: string;
  address: string;
  port: number;
  ts: number;
  owner: string;
  pet: string;
  commit: string;
}): string {
  return [
    'dsh-pet/duel/v1',
    input.hostId,
    `${input.address}:${input.port}`,
    String(input.ts),
    input.owner,
    input.pet,
    input.commit,
  ].join('\n');
}

/** 隔空切磋的应答（应战方签）：<挑战方 id> <本机收到这个连接的地址>:<接待端口> <token>（口径同进门应答） */
export function duelAcceptMessage(input: {
  challengerId: string;
  address: string;
  port: number;
  token: string;
}): string {
  return ['dsh-pet/duel-accept/v1', input.challengerId, `${input.address}:${input.port}`, input.token].join('\n');
}
