# 代码审计报告：dsh-ui-beautify

| 项 | 值 |
|---|---|
| 项目版本 | `0.1.0`（代码审计基于 commit `2aa2893`；文档与仓库元数据更新见后续提交） |
| 审计日期 | 2026-10-23 |
| 审计环境 | DSH `0.2.1-rc.2`，Node `v24.17.0`，Windows / PowerShell |
| 审计范围 | 仓库内全部源码、配置、文档、测试与资源（不含 `node_modules`） |
| 扫描命令 | `node "<plugin-builder skill>/scripts/audit-scan.mjs" .` |

## 结论

**可安全交付。**

未发现凭据、隐私外发、危险动态执行或越界文件读写。插件只调用 Client 的 `theme` / `slots` / `locale` 三个服务，所有全局写入都带清理函数。视觉渲染与卸载残留需要真机确认，见文末“测试与审计的边界”。

## 检查项

| # | 类别 | 结果 | 说明 |
|---|---|---|---|
| 1 | 凭据泄露 | 通过 | 源码、配置、文档、测试中没有 API Key、Token、密码、Cookie、私钥或 JWT |
| 2 | 隐私数据 | 通过 | 不读会话内容、不读文件系统、不读其他插件数据；只处理用户在设置页主动选择的本地图片 |
| 3 | 网络请求 | 通过 | 插件 JavaScript 没有 `fetch` / `XMLHttpRequest` / WebSocket；远程背景图由浏览器按用户填写的 http(s) URL 加载 |
| 4 | 文件读写 | 通过 / 不适用 | 没有 Host 文件读写；浏览器端只通过 `FileReader` 读取用户选择的图片，压缩在 canvas 内完成 |
| 5 | 注入与动态执行 | 通过 | 没有 `eval`、`new Function`、`innerHTML`、`document.write`；背景图 URL 与 data URL 走协议白名单；字体名去除引号、反斜杠、尖括号、分号与控制字符 |
| 6 | 权限与能力 | 通过 | 只使用 `ctx.theme.overrideTokens`、`ctx.slots`、`ctx.locale`；不注册工具、不发请求、不调用审批或凭据服务 |
| 7 | 第三方依赖 | 通过 | 运行时零依赖；测试只用 Node 内置模块；`react` 由 DSH 浏览器模块表提供 |
| 8 | 发布面 | 通过 | 无本地绝对路径、无临时文件、无构建产物、无调试日志、无测试敏感数据；`.gitignore` 覆盖 `node_modules`、`.env`、日志与个人配置 |

## 发现的问题

### 高

无。

### 中

无。

### 低 / 提示

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| L-1 | `client.js` 背景图 URL 处理 | 用户可填写任意 http(s) 图片地址，浏览器会向该地址发起图片请求 | 接受：这是“网络背景图”功能的必要行为；插件自身不发请求，只校验协议并拒绝凭据、`javascript:`、`file:`、SVG data URL。README 已说明 |
| L-2 | `client.js` localStorage 持久化 | 压缩后的背景图 data URL 仍可能占满浏览器配额 | 接受：已限制 180 万字符、最长边 2560px、最多 4 次质量/缩放阶梯；存储失败时提示“仅本次会话生效”，不阻断界面 |
| L-3 | `client.js` token 覆盖 | 覆盖的 `--dsw-*` / `--dsh-font-family-*` 名称随 DSH 版本可能变化 | 接受：未匹配的 token 不会破坏布局，只会“不生效”；README 已列真机复核步骤 |
| L-4 | `client.js` 字体覆盖 | 选择非“跟随 DSH”的字体后，会覆盖 DSH 自带字体设置 | 接受：这是功能语义；设置页提供“跟随 DSH”随时退出覆盖，README 已说明 |

## 已修复

| # | 原状态 | 修复方式 | 复扫结果 |
|---|---|---|---|
| 1 | 首次自动扫描无高危/中危项 | 无需修复；补充 README、LICENSE、`.gitignore` 后复扫 | 已清零 |

## 尚未解决

| # | 问题 | 为什么不修 | 影响范围 | 建议 |
|---|---|---|---|---|
| 1 | 未做真机视觉验证 | 当前环境没有可用的浏览器控制；不能截图或模拟真实 DSH 渲染 | 设置页 slot 是否渲染、五个预设的实际观感、深色对比度、卸载残留 | 安装后打开“设置 → 界面美化”，逐项切换预设并检查明亮/深色；卸载后刷新确认外观恢复 |
| 2 | 未覆盖全部设计令牌 | 只覆盖主背景、层、侧栏、气泡、代码块、边框、标签、品牌与圆角；嵌套组件可能保留自有表面 | 菜单、对话框、第三方面板的透明度可能不一致 | 如某个区域需要透明，先确认它使用的 token，再在 `buildTokens` 中补一条 `{ light, dark }` |
| 3 | 第三方主题的底色差异 | 透明表面使用插件自带的明暗中性/预设色，不读取第三方主题的原始色值 | 换用第三方 DSH 主题后，透明度下的底色可能与主题不完全一致 | 需要精确匹配时，改用“跟随 DSH”并只调透明度；或在预设中手工对齐该主题色 |

## 隐私数据处理

| 问题 | 结论 |
|---|---|
| 插件读取哪些用户数据 | 只读取用户在设置页选择的本地图片；不读取会话内容、文件系统或其他插件数据 |
| 数据是否离开本机 | 插件 JavaScript 不发送任何数据；若用户填写远程图片 URL，浏览器会向该地址请求图片 |
| 是否写入日志 | 否。仅在 token 覆盖异常时通过 `ctx.logger.warn` 记录错误事件，不含用户内容 |
| 是否持久化 | 是，写入浏览器 localStorage：`dsh-ui-beautify:settings`、`dsh-ui-beautify:wallpaper` |
| 用户如何清除 | 设置页“恢复默认”/“清除背景图”，或删除上述两个 localStorage 键 |

## 凭据检查

| 问题 | 结论 |
|---|---|
| 是否发现真实凭据 | 否 |
| 已如何处理 | 不适用 |
| 是否曾进入 Git 历史 | 否（已推送到公开仓库 `https://github.com/vi0let-dev/dsh-ui-beautify`；历史中未发现凭据） |
| 需要用户执行的轮换 | 否 |

## 复扫结果

```text
$ node "<plugin-builder skill>/scripts/audit-scan.mjs" .
审计扫描：<项目目录>
扫描文件：13
高危：0    中危：0    提示：0

未发现匹配项。注意：扫描通过不等于安全，仍需人工审计。
```

## 测试与审计的边界

- 已实际运行：
  - `node --check index.js`、`node --check client.js`、`node --check test/client.test.mjs`：全部通过。
  - `node test/client.test.mjs`：25 项测试全部通过。
  - `node "<plugin-builder skill>/scripts/check-project.mjs" .`：23 项通过、0 项失败、1 项提示（ESM 语法需手动 `node --check`，已执行）。
  - `node "<plugin-builder skill>/scripts/audit-scan.mjs" .`：0 高危、0 中危、0 提示。
- 仅静态检查：结构、清单、JSON、locale、图标、token 名称、URL 白名单、危险模式静态断言。
- 尚未验证：`settings.section` 的真实渲染、五个预设的实际观感、深色模式对比度、背景图在真实 CSP/网络下的表现、卸载后是否无残留。这些需要真机 DSH。

## 审计人

DeepSeek Harness coding agent，2026-10-23。本报告基于上述范围内的文件；范围外的改动不在此报告覆盖之内。
