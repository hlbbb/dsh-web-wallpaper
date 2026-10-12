# dshpaper · DSH 桌面端壁纸插件

> 🖼️ 给 **DeepSeek Harness 桌面端（Web UI）** 换背景图 / MP4 动态壁纸的轻量插件：导入本机**图片**或**视频**、
> 粘贴图片 URL，一键随机、定时轮换，并带亮度/遮罩/模糊调节与「面板透明化」，让背景真正透出来。
> 图片与视频可以混在同一个随机池里轮换；视频默认静音、自动循环，并能随时暂停、静音与调倍速。
> 不注册主题、不抢配色令牌，可与任意主题插件（如流萤）共存。

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 随时换图 | 右下角毛玻璃工具条：**🎲 随机换一张** / **🖼 壁纸设置**（可拖动，位置记忆） |
| 本机导入 | 「＋ 添加图片」支持一次多选：**图片** `image/*` ≤15MB、**视频** `video/*` ≤200MB，存 IndexedDB，重启仍在 |
| MP4 动态壁纸 | 视频当背景播放，**静音 + 循环**；壁纸默认静音，否则会被浏览器/Electron 的自动播放策略拦截 |
| 视频播放控制 | 当前壁纸是视频时，面板多出「视频」一行：**播放 / 暂停**、**静音**、**循环**开关，以及 **0.5× / 1× / 1.5× / 2×** 倍速 |
| 视频缩略图 | 导入时用 `<video>` + canvas 自动抽帧生成封面；抽帧失败（如跨域源）降级为 🎬 占位图标，不会裂图 |
| 图文混池 | 图片与视频可以勾进**同一个随机池**一起轮换，缩略图卡片上有角标区分两者 |
| 后台省电 | 切到别的标签页/窗口时自动暂停视频，回来继续播，避免后台空耗 GPU |
| URL 添加 | 粘贴 `http(s)://` 图片地址直接应用（适合在线壁纸站/图床） |
| 网格选择 | 缩略图网格，**单击即换**；勾选后可「删除所选」或「设为随机池」 |
| 定时轮换 | 勾选「定时随机」+ 分钟数（默认 30），到点自动换池中随机一张 |
| 显示方式 | 铺满 `cover` / 适应 `contain` / 居中 `center` / 平铺 `tile` |
| 画面调节 | **亮度** 50–180%（默认 120%）、**遮罩** 0–90%（默认 5%）、**模糊** 0–24px；滤镜作用在背景层上，**对视频同样生效** |
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
2. **＋ 添加图片** 选一张或多张本地图片，或选一个 MP4/WebM 视频（或粘贴 URL → 添加 URL）。
3. 在网格里**单击缩略图**立即切换；想固定几张轮换就勾选它们 → **设为随机池** → 勾「定时随机」。
4. 画面太暗/太花：调 **亮度**（>100% 更亮）、**遮罩**（压暗背景保证文字可读）、**模糊**。
5. 面板不够透：确认 **面板透明化** 已勾选，再选 **轻度/中度/重度**。
6. 想临时回到默认外观：**停用**；再点一次恢复。

### 用视频做动态壁纸

1. 点 **＋ 添加图片**（同一个按钮也收视频），选一个 ≤200MB 的 MP4/WebM 等视频文件，导入后立刻作为背景播放。
2. 在缩略图网格里认视频卡片：带 **MP4 / VIDEO 角标**的那张就是；抽帧成功的显示自动封面，抽帧失败的显示 🎬 占位图标。
3. 单击视频卡片即可切过去；可以把图片和视频一起勾选后 **设为随机池**，让**图文混池**轮换。
4. 当前壁纸是视频时，面板上会多出一行「视频」控件：
   - **播放 / 暂停**：手动控制当前视频的播放状态；
   - **静音**：默认已勾选，取消后可听到声音（一般不建议，见「已知限制」）；
   - **循环**：默认已勾选，关掉后只播一遍；
   - **速度**：`0.5× / 1× / 1.5× / 2×`。
5. 这些视频选项都会被记住（存在 `localStorage`），重启后仍是上次的选择。

> ESC 关闭面板；工具条可拖到任意位置，位置会被记住。

---

## 🔧 实现要点

1. **客户端插件机制**：`window.__ModuleLoader__.load()` 注册 DSH 客户端模块，导出 cordis 插件 `{ isPlugin, inject: ["theme"], apply }`。
2. **注入槽位**：`package.json` 的 `dsh.client.inject` 声明依赖 `@deepseek-ai/dsh-client-ui-theme`，浏览器 bundle 由 DSH 客户端模块扫描注入。
3. **身份层**：`apply(ctx)` 内用 `ctx.effect(fn, label)` 注入 `<style>`、背景层 `#wwp-bg`（`z:-1`，`::after` 做遮罩）与工具条 DOM，并返回清理函数。
4. **不抢主题**：不调用 `ctx.theme.register/setTheme`，只在「面板透明化」开启时用独立 `<style>` 覆盖表面令牌。
   覆盖选择器为 `:root, html body, html body[data-ds-dark-theme]` —— 因为 DSH 主题把令牌定义在 `body` 上，只写 `:root` 无效。
5. **背景可见**：壁纸激活时给 `<html>` 加 `wwp-on` 类，令 `html, body` 背景透明（门控，停用时自动还原）。
6. **持久化**：设置 → `localStorage`（`wwp_*`）；图片与视频 → `IndexedDB`（库 `dsh-web-wallpaper`，表 `wallpapers`）。
7. **图片存 data URI，视频存 Blob**：图片沿用现有路径（`FileReader.readAsDataURL`）；视频**不转 base64**，直接把原始 `File`/`Blob` 写进记录，靠 IndexedDB 的**结构化克隆**持久化，避免 base64 膨胀约 33%。
8. **视频渲染**：`renderBG()` 仍是唯一的背景渲染入口。视频分支在 `#wwp-bg` **内部**创建 `<video id="wwp-video">`（`muted` / `loop` / `playsinline` / `preload="auto"`），用 `URL.createObjectURL(blob)` 提供 `blob:` 播放源；切回图片或清理时 `URL.revokeObjectURL()` 释放，并把 `src` 清掉后 `load()`，不残留 object URL。`play()` 的 Promise 统一 `.catch()`，自动播放被拦截时只提示、不抛未捕获异常。
9. **滤镜与遮罩复用**：模糊/亮度缩放 filter 仍施加在父元素 `#wwp-bg` 上、遮罩仍由 `#wwp-bg::after` 承担，所以对视频**天然生效**，无需为视频重写一套。
10. **记录类型与兼容**：记录新增可选字段 `type`（`"image"` / `"video"`），判定统一走 `recType()`；**老记录没有 `type`，按图片路径兼容渲染**，不会报错也不会丢图。
11. **缩略图抽帧**：视频导入时用 `<video>` 解码一帧画到 `canvas`，再 `canvas.toDataURL("image/jpeg")` 得到 poster 存进记录；跨域视频源会因 canvas 污染抛 `SecurityError`，被捕获后降级为占位图标。
12. **失败可见**：`idbPut` 失败（如 IndexedDB 配额不足）会给出明确提示，不静默丢数据。
13. **后台暂停**：监听 `visibilitychange`，页面隐藏时暂停视频、恢复可见时续播，避免后台空转耗电。

---

## 🧪 自检

仓库自带两个离线校验脚本，都用 DOM 桩真实执行 `lib/client.js`（不需要浏览器）：

```powershell
# 1) 对比度校验：解析注入的 CSS，按 WCAG 2.1 计算对比度
node tools/check-contrast.cjs lib/client.js

# 2) 视频路径校验：覆盖视频渲染、Blob 存储、object URL 生命周期与老记录兼容
node tools/check-video.cjs lib/client.js
```

`check-video.cjs` 会把 DOM 桩包装成能跑视频逻辑的环境，逐条断言：

- **视频渲染**：视频记录会让 `#wwp-video` 可见、设置 `src` 并调用 `play()`；图片记录则隐藏、暂停、清空 `src`；
- **Blob 存储**：`kind=file` 的视频记录走 `blob` 字段（结构化克隆），**不把视频写成 base64/data URI**；
- **object URL 生命周期**：每次切换都会 `revokeObjectURL()` 上一个 `blob:` URL，`cleanup()` 后不残留；
- **老记录兼容**：没有 `type` 字段的老记录仍按图片渲染，不报错、不丢图；
- **URL 视频**：粘贴视频 URL 时不会误把 URL 字符串当 Blob 传给 `createObjectURL`，缩略图与静默降级都受覆盖。

`check-video.cjs` 必须退出码 `0`。`check-contrast.cjs` 目前**已知存在既有基线问题**（与壁纸/视频功能无关，本次未修复也未引入新失败）：

- **透明化三档的语义与数值方向相反**：代码注释与 `check-contrast.cjs` 的断言都写「轻度最不透、重度最透」，
  但 `LEVELS` 的实际数值是递增的（`light` 最透 → `heavy` 最实），而面板标签仍是「轻度 / 中度 / 重度」。
  也就是说选「重度」会让承载文字的表面**更不透明**，壁纸反而更透不出来，与用户预期相反。
- `LEVELS.light` 的 `l1 = 0.72`、`l2 = 0.86` 低于脚本自定的可读下限（`0.85 / 0.88`），`mid` 的 `l1 = 0.82` 亦然。

> 这两点都属**历史遗留**（在引入视频功能之前就存在），修复它会改变透明化档位的视觉行为，需要产品决策，故本次未改动。

---

## ⚠️ 已知限制

- **视频能不能播取决于 Electron/Chromium 的解码能力**：`mp4`（H.264/AAC）与 `webm` 基本可用；`mov`、`mkv` 等容器**视内部编码而定，可能无法播放**（导入不会报错，但背景会保持空白/黑屏）。
- **视频没有声音**：本插件把动态壁纸默认静音，即便你在面板里取消静音，它也只是把原视频的音轨放出来，不是音乐播放器，也没有音量控制。
- 图片以 data URI 存进 IndexedDB，单张建议 ≤5MB；超过 15MB 会被跳过。
- **单个视频 ≤200MB**：视频按原始 Blob 存进 IndexedDB，几个大视频就可能占满配额，保存失败时会有提示。
- **性能**：4K / 高码率视频会明显增加 GPU/CPU 与内存占用（还要叠加模糊、亮度滤镜），建议用 **1080p 以内**的短片；画面卡顿时先降分辨率或改回图片。
- 与其它强制覆盖 `--dsw-*` 令牌的主题同时启用时，透明效果以「后加载者」为准。
- 客户端 bundle 在桌面端启动时构建，**装/卸/改后必须完全重启**。

## 📄 License

MIT（仅代码）。壁纸素材版权归各自作者所有。
