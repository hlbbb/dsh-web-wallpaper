/**
 * dsh-web-wallpaper —— DSH Web UI 壁纸插件（浏览器端）
 *
 * 实现机制与 dsh-theme-firefly 相同：
 *   1. window.__ModuleLoader__.load() 注册为 DSH 客户端模块；
 *   2. 导出 { isPlugin, inject: ["theme"], apply }；
 *   3. apply(ctx) 里 ctx.effect(fn, label) 挂载背景层与工具条，返回清理函数；
 *   4. 不注册主题、不覆盖配色令牌（可选的「面板透明化」独立开关），
 *      与任何主题插件（如流萤）共存。
 *
 * 功能：
 *   - 本机图片导入（IndexedDB 持久化）+ 图片 URL 添加
 *   - 网格选择、单击即换、勾选删除 / 设为随机池
 *   - 🎲 一键随机、定时随机轮换（分钟）
 *   - 显示方式（铺满/适应/居中/平铺）、模糊、可读性遮罩
 *   - 界面面板透明化（极轻/轻度/中度/重度），自动跟随深浅色
 *   - 工具条可拖动、位置记忆；全部设置持久化
 */
window.__ModuleLoader__.load({
	id: "dsh-web-wallpaper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var PLUGIN_ID = "dsh-web-wallpaper";
		var DB_NAME = "dsh-web-wallpaper";
		var DB_VERSION = 1;
		var STORE = "wallpapers";

		// ── localStorage 持久化 ──
		function lsGet(key, fallback) {
			try {
				var raw = localStorage.getItem(key);
				if (raw === null || raw === undefined) return fallback;
				return JSON.parse(raw);
			} catch (e) { return fallback; }
		}
		function lsSet(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
		}
		function lsDel(key) {
			try { localStorage.removeItem(key); } catch (e) {}
		}

		// ── 设置状态 ──
		// 一次性迁移：旧版本默认值偏暗（遮罩 32% + 中度透明化），升级后改为更亮的默认。
		// 仅当用户从未改动过这两项（仍是旧默认值）时才迁移。
				(function migrate() {
			try {
				if (localStorage.getItem("wwp_migrated") === "4") return;
				// 壁纸偏暗修正：亮度低于 100% 或遮罩偏高都会压暗画面，一次性拉正。
				// （0.65 这类值来自早期版本滑块的最低端，属于误设而非有意选择）
				var br = parseFloat(localStorage.getItem("wwp_bright"));
				if (!isNaN(br) && br < 1.05) localStorage.setItem("wwp_bright", "1.2");
				var sh = parseFloat(localStorage.getItem("wwp_shade"));
				if (!isNaN(sh) && sh > 0.2) localStorage.setItem("wwp_shade", "0.05");
				var lv = localStorage.getItem("wwp_surface_level");
				if (lv === '"mid"' || lv === '"heavy"') localStorage.setItem("wwp_surface_level", '"light"');
				if (localStorage.getItem("wwp_bright") === null) localStorage.setItem("wwp_bright", "1.2");
				if (localStorage.getItem("wwp_shade") === null) localStorage.setItem("wwp_shade", "0.05");
				localStorage.setItem("wwp_migrated", "4");
			} catch (e) {}
		})();

var S = {
			enabled: lsGet("wwp_enabled", true),
			fit: lsGet("wwp_fit", "cover"),          // cover | contain | center | tile
			shade: lsGet("wwp_shade", 0.05),          // 0 - 0.9
			blur: lsGet("wwp_blur", 0),
			bright: lsGet("wwp_bright", 1.2),               // 0 - 24 px
			surface: lsGet("wwp_surface", true),      // 面板透明化
			surfaceLevel: lsGet("wwp_surface_level", "light"), // ultra | light | mid | heavy
			rotate: lsGet("wwp_rotate", false),
			rotateMin: lsGet("wwp_rotate_min", 30),
			videoMuted: lsGet("wwp_video_muted", true),   // 视频默认静音（否则不允许自动播放）
			videoLoop: lsGet("wwp_video_loop", true),     // 视频循环
			videoRate: lsGet("wwp_video_rate", 1),        // 视频倍速 0.5 / 1 / 1.5 / 2
			// 视觉特效层（雪花 / 星光 …）：与壁纸正交，可单独开关，也可叠加
			fx: lsGet("wwp_fx", "none"),                  // none | snow | stars | rain | sakura | fireflies | bubbles
			fxIntensity: lsGet("wwp_fx_intensity", 0.7),  // 0.2 - 1.5，线性缩放粒子基数
			fxSpeed: lsGet("wwp_fx_speed", 1),            // 0.2 - 3，线性缩放位移
			fxOpacity: lsGet("wwp_fx_opacity", 0.8),      // 0.1 - 1，乘到 globalAlpha
			pool: lsGet("wwp_pool", null)             // null = 全部；否则为 id 数组
		};
		var currentId = lsGet("wwp_current", null);
		var nextAt = lsGet("wwp_next_at", 0);

		function saveS() {
			lsSet("wwp_enabled", S.enabled);
			lsSet("wwp_fit", S.fit);
			lsSet("wwp_shade", S.shade);
			lsSet("wwp_bright", S.bright);
			lsSet("wwp_blur", S.blur);
			lsSet("wwp_surface", S.surface);
			lsSet("wwp_surface_level", S.surfaceLevel);
			lsSet("wwp_rotate", S.rotate);
			lsSet("wwp_rotate_min", S.rotateMin);
			lsSet("wwp_pool", S.pool);
			lsSet("wwp_video_muted", S.videoMuted);
			lsSet("wwp_video_loop", S.videoLoop);
			lsSet("wwp_video_rate", S.videoRate);
			lsSet("wwp_fx", S.fx);
			lsSet("wwp_fx_intensity", S.fxIntensity);
			lsSet("wwp_fx_speed", S.fxSpeed);
			lsSet("wwp_fx_opacity", S.fxOpacity);
		}

		// ── IndexedDB（图片持久化）──
		function idbOpen() {
			return new Promise(function (resolve, reject) {
				if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
				var req = indexedDB.open(DB_NAME, DB_VERSION);
				req.onupgradeneeded = function () {
					var db = req.result;
					if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
				};
				req.onsuccess = function () { resolve(req.result); };
				req.onerror = function () { reject(req.error); };
			});
		}
		function idbAll() {
			return idbOpen().then(function (db) {
				return new Promise(function (resolve) {
					var req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
					req.onsuccess = function () { db.close(); resolve(req.result || []); };
					req.onerror = function () { db.close(); resolve([]); };
				});
			}).catch(function () { return []; });
		}
		function idbPut(record) {
			return idbOpen().then(function (db) {
				return new Promise(function (resolve) {
					var tx = db.transaction(STORE, "readwrite");
					tx.objectStore(STORE).put(record);
					tx.oncomplete = function () { db.close(); resolve(true); };
					tx.onerror = function () { db.close(); resolve(false); };
				});
			}).catch(function () { return false; });
		}
		function idbDelete(key) {
			return idbOpen().then(function (db) {
				return new Promise(function (resolve) {
					var tx = db.transaction(STORE, "readwrite");
					tx.objectStore(STORE).delete(key);
					tx.oncomplete = function () { db.close(); resolve(true); };
					tx.onerror = function () { db.close(); resolve(false); };
				});
			}).catch(function () { return false; });
		}

		// ── 深浅色检测（跟随 DSH 的 data-ds-dark-theme 标记）──
		function isDark() {
			return !!(document.body && document.body.hasAttribute("data-ds-dark-theme"));
		}

		// ── 面板透明化令牌（极轻/轻度/中度/重度四档）──
		// 三档表示「越来越透」：轻度最不透、重度最透，与面板里的「轻度/中度/重度」一致。
		// 可读性下限：凡是承载文字的表面（l1/l2/l3 卡片与弹窗、input 输入框、
		// selector 选择器、menu 菜单）都必须留在 0.78 以上。
		// 原因：设置页弹窗用的就是 l2，一旦它降到 0.26，弹窗 74% 透出壁纸，
		// 文字对比度只剩 1.7:1（WCAG AA 要求 4.5:1），于是「看不清字」。
		// base 是整页底衬，保持很低，壁纸才透得出来；sidebar/bubble 是装饰玻璃，
		// 允许更透一些，但也不低于 0.68 以免侧栏与会话气泡的文字发虚。
		var LEVELS = {
			ultra: { base: 0.03, l1: 0.60, l2: 0.78, l3: 0.84, overlay: 0.94, module: 0.88, sidebar: 0.60, bubble: 0.62, input: 0.80, selector: 0.82, menu: 0.95 },
			light: { base: 0.06, l1: 0.72, l2: 0.86, l3: 0.9, overlay: 0.96, module: 0.92, sidebar: 0.72, bubble: 0.74, input: 0.86, selector: 0.88, menu: 0.97 },
			mid: { base: 0.1, l1: 0.82, l2: 0.9, l3: 0.93, overlay: 0.97, module: 0.94, sidebar: 0.8, bubble: 0.82, input: 0.9, selector: 0.91, menu: 0.97 },
			heavy: { base: 0.16, l1: 0.88, l2: 0.93, l3: 0.95, overlay: 0.98, module: 0.96, sidebar: 0.86, bubble: 0.88, input: 0.93, selector: 0.94, menu: 0.98 }
		};
		function surfaceCSS() {
			var a = LEVELS[S.surfaceLevel] || LEVELS.mid;
			var rgb = isDark() ? "13, 17, 23" : "248, 250, 252";
			function c(alpha) { return "rgba(" + rgb + ", " + alpha + ")"; }
			var vars = {
				"--dsw-alias-bg-base": c(a.base),
				"--dsw-alias-bg-layer-1": c(a.l1),
				"--dsw-alias-bg-layer-2": c(a.l2),
				"--dsw-alias-bg-layer-3": c(a.l3),
				"--dsw-alias-bg-overlay": c(a.overlay),
				"--dsw-alias-bg-module-platform": c(a.module),
				"--dsw-specific-sidebar-fill": c(a.sidebar),
				"--dsw-specific-bubble": c(a.bubble),
				"--dsw-specific-input-major": c(a.input),
				"--dsw-specific-selector": c(a.selector),
				"--dsw-specific-menu": c(a.menu)
			};
			var HY = String.fromCharCode(45);
			var SEL = ":root, html body, html body[data" + HY + "ds" + HY + "dark" + HY + "theme]";
			var lines = [];
			for (var k in vars) lines.push("  " + k + ": " + vars[k] + " !important;");
			return SEL + " {\n" + lines.join("\n") + "\n}";
		}

		// ── 样式表 ──
		function mainCSS() {
			return [
				"#wwp-bg { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;",
				"  background-color: #0b0e14; background-position: center; background-repeat: no-repeat; background-size: cover; }",
				"#wwp-bg::after { content: ''; position: absolute; inset: 0;",
				"  background: rgba(8, 10, 15, var(--wwp-shade, 0.08)); }",
				"#wwp-bg.wwp-hidden { display: none; }",
				"#wwp-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;",
				"  background: transparent; pointer-events: none; }",
				"#wwp-fx { position: fixed; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; display: block; }",
				"#wwp-fx.wwp-fx-off { display: none; }",
				"html.wwp-on, html.wwp-on body { background: transparent !important; }",

				".wwp-dock { position: fixed; right: 16px; bottom: 16px; z-index: 89; display: flex; align-items: center; gap: 6px;",
				"  padding: 5px 7px; border-radius: 999px; background: rgba(12, 16, 24, 0.55);",
				"  border: 1px solid rgba(255, 255, 255, 0.14); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);",
				"  backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%);",
				"  cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }",
				".wwp-dock.dragging { cursor: grabbing; }",
				".wwp-btn { width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.16);",
				"  background: rgba(20, 26, 38, 0.6); color: #dfe6f2; font-size: 14px; line-height: 1; cursor: pointer;",
				"  display: flex; align-items: center; justify-content: center; padding: 0;",
				"  transition: background 0.15s ease, color 0.15s ease; }",
				".wwp-btn:hover { background: rgba(40, 50, 72, 0.8); }",
				".wwp-btn.on { color: #8fd0ff; border-color: rgba(120, 180, 255, 0.5); box-shadow: 0 0 8px rgba(90, 150, 255, 0.35); }",

				".wwp-panel { position: absolute; cursor: default; user-select: auto; right: 0; bottom: calc(100% + 10px); width: 372px; max-width: calc(100vw - 24px);",
				"  max-height: calc(100vh - 90px); display: none; flex-direction: column; gap: 9px; padding: 12px;",
				"  border-radius: 12px; background: rgba(12, 16, 24, 0.92); border: 1px solid rgba(255, 255, 255, 0.14);",
				"  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);",
				"  color: #e6ebf4; font-size: 12px; overflow: auto; }",
				".wwp-panel.open { display: flex; }",
				".wwp-panel.below { bottom: auto; top: calc(100% + 10px); }",
				".wwp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
				".wwp-title { font-size: 13px; font-weight: 600; letter-spacing: 1px; }",
				".wwp-close { width: 22px; height: 22px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2);",
				"  background: rgba(255, 255, 255, 0.08); color: #dfe6f2; cursor: pointer; font-size: 12px; line-height: 1; padding: 0; }",
				".wwp-close:hover { background: rgba(255, 255, 255, 0.18); }",

				".wwp-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;",
				"  max-height: 236px; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }",
				".wwp-grid::-webkit-scrollbar { width: 8px; }",
				".wwp-grid::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.22); border-radius: 8px; }",
				".wwp-empty { grid-column: 1 / -1; text-align: center; color: #8a94a8; font-size: 12px; padding: 26px 0; }",
				".wwp-card { position: relative; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px;",
				"  padding: 3px; cursor: pointer; background: transparent; min-width: 0; }",
				".wwp-card:hover { border-color: rgba(140, 190, 255, 0.55); }",
				".wwp-card.cur { border-color: #6fb3ff; box-shadow: 0 0 8px rgba(110, 180, 255, 0.4); }",
				".wwp-card img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; display: block; background: #0b0e14; }",
				".wwp-card .wwp-cap { display: block; font-size: 10px; color: #aab4c8; overflow: hidden; text-overflow: ellipsis;",
				"  white-space: nowrap; text-align: center; line-height: 16px; height: 16px; }",
				".wwp-card input.wwp-chk { position: absolute; top: 6px; right: 6px; width: 15px; height: 15px;",
				"  accent-color: #4a9eff; cursor: pointer; z-index: 2; margin: 0; }",
				".wwp-vbadge { position: absolute; left: 6px; top: 6px; z-index: 1; padding: 1px 5px; border-radius: 4px;",
				"  font-size: 9px; letter-spacing: 0.5px; color: #cfe4ff; background: rgba(20, 40, 70, 0.78);",
				"  border: 1px solid rgba(120, 180, 255, 0.45); pointer-events: none; }",

				".wwp-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }",
				".wwp-lbl { color: #9aa6bd; }",
				".wwp-seg { height: 26px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.18);",
				"  background: rgba(255, 255, 255, 0.06); color: #dfe6f2; cursor: pointer; font-size: 12px; padding: 0 9px; }",
				".wwp-seg:hover { background: rgba(255, 255, 255, 0.14); }",
				".wwp-seg.active { background: rgba(90, 150, 255, 0.28); border-color: rgba(120, 180, 255, 0.6); color: #bcdcff; }",
				".wwp-act { height: 26px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2);",
				"  background: rgba(255, 255, 255, 0.08); color: #dfe6f2; cursor: pointer; font-size: 12px; padding: 0 9px; }",
				".wwp-act:hover { background: rgba(255, 255, 255, 0.16); }",
				".wwp-act:disabled { opacity: 0.35; cursor: not-allowed; }",
				".wwp-act.danger { color: #ffb3c0; border-color: rgba(255, 93, 122, 0.4); background: rgba(255, 93, 122, 0.1); }",
				".wwp-act.danger:hover { background: rgba(255, 93, 122, 0.22); }",
				".wwp-url { flex: 1; min-width: 130px; height: 26px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16);",
				"  background: rgba(255, 255, 255, 0.06); color: #e6ebf4; font-size: 12px; padding: 0 8px; box-sizing: border-box; }",
				".wwp-url::placeholder { color: #6b7688; }",
				".wwp-num { width: 52px; height: 26px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16);",
				"  background: rgba(255, 255, 255, 0.06); color: #e6ebf4; font-size: 12px; padding: 0 6px; box-sizing: border-box; }",
				".wwp-select { height: 26px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16);",
				"  background: rgba(20, 26, 38, 0.9); color: #e6ebf4; font-size: 12px; padding: 0 4px; }",
				".wwp-range { flex: 1; min-width: 70px; -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px;",
				"  background: rgba(255, 255, 255, 0.18); outline: none; cursor: pointer; }",
				".wwp-range::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 11px; border-radius: 50%;",
				"  background: #6fb3ff; box-shadow: 0 0 6px rgba(110, 180, 255, 0.7); }",
				".wwp-val { min-width: 34px; text-align: right; color: #9aa6bd; font-variant-numeric: tabular-nums; }",
				".wwp-chk-inline { display: flex; align-items: center; gap: 5px; cursor: pointer; color: #dfe6f2; }",
				".wwp-chk-inline input { accent-color: #4a9eff; cursor: pointer; margin: 0; }",
				".wwp-sep { height: 1px; background: rgba(255, 255, 255, 0.1); }",
				".wwp-note { font-size: 11px; color: #8a94a8; min-height: 14px; line-height: 14px; }"
			].join("\n");
		}

		// ── DOM 引用 ──
		var bg = null, surfaceEl = null, styleEl = null;
		var dock = null, panel = null, grid = null, note = null, fileInput = null;
		var urlInput = null;
		var panelOpen = false;
		var sel = new Set();
		var rotateTimer = null;
		var darkObserver = null;
		// 视频：元素与 object URL 都用模块级变量持有。
		// 不能用 querySelector 取 videoEl —— 离线自检桩的 querySelector 每次返回新对象。
		var videoEl = null;
		var videoObjectUrl = null;
		// 面板里的视频控件行（buildUI 时取一次引用，之后只用模块级变量）
		var videoRow = null, btnVidPlay = null, chkVidMuted = null, chkVidLoop = null, selVidRate = null;
		// 导入汇总的 note 写入后，短时间内抑制 renderBG() 的「已应用」提示，
		// 否则用户永远看不到「跳过 N 个」这类导入结果。
		var suppressApplyNoteUntil = 0;
		// 当前渲染的是否为视频（供 syncVideoRow / visibilitychange 判断）
		var currentIsVideo = false;
		// 连字符集中一个常量：本会话工具层有「吞连字符」的历史遗留问题。
		var HYPHEN = String.fromCharCode(45);
		// 视频倍速白名单
		var RATES = [0.5, 1, 1.5, 2];
		function rateVal(v) {
			var n = Number(v);
			for (var i = 0; i < RATES.length; i++) if (RATES[i] === n) return n;
			return 1;
		}

		// ══════════════════════════════════════════════════════════
		// ── 视觉特效层（雪花 / 星光 / 雨 / 樱花 / 萤火虫 / 气泡）──
		// 独立全屏 canvas，叠在 #wwp-bg 之上、界面 UI 之下；与壁纸正交。
		// 契约见 tmp/fx-spec.md：DOM id / 类名 / localStorage 键 / data-* 一律不得改。
		// ══════════════════════════════════════════════════════════
		var FX_ID = "wwp" + HYPHEN + "fx";
		var FX_OFF = "wwp" + HYPHEN + "fx" + HYPHEN + "off";
		var FX_MAX = 900;               // 所有特效共享的粒子硬上限
		var TAU = Math.PI * 2;

		// ── 柔和精灵（sprite）基础设施 ──
		// v1 用 arc() 硬填充 + 纯黑底衬圆做对比度补偿，结果在亮壁纸上露出**可见黑圈**，
		// 雨更是被加粗黑线垫底 → 用户反馈「还有个黑圈」「下雨就是黑线」。
		// v2 改为：把「亮芯 + 柔光 + 极淡的宽幅暗晕」一次性烘焙进离屏 canvas，
		// 绘制时只做 drawImage —— 边缘完全靠径向渐变**羽化**，不再有任何硬边圆环。
		// 暗晕只在半径 55%→100% 之间从很低的不透明度平滑衰减到 0，肉眼看到的是
		// 「淡淡的阴影」而非黑边；且浓度随粒子层深自适应（小/远粒子几乎不带暗晕）。
		var FX_SPRITES = {};            // 精灵缓存（key → canvas | null）

		function fxNewCanvas(w, h) {
			try {
				var cv = document.createElement("canvas");
				cv.width = Math.max(1, Math.ceil(w));
				cv.height = Math.max(1, Math.ceil(h));
				var c = cv.getContext("2d");
				return c ? { cv: cv, c: c } : null;
			} catch (e) { return null; }
		}

		// 六角枝晶精灵（雪花 v3）：以中心为原点做 6 重对称 —— 每条主枝从中心向外
		// 渐细，30%/55%/80% 处生侧枝（夹角约 55-65°），末端加小圆点；中心一枚小亮核。
		// 柔光描边用「先粗淡、后细亮两遍线」烘焙，禁用 shadowBlur（性能红线）。
		// 3 种变体：A 经典枝晶（分枝密）、B 短粗六边形板状、C 带分叉的星芒。
		function fxCrystalSprite(vi) {
			var key = "crystal|" + vi;
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var R = 26, made = fxNewCanvas(R * 2 + 4, R * 2 + 4);
			if (made && typeof made.c.save === "function" && typeof made.c.rotate === "function") {
				var c = made.c, cc = R + 2, i, j;
				try {
					c.lineCap = "round";
					for (i = 0; i < 6; i++) {
						c.save();
						c.translate(cc, cc);
						c.rotate(i * TAU / 6);
						for (j = 0; j < 2; j++) {
							c.strokeStyle = j === 0 ? "rgba(238,246,255,0.16)" : "rgba(238,246,255,0.92)";
							c.lineWidth = j === 0 ? 2.6 : 1.0;
							c.beginPath();
							if (vi === 0) {
								// 变体 A：经典枝晶 —— 主枝 + 3 对递减侧枝
								c.moveTo(0, 0); c.lineTo(R, 0);
								c.moveTo(R * 0.30, 0); c.lineTo(R * 0.30 + 4.2, -6.0);
								c.moveTo(R * 0.30, 0); c.lineTo(R * 0.30 + 4.2, 6.0);
								c.moveTo(R * 0.55, 0); c.lineTo(R * 0.55 + 3.4, -4.6);
								c.moveTo(R * 0.55, 0); c.lineTo(R * 0.55 + 3.4, 4.6);
								c.moveTo(R * 0.80, 0); c.lineTo(R * 0.80 + 2.4, -3.0);
								c.moveTo(R * 0.80, 0); c.lineTo(R * 0.80 + 2.4, 3.0);
							} else if (vi === 1) {
								// 变体 B：短粗六边形板状 —— 六边形轮廓 + 短主枝
								c.moveTo(0, 0); c.lineTo(R * 0.74, 0);
								c.moveTo(R * 0.42, -R * 0.243); c.lineTo(R * 0.21, -R * 0.364);
								c.lineTo(-R * 0.21, -R * 0.364); c.lineTo(-R * 0.42, -R * 0.243);
								c.lineTo(-R * 0.42, R * 0.243); c.lineTo(-R * 0.21, R * 0.364);
								c.lineTo(R * 0.21, R * 0.364); c.lineTo(R * 0.42, R * 0.243);
								c.moveTo(R * 0.58, 0); c.lineTo(R * 0.58 + 3.0, -4.2);
								c.moveTo(R * 0.58, 0); c.lineTo(R * 0.58 + 3.0, 4.2);
							} else {
								// 变体 C：星芒 —— 主枝 60% 处分叉 + 70% 处一对小侧枝
								c.moveTo(0, 0); c.lineTo(R * 0.88, 0);
								c.moveTo(R * 0.60, 0); c.lineTo(R * 0.60 + 7.4, -R * 0.30);
								c.moveTo(R * 0.60, 0); c.lineTo(R * 0.60 + 7.4, R * 0.30);
								c.moveTo(R * 0.72, 0); c.lineTo(R * 0.72 + 2.6, -3.2);
								c.moveTo(R * 0.72, 0); c.lineTo(R * 0.72 + 2.6, 3.2);
							}
							c.stroke();
						}
						c.fillStyle = "rgba(238,246,255,0.9)";
						c.beginPath(); c.arc(R * (vi === 1 ? 0.74 : (vi === 2 ? 0.88 : 1)), 0, 1.1, 0, TAU); c.fill();
						c.restore();
					}
					var g = c.createRadialGradient(cc, cc, 0, cc, cc, 4.5);
					g.addColorStop(0, "rgba(255,255,255,0.95)");
					g.addColorStop(1, "rgba(238,246,255,0)");
					c.fillStyle = g;
					c.beginPath(); c.arc(cc, cc, 4.5, 0, TAU); c.fill();
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// 圆形粒子精灵：暗晕（可关）+ 柔光 + 亮芯
		function fxOrbSprite(R, coreRGB, glowRGB, halo) {
			var key = "orb|" + R + "|" + coreRGB + "|" + glowRGB + "|" + halo;
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var made = fxNewCanvas(R * 4, R * 4);
			if (made && typeof made.c.createRadialGradient === "function") {
				var c = made.c, cc = R * 2;
				try {
					if (halo > 0) {
						var g0 = c.createRadialGradient(cc, cc, R * 0.55, cc, cc, R * 2);
						g0.addColorStop(0, "rgba(0,0,0," + halo + ")");
						g0.addColorStop(1, "rgba(0,0,0,0)");
						c.fillStyle = g0;
						c.beginPath(); c.arc(cc, cc, R * 2, 0, TAU); c.fill();
					}
					var g1 = c.createRadialGradient(cc, cc, 0, cc, cc, R * 1.6);
					g1.addColorStop(0, "rgba(" + glowRGB + ",0.50)");
					g1.addColorStop(0.45, "rgba(" + glowRGB + ",0.16)");
					g1.addColorStop(1, "rgba(" + glowRGB + ",0)");
					c.fillStyle = g1;
					c.beginPath(); c.arc(cc, cc, R * 1.6, 0, TAU); c.fill();
					var g2 = c.createRadialGradient(cc, cc, 0, cc, cc, R * 0.62);
					g2.addColorStop(0, "rgba(" + coreRGB + ",1)");
					g2.addColorStop(0.5, "rgba(" + coreRGB + ",0.72)");
					g2.addColorStop(1, "rgba(" + coreRGB + ",0)");
					c.fillStyle = g2;
					c.beginPath(); c.arc(cc, cc, R * 0.62, 0, TAU); c.fill();
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// 十字光芒精灵（星光 flare v3）：8 芒 —— 主 4 芒（长）+ 斜 4 芒（45°，约 60% 长、
		// 更细更淡）+ 中心柔光。所有线段渐变在预渲染时烘焙，帧内零新建渐变。
		function fxFlareSprite(R, rgb) {
			var key = "flare2|" + R + "|" + rgb;
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var made = fxNewCanvas(R * 2, R * 2);
			if (made && typeof made.c.createLinearGradient === "function") {
				var c = made.c, cc = R, i;
				try {
					for (i = 0; i < 2; i++) {
						var g = i === 0
							? c.createLinearGradient(0, cc, R * 2, cc)
							: c.createLinearGradient(cc, 0, cc, R * 2);
						g.addColorStop(0, "rgba(" + rgb + ",0)");
						g.addColorStop(0.5, "rgba(" + rgb + ",0.85)");
						g.addColorStop(1, "rgba(" + rgb + ",0)");
						c.strokeStyle = g;
						c.lineWidth = 1.5;
						c.lineCap = "round";
						c.beginPath();
						if (i === 0) { c.moveTo(0, cc); c.lineTo(R * 2, cc); }
						else { c.moveTo(cc, 0); c.lineTo(cc, R * 2); }
						c.stroke();
					}
					// 斜 4 芒（45°）：长约 60%、线更细、峰更淡
					var D = R * 0.6 / Math.SQRT2;
					for (i = 0; i < 2; i++) {
						var g2 = i === 0
							? c.createLinearGradient(cc - D, cc - D, cc + D, cc + D)
							: c.createLinearGradient(cc - D, cc + D, cc + D, cc - D);
						g2.addColorStop(0, "rgba(" + rgb + ",0)");
						g2.addColorStop(0.5, "rgba(" + rgb + ",0.5)");
						g2.addColorStop(1, "rgba(" + rgb + ",0)");
						c.strokeStyle = g2;
						c.lineWidth = 0.9;
						c.beginPath();
						if (i === 0) { c.moveTo(cc - D, cc - D); c.lineTo(cc + D, cc + D); }
						else { c.moveTo(cc - D, cc + D); c.lineTo(cc + D, cc - D); }
						c.stroke();
					}
					var g3 = c.createRadialGradient(cc, cc, 0, cc, cc, R * 0.35);
					g3.addColorStop(0, "rgba(" + rgb + ",0.95)");
					g3.addColorStop(1, "rgba(" + rgb + ",0)");
					c.fillStyle = g3;
					c.beginPath(); c.arc(cc, cc, R * 0.35, 0, TAU); c.fill();
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// 溅射精灵（雨 v3）：落点向上外扩的 3 枚小亮点 + 底部主亮点，
		// 全部径向渐变羽化，预渲染一次（单张，无变体档位）。
		function fxSplatSprite() {
			var key = "splat";
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var SZ = 18, made = fxNewCanvas(SZ, SZ);
			if (made && typeof made.c.createRadialGradient === "function") {
				var c = made.c;
				try {
					var pts = [[SZ / 2, SZ - 4, 2.0], [SZ / 2 - 4.5, SZ - 7, 1.4], [SZ / 2 + 4.5, SZ - 7.5, 1.4], [SZ / 2, SZ - 11, 1.2]];
					for (var i = 0; i < pts.length; i++) {
						var g = c.createRadialGradient(pts[i][0], pts[i][1], 0, pts[i][0], pts[i][1], pts[i][2] * 2.4);
						g.addColorStop(0, "rgba(235,246,255,0.95)");
						g.addColorStop(0.5, "rgba(200,226,255,0.5)");
						g.addColorStop(1, "rgba(200,226,255,0)");
						c.fillStyle = g;
						c.beginPath(); c.arc(pts[i][0], pts[i][1], pts[i][2] * 2.4, 0, TAU); c.fill();
					}
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// 雨丝精灵：沿长度方向「尾淡头亮」的线性渐变 + 横向羽化（透镜形）
		// halo > 0 时额外烘焙一层「同形状、更宽、极淡」的暗晕 —— 同样是平滑渐变，
		// 所以看到的是柔和阴影而不是黑线（v1 的黑线垫底正是用户抱怨的那条「黑线」）。
		function fxStreakSprite(len, wide, rgb, halo) {
			var key = "streak|" + len + "|" + wide + "|" + rgb + "|" + halo;
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var W = wide * 2 + 2;
			var made = fxNewCanvas(W, len);
			if (made && typeof made.c.createLinearGradient === "function") {
				var c = made.c, cx = W / 2;
				try {
					function lens(w2) {
						c.beginPath();
						c.moveTo(cx, 0);
						c.quadraticCurveTo(cx + w2, len * 0.7, cx + w2 * 0.45, len);
						c.lineTo(cx - w2 * 0.45, len);
						c.quadraticCurveTo(cx - w2, len * 0.7, cx, 0);
						c.closePath();
					}
					if (halo > 0) {
						c.fillStyle = "rgba(0,0,0," + halo + ")";
						lens(wide * 1.9);
						c.fill();
					}
					var g = c.createLinearGradient(0, 0, 0, len);
					g.addColorStop(0, "rgba(" + rgb + ",0)");        // 尾部（上）完全透明
					g.addColorStop(0.55, "rgba(" + rgb + ",0.30)");
					g.addColorStop(0.88, "rgba(" + rgb + ",0.85)");
					g.addColorStop(1, "rgba(" + rgb + ",0.95)");      // 头部（下）最亮
					c.fillStyle = g;
					lens(wide);
					c.fill();
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// 统一的精灵绘制：以 (x,y) 为中心，半宽 half 铺开
		function fxBlit(ctx, sp, half, x, y, a) {
			if (!sp || typeof ctx.drawImage !== "function") return false;
			ctx.globalAlpha = a;
			ctx.drawImage(sp, x - half, y - half, half * 2, half * 2);
			return true;
		}
		// 精灵不可用时的安全回退（离线桩 / 极老环境）：退回简单的圆点，绝不抛错
		function fxDot(ctx, x, y, r, a, style) {
			ctx.globalAlpha = a;
			ctx.fillStyle = style;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, TAU);
			ctx.fill();
		}

		// 模块级句柄：canvas / ctx / rAF / 粒子状态全部用变量持有，绝不用 querySelector
		var fxCanvas = null, fxCtx = null;
		var fxRaf = null;               // rAF 句柄：null 表示当前没有排队帧
		var fxLooping = false;          // 幂等标志位：true 表示循环已在跑
		var fxState = null;             // 当前特效实例 { step(dt,t,speed), draw(ctx,alpha,t) }
		var fxKind = "none";            // 当前已构建的特效 id
		var fxBuiltCount = 0;           // 构建时的粒子数（强度变化时据此判断重建）
		var fxW = 0, fxH = 0, fxDprCur = 1;
		var fxLast = 0, fxT = 0, fxFrames = 0;
		var fxBroken = false;           // getContext 失败 / 绘制异常 → 安全降级
		var fxReduceMotion = false;     // prefers-reduced-motion: reduce 命中
		var fxMql = null, fxMediaHandler = null;
		var fxOnResizeBound = null;

		// ── 特效参数：取值域与面板滑块严格一致 ──
		function fxNum(v, def, min, max) {
			var n = Number(v);
			if (!isFinite(n)) n = def;
			if (n < min) n = min;
			if (n > max) n = max;
			return n;
		}
		function fxNormId(v) {
			var id = String(v === undefined || v === null ? "" : v);
			return Object.prototype.hasOwnProperty.call(FX_DEFS, id) ? id : "none";
		}
		// 未知 wwp_fx 安全回退 "none"；三个数值越界一律夹紧（绝不抛错）
		function fxSanitizeSettings() {
			S.fx = fxNormId(S.fx);
			S.fxIntensity = fxNum(S.fxIntensity, 0.7, 0.2, 1.5);
			S.fxSpeed = fxNum(S.fxSpeed, 1, 0.2, 3);
			S.fxOpacity = fxNum(S.fxOpacity, 0.8, 0.1, 1);
		}

		// ── 特效 1/6：雪花（三层景深 + 六角枝晶自转；远景柔光点）──
		function makeSnow(w, h, n) {
			var ps = [], i;
			for (i = 0; i < n; i++) {
				var dep = Math.random();                        // 0 = 远，1 = 近
				var r = 1.1 + dep * 3.4;                        // 半径 1.1 - 4.5 px
				ps.push({
					bx: Math.random() * w, x: 0,
					y: Math.random() * h,
					r: r,
					dep: dep,
					cr: dep >= 0.4,                             // 中近景用六角晶体，远景太小仍用柔光点
					vi: (Math.random() * 3) | 0,                // 3 种枝晶变体
					rot: Math.random() * TAU,
					rotV: (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.6),
					vy: 11 + dep * 52,                          // 近景落得更快（景深）
					sway: 3 + dep * 20,                         // 近景摆幅更大
					freq: 0.28 + Math.random() * 0.6,
					phase: Math.random() * TAU,
					alpha: 0.34 + dep * 0.52,                   // 近景更实
					// 少量雪花带极轻微闪烁（幅度很小，不是整片闪）
					tw: Math.random() < 0.16 ? (0.6 + Math.random() * 1.4) : 0
				});
				ps[i].x = ps[i].bx;
			}
			// 远景柔光点（三层各一张，越远越柔）；中近景用六角枝晶精灵（3 变体）
			var spFar = fxOrbSprite(4, "226,236,255", "188,210,255", 0.05);
			var spMid = fxOrbSprite(5, "240,247,255", "206,226,255", 0.09);
			var spNear = fxOrbSprite(7, "250,253,255", "218,234,255", 0.13);
			var crA = fxCrystalSprite(0), crB = fxCrystalSprite(1), crC = fxCrystalSprite(2);
			function spriteFor(dep) { return dep < 0.34 ? spFar : (dep < 0.7 ? spMid : spNear); }
			function crystalFor(vi) { return vi === 0 ? crA : (vi === 1 ? crB : crC); }
			return {
				step: function (dt, t, speed) {
					for (var k = 0; k < ps.length; k++) {
						var p = ps[k];
						p.y += p.vy * speed * dt;
						p.rot += p.rotV * speed * dt;
						p.x = p.bx + Math.sin(t * p.freq + p.phase) * p.sway;
						if (p.y - p.r * 2 > h) { p.y = -p.r * 3 - Math.random() * 30; p.bx = Math.random() * w; }
						if (p.bx < -30) p.bx = w + 30; else if (p.bx > w + 30) p.bx = -30;
					}
				},
				draw: function (ctx, alpha, t) {
					var k, p, a;
					var canRot = typeof ctx.save === "function" && typeof ctx.translate === "function"
						&& typeof ctx.rotate === "function" && typeof ctx.restore === "function";
					for (k = 0; k < ps.length; k++) {
						p = ps[k];
						a = p.alpha * alpha;
						if (p.tw) a *= 0.74 + 0.26 * (0.5 + 0.5 * Math.sin(t * p.tw + p.phase));
						if (p.cr && canRot) {
							var sp = crystalFor(p.vi);
							if (sp && typeof ctx.drawImage === "function") {
								var half = p.r * 3.2 + 2;
								ctx.save();
								ctx.translate(p.x, p.y);
								ctx.rotate(p.rot);
								// 离线桩兼容锚点：软桩不模拟矩阵变换，无法从 drawImage 参数还原
								// 晶体粒子中心（记录成 0,0）。alpha=0 的 arc 对真实渲染零影响，
								// 却让桩的粒子位置/位移统计覆盖到晶体粒子。
								if (typeof ctx.arc === "function" && typeof ctx.beginPath === "function") {
									ctx.globalAlpha = 0;
									ctx.beginPath();
									ctx.arc(p.x, p.y, half, 0, TAU);
								}
								ctx.globalAlpha = a;
								ctx.drawImage(sp, -half, -half, half * 2, half * 2);
								ctx.restore();
								continue;
							}
						}
						if (!fxBlit(ctx, spriteFor(p.dep), p.r * 2.4, p.x, p.y, a)) {
							fxDot(ctx, p.x, p.y, p.r, a, "#f2f7ff");
						}
					}
				}
			};
		}

		// ── 特效 2/6：星光（位置固定 + 独立相位呼吸 + 偶发流星带拖尾）──
		function makeStars(w, h, n) {
			var ps = [], meteors = [], i;
			for (i = 0; i < n; i++) {
				var r = 0.5 + Math.pow(Math.random(), 2.2) * 1.6;   // 多数小星、少量大星
				var slow = Math.random() < 0.22;                     // 少数慢速大闪
				ps.push({
					x: Math.random() * w,                            // 位置固定：生命周期内不再改变
					y: Math.random() * h,
					r: r,
					big: r > 1.45,
					phase: Math.random() * TAU,
					// 闪烁频率分层：多数快速微闪（周期 1-3s），少数慢速大闪（周期 4-8s）
					freq: slow ? (0.78 + Math.random() * 0.79) : (2.1 + Math.random() * 4.2),
					// 颜色分层：冷白为主，少量偏暖 / 偏蓝，增加层次
					rgb: Math.random() < 0.14 ? "255,228,190" : (Math.random() < 0.22 ? "198,220,255" : "244,248,255"),
					// 高频小幅二次微闪：叠在主闪烁上，让星光「抖动发光」而非机械正弦
					freq2: 6 + Math.random() * 7,
					phase2: Math.random() * TAU,
					base: 0.3 + Math.random() * 0.55
				});
			}
			var nextAt = 2 + Math.random() * 5, acc = 0;
			return {
				step: function (dt, t, speed) {
					acc += dt * speed;
					if (acc >= nextAt) {
						nextAt = acc + 6 + Math.random() * 9;            // 每 6 - 15 秒一颗
						var ang = Math.PI * (0.34 + Math.random() * 0.12);  // 向右下
						meteors.push({
							x: Math.random() * w * 0.6, y: -30 - Math.random() * 90,
							ux: Math.cos(ang), uy: Math.sin(ang),
							sp: 620 + Math.random() * 420,
							len: 90 + Math.random() * 130,
							life: 1.5, age: 0
						});
					}
					for (var k = meteors.length - 1; k >= 0; k--) {
						var m = meteors[k];
						m.age += dt * speed;
						m.x += m.ux * m.sp * dt * speed;
						m.y += m.uy * m.sp * dt * speed;
						if (m.age > m.life || m.y > h + 140 || m.x > w + 180) meteors.splice(k, 1);
					}
				},
				draw: function (ctx, alpha, t) {
					var k, p, j, m, a, L, tail, fade, f0, f1, peak, sp;
					// v1 的黑底衬已整体移除 —— 它正是「黑圈 / 灰十字」的来源。
					// 星星改用柔和精灵 + 十字光芒，靠渐变羽化拿对比度，而不是硬边。
					for (k = 0; k < ps.length; k++) {
						p = ps[k];
						// 「一闪一闪」：三次方锐化曲线 → 「暗 → 骤亮 → 暗」的闪光感，
						// 而不是缓慢匀速呼吸；再叠一个高频小幅二次微闪。
						peak = Math.pow(0.5 + 0.5 * Math.sin(t * p.freq + p.phase), 3);
						peak *= 0.86 + 0.14 * (0.5 + 0.5 * Math.sin(t * p.freq2 + p.phase2));
						a = p.base * (0.22 + 0.95 * peak) * alpha;
						if (p.big) {
							// 大星在闪烁峰值拉出十字光芒，长度随峰值增长
							L = p.r * (3.5 + 9 * peak);
							sp = fxFlareSprite(30, p.rgb);
							if (!fxBlit(ctx, sp, L, p.x, p.y, a * (0.3 + 0.7 * peak))) {
								ctx.globalAlpha = a * 0.35 * peak;
								ctx.strokeStyle = "rgb(" + p.rgb + ")";
								ctx.lineWidth = 0.8;
								ctx.beginPath();
								ctx.moveTo(p.x - L, p.y); ctx.lineTo(p.x + L, p.y);
								ctx.moveTo(p.x, p.y - L); ctx.lineTo(p.x, p.y + L);
								ctx.stroke();
							}
						}
						if (!fxBlit(ctx, fxOrbSprite(6, p.rgb, p.rgb, 0), p.r * 3.2, p.x, p.y, a)) {
							fxDot(ctx, p.x, p.y, p.r, a, "rgb(" + p.rgb + ")");
						}
					}
					// 流星：头亮尾渐隐的渐变拖尾（无黑底）
					for (k = 0; k < meteors.length; k++) {
						m = meteors[k];
						fade = 1 - m.age / m.life;
						if (fade <= 0) continue;
						tail = m.len * fade;
						ctx.strokeStyle = "#dff0ff";
						ctx.lineCap = "round";
						for (j = 0; j < 7; j++) {
							f0 = j / 7; f1 = (j + 1) / 7;
							ctx.globalAlpha = alpha * fade * 0.95 * (1 - f0) * (1 - f0);
							ctx.lineWidth = 0.6 + 2.0 * (1 - f0);
							ctx.beginPath();
							ctx.moveTo(m.x - m.ux * tail * f0, m.y - m.uy * tail * f0);
							ctx.lineTo(m.x - m.ux * tail * f1, m.y - m.uy * tail * f1);
							ctx.stroke();
						}
						if (!fxBlit(ctx, fxOrbSprite(6, "255,255,255", "208,230,255", 0), 11, m.x, m.y, alpha * fade)) {
							fxDot(ctx, m.x, m.y, 2.8, alpha * fade, "#ffffff");
						}
					}
				}
			};
		}

		// ── 特效 3/6：雨（约 15° 右倾细线，落速远快于雪花，带拖尾）──
		function makeRain(w, h, n) {
			var SLOPE = 0.28;                                    // ≈ 15.6° 倾角
			var K = 1 / Math.sqrt(1 + SLOPE * SLOPE);
			var ANG = Math.atan2(K, SLOPE * K);                  // 下落方向角（精灵旋转用）
			var ps = [], i;
			for (i = 0; i < n; i++) {
				var dep = Math.random();                          // 0 = 远，1 = 近
				var base = 16 + dep * 44;                         // 指数长度基准：近处更长
				// 指数分布：多数短、少数长（-ln(U) 均值为 1），夹紧防极端长丝
				var eLen = base * (-Math.log(1 - Math.random()));
				if (eLen < base * 0.25) eLen = base * 0.25;
				if (eLen > base * 2.8) eLen = base * 2.8;
				ps.push({
					bx: Math.random() * (w + 160) - 80, x: 0,
					y: Math.random() * h * 1.2 - h * 0.2,
					dep: dep,
					len: eLen,
					vy: 760 + dep * 760,                         // 雪花约 25-52 px/s，雨明显更快
					alpha: 0.22 + dep * 0.52,
					spl: false                                   // 本轮下落是否已触发过溅射
				});
				ps[i].x = ps[i].bx;
			}
			// 溅射：独立数组 + 独立硬上限 24（不计入 900 粒子上限，超出丢弃）
			var splats = [], SPLAT_MAX = 24;
			var spSplat = fxSplatSprite();
			// 预渲染雨丝精灵：头亮尾渐隐 + 横向羽化 + 极淡宽幅暗晕（柔和阴影，不是黑线）
			var spFar = fxStreakSprite(46, 1.5, "196,220,255", 0.05);
			var spMid = fxStreakSprite(70, 2.1, "212,232,255", 0.08);
			var spNear = fxStreakSprite(104, 2.9, "230,243,255", 0.11);
			function spriteFor(dep) { return dep < 0.34 ? spFar : (dep < 0.7 ? spMid : spNear); }
			return {
				step: function (dt, t, speed) {
					var sdt = dt * speed;
					for (var k = 0; k < ps.length; k++) {
						var p = ps[k];
						p.y += p.vy * sdt;
						p.bx += p.vy * SLOPE * sdt;
						p.x = p.bx;
						// 落地溅射：头部触地（只判一次）以约 30% 概率生成，超上限丢弃
						if (!p.spl && p.y >= h - 2) {
							p.spl = true;
							if (Math.random() < 0.3 && splats.length < SPLAT_MAX) {
								splats.push({
									x: p.x, y: Math.min(h - 3, p.y),
									age: 0,
									life: 0.12 + Math.random() * 0.08   // 120-200ms
								});
							}
						}
						if (p.y - p.len > h) {
							p.y = -p.len - Math.random() * h * 0.5;
							p.bx = Math.random() * (w + 160) - 80;
							p.x = p.bx;
							p.spl = false;
						}
						if (p.bx > w + 80) { p.bx -= w + 160; p.x = p.bx; }
					}
					for (var m = splats.length - 1; m >= 0; m--) {
						splats[m].age += sdt;
						if (splats[m].age >= splats[m].life) splats.splice(m, 1);
					}
				},
				draw: function (ctx, alpha) {
					var k, p, sp, dx, dy, sw;
					// v1 的「加粗黑线垫底」已整体移除 —— 它正是用户说的「雨就是黑线」。
					// 改为绘制带渐变羽化的雨丝精灵：读作「光的水痕」。
					var canXform = typeof ctx.save === "function" && typeof ctx.translate === "function" && typeof ctx.rotate === "function";
					ctx.lineCap = "round";
					for (k = 0; k < ps.length; k++) {
						p = ps[k];
						sp = spriteFor(p.dep);
						if (sp && canXform && typeof ctx.drawImage === "function") {
							ctx.save();
							ctx.translate(p.x, p.y);
							ctx.rotate(ANG - Math.PI / 2);        // 精灵 +y 对齐下落方向，亮头落在笔尖
							ctx.globalAlpha = p.alpha * alpha;
							// 等比缩放：宽随「len / 精灵原始高」缩放，保证雨丝纤细
							// （此前宽取 0.44*len，近景会被水平拉伸成 20px 宽的「纸条」）
							sw = sp.height > 0 ? sp.width * (p.len / sp.height) : p.len * 0.2;
							ctx.drawImage(sp, -sw / 2, -p.len, sw, p.len);
							ctx.restore();
						} else {
							// 回退：柔和的细线（无黑底）
							dx = SLOPE * K * p.len; dy = K * p.len;
							ctx.globalAlpha = p.alpha * alpha;
							ctx.strokeStyle = "#cfe4ff";
							ctx.lineWidth = 1.1;
							ctx.beginPath();
							ctx.moveTo(p.x, p.y);
							ctx.lineTo(p.x - dx, p.y - dy);
							ctx.stroke();
						}
					}
					// 溅射：随年龄淡出并轻微向上外扩（scale 不可用时固定大小）
					if (splats.length && spSplat && typeof ctx.drawImage === "function") {
						var canScale = typeof ctx.save === "function" && typeof ctx.translate === "function"
							&& typeof ctx.scale === "function" && typeof ctx.restore === "function";
						for (k = 0; k < splats.length; k++) {
							var st = splats[k];
							var sa = alpha * (1 - st.age / st.life);
							if (sa <= 0.01) continue;
							var grow = 1 + 0.5 * (st.age / st.life);
							if (canScale) {
								ctx.save();
								ctx.translate(st.x, st.y);
								ctx.scale(grow, grow * 0.8);
								ctx.globalAlpha = sa;
								ctx.drawImage(spSplat, -9, -9, 18, 18);
								ctx.restore();
							} else {
								fxBlit(ctx, spSplat, 9, st.x, st.y, sa);
							}
						}
					}
				}
			};
		}

		// 樱花整花精灵（v3）：96px 高分辨率预渲染 —— 5 瓣贝塞尔路径统一用「以花心为
		// 圆心的径向渐变」填色（根部 #f8a8c8 深 → 瓣尖 #ffe4ef 浅），花心 6 枚 #ffd24d
		// 小蕊点。draw 时只做 save/rotate/scale/drawImage，帧内零渐变。
		function fxFlowerSprite() {
			var key = "flower";
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var SZ = 96, made = fxNewCanvas(SZ, SZ);
			if (made && typeof made.c.createRadialGradient === "function") {
				var c = made.c, cc = SZ / 2, R = 40, j;
				try {
					var g = c.createRadialGradient(cc, cc, 0, cc, cc, R);
					g.addColorStop(0, "#f8a8c8");
					g.addColorStop(0.55, "#ffc9dd");
					g.addColorStop(1, "#ffe4ef");
					c.fillStyle = g;
					c.beginPath();
					for (j = 0; j < 5; j++) {
						var a = j * TAU / 5 + 0.35;
						var ca = Math.cos(a), sa = Math.sin(a);
						var tx = cc + ca * R, ty = cc + sa * R;
						var px = -sa * R * 0.45, py = ca * R * 0.45;
						c.moveTo(cc, cc);
						c.quadraticCurveTo(cc + ca * R * 0.55 + px, cc + sa * R * 0.55 + py, tx, ty);
						c.quadraticCurveTo(cc + ca * R * 0.55 - px, cc + sa * R * 0.55 - py, cc, cc);
					}
					c.fill();
					// 花心小蕊点（预渲染时固定布局，运行期零随机）
					c.fillStyle = "#ffd24d";
					for (j = 0; j < 6; j++) {
						var ra = j * TAU / 6 + 0.5;
						var rr = 3 + (j % 2) * 2.2;
						c.beginPath();
						c.arc(cc + Math.cos(ra) * rr, cc + Math.sin(ra) * rr, 1.6, 0, TAU);
						c.fill();
					}
					c.beginPath(); c.arc(cc, cc, 2.2, 0, TAU); c.fill();
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// ── 特效 4/6：樱花（预渲染整花精灵，边落边自转 + 3D 翻页 + 左右飘摆）──
		function makeSakura(w, h, n) {
			var ps = [], i;
			for (i = 0; i < n; i++) {
				ps.push({
					bx: Math.random() * w, x: 0,
					y: Math.random() * h,
					r: 6 + Math.random() * 7,                    // 花瓣半径 6 - 13 px
					rot: Math.random() * TAU,
					vrot: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 1.1),
					vy: 20 + Math.random() * 30,
					sway: 12 + Math.random() * 26,
					freq: 0.3 + Math.random() * 0.5,
					phase: Math.random() * TAU,
					alpha: 0.55 + Math.random() * 0.35,
					flipFreq: TAU / (2 + Math.random() * 2),     // 翻页周期约 2-4s
					flipPhase: Math.random() * TAU
				});
				ps[i].x = ps[i].bx;
			}
			var spFlower = fxFlowerSprite();
			return {
				step: function (dt, t, speed) {
					for (var k = 0; k < ps.length; k++) {
						var p = ps[k];
						// 翻到侧边（scaleX 小）时阻力小、略加速，幅度小
						var sx = 0.25 + 0.75 * Math.abs(Math.cos(t * p.flipFreq + p.flipPhase));
						p.y += p.vy * speed * dt * (1 + 0.18 * (1 - sx));
						p.rot += p.vrot * speed * dt;
						p.x = p.bx + Math.sin(t * p.freq + p.phase) * p.sway;
						if (p.y - p.r > h) { p.y = -p.r * 2 - Math.random() * 40; p.bx = Math.random() * w; }
						if (p.bx < -40) p.bx = w + 40; else if (p.bx > w + 40) p.bx = -40;
					}
				},
				draw: function (ctx, alpha, t) {
					var k, p, sx;
					var canXform = spFlower && typeof ctx.drawImage === "function"
						&& typeof ctx.save === "function" && typeof ctx.restore === "function"
						&& typeof ctx.translate === "function" && typeof ctx.rotate === "function"
						&& typeof ctx.scale === "function";
					for (k = 0; k < ps.length; k++) {
						p = ps[k];
						if (canXform) {
							// 3D 翻页：透视收缩（约 2-4s 一圈），这是「不假」的关键
							sx = 0.25 + 0.75 * Math.abs(Math.cos(t * p.flipFreq + p.flipPhase));
							var half = p.r * 1.9;
							ctx.save();
							ctx.translate(p.x, p.y);
							ctx.rotate(p.rot);
							ctx.scale(sx, 1);
							ctx.globalAlpha = p.alpha * alpha;
							ctx.drawImage(spFlower, -half, -half, half * 2, half * 2);
							ctx.restore();
							continue;
						}
						// 回退（离线桩 / 极老环境）：v2 的贝塞尔路径，绝不抛错
						ctx.save();
						ctx.translate(p.x, p.y);
						ctx.rotate(p.rot);
						ctx.beginPath();
						for (var j = 0; j < 5; j++) {
							var a = j * TAU / 5 + 0.35;
							var ca = Math.cos(a), sa = Math.sin(a);
							var tx = ca * p.r, ty = sa * p.r;
							var px = -sa * p.r * 0.45, py = ca * p.r * 0.45;
							ctx.moveTo(0, 0);
							ctx.quadraticCurveTo(tx * 0.55 + px, ty * 0.55 + py, tx, ty);
							ctx.quadraticCurveTo(tx * 0.55 - px, ty * 0.55 - py, 0, 0);
						}
						ctx.globalAlpha = p.alpha * alpha;
						ctx.fillStyle = "#ffd7e6";
						ctx.fill();
						ctx.globalAlpha = p.alpha * alpha * 0.55;
						ctx.fillStyle = "#ffe9a8";
						ctx.beginPath();
						ctx.arc(0, 0, p.r * 0.18, 0, TAU);
						ctx.fill();
						ctx.restore();
					}
				}
			};
		}

		// ── 特效 5/6：萤火虫（绿色脉冲发光 + 短尾迹 + 随机游走）──
		function makeFireflies(w, h, n) {
			var ps = [], i;
			for (i = 0; i < n; i++) {
				var dep = Math.random();                         // 0 = 远，1 = 近
				ps.push({
					x: Math.random() * w, y: Math.random() * h,
					// 短尾迹：上一帧 / 上上帧位置（运动残影）
					hx1: 0, hy1: 0, hx2: 0, hy2: 0,
					ang: Math.random() * TAU,
					sp: 6 + Math.random() * 16,
					dep: dep,
					r: 1.1 + dep * 2.0,                          // 近处更大更亮
					glow: 0,                                     // 脉冲余辉 0-1
					rate: 0.5 + Math.random(),                   // 脉冲触发率 0.5-1.5 次/秒
					alpha: 0.34 + dep * 0.55
				});
				ps[i].hx1 = ps[i].hx2 = ps[i].x;
				ps[i].hy1 = ps[i].hy2 = ps[i].y;
			}
			// 绿色光晕精灵：中心偏青绿、外圈偏正绿 → 自然的绿色辉光（不再用暖黄）
			var spFar = fxOrbSprite(5, "168,255,207", "58,190,108", 0.06);
			var spNear = fxOrbSprite(8, "188,255,216", "44,168,94", 0.11);
			function spriteFor(dep) { return dep < 0.55 ? spFar : spNear; }
			return {
				step: function (dt, t, speed) {
					var sdt = dt * speed;
					for (var k = 0; k < ps.length; k++) {
						var p = ps[k];
						// 记录尾迹历史（上帧 → 上上帧），再前进
						p.hx2 = p.hx1; p.hy2 = p.hy1;
						p.hx1 = p.x; p.hy1 = p.y;
						p.ang += (Math.random() - 0.5) * 2.2 * sdt;      // 方向缓变（随机游走）
						p.x += Math.cos(p.ang) * p.sp * sdt;
						p.y += Math.sin(p.ang) * p.sp * sdt;
						if (p.x < 0) { p.x = 0; p.ang = Math.PI - p.ang; }
						else if (p.x > w) { p.x = w; p.ang = Math.PI - p.ang; }
						if (p.y < 0) { p.y = 0; p.ang = -p.ang; }
						else if (p.y > h) { p.y = h; p.ang = -p.ang; }
						// 脉冲式发光：随机触发（0.5-1.5 次/秒）升至 1，再指数余辉衰减
						if (p.glow <= 0.02 && Math.random() < p.rate * sdt) p.glow = 1;
						else p.glow *= Math.exp(-sdt * 2.2);
					}
				},
				draw: function (ctx, alpha, t) {
					var k, p, a;
					// v1 的暗色底衬已整体移除（黑圈来源之一）。
					// 改用「绿色柔光 + 亮芯」的精灵：alpha = base * (0.15 + 0.85 * glow)，
					// 长时间低亮 + 短促高亮的间歇脉冲，替代均匀正弦呼吸。
					for (k = 0; k < ps.length; k++) {
						p = ps[k];
						a = p.alpha * (0.15 + 0.85 * p.glow) * alpha;
						var sp = spriteFor(p.dep);
						var half = p.r * 3.2;
						// 短尾迹：上 1-2 帧位置以 30%/15% alpha 补画缩小精灵
						if (p.glow > 0.12 && sp) {
							fxBlit(ctx, sp, half * 0.62, p.hx1, p.hy1, a * 0.3);
							fxBlit(ctx, sp, half * 0.45, p.hx2, p.hy2, a * 0.15);
						}
						if (!fxBlit(ctx, sp, half, p.x, p.y, a)) {
							fxDot(ctx, p.x, p.y, p.r, a, "#7CFFB2");
						}
					}
				}
			};
		}

		// 气泡环精灵（v3）：createLinearGradient 竖向渐变描环（上亮下暗更立体）
		// + 左上高光弧 + 极淡内部填充，全部烘焙进离屏 canvas。4 档半径，无逐粒子精灵。
		function fxBubbleSprite(R) {
			var key = "bubble|" + R;
			if (Object.prototype.hasOwnProperty.call(FX_SPRITES, key)) return FX_SPRITES[key];
			var sp = null;
			var SZ = R * 2 + 6, made = fxNewCanvas(SZ, SZ);
			if (made && typeof made.c.createLinearGradient === "function") {
				var c = made.c, cc = SZ / 2;
				try {
					// 极淡内部填充：让气泡有一点点「膜」的存在感
					c.fillStyle = "rgba(190,225,255,0.10)";
					c.beginPath(); c.arc(cc, cc, R, 0, TAU); c.fill();
					// 渐变环：上亮 rgba(214,236,255,0.95) → 下暗 rgba(150,190,230,0.45)
					var g = c.createLinearGradient(0, cc - R, 0, cc + R);
					g.addColorStop(0, "rgba(214,236,255,0.95)");
					g.addColorStop(1, "rgba(150,190,230,0.45)");
					c.strokeStyle = g;
					c.lineWidth = 1.6;
					c.beginPath(); c.arc(cc, cc, R, 0, TAU); c.stroke();
					// 左上高光弧
					c.strokeStyle = "rgba(255,255,255,0.85)";
					c.lineWidth = 1.4;
					c.lineCap = "round";
					c.beginPath(); c.arc(cc, cc, R * 0.62, Math.PI * 1.05, Math.PI * 1.55); c.stroke();
					sp = made.cv;
				} catch (e) { sp = null; }
			}
			FX_SPRITES[key] = sp;
			return sp;
		}

		// ── 特效 6/6：气泡（渐变环精灵 + 形变呼吸 + 顶部淡出，自下而上浮起）──
		function makeBubbles(w, h, n) {
			var ps = [], i;
			for (i = 0; i < n; i++) {
				ps.push({
					bx: Math.random() * w, x: 0,
					y: Math.random() * h,
					r: 3 + Math.random() * 10,
					vy: 14 + Math.random() * 30,                 // 向上
					sway: 6 + Math.random() * 20,
					freq: 0.35 + Math.random() * 0.6,
					phase: Math.random() * TAU,
					alpha: 0.2 + Math.random() * 0.3
				});
				ps[i].x = ps[i].bx;
			}
			// 4 档半径精灵（变体上限 ≤4）
			var B_R = [4, 6.5, 9.5, 13], B_SP = [];
			for (i = 0; i < 4; i++) B_SP.push(fxBubbleSprite(B_R[i]));
			function spriteFor(r) {
				if (r < 5.2) return B_SP[0];
				if (r < 8) return B_SP[1];
				if (r < 11.2) return B_SP[2];
				return B_SP[3];
			}
			return {
				step: function (dt, t, speed) {
					for (var k = 0; k < ps.length; k++) {
						var p = ps[k];
						p.y -= p.vy * speed * dt;
						p.x = p.bx + Math.sin(t * p.freq + p.phase) * p.sway;
						if (p.y + p.r < 0) { p.y = h + p.r + Math.random() * 40; p.bx = Math.random() * w; }
						if (p.bx < -30) p.bx = w + 30; else if (p.bx > w + 30) p.bx = -30;
					}
				},
				draw: function (ctx, alpha, t) {
					var k, p;
					var canXform = typeof ctx.save === "function" && typeof ctx.restore === "function"
						&& typeof ctx.translate === "function" && typeof ctx.scale === "function";
					var fadeTop = h * 0.12;
					for (k = 0; k < ps.length; k++) {
						p = ps[k];
						// 顶部淡出：y < h*0.12 后 alpha 线性降到 0（避免顶到边突然消失）
						var a = p.alpha * alpha;
						if (p.y < fadeTop) a *= Math.max(0, p.y / fadeTop);
						if (a <= 0.01) continue;
						var sp = spriteFor(p.r);
						if (sp && canXform && typeof ctx.drawImage === "function") {
							// 形变呼吸：轻微横向挤压（sx = 1 ± 0.07）
							var sx = 1 + 0.07 * Math.sin(t * 2.1 + p.phase);
							var half = p.r + 3;                  // 精灵自带 3px 边距
							ctx.save();
							ctx.translate(p.x, p.y);
							ctx.scale(sx, 1);
							ctx.globalAlpha = a;
							ctx.drawImage(sp, -half, -half, half * 2, half * 2);
							ctx.restore();
							continue;
						}
						// 回退（离线桩 / 极老环境）：v2 的柔蓝圆 + 高光弧，绝不抛错
						ctx.globalAlpha = a * 0.35;
						ctx.fillStyle = "#bfe3ff";
						ctx.beginPath();
						ctx.arc(p.x, p.y, p.r, 0, TAU);
						ctx.fill();
						ctx.globalAlpha = a;
						ctx.strokeStyle = "#9dc7ea";
						ctx.lineWidth = 1.2;
						ctx.beginPath();
						ctx.arc(p.x, p.y, p.r, 0, TAU);
						ctx.stroke();
						ctx.globalAlpha = Math.min(1, a * 1.8);
						ctx.lineWidth = 1.3;
						ctx.beginPath();
						ctx.arc(p.x, p.y, p.r * 0.62, Math.PI * 1.05, Math.PI * 1.55);
						ctx.stroke();
					}
				}
			};
		}

		// ── 特效表（id 逐字对应契约 §4）──
		var FX_DEFS = {
			snow:      { label: "雪花",   base: function (w, h) { return Math.round(w * h / 6000); },  make: makeSnow },
			stars:     { label: "星光",   base: function (w, h) { return Math.round(w * h / 8000); },  make: makeStars },
			rain:      { label: "雨",     base: function (w, h) { return Math.round(w * h / 3600); },  make: makeRain },
			sakura:    { label: "樱花",   base: function (w, h) { return Math.round(w * h / 20000); }, make: makeSakura },
			fireflies: { label: "萤火虫", base: function (w, h) { return Math.round(w * h / 14000); }, make: makeFireflies },
			bubbles:   { label: "气泡",   base: function (w, h) { return Math.round(w * h / 16000); }, make: makeBubbles }
		};

		// 最终粒子数 = 基准（按视口面积）× 强度，并夹在 [min, cap] 与硬上限 900 之间
		function fxDesiredCount(w, h, id) {
			var def = FX_DEFS[id];
			if (!def) return 0;
			var n = Math.round(def.base(w, h) * S.fxIntensity);
			if (def.min && n < def.min) n = def.min;
			if (def.cap && n > def.cap) n = def.cap;
			if (n < 1) n = 1;
			if (n > FX_MAX) n = FX_MAX;
			return n;
		}

		// ── 特效层：尺寸 / 上下文 / 降级判定 ──
		function fxDpr() {
			var d = 1;
			try { d = window.devicePixelRatio || 1; } catch (e) { d = 1; }
			if (!(d > 0)) d = 1;
			return Math.min(2, d);                       // DPR 上限 2（性能保护）
		}
		function fxViewSize() {
			var w = 0, h = 0;
			try { w = window.innerWidth || 0; h = window.innerHeight || 0; } catch (e) {}
			if (!w && document.documentElement) w = document.documentElement.clientWidth || 0;
			if (!h && document.documentElement) h = document.documentElement.clientHeight || 0;
			if (!(w > 0)) w = 1;
			if (!(h > 0)) h = 1;
			return [w, h];
		}
		function fxNow() {
			if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
				try { return performance.now(); } catch (e) {}
			}
			return Date.now();
		}
		function fxHasRaf() { return typeof requestAnimationFrame === "function"; }

		// 「应该绘制」只取决于选中 / 启用 / 上下文可用，不含页面可见性与动效偏好
		function fxActive() {
			return !!(fxCanvas && fxCtx && !fxBroken && S.enabled && S.fx && S.fx !== "none" && FX_DEFS[S.fx]);
		}
		function fxVisible() { return !document.hidden; }

		function fxClearAll() {
			if (!fxCtx) return;
			try { fxCtx.clearRect(0, 0, fxW, fxH); } catch (e) {}
		}

		// 被 onVisibility 与 resize 监听调用 → 异常必须就地消化，不能逃逸进事件处理器
		function fxBuild() {
			var def = FX_DEFS[S.fx];
			if (!def) { fxState = null; fxKind = "none"; fxBuiltCount = 0; return; }
			try {
				fxBuiltCount = fxDesiredCount(fxW, fxH, S.fx);
				fxState = def.make(fxW, fxH, fxBuiltCount);
				fxKind = S.fx;
				fxT = 0;
				fxFrames = 0;
			} catch (e) {
				// 粒子构建失败（含离屏 canvas / 2D API 不可用）→ 降级并提示一次，绝不抛进事件处理器
				fxState = null; fxKind = "none"; fxBuiltCount = 0;
				fxMarkBroken();
			}
		}

		function fxResize(force) {
			if (!fxCanvas) return;
			var size = fxViewSize();
			var w = size[0], h = size[1], dpr = fxDpr();
			if (!force && w === fxW && h === fxH && dpr === fxDprCur) return;
			fxW = w; fxH = h; fxDprCur = dpr;
			try {
				fxCanvas.width = Math.max(1, Math.round(w * dpr));
				fxCanvas.height = Math.max(1, Math.round(h * dpr));
			} catch (e) {}
			// 改尺寸会重置上下文状态，因此随后重设 DPR 变换，使坐标回到 CSS 像素
			if (fxCtx) { try { fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) {} }
			if (fxState) fxBuild();                      // 视口变化 → 粒子重新布局
		}

		// broken 状态迁移的唯一入口：只在「非 broken → broken」时提示一次，
		// 避免绘制异常时每帧刷屏（fxBroken 粘滞后 UI 仍显示已开启、画面空白且零提示）。
		// 用户重新选择特效时，面板 change 处理器会先把 fxBroken / fxBrokenNoted 复位再重试。
		var fxBrokenNoted = false;      // 提示是否已发出（防刷屏）
		function fxNoteBroken() {
			// note 元素由 buildUI() 创建，而 fxAttach() 早于 buildUI()：
			// 此时不能把 fxBrokenNoted 置位，留给后续 fxSync() 补发一次，避免提示被静默吞掉。
			if (fxBrokenNoted || !note) return;
			fxBrokenNoted = true;
			noteMsg("特效绘制失败，已自动停用；可重新选择特效重试");
		}
		function fxMarkBroken() {
			if (fxBroken) return;
			fxBroken = true;
			fxNoteBroken();
		}

		// prefers-reduced-motion 命中时只画一帧静态画面，不启动动画循环
		function fxStaticFrame() {
			if (!fxState || !fxCtx) return;
			try {
				fxCtx.globalAlpha = 1;
				fxCtx.globalCompositeOperation = "source-over";
				fxCtx.clearRect(0, 0, fxW, fxH);
				fxState.step(0, 0, 0);
				fxState.draw(fxCtx, S.fxOpacity, 0);
				fxCtx.globalAlpha = 1;
			} catch (e) { fxMarkBroken(); }
		}

		// ── 渲染循环（rAF + dt 钳制 + 幂等启停）──
		function fxFrame(ts) {
			fxRaf = null;                                // 本帧已开始执行：句柄先置空
			if (!fxActive() || !fxVisible() || fxReduceMotion || !fxState) { fxLooping = false; return; }
			var now = (typeof ts === "number" && isFinite(ts)) ? ts : fxNow();
			if (!fxLast) fxLast = now;
			var ms = now - fxLast;
			fxLast = now;
			if (!(ms > 0)) ms = 16.7;
			if (ms > 50) ms = 50;                        // 钳制上限：切回标签页不瞬移
			var dt = ms / 1000;
			fxT += dt;
			fxFrames++;
			try {
				fxCtx.globalAlpha = 1;
				fxCtx.globalCompositeOperation = "source-over";
				fxCtx.clearRect(0, 0, fxW, fxH);         // 每帧整屏清空
				fxState.step(dt, fxT, S.fxSpeed);
				fxState.draw(fxCtx, S.fxOpacity, fxT);
				fxCtx.globalAlpha = 1;
			} catch (e) {
				// 绘制异常（含离线桩缺 2D API）→ 停循环并降级；只在首次置 broken 时提示一次
				fxMarkBroken();
				fxLooping = false;
				return;
			}
			if (fxLooping) fxRaf = requestAnimationFrame(fxFrame);
		}

		function fxStart() {
			if (fxLooping || fxRaf !== null) return;     // 幂等：已有排队帧就不再启动
			if (!fxActive() || !fxVisible() || fxReduceMotion || !fxHasRaf()) return;
			fxLooping = true;
			fxLast = 0;
			// 双标志必须同生同灭：rAF 抛错时若只留下 fxLooping=true 而无排队帧，
			// 下一次 fxStart 会被第一行直接挡回 → 永久卡死（true 且无排队帧）。
			if (fxLooping) {
				try { fxRaf = requestAnimationFrame(fxFrame); }
				catch (e) { fxLooping = false; fxRaf = null; }
			}
		}
		function fxStop() {
			if (fxRaf !== null) {
				try { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(fxRaf); } catch (e) {}
				fxRaf = null;
			}
			fxLooping = false;
		}

		// 唯一的状态同步入口：选中 / 启用 / 可见性 / 尺寸 / 动效偏好变化后都调它
		function fxSync() {
			if (!fxCanvas) return;
			if (fxBroken) fxNoteBroken();                // note 晚于 fxAttach 创建 → 在此补发提示
			if (!fxActive()) {
				fxStop();
				fxClearAll();
				if (fxCanvas.classList) fxCanvas.classList.add(FX_OFF);
				fxState = null; fxKind = "none"; fxBuiltCount = 0;
				return;
			}
			if (fxCanvas.classList) fxCanvas.classList.remove(FX_OFF);
			fxResize(false);
			var want = fxDesiredCount(fxW, fxH, S.fx);
			if (fxKind !== S.fx || fxBuiltCount !== want || !fxState) fxBuild();
			if (!fxVisible()) { fxStop(); return; }      // 页面隐藏：暂停但保留粒子状态
			if (fxReduceMotion) { fxStop(); fxStaticFrame(); return; }
			fxStart();
		}

		// ── 动效偏好（matchMedia 不可用时安全跳过）──
		function fxSetupMedia() {
			if (fxMql) return;
			try {
				if (typeof matchMedia !== "function") return;
				fxMql = matchMedia("(prefers-reduced-motion: reduce)");
				if (!fxMql) return;
				fxReduceMotion = !!fxMql.matches;
				fxMediaHandler = function () {
					fxReduceMotion = !!(fxMql && fxMql.matches);
					fxSync();
				};
				if (typeof fxMql.addEventListener === "function") fxMql.addEventListener("change", fxMediaHandler);
				else if (typeof fxMql.addListener === "function") fxMql.addListener(fxMediaHandler);
				else fxMediaHandler = null;              // 无法监听：只用初始值
			} catch (e) { fxMql = null; fxMediaHandler = null; }
		}
		function fxTeardownMedia() {
			if (fxMql && fxMediaHandler) {
				try {
					if (typeof fxMql.removeEventListener === "function") fxMql.removeEventListener("change", fxMediaHandler);
					else if (typeof fxMql.removeListener === "function") fxMql.removeListener(fxMediaHandler);
				} catch (e) {}
			}
			fxMql = null; fxMediaHandler = null; fxReduceMotion = false;
		}

		// ── 特效层挂载 / 卸载 ──
		function fxAttach() {
			fxDetach();                                  // 幂等：先清掉上一轮残留
			if (!document.body) return;
			fxSetupMedia();
			var el = document.createElement("canvas");
			el.setAttribute("id", FX_ID);
			try { el.id = FX_ID; } catch (e) {}
			if (el.classList) el.classList.add(FX_OFF);  // 未选特效时 display:none
			// 在 #wwp-bg 之后插入 → DOM 顺序决定它绘制在壁纸遮罩之上
			document.body.appendChild(el);
			fxCanvas = el;
			fxCtx = null;
			try { fxCtx = (typeof el.getContext === "function") ? el.getContext("2d") : null; } catch (e) { fxCtx = null; }
			if (!fxCtx) fxMarkBroken();                  // 安全降级：不抛错、不启动循环，并提示一次
			fxOnResizeBound = function () { fxSync(); }; // 模块级只注册一次，cleanup 时移除
			try { window.addEventListener("resize", fxOnResizeBound); } catch (e) {}
			fxW = 0; fxH = 0;
			fxResize(true);
		}
		function fxDetach() {
			fxStop();
			if (fxOnResizeBound) {
				try { window.removeEventListener("resize", fxOnResizeBound); } catch (e) {}
				fxOnResizeBound = null;
			}
			fxTeardownMedia();
			if (fxCanvas) { try { fxCanvas.remove(); } catch (e) {} }
			fxCanvas = null; fxCtx = null;
			fxState = null; fxKind = "none"; fxBuiltCount = 0;
			fxW = 0; fxH = 0; fxDprCur = 1; fxLast = 0; fxT = 0; fxFrames = 0;
			fxBroken = false; fxBrokenNoted = false; fxLooping = false; fxRaf = null;
		}

		// 未知 wwp_fx 值在模块加载时即回退，避免后续任何分支读到脏值
		fxSanitizeSettings();

		// ── 类型判定（唯一入口）──
		// 老记录没有 type 字段，靠 mime 兜底；两者都缺则按图片处理，保证向后兼容。
		function recType(rec) {
			if (!rec) return "image";
			if (rec.type === "video") return "video";
			if (rec.type === "image") return "image";
			if (/^video\//.test(String(rec.mime || ""))) return "video";
			return "image";
		}
		function isVideoMime(mime) {
			return /^video\//.test(String(mime || ""));
		}
		var VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v|mkv)([?#].*)?$/i;
		function isVideoFile(file) {
			if (!file) return false;
			// MIME 明确时以 MIME 为准；MIME 缺失（空串 / octet-stream）才退回扩展名
			if (isVideoMime(file.type)) return true;
			if (/^image\//.test(String(file.type || ""))) return false;
			return VIDEO_EXT.test(String(file.name || ""));
		}
		function isVideoUrl(url) {
			try { return VIDEO_EXT.test(String(url || "")); } catch (e) { return false; }
		}

		// 释放当前的 blob object URL（幂等）
		function revokeVideoUrl() {
			if (videoObjectUrl) {
				try { URL.revokeObjectURL(videoObjectUrl); } catch (e) {}
				videoObjectUrl = null;
			}
		}
		// 把原图的 filters 施加到 #wwp-bg 父元素上（视频子元素自然继承，遮罩 ::after 语义不变）
		function applyFilter() {
			var parts = [];
			if (S.blur > 0) parts.push("blur(" + S.blur + "px)");
			if (S.bright && S.bright !== 1) parts.push("brightness(" + S.bright + ")");
			bg.style.filter = parts.join(" ");
			bg.style.transform = S.blur > 0 ? "scale(1.06)" : "";
		}
		// 视频元素的 S.fit 映射：cover/tile → cover；contain/center → contain
		function videoFit() {
			return (S.fit === "contain" || S.fit === "center") ? "contain" : "cover";
		}

		function noteMsg(text) {
			if (note) note.textContent = text || "";
			if (text) {
				clearTimeout(noteMsg._t);
				noteMsg._t = setTimeout(function () { if (note) note.textContent = ""; }, 4000);
			}
		}

		// ── 背景渲染 ──
		
		// 视频元素在 apply() 时创建，挂在 #wwp-bg 内部（spec §2）。
		// 图片壁纸时它保持 display:none + 无 src；只用模块级 videoEl 持有，
		// 绝不 querySelector（离线自检桩的 querySelector 每次返回新对象）。
		function ensureVideoEl() {
			if (videoEl) return videoEl;
			if (!bg) return null;
			var el = document.createElement("video");
			el.setAttribute("id", "wwp" + HYPHEN + "video");
			try { el.id = "wwp" + HYPHEN + "video"; } catch (e) {}
			el.muted = true;
			el.loop = true;
			el.setAttribute("muted", "");
			el.setAttribute("loop", "");
			el.setAttribute("playsinline", "");
			el.setAttribute("preload", "auto");
			el.setAttribute("disablepictureinpicture", "");
			// 绝对铺满父元素；父元素上的 filter / transform 会被子元素继承，
			// #wwp-bg::after 遮罩仍在视频之上，语义与图片一致。
			el.style.position = "absolute";
			el.style.inset = "0";
			el.style.width = "100%";
			el.style.height = "100%";
			el.style.objectFit = "cover";
			el.style.pointerEvents = "none";
			el.style.display = "none";
			bg.appendChild(el);
			videoEl = el;
			return videoEl;
		}

		// 暂停 + 清 src + revoke object URL。幂等，任何一步失败都不抛。
		function stopVideo() {
			if (videoEl) {
				try { videoEl.pause(); } catch (e) {}
				try { videoEl.removeAttribute("src"); } catch (e) {}
				try { if (typeof videoEl.load === "function") videoEl.load(); } catch (e) {}
				try { videoEl.style.display = "none"; } catch (e) {}
			}
			revokeVideoUrl();
		}

		// 隐藏路径：无 currentId / 记录已删 / 停用 / 找不到记录，都走这里，不抛错。
		function hideBG() {
			if (!bg) return;
			bg.classList.add("wwp" + HYPHEN + "hidden");
			document.documentElement.classList.remove("wwp" + HYPHEN + "on");
			currentIsVideo = false;
			bg.style.backgroundImage = "none";
			stopVideo();
			syncVideoRow();
		}

		function renderImageBG(rec, SHADE) {
			currentIsVideo = false;
			stopVideo();
			bg.style.backgroundImage = 'url("' + String(rec.data || "").replace(/"/g, "%22") + '")';
			bg.style.backgroundSize = S.fit === "contain" ? "contain" : (S.fit === "cover" ? "cover" : "auto");
			bg.style.backgroundRepeat = S.fit === "tile" ? "repeat" : "no" + HYPHEN + "repeat";
			applyFilter();
			bg.style.setProperty(SHADE, String(S.shade));
			syncVideoRow();
		}

		function renderVideoBG(rec, SHADE) {
			currentIsVideo = true;
			// 视频是 <video> 铺满，父元素不能再挂背景图 / 背景尺寸
			bg.style.backgroundImage = "none";
			bg.style.backgroundRepeat = "no" + HYPHEN + "repeat";
			applyFilter();
			bg.style.setProperty(SHADE, String(S.shade));
			var el = ensureVideoEl();
			if (!el) { currentIsVideo = false; syncVideoRow(); return; }
			// 单一 object URL：切换前先 revoke 上一次的，杜绝泄漏
			revokeVideoUrl();
			var src = "";
			if (rec.kind === "url") {
				src = String(rec.data || "");
			} else if (rec.blob) {
				try { videoObjectUrl = URL.createObjectURL(rec.blob); src = videoObjectUrl; } catch (e) { src = ""; }
			}
			if (!src) {
				stopVideo();
				// 没拿到 src 就等于没渲染出视频：必须回滚标记，
				// 否则面板会误显示「视频」行、点「▶ 播放」会给出误导提示、visibilitychange 会白调 play()。
				currentIsVideo = false;
				noteMsg("视频数据缺失或不可用，未能播放：" + rec.name);
				syncVideoRow();
				return;
			}
			try {
				el.muted = !!S.videoMuted;
				el.loop = !!S.videoLoop;
				el.style.display = "block";
				el.style.objectFit = videoFit();
				el.setAttribute("src", src);
				try { if (typeof el.load === "function") el.load(); } catch (e) {}
				// 注意：真实浏览器里 load() / 设置 src 会把 playbackRate 重置回
				// defaultPlaybackRate，所以倍速必须在 load() 之后设置。
				try {
					var rate = rateVal(S.videoRate);
					el.defaultPlaybackRate = rate;
					el.playbackRate = rate;
				} catch (e) {}
				var p = el.play();
				// 自动播放被拦截时必须吃掉拒绝，不能抛未捕获异常
				if (p && typeof p.catch === "function") {
					p.catch(function () { noteMsg("视频自动播放被拦截，请在面板点「▶ 播放」"); });
				}
			} catch (e) {
				// 同步抛出的情况下视频并没有在播（play() 的失败走的是下面的 Promise 分支，
				// 不走这里），因此同样要把标记回滚，避免面板误显示「视频」行。
				currentIsVideo = false;
				noteMsg("视频播放失败：" + (e && e.message ? e.message : e));
			}
			syncVideoRow();
		}

		// 页面隐藏暂停、恢复续播
		function onVisibility() {
			if (videoEl && currentIsVideo) {
				try {
					if (document.hidden) {
						videoEl.pause();
					} else if (S.enabled && currentId) {
						var p = videoEl.play();
						if (p && typeof p.catch === "function") p.catch(function () {});
					}
				} catch (e) {}
			}
			// 特效层跟随可见性：隐藏即停循环（保留粒子状态），恢复即重启
			fxSync();
		}

		function renderBG() {
			var HY = String.fromCharCode(45);
			var HIDDEN = "wwp" + HY + "hidden";
			var SHADE = HY + HY + "wwp" + HY + "shade";
			if (!bg) return;
			fxSync();                                   // 特效层跟随「启用/停用」
			if (!S.enabled || !currentId) { hideBG(); return; }
			idbAll().then(function (list) {
				var rec = null;
				for (var i = 0; i < list.length; i++) if (list[i].id === currentId) rec = list[i];
				if (!rec) { hideBG(); return; }
				bg.classList.remove(HIDDEN);
				document.documentElement.classList.add("wwp" + HY + "on");
				// 唯一渲染入口：图片 / 视频都从这里分派
				if (recType(rec) === "video") renderVideoBG(rec, SHADE);
				else renderImageBG(rec, SHADE);
				// 导入流程刚写过汇总提示时不要抢话
				if (Date.now() >= suppressApplyNoteUntil && typeof noteMsg === "function") {
					noteMsg("已应用：" + rec.name + (S.surface ? "" : "（面板透明化已关，可能被界面挡住）"));
				}
			});
		}

		// ── 随机 ──
		function armNext() {
			nextAt = Date.now() + Math.max(1, S.rotateMin) * 60000;
			lsSet("wwp_next_at", nextAt);
		}
		function pickRandom(force) {
			return idbAll().then(function (list) {
				if (!list.length) { if (force) noteMsg("还没有壁纸，先添加几张吧"); return; }
				var ids = list.map(function (r) { return r.id; });
				var pool = ids;
				if (Array.isArray(S.pool) && S.pool.length) {
					var kept = S.pool.filter(function (id) { return ids.indexOf(id) >= 0; });
					if (kept.length) pool = kept;
				}
				var cand = pool.length > 1 ? pool.filter(function (id) { return id !== currentId; }) : pool;
				var id = cand[Math.floor(Math.random() * cand.length)] || pool[0];
				currentId = id;
				lsSet("wwp_current", currentId);
				renderBG();
				renderGrid();
				armNext();
			});
		}
		function schedule() {
			if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
			if (!S.rotate) return;
			if (!nextAt || nextAt < Date.now()) armNext();
			rotateTimer = setInterval(function () {
				if (S.rotate && Date.now() >= nextAt) pickRandom(false);
			}, 20000);
		}

		// ── 面板透明化 ──
		function renderSurface() {
			if (!surfaceEl) return;
			surfaceEl.textContent = S.surface ? surfaceCSS() : "";
		}

		// ── 导入 ──
		var IMG_MAX = 15 * 1024 * 1024;
		var VIDEO_MAX = 200 * 1024 * 1024;

		// 尽力生成视频缩略图。入参可以是 File/Blob，也可以是 http(s) URL 字符串。
		// 任何失败（URL 视频跨域导致 canvas 污染 SecurityError、无法解码、
		// 元数据超时…）都静默降级为 undefined，绝不中断导入。
		function makePoster(src) {
			return new Promise(function (resolve) {
				var url = null, done = false, timer = null, v = null;
				function finish(poster) {
					if (done) return;
					done = true;
					if (timer) { clearTimeout(timer); timer = null; }
					try { if (url) URL.revokeObjectURL(url); } catch (e) {}
					try { if (v && v.remove) v.remove(); } catch (e) {}
					resolve(poster || undefined);
				}
				function seekNear() {
					try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) {}
				}
				function grab() {
					try {
						var w = v.videoWidth, h = v.videoHeight;
						if (!w || !h) return finish();
						var scale = Math.min(1, 480 / w);
						var cv = document.createElement("canvas");
						cv.width = Math.max(1, Math.round(w * scale));
						cv.height = Math.max(1, Math.round(h * scale));
						cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
						finish(cv.toDataURL("image/jpeg", 0.7));
					} catch (e) { finish(); }
				}
				try {
					var isUrl = typeof src === "string";
					// Blob 分支：object URL 由 makePoster 自己 create，也由 finish() 自己 revoke。
					// URL 分支：直接把原地址交给 video；普通 http(s) 地址调 createObjectURL 会抛
					// TypeError，所以这里绝不调用它，也就不存在需要 revoke 的 object URL。
					url = isUrl ? null : URL.createObjectURL(src);
					v = document.createElement("video");
					v.muted = true;
					v.setAttribute("muted", "");
					v.setAttribute("playsinline", "");
					v.setAttribute("preload", "auto");
					v.style.position = "fixed";
					v.style.left = "-9999px";
					v.style.width = "1px";
					v.style.height = "1px";
					v.src = isUrl ? src : url;
					v.addEventListener("loadedmetadata", seekNear);
					v.addEventListener("loadeddata", seekNear);
					v.addEventListener("seeked", grab);
					v.addEventListener("error", function () { finish(); });
					if (document.body) document.body.appendChild(v);
					timer = setTimeout(function () { finish(); }, 8000);
				} catch (e) { finish(); }
			});
		}

		// 视频记录：blob 结构化克隆直存（严禁 readAsDataURL，200MB 会爆内存）。
		// 先入库、再异步补 poster —— poster 是锦上添花，绝不能拖慢甚至阻断入库。
		function importVideo(file, names) {
			var rec = {
				id: "v_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
				name: file.name,
				kind: "file",
				type: "video",
				mime: file.type || "video/*",
				bytes: file.size,
				blob: file,
				added: Date.now()
			};
			return idbPut(rec).then(function (ok) {
				if (!ok) return "quota";
				names[rec.name + "::" + rec.bytes] = 1;
				// 尽力补一张缩略图：任何失败都静默忽略，失败就继续用占位图
				makePoster(file).then(function (poster) {
					if (!poster) return;
					rec.poster = poster;
					idbPut(rec).then(function () { renderGrid(); });
				}).catch(function () {});
				return "added";
			});
		}

		function importFiles(fileList) {
			var files = Array.prototype.slice.call(fileList || []);
			if (!files.length) return;
			var done = 0, added = 0, skipped = 0, oversize = 0, quota = 0;
			idbAll().then(function (existing) {
				var names = {};
				for (var i = 0; i < existing.length; i++) names[existing[i].name + "::" + (existing[i].bytes || 0)] = 1;
				var jobs = files.map(function (file) {
					var video = isVideoFile(file);
					if (!video && !/^image\//.test(file.type || "")) { skipped++; done++; return Promise.resolve(); }
					var max = video ? VIDEO_MAX : IMG_MAX;
					// 恰好等于上限是通过（spec：图片 ≤15MB / 视频 ≤200MB）。
					// 0 字节文件没有内容，直接跳过，不入库空记录。
					if (file.size > max || file.size === 0) { skipped++; oversize++; done++; return Promise.resolve(); }
					if (names[file.name + "::" + file.size]) { skipped++; done++; return Promise.resolve(); }
					if (video) {
						return importVideo(file, names).then(function (r) {
							if (r === "added") added++;
							else { skipped++; if (r === "quota") quota++; }
							done++;
						});
					}
					return new Promise(function (resolve) {
						var reader = new FileReader();
						reader.onload = function () {
							var rec = {
								id: "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
								name: file.name,
								kind: "file",
								type: "image",
								mime: file.type,
								bytes: file.size,
								data: String(reader.result),
								added: Date.now()
							};
							idbPut(rec).then(function (ok) {
								if (ok) { added++; names[rec.name + "::" + rec.bytes] = 1; }
								else { skipped++; quota++; }
								done++; resolve();
							});
						};
						reader.onerror = function () { skipped++; done++; resolve(); };
						reader.readAsDataURL(file);
					});
				});
				return Promise.all(jobs);
			}).then(function () {
				var msg = "导入完成：新增 " + added + " 个" + (skipped ? "，跳过 " + skipped + " 个" : "");
				var why = [];
				if (oversize) why.push("空文件或超限 " + oversize + "（图片 15MB / 视频 200MB）");
				if (quota) why.push("存储空间不足，视频未保存 " + quota);
				if (why.length) msg += "；" + why.join("；");
				// renderBG() 里的「已应用：xxx」可能在本轮之后才落笔，会盖掉导入汇总。
				// 先抑制一小段时间，再写汇总，保证用户看到导入结果。
				suppressApplyNoteUntil = Date.now() + 1000;
				var tellResult = function () { noteMsg(msg); };
				if (added && !currentId) {
					idbAll().then(function (list) {
						if (list.length) {
							currentId = list[list.length - 1].id;
							lsSet("wwp_current", currentId);
							renderBG();
						}
						renderGrid();
						tellResult();
					});
				} else { renderGrid(); tellResult(); }
			});
		}
		function addUrl() {
			var url = (urlInput && urlInput.value || "").trim();
			if (!/^https?:\/\//i.test(url)) { noteMsg("请输入 http(s):// 开头的图片或视频地址"); return; }
			var name = url.split("/").pop().split("?")[0] || url;
			try { name = decodeURIComponent(name); } catch (e) {}
			if (name.length > 40) name = name.slice(0, 37) + "…";
			var isVid = isVideoUrl(url);
			var rec = {
				id: "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
				name: name || (isVid ? "url-video" : "url-image"),
				kind: "url",
				type: isVid ? "video" : "image",
				mime: isVid ? "video/*" : "image/*",
				data: url,
				added: Date.now()
			};
			idbPut(rec).then(function (ok) {
				if (!ok) { noteMsg("保存失败（IndexedDB 不可用）"); return; }
				if (urlInput) urlInput.value = "";
				currentId = rec.id;
				lsSet("wwp_current", currentId);
				noteMsg("已添加并应用：" + rec.name);
				renderBG();
				renderGrid();
				// URL 视频尽力抓一帧做缩略图：makePoster 接受 URL 字符串，直接把它交给 video。
				// URL 视频跨域时 canvas 会被污染（drawImage / toDataURL 抛 SecurityError），
				// 此时静默降级为无 poster，卡片继续用 🎬 占位。
				// 必须在首次入库之后再补写，否则会被上面那次 put 覆盖掉。
				if (isVid) {
					makePoster(url).then(function (poster) {
						if (!poster) return;
						rec.poster = poster;
						idbPut(rec).then(function () { renderGrid(); });
					}).catch(function () {});
				}
			});
		}

		// ── 网格 ──
		function renderGrid() {
			if (!grid) return;
			idbAll().then(function (list) {
				list.sort(function (a, b) { return (a.added || 0) - (b.added || 0); });
				grid.innerHTML = "";
				if (!list.length) {
					var empty = document.createElement("div");
					empty.className = "wwp-empty";
					empty.textContent = "还没有壁纸：点「＋ 添加图片」或粘贴图片 URL";
					grid.appendChild(empty);
					return;
				}
				list.forEach(function (rec) {
					var isVid = recType(rec) === "video";
					var card = document.createElement("div");
					card.className = "wwp-card" + (rec.id === currentId ? " cur" : "");
					card.title = rec.name;
					var img = document.createElement("img");
					if (isVid) {
						// 视频没有 data 字段，绝不能 img.src = rec.data（会裂图）
						if (rec.poster) img.src = rec.poster;
						else {
							// 无 poster 的占位：用内联 SVG 画 🎬 + VIDEO，避免空 src 的裂图图标
							img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
								'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">' +
								'<rect width="120" height="120" fill="#141a26"/>' +
								'<text x="60" y="58" font-size="34" text-anchor="middle">🎬</text>' +
								'<text x="60" y="86" font-size="13" fill="#8fa0bd" text-anchor="middle" font-family="sans-serif">VIDEO</text>' +
								'</svg>');
						}
						var badge = document.createElement("span");
						badge.className = "wwp-vbadge";
						badge.textContent = "VIDEO";
						card.appendChild(badge);
					} else {
						img.src = rec.data;
					}
					img.loading = "lazy";
					var cap = document.createElement("span");
					cap.className = "wwp-cap";
					cap.textContent = rec.name;
					var chk = document.createElement("input");
					chk.type = "checkbox";
					chk.className = "wwp-chk";
					chk.checked = sel.has(rec.id);
					chk.title = "勾选后可删除或设为随机池";
					chk.addEventListener("click", function (e) { e.stopPropagation(); });
					chk.addEventListener("change", function () {
						if (chk.checked) sel.add(rec.id); else sel.delete(rec.id);
					});
					card.appendChild(img);
					card.appendChild(cap);
					card.appendChild(chk);
					card.addEventListener("click", function () {
						currentId = rec.id;
						lsSet("wwp_current", currentId);
						S.enabled = true; saveS();
						renderBG();
						renderGrid();
						updateDockState();
					});
					grid.appendChild(card);
				});
			});
		}

		// ── 工具条 + 面板 ──
		function buildUI() {
			dock = document.createElement("div");
			dock.className = "wwp-dock";
			dock.title = "壁纸（可拖动）";

			var btnRandom = document.createElement("button");
			btnRandom.className = "wwp-btn";
			btnRandom.textContent = "🎲";
			btnRandom.title = "随机换一张";
			btnRandom.addEventListener("click", function (e) { e.stopPropagation(); pickRandom(true); });

			var btnPanel = document.createElement("button");
			btnPanel.className = "wwp-btn";
			btnPanel.textContent = "🖼";
			btnPanel.title = "壁纸设置";
			btnPanel.addEventListener("click", function (e) { e.stopPropagation(); togglePanel(); });

			dock.appendChild(btnRandom);
			dock.appendChild(btnPanel);
			document.body.appendChild(dock);

			panel = document.createElement("div");
			panel.className = "wwp-panel";
			panel.innerHTML =
				'<div class="wwp-head">' +
					'<div class="wwp-title">壁纸 · Wallpaper</div>' +
					'<button class="wwp-close" data-act="close">✕</button>' +
				'</div>' +
				'<div class="wwp-row" data-row="pool-actions">' +
					'<button class="wwp-act" data-act="add">＋ 添加图片</button>' +
					'<button class="wwp-act danger" data-act="del">删除所选</button>' +
					'<button class="wwp-act" data-act="pool">设为随机池</button>' +
					'<button class="wwp-act" data-act="clearpool">清除池</button>' +
				'</div>' +
				'<div class="wwp-grid" data-grid></div>' +
				'<div class="wwp-row">' +
					'<input class="wwp-url" data-url placeholder="粘贴图片 URL（http…）后点添加">' +
					'<button class="wwp-act" data-act="addurl">添加 URL</button>' +
				'</div>' +
				'<div class="wwp-sep"></div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">显示</span>' +
					'<button class="wwp-seg" data-fit="cover">铺满</button>' +
					'<button class="wwp-seg" data-fit="contain">适应</button>' +
					'<button class="wwp-seg" data-fit="center">居中</button>' +
					'<button class="wwp-seg" data-fit="tile">平铺</button>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">遮罩</span>' +
					'<input type="range" class="wwp-range" data-range="shade" min="0" max="90" step="1">' +
					'<span class="wwp-val" data-val="shade"></span>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">模糊</span>' +
					'<input type="range" class="wwp-range" data-range="blur" min="0" max="24" step="1">' +
					'<span class="wwp-val" data-val="blur"></span>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">亮度</span>' +
					'<input type="range" class="wwp-range" data-range="bright" min="50" max="180" step="5">' +
					'<span class="wwp-val" data-val="bright"></span>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<label class="wwp-chk-inline"><input type="checkbox" data-chk="surface">面板透明化</label>' +
					'<select class="wwp-select" data-sel="level">' +
						'<option value="ultra">极轻</option>' +
						'<option value="light">轻度</option>' +
						'<option value="mid">中度</option>' +
						'<option value="heavy">重度</option>' +
					'</select>' +
				'</div>' +
				'<div class="wwp-sep"></div>' +
				'<div class="wwp-row" data-row="fx">' +
					'<span class="wwp-lbl">特效</span>' +
					'<select class="wwp-select" data-sel="fx">' +
						'<option value="none">无</option>' +
						'<option value="snow">雪花</option>' +
						'<option value="stars">星光</option>' +
						'<option value="rain">雨</option>' +
						'<option value="sakura">樱花</option>' +
						'<option value="fireflies">萤火虫</option>' +
						'<option value="bubbles">气泡</option>' +
					'</select>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">强度</span>' +
					'<input type="range" class="wwp-range" data-range="fxintensity" min="20" max="150" step="5">' +
					'<span class="wwp-val" data-val="fxintensity"></span>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">速度</span>' +
					'<input type="range" class="wwp-range" data-range="fxspeed" min="20" max="300" step="10">' +
					'<span class="wwp-val" data-val="fxspeed"></span>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<span class="wwp-lbl">透明</span>' +
					'<input type="range" class="wwp-range" data-range="fxopacity" min="10" max="100" step="5">' +
					'<span class="wwp-val" data-val="fxopacity"></span>' +
				'</div>' +
				'<div class="wwp-sep"></div>' +
				'<div class="wwp-row" data-row="video" style="display:none">' +
					'<span class="wwp-lbl">视频</span>' +
					'<button class="wwp-act" data-act="vidplay">▶ 播放</button>' +
					'<label class="wwp-chk-inline"><input type="checkbox" data-chk="vidmuted">静音</label>' +
					'<label class="wwp-chk-inline"><input type="checkbox" data-chk="vidloop">循环</label>' +
					'<select class="wwp-select" data-sel="vidrate">' +
						'<option value="0.5">0.5x</option>' +
						'<option value="1">1x</option>' +
						'<option value="1.5">1.5x</option>' +
						'<option value="2">2x</option>' +
					'</select>' +
				'</div>' +
				'<div class="wwp-sep"></div>' +
				'<div class="wwp-row">' +
					'<label class="wwp-chk-inline"><input type="checkbox" data-chk="rotate">定时随机</label>' +
					'<input type="number" class="wwp-num" data-num="min" min="1" max="1440"> 分钟' +
					'<button class="wwp-act" data-act="random">🎲 立即随机</button>' +
				'</div>' +
				'<div class="wwp-row">' +
					'<button class="wwp-act" data-act="toggle">启用 / 停用</button>' +
					'<button class="wwp-act" data-act="clearcur">清除当前</button>' +
				'</div>' +
				'<div class="wwp-note" data-note></div>';
			fileInput = document.createElement("input");
			fileInput.type = "file";
			fileInput.setAttribute("type", "file");
			fileInput.accept = "image/*,video/*";
			fileInput.multiple = true;
			fileInput.style.display = "none";
			fileInput.addEventListener("change", function () {
				importFiles(fileInput.files);
				fileInput.value = "";
			});
			document.body.appendChild(fileInput);
			dock.appendChild(panel);

			grid = panel.querySelector("[data-grid]");
			note = panel.querySelector("[data-note]");
			urlInput = panel.querySelector("[data-url]");

			panel.querySelector('[data-act="close"]').addEventListener("click", function () { togglePanel(false); });
			panel.querySelector('[data-act="add"]').addEventListener("click", function () { fileInput.click(); });
			panel.querySelector('[data-act="addurl"]').addEventListener("click", addUrl);
			panel.querySelector('[data-act="random"]').addEventListener("click", function () { pickRandom(true); });
			panel.querySelector('[data-act="toggle"]').addEventListener("click", function () {
				S.enabled = !S.enabled; saveS(); renderBG(); updateDockState();
				noteMsg(S.enabled ? "壁纸已启用" : "壁纸已停用（背景恢复默认）");
			});
			panel.querySelector('[data-act="clearcur"]').addEventListener("click", function () {
				currentId = null; lsDel("wwp_current"); renderBG(); renderGrid();
				noteMsg("已清除当前壁纸");
			});
			panel.querySelector('[data-act="del"]').addEventListener("click", function () {
				if (!sel.size) { noteMsg("先在缩略图上勾选要删除的壁纸"); return; }
				var ids = Array.from(sel);
				Promise.all(ids.map(idbDelete)).then(function () {
					if (currentId && sel.has(currentId)) {
						currentId = null; lsDel("wwp_current"); renderBG();
					}
					var pool = Array.isArray(S.pool) ? S.pool : [];
					S.pool = pool.filter(function (id) { return sel.has(id) ? false : true; });
					if (S.pool && !S.pool.length) S.pool = null;
					sel.clear();
					saveS();
					noteMsg("已删除 " + ids.length + " 张");
					renderGrid();
				});
			});
			panel.querySelector('[data-act="pool"]').addEventListener("click", function () {
				if (!sel.size) { S.pool = null; saveS(); noteMsg("随机池已清除（使用全部壁纸）"); return; }
				S.pool = Array.from(sel); saveS();
				noteMsg("随机池已设置为所选 " + sel.size + " 张");
			});
			panel.querySelector('[data-act="clearpool"]').addEventListener("click", function () {
				S.pool = null; saveS(); noteMsg("随机池已清除（使用全部壁纸）");
			});

			panel.querySelectorAll("[data-fit]").forEach(function (b) {
				b.addEventListener("click", function () {
					S.fit = b.getAttribute("data-fit"); saveS(); renderBG(); syncPanel();
				});
			});
			var rangeShade = panel.querySelector('[data-range="shade"]');
			var rangeBlur = panel.querySelector('[data-range="blur"]');
			var rangeBright = panel.querySelector('[data-range="bright"]');
			rangeShade.addEventListener("input", function () {
				S.shade = Number(rangeShade.value) / 100; saveS(); renderBG(); syncPanel();
			});
			rangeBlur.addEventListener("input", function () {
				S.blur = Number(rangeBlur.value); saveS(); renderBG(); syncPanel();
			});
			rangeBright.addEventListener("input", function () {
				S.bright = Number(rangeBright.value) / 100; saveS(); renderBG(); syncPanel();
			});
			var chkSurface = panel.querySelector('[data-chk="surface"]');
			chkSurface.addEventListener("change", function () {
				S.surface = chkSurface.checked; saveS(); renderSurface();
			});
			var selLevel = panel.querySelector('[data-sel="level"]');
			selLevel.addEventListener("change", function () {
				S.surfaceLevel = selLevel.value; saveS(); renderSurface();
			});
			var chkRotate = panel.querySelector('[data-chk="rotate"]');
			chkRotate.addEventListener("change", function () {
				S.rotate = chkRotate.checked; saveS(); schedule();
			});
			var numMin = panel.querySelector('[data-num="min"]');
			numMin.addEventListener("change", function () {
				var v = Math.max(1, Math.min(1440, Number(numMin.value) || 30));
				S.rotateMin = v; numMin.value = String(v); saveS(); armNext(); schedule();
			});

			// 特效控件：选择 + 强度/速度/透明度（input 即时生效并 saveS()）
			var selFx = panel.querySelector('[data-sel="fx"]');
			if (selFx) selFx.addEventListener("change", function () {
				// 允许重试：先复位 broken，再走原有逻辑；仍失败会再次提示一次（不刷屏）
				fxBroken = false;
				fxBrokenNoted = false;
				S.fx = fxNormId(selFx.value); saveS(); fxSync(); syncPanel();
			});
			var rangeFxI = panel.querySelector('[data-range="fxintensity"]');
			if (rangeFxI) rangeFxI.addEventListener("input", function () {
				S.fxIntensity = fxNum(Number(rangeFxI.value) / 100, 0.7, 0.2, 1.5);
				saveS(); fxSync(); syncPanel();
			});
			var rangeFxS = panel.querySelector('[data-range="fxspeed"]');
			if (rangeFxS) rangeFxS.addEventListener("input", function () {
				S.fxSpeed = fxNum(Number(rangeFxS.value) / 100, 1, 0.2, 3);
				saveS(); fxSync(); syncPanel();
			});
			var rangeFxO = panel.querySelector('[data-range="fxopacity"]');
			if (rangeFxO) rangeFxO.addEventListener("input", function () {
				S.fxOpacity = fxNum(Number(rangeFxO.value) / 100, 0.8, 0.1, 1);
				saveS(); fxSync(); syncPanel();
			});

			// 视频控件（仅当前壁纸是视频时可见）
			videoRow = panel.querySelector('[data-row="video"]');
			btnVidPlay = panel.querySelector('[data-act="vidplay"]');
			chkVidMuted = panel.querySelector('[data-chk="vidmuted"]');
			chkVidLoop = panel.querySelector('[data-chk="vidloop"]');
			selVidRate = panel.querySelector('[data-sel="vidrate"]');
			if (btnVidPlay) btnVidPlay.addEventListener("click", function () {
				if (!videoEl || !currentIsVideo) { noteMsg("当前壁纸不是视频"); return; }
				try {
					if (videoEl.paused) {
						var p = videoEl.play();
						if (p && typeof p.catch === "function") p.catch(function () { noteMsg("播放被拦截，请先点一下界面再试"); });
					} else videoEl.pause();
				} catch (e) {}
				syncVideoRow();
			});
			if (chkVidMuted) chkVidMuted.addEventListener("change", function () {
				S.videoMuted = !!chkVidMuted.checked; saveS();
				if (videoEl) { try { videoEl.muted = S.videoMuted; } catch (e) {} }
				if (currentIsVideo) renderBG();
			});
			if (chkVidLoop) chkVidLoop.addEventListener("change", function () {
				S.videoLoop = !!chkVidLoop.checked; saveS();
				if (videoEl) { try { videoEl.loop = S.videoLoop; } catch (e) {} }
			});
			if (selVidRate) selVidRate.addEventListener("change", function () {
				S.videoRate = rateVal(selVidRate.value); saveS();
				if (videoEl) {
					try {
						videoEl.defaultPlaybackRate = S.videoRate;
						videoEl.playbackRate = S.videoRate;
					} catch (e) {}
				}
			});

			// 拖动（位置记忆）
			var LS_DOCK = "wwp_dock_pos";
			try {
				var raw = localStorage.getItem(LS_DOCK);
				if (raw) {
					var p = JSON.parse(raw);
					if (typeof p.x === "number" && typeof p.y === "number") {
						dock.style.left = p.x + "px";
						dock.style.top = p.y + "px";
						dock.style.right = "auto";
						dock.style.bottom = "auto";
					}
				}
			} catch (e) {}
			var startX = 0, startY = 0, origL = 0, origT = 0, pid = null, dragging = false, moved = false, suppressUntil = 0;
			function clamp(x, y) {
				var r = dock.getBoundingClientRect();
				var pad = 8;
				var maxX = Math.max(pad, window.innerWidth - r.width - pad);
				var maxY = Math.max(pad, window.innerHeight - r.height - pad);
				return [Math.min(Math.max(pad, x), maxX), Math.min(Math.max(pad, y), maxY)];
			}
			dock.addEventListener("pointerdown", function (e) {
				if (panel && panel.contains(e.target)) return;
				var r = dock.getBoundingClientRect();
				pid = e.pointerId; startX = e.clientX; startY = e.clientY;
				origL = r.left; origT = r.top; dragging = true; moved = false;
			});
			window.addEventListener("pointermove", function (e) {
				if (!dragging || e.pointerId !== pid) return;
				var dx = e.clientX - startX, dy = e.clientY - startY;
				if (!moved && Math.hypot(dx, dy) < 4) return;
				if (!moved) {
					moved = true;
					dock.classList.add("dragging");
					try { dock.setPointerCapture(pid); } catch (err) {}
				}
				var pos = clamp(origL + dx, origT + dy);
				dock.style.left = pos[0] + "px";
				dock.style.top = pos[1] + "px";
				dock.style.right = "auto";
				dock.style.bottom = "auto";
			});
			window.addEventListener("pointerup", function (e) {
				if (e.pointerId !== pid) return;
				dragging = false;
				dock.classList.remove("dragging");
				try { if (dock.hasPointerCapture(pid)) dock.releasePointerCapture(pid); } catch (err) {}
				if (moved) {
					var r = dock.getBoundingClientRect();
					try { localStorage.setItem(LS_DOCK, JSON.stringify({ x: r.left, y: r.top })); } catch (err) {}
					suppressUntil = Date.now() + 300;
				}
				pid = null;
			});
			dock.addEventListener("click", function (e) {
				if (Date.now() < suppressUntil) { e.stopPropagation(); e.preventDefault(); }
			}, true);
			window.addEventListener("resize", onWinResize);

			syncPanel();
			renderGrid();
		}

		function onWinResize() {
			if (!dock || !dock.style.left || !panelOpen) return;
			var r = dock.getBoundingClientRect();
			var pos = [r.left, r.top];
			var pad = 8;
			pos[0] = Math.min(Math.max(pad, pos[0]), Math.max(pad, window.innerWidth - r.width - pad));
			pos[1] = Math.min(Math.max(pad, pos[1]), Math.max(pad, window.innerHeight - r.height - pad));
			dock.style.left = pos[0] + "px";
			dock.style.top = pos[1] + "px";
		}

		function syncPanel() {
			if (!panel) return;
			panel.querySelectorAll("[data-fit]").forEach(function (b) {
				b.classList.toggle("active", b.getAttribute("data-fit") === S.fit);
			});
			panel.querySelector('[data-range="shade"]').value = String(Math.round(S.shade * 100));
			panel.querySelector('[data-val="shade"]').textContent = Math.round(S.shade * 100) + "%";
			panel.querySelector('[data-range="blur"]').value = String(S.blur);
			panel.querySelector('[data-val="blur"]').textContent = S.blur + "px";
			panel.querySelector('[data-range="bright"]').value = String(Math.round(S.bright * 100));
			panel.querySelector('[data-val="bright"]').textContent = Math.round(S.bright * 100) + "%";
			panel.querySelector('[data-chk="surface"]').checked = !!S.surface;
			panel.querySelector('[data-sel="level"]').value = S.surfaceLevel;
			panel.querySelector('[data-chk="rotate"]').checked = !!S.rotate;
			panel.querySelector('[data-num="min"]').value = String(S.rotateMin);
			// 特效控件回填（选择 + 三个滑块 + 三个回显）
			var selFxEl = panel.querySelector('[data-sel="fx"]');
			if (selFxEl) selFxEl.value = fxNormId(S.fx);
			var rFxI = panel.querySelector('[data-range="fxintensity"]');
			if (rFxI) rFxI.value = String(Math.round(S.fxIntensity * 100));
			var vFxI = panel.querySelector('[data-val="fxintensity"]');
			if (vFxI) vFxI.textContent = Math.round(S.fxIntensity * 100) + "%";
			var rFxS = panel.querySelector('[data-range="fxspeed"]');
			if (rFxS) rFxS.value = String(Math.round(S.fxSpeed * 100));
			var vFxS = panel.querySelector('[data-val="fxspeed"]');
			if (vFxS) vFxS.textContent = S.fxSpeed.toFixed(1) + "×";
			var rFxO = panel.querySelector('[data-range="fxopacity"]');
			if (rFxO) rFxO.value = String(Math.round(S.fxOpacity * 100));
			var vFxO = panel.querySelector('[data-val="fxopacity"]');
			if (vFxO) vFxO.textContent = Math.round(S.fxOpacity * 100) + "%";
			syncVideoRow();
		}

		// 视频控件行的显隐 + 控件状态同步。切壁纸后 renderBG() 也会调用它。
		function syncVideoRow() {
			if (videoRow) videoRow.style.display = currentIsVideo ? "flex" : "none";
			if (chkVidMuted) chkVidMuted.checked = !!S.videoMuted;
			if (chkVidLoop) chkVidLoop.checked = !!S.videoLoop;
			if (selVidRate) selVidRate.value = String(rateVal(S.videoRate));
			if (btnVidPlay) {
				var playing = false;
				try { playing = !!(currentIsVideo && videoEl && !videoEl.paused); } catch (e) {}
				btnVidPlay.textContent = playing ? "⏸ 暂停" : "▶ 播放";
			}
		}

		function updateDockState() {
			if (!dock) return;
			var btnPanel = dock.querySelectorAll(".wwp-btn")[1];
			if (btnPanel) btnPanel.classList.toggle("on", !!(S.enabled && currentId));
		}

		function togglePanel(force) {
			if (!panel || !dock) return;
			panelOpen = typeof force === "boolean" ? force : !panelOpen;
			panel.classList.toggle("open", panelOpen);
			if (panelOpen) {
				// 面板相对 dock 定位：默认在上方；dock 靠近顶部时翻到下方
				var dr = dock.getBoundingClientRect();
				panel.classList.toggle("below", dr.top < 300);
				panel.style.left = "auto";
				var pw = panel.getBoundingClientRect();
				if (pw.width) {
					var minL = 8 - dr.left;
					var maxL = window.innerWidth - 8 - dr.left - pw.width;
					var centered = (dr.width - pw.width) / 2;
					var left = minL > maxL ? minL : Math.min(Math.max(centered, minL), maxL);
					panel.style.left = left + "px";
				}
				renderGrid();
			}
		}

		function onEsc(e) {
			if (e.key === "Escape" && panelOpen) togglePanel(false);
		}

		// ── apply ──
		function apply(ctx) {
			var run = function () {
				// 单实例保护
				if (document.getElementById("wwp-bg") || document.querySelector(".wwp-dock")) return function () {};

				styleEl = document.createElement("style");
				styleEl.setAttribute("data-wwp", PLUGIN_ID);
				styleEl.textContent = mainCSS();
				document.head.appendChild(styleEl);

				surfaceEl = document.createElement("style");
				surfaceEl.setAttribute("data-wwp-surface", PLUGIN_ID);
				document.head.appendChild(surfaceEl);

				bg = document.createElement("div");
				bg.id = "wwp-bg";
				document.body.appendChild(bg);
				// spec §2：视频元素在 apply() 时创建并挂进 #wwp-bg，
				// 图片壁纸下保持隐藏 + 无 src。
				ensureVideoEl();

				// spec §2：特效层 canvas 在 apply() 时创建，appendChild 到 body 且在 #wwp-bg 之后
				fxAttach();

				buildUI();
				renderSurface();
				renderBG();
				schedule();
				updateDockState();

				// 跟随深浅色切换重算透明化令牌
				darkObserver = new MutationObserver(function () { renderSurface(); });
				if (document.body) darkObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
				document.addEventListener("keydown", onEsc);
				document.addEventListener("visibilitychange", onVisibility);

				return function cleanup() {
					document.removeEventListener("keydown", onEsc);
					document.removeEventListener("visibilitychange", onVisibility);
					// buildUI() 里注册的 resize 监听必须在此移除，否则反复 apply→cleanup 会累积监听
					try { window.removeEventListener("resize", onWinResize); } catch (e) {}
					if (darkObserver) { darkObserver.disconnect(); darkObserver = null; }
					if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
					// 视频清理：暂停 → 清 src → revoke object URL → 移除元素
					stopVideo();
					if (videoEl) { try { videoEl.remove(); } catch (e) {} videoEl = null; }
					currentIsVideo = false;
					revokeVideoUrl();
					videoRow = null; btnVidPlay = null; chkVidMuted = null; chkVidLoop = null; selVidRate = null;
					// 特效层清理：cancel rAF → 移除 resize/matchMedia 监听 → 移除 canvas → 置空模块级变量
					fxDetach();
					document.documentElement.classList.remove("wwp" + String.fromCharCode(45) + "on");
					if (bg) { bg.remove(); bg = null; }
					if (dock) { dock.remove(); dock = null; }
					if (panel) { panel.remove(); panel = null; }
					if (fileInput) { fileInput.remove(); fileInput = null; }
					if (styleEl) { styleEl.remove(); styleEl = null; }
					if (surfaceEl) { surfaceEl.remove(); surfaceEl = null; }
				};
			};
			if (ctx && typeof ctx.effect === "function") ctx.effect(run, PLUGIN_ID + ": apply");
			else run();
		}

		exports.isPlugin = true;
		exports.inject = ["theme"];
		exports.apply = apply;
		return module.exports;
	}
});
