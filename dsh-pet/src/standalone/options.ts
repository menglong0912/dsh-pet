/**
 * 独立应用的配置路径推导（纯逻辑，零 I/O —— 便于 node:test 直接单测）。
 *
 * `src/host/index.ts` 是唯一事实来源，这里是它的**只读镜像**；`options.test.ts` 用宿主自己的
 * `GET /config/meta`（由 `createPetHost` 注册的真实路由）钉住两者一致，镜像一旦漂移测试就红。
 */
import { join } from 'node:path';

import type { ConfigPaths } from '../host/config';

/**
 * 配置路径集（`src/host/index.ts` 那份推导的只读镜像）。
 * @param root 插件包根目录（构建产物里 = 包根；源码形态下 = `src/`）
 * @param home DSH_HOME
 */
export function configPathsFor(root: string, home: string): ConfigPaths {
  const userRoot = join(home, 'dsh-pet');
  return {
    defaultFile: join(root, 'assets', 'config.jsonc'),
    userFile: join(userRoot, 'main-config.jsonc'),
    legacyUserFile: join(userRoot, 'main-config.json'),
    petDir: join(userRoot, 'pet'),
  };
}
