// tsdown 配置（src → lib 产物）
//
// 只有一个入口：独立应用（app → lib/app.js）—— 一个 Electron 进程里跑「本机服务 + 宿主代码 + 桌面窗口」。
// 产物要跑在**不依赖 node_modules** 的安装目录里，所以运行时要用的依赖必须打进包。
import { defineConfig } from 'tsdown';

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
  // 只有一个入口，构建前清空 lib：否则删掉的入口与旧 hash 的 chunk 会一直留着。
  clean: true,
  entry: {
    app: 'src/app/main.ts',
  },
  // 单入口产物：把依赖里的动态 import 也内联进 app.js，lib 下只留一个入口文件
  // （Electron 进程里不需要按需拆包）。
  outputOptions: {
    inlineDynamicImports: true,
  },
  // tsdown 默认把 dependencies 全部外部化；应用产物必须自包含，运行时要用的都拉回打包图。
  //
  // zod 打进包：配置校验每次启动都要用。
  // openai / @anthropic-ai/sdk 同理（独立 AI 的传输层静态 import 它们）：漏打时在仓库里跑看不出来——
  // 模块解析会一路向上找到仓库的 node_modules——装到 /Applications 才报 ERR_MODULE_NOT_FOUND。
  noExternal: [/^zod$/, /^openai(?:\/|$)/, /^@anthropic-ai\/sdk(?:\/|$)/],
  // electron 由 Electron 自己的模块加载器提供，进包反而会炸。
  external: ['electron', /^node:/],
});
