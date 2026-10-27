// tsdown 配置（src → lib 产物）
//
// 只有一个入口：独立应用（app → lib/app.js）—— 一个 Electron 进程里跑「本机服务 + 宿主代码 + 桌面窗口」。
// 宿主半边的模块图静态 import 了三个只在 DSH 里存在的包，产物要跑在**没有 DSH** 的环境里，
// 因此用 alias 把它们换成本地替身（src/standalone/shims/*）：替身只做 "转调插件自己的同口径实现"
// 或 "明确降级"，没有任何生成/网络逻辑（细节见各文件头）。其余 @deepseek-ai/* 仍按外部处理
// （负向断言），避免哪天误把 DSH 代码打进产物。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/** 本配置文件所在目录（= 包根） */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));

/** 替换包名用的绝对路径（rolldown 的 alias 收绝对路径最稳） */
const shim = (name) => join(packageRoot, 'src', 'standalone', 'shims', `${name}.ts`);

export default defineConfig({
  format: ['esm'],
  platform: 'node',
  // 独立应用只在 Node ≥ 22.12 上运行（package.json 的 engines 已声明），因此目标可以是 es2022：
  // es2020 目标会把 class field 一类语法降级成 `_defineProperty(...)`，进而把
  // `@oxc-project/runtime` 拖成一条裸 import —— 那个包不在本包依赖里，装好的用户跑起来会
  // ERR_MODULE_NOT_FOUND。提到 es2022 后这类降级辅助整体消失。
  target: 'es2022',
  dts: false,
  outDir: 'lib',
  // 只有一个入口，构建前清空 lib：否则删掉的入口（旧的 standalone.js）与旧 hash 的 chunk 会一直留着。
  clean: true,
  entry: {
    app: 'src/app/main.ts',
  },
  // 单入口产物：把依赖里的动态 import 也内联进 app.js，lib 下只留一个入口文件
  // （Electron 进程里不需要按需拆包）。
  outputOptions: {
    inlineDynamicImports: true,
  },
  // tsdown 默认把 dependencies/peerDependencies 全部外部化（本包用到的 DSH 专有包也在其中），
  // 所以这里必须先 noExternal 把它们拉回打包图，下面的 alias 才轮得到生效；
  // 否则产物里留下裸 import，在没有 DSH 的环境里 ERR_MODULE_NOT_FOUND。
  //
  // zod 打进包：应用产物要做到「不依赖 node_modules」，而配置校验每次启动都要用。
  // openai / @anthropic-ai/sdk 同理（独立 AI 的传输层静态 import 它们）：漏打时在仓库里跑看不出来——
  // 模块解析会一路向上找到仓库的 node_modules——装到 /Applications 才报 ERR_MODULE_NOT_FOUND。
  noExternal: [
    /^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/,
    /^zod$/,
    /^openai(?:\/|$)/,
    /^@anthropic-ai\/sdk(?:\/|$)/,
  ],
  // electron 由 Electron 自己的模块加载器提供，进包反而会炸；其余 @deepseek-ai/* 仍视为宿主提供。
  external: ['electron', /^node:/, /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/],
  alias: {
    '@deepseek-ai/dsh-home-paths': shim('dsh-home-paths'),
    '@deepseek-ai/dsh-credentials': shim('dsh-credentials'),
    '@deepseek-ai/dsh-llm': shim('dsh-llm'),
  },
});
