# dshpaper · DSH 桌面端壁纸插件

> 🖼️ 给 **DeepSeek Harness 桌面端（Web UI）** 换背景图的轻量插件：随时导入本机图片或图片 URL，
> 一键随机、定时轮换，并带可读性遮罩与「面板透明化」，让背景真正透出来。
> 不注册主题、不覆盖配色令牌，可与任意主题插件（如流萤）共存。

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 随时换图 | 右下角毛玻璃工具条：**🎲 随机换一张** / **🖼 壁纸设置**（可拖动，位置记忆） |
| 本机导入 | 「＋ 添加图片」支持一次多选（`image/*`，≤15MB），IndexedDB 持久化，重启仍在 |
| URL 添加 | 粘贴 `http(s)://` 图片地址直接应用（适合在线壁纸站/图床） |
| 网格选择 | 缩略图网格，**单击即换**；勾选后可「删除所选」或「设为随机池」 |
| 定时轮换 | 勾选「定时随机」+ 分钟数（默认 30），到点自动换池中随机一张 |
| 显示方式 | 铺满 `cover` / 适应 `contain` / 居中 `center` / 平铺 `tile` |
| 可读性 | **遮罩** 0–90%（压暗背景保证文字可读）、**模糊** 0–24px |
| 面板透明化 | 轻/中/重三档：**壁纸透出程度**由整页底衬与侧栏/气泡决定，弹窗与输入框始终保留可读性下限；自动跟随深浅色 |
| 一键停用 | 「启用 / 停用」临时关掉壁纸回到默认外观；「清除当前」只去掉当前图不删文件 |

所有设置（当前壁纸、显示方式、遮罩、模糊、透明档位、轮换、随机池、工具条位置）都存在浏览器本地。

---

## 🚀 安装

**桌面端实际使用的 profile 是 `~/.dsh/profiles/desktop`**（见文末「本机安装记录」）。

标准方式（其它机器 / pnpm store 版本匹配时）：

```powershell
dsh plugin --profile desktop add "link:<本插件目录绝对路径>"
# 完全退出并重开 DeepSeek Harness
```

本机方式（pnpm 11 与 profile 的 v10 store 不匹配，CLI 安装会报 `ERR_PNPM_UNEXPECTED_STORE`）：

```powershell
node tools/install.js <本插件目录绝对路径>
# 完全退出并重开 DeepSeek Harness
```

> 装好后右下角出现 **🎲 🖼** 毛玻璃工具条；若没有，见文末「重启后自检」。
### 卸载

```powershell
$env:DSH_HOME = "$env:APPDATA\dshktop\harness"
dsh plugin --profile web remove dshpaper
# 重启 DeepSeek Harness
```

---

## 🎛️ 使用

1. 点 **🖼** 打开设置面板。
2. **＋ 添加图片** 选一张或多张本地图片（或粘贴 URL → 添加 URL）。
3. 在网格里**单击缩略图**立即切换；想固定几张轮换就勾选它们 → **设为随机池** → 勾「定时随机」。
4. 背景太花看不清字？调 **遮罩**（推荐 25–45%）和 **模糊**。
5. **面板透明化** 只影响壁纸透出程度：整页底衬与侧栏/气泡越透，壁纸越明显；弹窗与输入框有可读性下限，不会跟着一起透。
6. 想临时回到默认外观：**停用**；再点一次恢复。

> ESC 关闭面板；工具条可拖到任意位置，位置会被记住。

---

## 🔧 实现要点

1. **客户端插件机制**：`window.__ModuleLoader__.load()` 注册 DSH 客户端模块，导出 cordis 插件 `{ isPlugin, inject: ["theme"], apply }`。
2. **注入槽位**：`package.json` 的 `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-theme"]`，浏览器 bundle 由 DSH 客户端模块扫描注入。
3. **身份层**：`apply(ctx)` 内 `ctx.effect(fn, label)` 注入 `<style>`、背景层 `#wwp-bg`（`z:-1`，`::after` 做遮罩）与工具条 DOM，并返回清理函数。
4. **不抢主题**：不调用 `ctx.theme.register/setTheme`，只在「面板透明化」打开时用独立 `<style>` 覆盖表面令牌（轻/中/重），因此与流萤等主题插件共存；若两者都启用，后加载者优先，可用各自开关取舍。
5. **可读性下限**：承载文字的表面（`layer-1/2/3`、`input-major`、`selector`、`menu`）恒定保持在 0.78 以上，只有整页底衬与侧栏/气泡才压到很低。设置页弹窗用的正是 `layer-2`——早期版本把它降到 0.26，弹窗 74% 透出壁纸，正文对比度只剩 1.7:1（WCAG AA 要求 4.5:1），表现为「设置页看不清字」。
6. **持久化**：设置 → `localStorage`（`wwp_*`）；图片 → `IndexedDB`（库 `dshpaper`，表 `wallpapers`）。

---

## ⚠️ 已知限制

- 只支持**图片**（jpg/png/webp/gif/avif…），暂不支持 mp4 动态壁纸（流萤主题支持）。
- 图片以 data URI 存进 IndexedDB，单张建议 ≤5MB；超过 15MB 会被跳过。
- 与其它会强制 `--dsw-*` 令牌的主题同时启用时，透明效果以「后加载者」为准。
- 客户端 bundle 在桌面端启动时构建，**装/卸后必须重启 DeepSeek Harness**。

## 📄 License

MIT（仅代码）。

---

## 本机安装记录

**桌面端实际使用的 profile 是 `~/.dsh/profiles/desktop`**（由 `DeepSeek Harness.exe` 的命令行确认：
它把该目录作为 profile 参数传入），不是 `%APPDATA%/dsh-desktop/harness/profiles/web`。

本机 pnpm 11 与该 profile 的 v10 store 不兼容，`dsh plugin --profile ... add` 会报
`ERR_PNPM_UNEXPECTED_STORE`，因此按 DSH 的解析约定手动安装：

1. 在 `~/.dsh/profiles/desktop/node_modules/` 下建 junction（目录联接）指向本插件源码目录
2. `~/.dsh/profiles/desktop/package.json`：`dependencies` 加 `"dsh-web-wallpaper": "link:<插件目录>"`，
   `dsh.profile.bundles` 追加 `dsh-web-wallpaper`
3. 无需改用户 patch 层：bundle 自身的 `cordis.patch.yml` 会自动插入 loader 行
   （id `ui-web-wallpaper`，name `dsh-web-wallpaper`）
4. 完全退出并重开 DeepSeek Harness（客户端 bundle 在启动时构建）

一键脚本（幂等，默认写 desktop profile）：

```powershell
node tools/install.js <本插件目录绝对路径>            # 默认 ~/.dsh/profiles/desktop
node tools/install.js <本插件目录> <其它 profile 目录>  # 也可指定
```

### 手动卸载

1. 删除 junction：`~/.dsh/profiles/desktop/node_modules/dsh-web-wallpaper`
   （只删链接，不动源码目录：`[IO.Directory]::Delete($link, $false)`）
2. 从 `~/.dsh/profiles/desktop/package.json` 移除 `dependencies` 与 `dsh.profile.bundles` 中的 `dsh-web-wallpaper`
3. 重启 DeepSeek Harness

### 重启后自检

- 右下角出现 **🎲 🖼** 毛玻璃工具条
- 会话里执行 `plugin_manager list_plugins`，应看到 `include:ui-web-wallpaper`
  且 `fiberPhase` 为 `active`；若失败看 `%APPDATA%/dsh-desktop/logs/harness.log`

### 可读性自检

设置页弹窗用的是 --dsw-alias-bg-layer-2 令牌。改档位数值后请跑一次自检，
它会用最小 DOM 桩真实执行 `lib/client.js`，解析出实际注入的令牌不透明度，
再按 WCAG 2.1 校验对比度：

```powershell
node tools/check-contrast.cjs lib/client.js
```

通过标准：

- 承载文字的表面不低于可读下限（`layer-1/2/3` ≥ 0.85、`inputajor` ≥ 0.78、`menu` ≥ 0.92）
- 档位单调：轻度 ≥ 中度 ≥ 重度（越重越透）
- 设置页弹窗正文对比度 ≥ 4.5:1（WCAG AA），深色/浅色主题都要过
