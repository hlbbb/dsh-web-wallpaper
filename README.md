# dshpaper · DSH 桌面端壁纸插件

> 🖼️ 给 **DeepSeek Harness 桌面端（Web UI）** 换背景图的轻量插件：导入本机图片或图片 URL，
> 一键随机、定时轮换，并带亮度/遮罩/模糊调节与「面板透明化」，让背景真正透出来。
> 不注册主题、不抢配色令牌，可与任意主题插件（如流萤）共存。

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 随时换图 | 右下角毛玻璃工具条：**🎲 随机换一张** / **🖼 壁纸设置**（可拖动，位置记忆） |
| 本机导入 | 「＋ 添加图片」支持一次多选（`image/*`，≤15MB），存 IndexedDB，重启仍在 |
| URL 添加 | 粘贴 `http(s)://` 图片地址直接应用（适合在线壁纸站/图床） |
| 网格选择 | 缩略图网格，**单击即换**；勾选后可「删除所选」或「设为随机池」 |
| 定时轮换 | 勾选「定时随机」+ 分钟数（默认 30），到点自动换池中随机一张 |
| 显示方式 | 铺满 `cover` / 适应 `contain` / 居中 `center` / 平铺 `tile` |
| 画面调节 | **亮度** 50–180%（默认 120%）、**遮罩** 0–90%（默认 5%）、**模糊** 0–24px |
| 面板透明化 | 轻/中/重三档，把 `--dsw-*` 表面令牌改成半透明；承载文字的表面保持不透明以保证可读 |
| 一键停用 | 「启用 / 停用」临时回到默认外观；「清除当前」只去掉当前图不删文件 |

所有设置都存在浏览器本地（`localStorage` + `IndexedDB`）。

---

## 🚀 安装

```powershell
# 从 GitHub 安装
dsh plugin --profile <你的profile> add "github:hlbbb/dsh-web-wallpaper"

# 或先 clone 再以 link 方式安装（便于改代码）
git clone https://github.com/hlbbb/dsh-web-wallpaper.git
dsh plugin --profile <你的profile> add "link:<克隆目录的绝对路径>"
```

装完 **完全退出并重开 DeepSeek Harness**（客户端 bundle 在启动时构建）。

### 手动安装（pnpm 版本不匹配时）

若 `dsh plugin add` 报 `ERR_PNPM_UNEXPECTED_STORE`（profile 的 node_modules 与自带 pnpm 的 store 版本不一致），可用仓库自带脚本：

```powershell
node tools/install.js <本插件目录绝对路径> [profile 目录]
# 默认写入 ~/.dsh/profiles/desktop
```

脚本做三件事：在 `<profile>/node_modules` 下建目录联接指向本插件源码、在 `package.json` 的 `dependencies` 写入 `link:`、把包名追加进 `dsh.profile.bundles`。
bundle 自身的 `cordis.patch.yml` 会自动插入 loader 行（`- insert:`），**无需**改用户 patch 层。

> ⚠️ 桌面端会把插件**复制**进 `profiles/.generations/live/<pkg>+<ver>+<hash>/` 并加载那份快照。
> 用 `link:` 安装后若改了源码却不生效，请把改动同步到该快照目录，或重装插件。

### 卸载

```powershell
dsh plugin --profile <你的profile> remove dsh-web-wallpaper
# 重启 DeepSeek Harness
```

---

## 🎛️ 使用

1. 点右下角 **🖼** 打开设置面板。
2. **＋ 添加图片** 选一张或多张本地图片（或粘贴 URL → 添加 URL）。
3. 在网格里**单击缩略图**立即切换；想固定几张轮换就勾选它们 → **设为随机池** → 勾「定时随机」。
4. 画面太暗/太花：调 **亮度**（>100% 更亮）、**遮罩**（压暗背景保证文字可读）、**模糊**。
5. 面板不够透：确认 **面板透明化** 已勾选，再选 **轻度/中度/重度**。
6. 想临时回到默认外观：**停用**；再点一次恢复。

> ESC 关闭面板；工具条可拖到任意位置，位置会被记住。

---

## 🔧 实现要点

1. **客户端插件机制**：`window.__ModuleLoader__.load()` 注册 DSH 客户端模块，导出 cordis 插件 `{ isPlugin, inject: ["theme"], apply }`。
2. **注入槽位**：`package.json` 的 `dsh.client.inject` 声明依赖 `@deepseek-ai/dsh-client-ui-theme`，浏览器 bundle 由 DSH 客户端模块扫描注入。
3. **身份层**：`apply(ctx)` 内用 `ctx.effect(fn, label)` 注入 `<style>`、背景层 `#wwp-bg`（`z:-1`，`::after` 做遮罩）与工具条 DOM，并返回清理函数。
4. **不抢主题**：不调用 `ctx.theme.register/setTheme`，只在「面板透明化」开启时用独立 `<style>` 覆盖表面令牌。
   覆盖选择器为 `:root, html body, html body[data-ds-dark-theme]` —— 因为 DSH 主题把令牌定义在 `body` 上，只写 `:root` 无效。
5. **背景可见**：壁纸激活时给 `<html>` 加 `wwp-on` 类，令 `html, body` 背景透明（门控，停用时自动还原）。
6. **持久化**：设置 → `localStorage`（`wwp-_*`）；图片 → `IndexedDB`（库 `dshpaper`，表 `wallpapers`）。

---

## 🧪 自检

仓库自带一个离线对比度校验脚本（用 DOM 桩真实执行 `lib/client.js`，解析注入的 CSS 并按 WCAG 2.1 计算对比度）：

```powershell
node tools/check-contrast.cjs lib/client.js
```

---

## ⚠️ 已知限制

- 只支持**图片**（jpg/png/webp/gif/avif…），暂不支持 mp4 动态壁纸。
- 图片以 data URI 存进 IndexedDB，单张建议 ≤5MB；超过 15MB 会被跳过。
- 与其它强制覆盖 `--dsw-*` 令牌的主题同时启用时，透明效果以「后加载者」为准。
- 客户端 bundle 在桌面端启动时构建，**装/卸/改后必须完全重启**。

## 📄 License

MIT（仅代码）。壁纸素材版权归各自作者所有。
