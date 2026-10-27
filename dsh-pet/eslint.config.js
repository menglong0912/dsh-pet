// ESLint 扁平配置（ESLint 9 flat config）
// 规则基调：js recommended + typescript-eslint recommended（未使用变量/类型相关规则）
// 忽略：构建产物 lib、发布前检查脚本 scripts、素材 assets（类型正确性交给 tsc，
//       因此 TS 文件关闭 no-undef，避免 window/fetch 等全局误报）
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // dist-app：electron-builder 产物（含随 .app 放在 asar 外的 pet-cli.mjs 副本）
  // .zcode：workflow 会话在本目录落的工作产物（git 已忽略，不是仓库代码）——
  //   不排除的话 `eslint .` 会把里面的 .mjs 当代码 lint，npm run lint 就红了（2026-10-25 实际发生过）
  { ignores: ['lib/**', 'scripts/**', 'assets/**', 'runtime/**', 'node_modules/**', 'dist-app/**', '.zcode/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TS 文件：类型正确性由 tsc 负责，关闭 no-undef（避免 window/fetch 等全局误报）
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // 配置文件本身用的 ESM import，无浏览器代码，no-undef 放开
    files: ['eslint.config.js'],
    rules: {
      'no-undef': 'off',
    },
  },
);
