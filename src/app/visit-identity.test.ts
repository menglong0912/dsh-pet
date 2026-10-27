import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  duelAcceptMessage,
  duelMessage,
  generateVisitIdentity,
  idOfPub,
  knockMessage,
  loadVisitIdentity,
  verifyWithPub,
  welcomeMessage,
} from './visit-identity';

const warnText = (logs: string[]) => (message: string) => logs.push(message);

test('an identity survives reload, and its pub checks out as Ed25519 SPKI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-identity-'));
  try {
    const path = join(dir, 'visit-identity.json');
    const warnings: string[] = [];
    const first = loadVisitIdentity(path, warnText(warnings));
    const again = loadVisitIdentity(path, warnText(warnings));
    assert.deepEqual(warnings, []);
    assert.equal(again.id, first.id);
    assert.equal(again.pub, first.pub);
    assert.match(first.id, /^[0-9a-f]{32}$/);
    assert.equal(first.pub.length, 60);
    assert.equal(idOfPub(first.pub), first.id);

    // 两个不同的身份不会撞 id
    assert.notEqual(generateVisitIdentity().id, generateVisitIdentity().id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the identity file is 0600 and holds a v1 PKCS8 PEM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-identity-'));
  try {
    const path = join(dir, 'visit-identity.json');
    const identity = loadVisitIdentity(path, warnText([]));
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { v: number; key: string };
    assert.equal(saved.v, 1);
    assert.match(saved.key, /^-----BEGIN PRIVATE KEY-----/);
    // 换个身份文件签名验证不过：存的确实是这把私钥
    assert.equal(verifyWithPub(identity.pub, 'dsh-pet/test', identity.sign('dsh-pet/test')), true);
    // Windows 没有 POSIX 权限位：mode 恒报 0o666（只读文件 0o444），0600 在那里无从谈起
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken identity file is renamed and replaced, with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-identity-'));
  try {
    const path = join(dir, 'visit-identity.json');
    writeFileSync(path, '不是 JSON');
    const warnings: string[] = [];
    const identity = loadVisitIdentity(path, warnText(warnings));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /身份文件读不了/);
    assert.match(
      readdirSync(dir).find((name) => name.startsWith('visit-identity.json.bad-')) as string,
      /^visit-identity\.json\.bad-\d+$/,
    );
    // 换上的新身份能用，重读还是它
    assert.equal(loadVisitIdentity(path, warnText([])).id, identity.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idOfPub only accepts Ed25519 SPKI base64, and signatures verify only for the right key and content', () => {
  const a = generateVisitIdentity();
  const b = generateVisitIdentity();
  assert.equal(idOfPub('不是 base64'), null);
  assert.equal(idOfPub(42), null);
  assert.equal(idOfPub('AAAA'), null);
  assert.equal(idOfPub(`${a.pub}=`), null, 'base64 有噪音');
  assert.equal(idOfPub(a.pub), a.id);

  const message = knockMessage({
    hostId: a.id,
    address: '192.168.1.9',
    port: 51234,
    ts: 1_777_000_000_000,
    owner: '小王',
    pet: '小鱼',
  });
  assert.equal(message, `dsh-pet/knock/v1\n${a.id}\n192.168.1.9:51234\n1777000000000\n小王\n小鱼`);
  assert.equal(
    welcomeMessage({ guestId: a.id, address: '127.0.0.1', port: 41234, token: '0f'.repeat(16) }),
    `dsh-pet/welcome/v1\n${a.id}\n127.0.0.1:41234\n${'0f'.repeat(16)}`,
  );
  assert.equal(verifyWithPub(a.pub, message, a.sign(message)), true);
  assert.equal(verifyWithPub(b.pub, message, a.sign(message)), false, '别人的公钥');
  assert.equal(verifyWithPub(a.pub, `${message}!`, a.sign(message)), false, '内容被改');
  assert.equal(verifyWithPub(a.pub, message, 'AAA'), false, '签名是坏的');
});

test('duel 与 duel-accept 的签名内容各拼各的，敲门的签名挪不过来用', () => {
  const a = generateVisitIdentity();
  const b = generateVisitIdentity();
  const commit = 'c'.repeat(64);
  const duel = duelMessage({
    hostId: a.id,
    address: '192.168.1.9',
    port: 51234,
    ts: 1_777_000_000_000,
    owner: '小王',
    pet: '小鱼',
    commit,
  });
  assert.equal(duel, `dsh-pet/duel/v1\n${a.id}\n192.168.1.9:51234\n1777000000000\n小王\n小鱼\n${commit}`);
  assert.equal(
    duelAcceptMessage({ challengerId: a.id, address: '127.0.0.1', port: 41234, token: '0f'.repeat(16) }),
    `dsh-pet/duel-accept/v1\n${a.id}\n127.0.0.1:41234\n${'0f'.repeat(16)}`,
  );
  assert.equal(verifyWithPub(a.pub, duel, a.sign(duel)), true);
  assert.equal(verifyWithPub(b.pub, duel, a.sign(duel)), false, '别人的公钥');
  assert.equal(verifyWithPub(a.pub, `${duel}!`, a.sign(duel)), false, '内容被改');
  // 前缀不同、还多一段承诺：拿着敲门签名去冒充 duel 验不过
  const knock = knockMessage({
    hostId: a.id,
    address: '192.168.1.9',
    port: 51234,
    ts: 1_777_000_000_000,
    owner: '小王',
    pet: '小鱼',
  });
  assert.notEqual(duel, knock);
  assert.equal(verifyWithPub(a.pub, duel, a.sign(knock)), false, '敲门的签名挪不过来');
  // 反过来也不行：duel 签名里多了承诺，验敲门同样不过
  assert.equal(verifyWithPub(a.pub, knock, a.sign(duel)), false);
});
