/**
 * 配置路径推导的单测（纯逻辑，零 I/O）。
 *
 * 为什么单独有这一层：独立应用没有 DSH 的启动器兜底 —— 配置路径推导错了会表现为"改了配置没生效"。
 * 镜像的漂移由 integration.test.ts 用宿主自己的 GET /config/meta 钉住。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { configPathsFor } from './options.ts';

describe('configPathsFor —— 配置路径推导（host/index.ts 那份的镜像）', () => {
  const paths = configPathsFor('/pkg', '/home/.dsh');

  test('内置默认 / 用户主配置 / 旧版回落 / 文件宠物目录', () => {
    assert.deepEqual(paths, {
      defaultFile: join('/pkg', 'assets', 'config.jsonc'),
      userFile: join('/home/.dsh', 'dsh-pet', 'main-config.jsonc'),
      legacyUserFile: join('/home/.dsh', 'dsh-pet', 'main-config.json'),
      petDir: join('/home/.dsh', 'dsh-pet', 'pet'),
    });
  });
});
