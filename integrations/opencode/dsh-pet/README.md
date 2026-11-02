# OpenCode → dsh-pet（独立插件）

完全独立的 OpenCode 插件：**不改桌宠源码**，只调用桌宠已有的本机接口。

| OpenCode 状态 | 桌宠 |
| --- | --- |
| 回合开始 / 思考 / 生成下一步 | `workStatus` 的 thinking 档（默认「写代码」＝敲电脑），气泡「正在思考」 |
| 工具执行 | working 档（「忙碌点按」），气泡「正在干活」 |
| 一轮执行成功 | success 档（「雀跃庆祝」），并说一句「OpenCode 干完啦，去看看吧」 |
| 一轮执行失败 | error 档（「垂头叹气冒汗」），气泡「出错了」 |
| 中断 / 会话空闲 | 清掉状态，回到待机 |

插件只使用这两个已有接口：

```text
POST   /dsh-pet-7340/work-status  { state, task }
DELETE /dsh-pet-7340/work-status
POST   /app/say                   { text }
```

所以桌宠作者更新源码时，这个插件不需要跟着改；反过来，插件也不往桌宠仓库里加任何核心代码。

## 安装

1. 把本目录复制到 OpenCode 的全局插件目录：

   ```text
   Windows: %USERPROFILE%\.config\opencode\plugins\dsh-pet\
   macOS:   ~/.config/opencode/plugins/dsh-pet/
   ```

   目录里至少要有 `index.ts`。

2. 在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 里加上：

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["./plugins/dsh-pet"]
   }
   ```

   也可以直接指向本仓库的这个目录（绝对路径）：

   ```jsonc
   "plugins": ["C:/Users/you/.dsh/dsh-pet-src/integrations/opencode/dsh-pet"]
   ```

3. 保存配置后 OpenCode 会自动重载；也可以执行 `opencode reload`。用
   `opencode plugin list` 确认能看到 `dsh-pet`。

## 桌宠端要求

- 桌宠应用需要是能正常响应 `/dsh-pet-7340/work-status` 与 `/app/say` 的版本（作者原版就有）。
- 想让「思考」显示成敲电脑，把 `animations.events.workStatus` 的第 0 档改成 `写代码`
  （本仓库的 `assets/config.jsonc` 已经改好；如果你用作者原版，在用户配置里改这一档即可）。

桌宠没开时插件静默跳过；不需要额外端口或令牌，插件只连 `127.0.0.1`，端口从
`app.json` 读（每次启动随机）。
