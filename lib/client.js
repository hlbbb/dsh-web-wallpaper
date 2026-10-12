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
 *   - 界面面板透明化（轻/中/重），自动跟随深浅色
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
			surfaceLevel: lsGet("wwp_surface_level", "light"), // light | mid | heavy
			rotate: lsGet("wwp_rotate", false),
			rotateMin: lsGet("wwp_rotate_min", 30),
			videoMuted: lsGet("wwp_video_muted", true),   // 视频默认静音（否则不允许自动播放）
			videoLoop: lsGet("wwp_video_loop", true),     // 视频循环
			videoRate: lsGet("wwp_video_rate", 1),        // 视频倍速 0.5 / 1 / 1.5 / 2
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

		// ── 面板透明化令牌（轻/中/重三档）──
		// 三档表示「越来越透」：轻度最不透、重度最透，与面板里的「轻度/中度/重度」一致。
		// 可读性下限：凡是承载文字的表面（l1/l2/l3 卡片与弹窗、input 输入框、
		// selector 选择器、menu 菜单）都必须留在 0.78 以上。
		// 原因：设置页弹窗用的就是 l2，一旦它降到 0.26，弹窗 74% 透出壁纸，
		// 文字对比度只剩 1.7:1（WCAG AA 要求 4.5:1），于是「看不清字」。
		// base 是整页底衬，保持很低，壁纸才透得出来；sidebar/bubble 是装饰玻璃，
		// 允许更透一些，但也不低于 0.68 以免侧栏与会话气泡的文字发虚。
		var LEVELS = {
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
			if (!videoEl || !currentIsVideo) return;
			try {
				if (document.hidden) {
					videoEl.pause();
				} else if (S.enabled && currentId) {
					var p = videoEl.play();
					if (p && typeof p.catch === "function") p.catch(function () {});
				}
			} catch (e) {}
		}

		function renderBG() {
			var HY = String.fromCharCode(45);
			var HIDDEN = "wwp" + HY + "hidden";
			var SHADE = HY + HY + "wwp" + HY + "shade";
			if (!bg) return;
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
						'<option value="light">轻度</option>' +
						'<option value="mid">中度</option>' +
						'<option value="heavy">重度</option>' +
					'</select>' +
				'</div>' +
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
					if (darkObserver) { darkObserver.disconnect(); darkObserver = null; }
					if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
					// 视频清理：暂停 → 清 src → revoke object URL → 移除元素
					stopVideo();
					if (videoEl) { try { videoEl.remove(); } catch (e) {} videoEl = null; }
					currentIsVideo = false;
					revokeVideoUrl();
					videoRow = null; btnVidPlay = null; chkVidMuted = null; chkVidLoop = null; selVidRate = null;
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
