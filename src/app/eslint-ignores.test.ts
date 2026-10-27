/**
 * 仓库 lint 配置的契约（回归）：workflow 会话会在包目录下落 `.zcode/`（运行产物，git 已忽略，
 * 里面是临时生成的 .mjs 脚本）。它不在 eslint 的全局忽略里时，`npm run lint`（`eslint .`）会把
 * 产物脚本当代码 lint，门就红了——2026-10-25 实际发生过（no-undef / no-unused-expressions 一堆）。
 * 这里用 eslint 自己的公开 API 钉住行为本身，而不是只对配置文件做字符串匹配。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('eslint 的全局忽略盖住 .zcode（workflow 会话的运行产物目录），仓库代码照常要 lint', async () => {
  const eslint = new ESLint({ cwd: packageRoot });
  // 产物路径不必真实存在：isPathIgnored 按路径算配置
  assert.equal(
    await eslint.isPathIgnored(join('.zcode', 'workflow-runs', 'dwfrun-example.mjs')),
    true,
    '.zcode 里的产物脚本应当被忽略',
  );
  assert.equal(await eslint.isPathIgnored(join('.zcode', 'workflow-drafts', 'draft.ts')), true);
  // 反向护栏：不能为了治产物顺手把仓库代码也忽略了
  assert.equal(await eslint.isPathIgnored(join('src', 'app', 'features.ts')), false, '仓库代码照常要 lint');
  assert.equal(await eslint.isPathIgnored(join('eslint.config.js')), false);
});
