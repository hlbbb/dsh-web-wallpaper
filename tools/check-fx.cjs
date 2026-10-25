#!/usr/bin/env node
/**
 * tools/check-fx.cjs —— 视觉特效层离线自检（自包含，无第三方依赖）
 *
 * 用法：
 *   node tools/check-fx.cjs [client.js]     默认 lib/client.js
 *   node tools/check-fx.cjs lib/client.js --dump
 *
 * 原理：用最小 DOM 桩 + Node vm 在宿主侧执行 lib/client.js，
 * 手动推进 requestAnimationFrame 队列，统计 canvas 2D 出图调用，
 * 逐条验证特效层的冻结契约。全通过 exit 0，任一失败 exit 1。
 *
 * 注意：源码里所有含连字符的字面量（wwp-fx / data-sel 等）在本文件中
 * 一律用 HY = String.fromCharCode(45) 拼接，避免写入时被吞字符。
 */
"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ── 契约常量（连字符一律拼接）──
const HY = String.fromCharCode(45);
const FX_ID = "wwp" + HY + "fx";
const FX_OFF = FX_ID + HY + "off";
const BG_ID = "wwp" + HY + "bg";
const DOCK_SEL = ".wwp" + HY + "dock";
const RM_QUERY = "prefers" + HY + "reduced" + HY + "motion: reduce";
const SEL_FX = '[data' + HY + 'sel="fx"]';
const RANGE_I = '[data' + HY + 'range="fxintensity"]';
const RANGE_S = '[data' + HY + 'range="fxspeed"]';
const RANGE_O = '[data' + HY + 'range="fxopacity"]';
const VAL_I = '[data' + HY + 'val="fxintensity"]';
const ROW_FX = '[data' + HY + 'row="fx"]';
const FX_IDS = ["snow", "stars", "rain", "sakura", "fireflies", "bubbles"];
const ATTR_NAME = "[a-zA-Z_:][a-zA-Z0-9_:." + HY + "]*";
const OUT_KEYS = ["fill", "stroke", "fillRect", "strokeRect", "fillText", "drawImage"];
const TAIL_KEYS = [
	"clearRect", "beginPath", "arc", "moveTo", "lineTo", "save", "restore",
	"translate", "rotate", "scale", "createRadialGradient", "createLinearGradient",
	"setTransform", "closePath", "ellipse", "rect", "clip", "quadraticCurveTo",
	"bezierCurveTo", "measureText", "fillStyle", "strokeStyle", "lineWidth",
];
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const REJECTIONS = [];
process.on("unhandledRejection", function (e) { REJECTIONS.push(e); });

// ─────────────────────────────────────────────────────────────
// 一、DOM 桩
// ─────────────────────────────────────────────────────────────

function makeStyle() {
	const o = {
		setProperty: function (k, v) { o[String(k)] = String(v); },
		removeProperty: function (k) { delete o[String(k)]; },
		getPropertyValue: function (k) { return o[String(k)] === undefined ? "" : o[String(k)]; },
	};
	return o;
}

function makeClassList(set) {
	return {
		add: function () { for (var i = 0; i < arguments.length; i++) { var n = arguments[i]; if (n) set.add(String(n)); } },
		remove: function () { for (var i = 0; i < arguments.length; i++) set.delete(String(arguments[i])); },
		contains: function (n) { return set.has(String(n)); },
		toggle: function (n, force) {
			var has = set.has(String(n));
			var on = arguments.length > 1 ? !!force : !has;
			if (on) set.add(String(n)); else set.delete(String(n));
			return on;
		},
		item: function (i) { return Array.from(set)[i] || null; },
		toString: function () { return Array.from(set).join(" "); },
		get length() { return set.size; },
	};
}

function compileSelector(sel) {
	const out = [];
	String(sel).split(",").forEach(function (raw) {
		const part = raw.trim();
		if (!part) return;
		const spec = { tag: null, id: null, classes: [], attrs: [] };
		const rest = part.replace(
			new RegExp("\\[\\s*(" + ATTR_NAME + ")\\s*(?:=\\s*(\"[^\"]*\"|'[^']*'|[^\\]]*))?\\s*\\]", "g"),
			function (_m, name, val) {
				spec.attrs.push({
					name: name,
					value: val === undefined ? null : String(val).replace(/^["']|["']$/g, ""),
				});
				return " ";
			}
		);
		rest.split(/(?=[.#])|\s+/).forEach(function (tok) {
			if (!tok) return;
			if (tok[0] === "#") spec.id = tok.slice(1);
			else if (tok[0] === ".") spec.classes.push(tok.slice(1));
			else spec.tag = tok.toUpperCase();
		});
		out.push(spec);
	});
	return out;
}

function matchSpec(el, spec) {
	if (spec.tag && el.tagName !== spec.tag) return false;
	if (spec.id && el.id !== spec.id) return false;
	for (var i = 0; i < spec.classes.length; i++) if (!el.classList.contains(spec.classes[i])) return false;
	for (var j = 0; j < spec.attrs.length; j++) {
		var a = spec.attrs[j];
		var v = el.getAttribute(a.name);
		if (v === null) return false;
		if (a.value !== null && String(v) !== a.value) return false;
	}
	return true;
}

function matchSelector(el, sel) {
	const specs = compileSelector(sel);
	for (var i = 0; i < specs.length; i++) if (matchSpec(el, specs[i])) return true;
	return false;
}

function collectDescendants(root, acc) {
	for (var i = 0; i < root.children.length; i++) {
		var c = root.children[i];
		acc.push(c);
		collectDescendants(c, acc);
	}
	return acc;
}

function parseHTML(html, env) {
	const root = [];
	const stack = [{ node: null, children: root }];
	const re = new RegExp("<(\\/)?([a-zA-Z][a-zA-Z0-9]*)((?:\\s+[^<>]*?)?)(\\/)?>", "g");
	let m;
	while ((m = re.exec(String(html)))) {
		const closing = !!m[1], tag = m[2], attrText = m[3] || "", selfClose = !!m[4];
		if (closing) { if (stack.length > 1) stack.pop(); continue; }
		const el = makeEl(tag, env);
		const are = new RegExp("(" + ATTR_NAME + ")(?:\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+)))?", "g");
		let a;
		while ((a = are.exec(attrText))) {
			const val = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : (a[5] !== undefined ? a[5] : ""));
			el.setAttribute(a[1], val);
		}
		const parent = stack[stack.length - 1];
		parent.children.push(el);
		el.parentNode = parent.node;
		if (!selfClose && !VOID_TAGS.has(String(tag).toLowerCase())) stack.push({ node: el, children: el.children });
	}
	return root;
}

function makeEl(tag, env) {
	const el = {
		tagName: String(tag).toUpperCase(),
		nodeType: 1,
		children: [],
		parentNode: null,
		attributes: {},
		style: makeStyle(),
		textContent: "",
		value: "",
		checked: false,
		disabled: false,
		selectedIndex: 0,
		scrollTop: 0,
		offsetWidth: 0,
		offsetHeight: 0,
		clientWidth: 0,
		clientHeight: 0,
		__listeners: {},
	};
	const cls = new Set();
	el.classList = makeClassList(cls);
	Object.defineProperty(el, "className", {
		get: function () { return Array.from(cls).join(" "); },
		set: function (v) { cls.clear(); String(v).split(/\s+/).forEach(function (n) { if (n) cls.add(n); }); },
		enumerable: true,
		configurable: true,
	});
	let idVal = "";
	Object.defineProperty(el, "id", {
		get: function () { return idVal; },
		set: function (v) {
			if (idVal && env && env.byId.get(idVal) === el) env.byId.delete(idVal);
			idVal = v === undefined || v === null ? "" : String(v);
			if (idVal && env) env.byId.set(idVal, el);
		},
		enumerable: true,
		configurable: true,
	});
	let innerVal = "";
	Object.defineProperty(el, "innerHTML", {
		get: function () { return innerVal; },
		set: function (v) {
			innerVal = String(v);
			el.children.length = 0;
			const kids = parseHTML(innerVal, env);
			for (var i = 0; i < kids.length; i++) { kids[i].parentNode = el; el.children.push(kids[i]); }
			if (el.tagName === "SELECT") el.options = el.children.filter(function (c) { return c.tagName === "OPTION"; });
		},
		enumerable: true,
		configurable: true,
	});

	el.setAttribute = function (k, v) {
		const name = String(k);
		const val = v === undefined || v === null ? "" : String(v);
		el.attributes[name] = val;
		if (name === "id") el.id = val;
		if (name === "class") el.className = val;
		if (name === "value") el.value = val;
		if (name === "checked") el.checked = true;
	};
	el.getAttribute = function (k) {
		const name = String(k);
		return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
	};
	el.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(el.attributes, String(k)); };
	el.removeAttribute = function (k) {
		const name = String(k);
		delete el.attributes[name];
		if (name === "id" && el.id && env && env.byId.get(el.id) === el) { env.byId.delete(el.id); idVal = ""; }
	};
	el.appendChild = function (child) {
		if (!child) return child;
		if (child.parentNode && child.parentNode !== el && child.parentNode.removeChild) child.parentNode.removeChild(child);
		child.parentNode = el;
		el.children.push(child);
		if (el.tagName === "SELECT" && child.tagName === "OPTION") el.options = el.children.filter(function (c) { return c.tagName === "OPTION"; });
		return child;
	};
	el.insertBefore = function (child, ref) {
		const i = ref ? el.children.indexOf(ref) : -1;
		child.parentNode = el;
		if (i < 0) el.children.push(child); else el.children.splice(i, 0, child);
		return child;
	};
	el.removeChild = function (child) {
		const i = el.children.indexOf(child);
		if (i >= 0) { el.children.splice(i, 1); child.parentNode = null; }
		return child;
	};
	el.remove = function () {
		if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
		if (idVal && env && env.byId.get(idVal) === el) env.byId.delete(idVal);
	};
	el.contains = function (node) {
		if (!node) return false;
		if (node === el) return true;
		return collectDescendants(el, []).indexOf(node) >= 0;
	};
	el.querySelectorAll = function (sel) { return collectDescendants(el, []).filter(function (c) { return matchSelector(c, sel); }); };
	el.querySelector = function (sel) { return el.querySelectorAll(sel)[0] || null; };
	el.matches = function (sel) { return matchSelector(el, sel); };
	el.closest = function (sel) {
		let cur = el;
		while (cur) { if (matchSelector(cur, sel)) return cur; cur = cur.parentNode; }
		return null;
	};
	el.getBoundingClientRect = function () {
		const w = el.offsetWidth || 300, h = el.offsetHeight || 40;
		return { top: 0, left: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 };
	};
	el.addEventListener = function (type, fn) {
		if (!fn) return;
		(el.__listeners[type] = el.__listeners[type] || []).push(fn);
	};
	el.removeEventListener = function (type, fn) {
		const arr = el.__listeners[type];
		if (!arr) return;
		const i = arr.indexOf(fn);
		if (i >= 0) arr.splice(i, 1);
	};
	el.dispatchEvent = function (ev) {
		const arr = (el.__listeners[(ev && ev.type) || "x"] || []).slice();
		for (var i = 0; i < arr.length; i++) arr[i].call(el, ev || {});
		return true;
	};
	el.trigger = function (type) {
		el.dispatchEvent({ type: type, target: el, preventDefault: function () {}, stopPropagation: function () {} });
	};
	el.focus = function () {};
	el.blur = function () {};
	el.click = function () { el.trigger("click"); };
	return el;
}

// ── canvas 2D 上下文桩：记录每一次调用与样式赋值 ──
function makeCtx(env, canvas) {
	const counts = env.draw;
	const store = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "", lineCap: "butt", lineJoin: "miter" };
	const grad = { addColorStop: function () {} };
	return new Proxy(store, {
		get: function (t, p) {
			if (typeof p !== "string") return t[p];
			if (p in t) return t[p];
			if (p === "canvas") return canvas;
			if (p === "createRadialGradient" || p === "createLinearGradient") {
				counts[p] = (counts[p] || 0) + 1;
				return function () { return { addColorStop: function () {} }; };
			}
			if (p === "createPattern") return function () { return null; };
			if (p === "measureText") { counts.measureText = (counts.measureText || 0) + 1; return function () { return { width: 8 }; }; }
			if (p === "getImageData") return function () { return { data: [] }; };
			return function () {
				if (p in counts) counts[p]++;
				// 坐标日志只记「特效主画布」：粒子精灵化后改用 drawImage 绘制，而离屏精灵自身的
				// arc/fill 也走同一个桩；若一并记入会污染断言 8/13 的「同索引粒子」位移口径。
				const onFx = !!canvas && canvas.id === FX_ID;
				if (p === "arc") { if (onFx) env.arcLog.push([arguments[0], arguments[1], arguments[2]]); }
				if (p === "fillRect") env.rectLog.push([arguments[0], arguments[1], arguments[2], arguments[3]]);
				if (p === "drawImage" && onFx) {
					// 记录目标矩形中心（即粒子圆心）与半宽，作为 arc(x,y,r) 坐标日志的等价物
					if (arguments.length >= 5) env.arcLog.push([arguments[1] + arguments[3] / 2, arguments[2] + arguments[4] / 2, arguments[3] / 2]);
					else if (arguments.length >= 3) env.arcLog.push([arguments[1], arguments[2], 0]);
				}
				return grad;
			};
		},
		set: function (t, p, v) {
			t[p] = v;
			if (p === "globalAlpha") env.alphaLog.push(Number(v));
			else if (p === "globalCompositeOperation") env.compLog.push(String(v));
			else if (p === "fillStyle" || p === "strokeStyle" || p === "lineWidth") env.styleLog.push([p, v]);
			return true;
		},
	});
}

function makeCanvas(env) {
	const el = makeEl("canvas", env);
	el.width = 300;
	el.height = 150;
	el.getContext = function (kind) {
		if (String(kind) !== "2d") return null;
		if (env.ctxNull) return null;
		if (!el.__ctx) el.__ctx = makeCtx(env, el);
		return el.__ctx;
	};
	el.toDataURL = function () { return "data:,"; };
	return el;
}

function makeDocument(env) {
	const doc = makeEl("#document", env);
	doc.tagName = "#DOCUMENT";
	doc.nodeType = 9;
	doc.head = makeEl("head", env);
	doc.body = makeEl("body", env);
	doc.documentElement = makeEl("html", env);
	doc.documentElement.appendChild(doc.head);
	doc.documentElement.appendChild(doc.body);
	doc.createElement = function (tag) {
		if (String(tag).toLowerCase() === "canvas") {
			const c = makeCanvas(env);
			env.canvases.push(c);
			return c;
		}
		return makeEl(tag, env);
	};
	doc.createTextNode = function (t) { const n = makeEl("#text", env); n.tagName = "#TEXT"; n.textContent = String(t); return n; };
	doc.createDocumentFragment = function () { return makeEl("#fragment", env); };
	doc.getElementById = function (id) { return env.byId.get(String(id)) || null; };
	doc.getElementsByTagName = function (tag) {
		return collectDescendants(doc.documentElement, []).filter(function (c) { return c.tagName === String(tag).toUpperCase(); });
	};
	doc.querySelectorAll = function (sel) { return collectDescendants(doc.documentElement, []).filter(function (c) { return matchSelector(c, sel); }); };
	doc.querySelector = function (sel) { return doc.querySelectorAll(sel)[0] || null; };
	Object.defineProperty(doc, "hidden", { get: function () { return env.hidden; }, set: function (v) { env.hidden = !!v; }, configurable: true });
	Object.defineProperty(doc, "visibilityState", { get: function () { return env.hidden ? "hidden" : "visible"; }, configurable: true });
	return doc;
}

function makeLocalStorage(env) {
	return {
		getItem: function (k) { k = String(k); return env.store.has(k) ? env.store.get(k) : null; },
		setItem: function (k, v) { env.store.set(String(k), String(v)); },
		removeItem: function (k) { env.store.delete(String(k)); },
		clear: function () { env.store.clear(); },
		key: function (i) { return Array.from(env.store.keys())[i] || null; },
		get length() { return env.store.size; },
	};
}

// ─────────────────────────────────────────────────────────────
// 二、环境与模块加载
// ─────────────────────────────────────────────────────────────

function makeEnv(opts) {
	opts = opts || {};
	const env = {
		now: 0,
		rafSeq: 1,
		rafQueue: [],
		cancelled: [],
		tseq: 1,
		timeouts: new Map(),
		intervals: new Map(),
		draw: {},
		arcLog: [],
		rectLog: [],
		alphaLog: [],
		compLog: [],
		styleLog: [],
		byId: new Map(),
		canvases: [],
		store: new Map(),
		winListeners: [],
		docListeners: [],
		errors: [],
		hidden: false,
		reduceMotion: !!opts.reduceMotion,
		noMatchMedia: !!opts.noMatchMedia,
		ctxNull: !!opts.ctxNull,
		vw: opts.vw || 1280,
		vh: opts.vh || 800,
		dpr: opts.dpr === undefined ? 1 : opts.dpr,
	};
	OUT_KEYS.concat(TAIL_KEYS).forEach(function (k) { env.draw[k] = 0; });
	// localStorage 里存的是 JSON（源码用 JSON.parse 读），因此统一序列化
	Object.keys(opts.ls || {}).forEach(function (k) { env.store.set(k, JSON.stringify(opts.ls[k])); });

	env.tick = function (ms) {
		env.now += (ms === undefined ? 16.7 : ms);
		const q = env.rafQueue.slice();
		env.rafQueue.length = 0;
		for (var i = 0; i < q.length; i++) {
			try { q[i].cb(env.now); } catch (e) { env.errors.push(e); }
		}
	};
	env.snapshot = function () {
		const o = {};
		Object.keys(env.draw).forEach(function (k) { o[k] = env.draw[k]; });
		return o;
	};
	env.diff = function (before) {
		const o = {};
		Object.keys(env.draw).forEach(function (k) { o[k] = env.draw[k] - (before[k] || 0); });
		return o;
	};
	return env;
}

const outSum = (d) => OUT_KEYS.reduce((s, k) => s + (d[k] || 0), 0);
// 「出图调用」口径：粒子精灵化后由 drawImage 贴图，故一并计入（旧实现的 fill/stroke/fillRect 不受影响）
const coreSum = (d) => (d.fill || 0) + (d.stroke || 0) + (d.fillRect || 0) + (d.drawImage || 0);

/** 按帧边界统计相邻帧间「同索引粒子」的正向 y 位移和（用于观测 speed 效果） */
function yDisplacement(arcLog, marks) {
	let sum = 0, prevStart = 0, prevEnd = 0;
	for (var f = 0; f < marks.length; f++) {
		const start = prevEnd, end = marks[f];
		if (f > 0) {
			const len = Math.min(end - start, prevEnd - prevStart);
			for (var k = 0; k < len; k++) {
				const dy = arcLog[start + k][1] - arcLog[prevStart + k][1];
				if (dy > 0) sum += dy;
			}
		}
		prevStart = start;
		prevEnd = end;
	}
	return sum;
}

function buildSandbox(env, src, clientPath) {
	const sandbox = {};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	const doc = makeDocument(env);
	sandbox.document = doc;
	env.document = doc;
	sandbox.localStorage = makeLocalStorage(env);
	const noop = function () {};
	sandbox.console = { log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop };
	sandbox.setTimeout = function (fn) { const id = env.tseq++; env.timeouts.set(id, fn); return id; };
	sandbox.clearTimeout = function (id) { env.timeouts.delete(id); };
	sandbox.setInterval = function (fn) { const id = env.tseq++; env.intervals.set(id, fn); return id; };
	sandbox.clearInterval = function (id) { env.intervals.delete(id); };
	sandbox.requestAnimationFrame = function (cb) { const id = env.rafSeq++; env.rafQueue.push({ id: id, cb: cb }); return id; };
	sandbox.cancelAnimationFrame = function (id) {
		for (var i = 0; i < env.rafQueue.length; i++) if (env.rafQueue[i].id === id) { env.rafQueue.splice(i, 1); break; }
		env.cancelled.push(id);
	};
	sandbox.performance = { now: function () { return env.now; } };
	sandbox.matchMedia = env.noMatchMedia ? undefined : function (q) {
		return {
			matches: env.reduceMotion, media: String(q),
			addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop,
		};
	};
	sandbox.MutationObserver = function () { this.observe = noop; this.disconnect = noop; this.takeRecords = function () { return []; }; };
	sandbox.URL = { createObjectURL: function () { return "blob:stub"; }, revokeObjectURL: noop };
	sandbox.FileReader = function () {
		this.readAsDataURL = function () { if (this.onerror) this.onerror(new Error("stub")); };
		this.readAsArrayBuffer = function () { if (this.onerror) this.onerror(new Error("stub")); };
		this.abort = noop;
	};
	sandbox.navigator = { userAgent: "node-check", platform: "node" };
	sandbox.location = { href: "http://localhost/", hostname: "localhost", protocol: "http:", search: "" };
	sandbox.getComputedStyle = function () { return { getPropertyValue: function () { return ""; } }; };
	sandbox.Image = function () { this.onload = null; this.onerror = null; this.src = ""; this.width = 0; this.height = 0; };
	sandbox.addEventListener = function (t, fn) { env.winListeners.push({ type: String(t), fn: fn }); };
	sandbox.removeEventListener = function (t, fn) {
		for (var i = 0; i < env.winListeners.length; i++) {
			if (env.winListeners[i].type === String(t) && env.winListeners[i].fn === fn) { env.winListeners.splice(i, 1); break; }
		}
	};
	// document 监听：既要计数，也要真正注册到元素桩上（否则 dispatchEvent 到不了监听器）
	const rawDocAdd = doc.addEventListener, rawDocRemove = doc.removeEventListener;
	doc.addEventListener = function (t, fn) { env.docListeners.push({ type: String(t), fn: fn }); rawDocAdd.call(doc, t, fn); };
	doc.removeEventListener = function (t, fn) {
		for (var i = 0; i < env.docListeners.length; i++) {
			if (env.docListeners[i].type === String(t) && env.docListeners[i].fn === fn) { env.docListeners.splice(i, 1); break; }
		}
		rawDocRemove.call(doc, t, fn);
	};
	Object.defineProperty(sandbox, "innerWidth", { get: function () { return env.vw; }, configurable: true });
	Object.defineProperty(sandbox, "innerHeight", { get: function () { return env.vh; }, configurable: true });
	Object.defineProperty(sandbox, "devicePixelRatio", { get: function () { return env.dpr; }, configurable: true });
	env.sandbox = sandbox;
	env.src = src;
	env.clientPath = clientPath;
	env.ctxObj = vm.createContext(sandbox);
	return env;
}

function loadModule(env) {
	let captured = null;
	env.sandbox.__ModuleLoader__ = { load: function (def) { captured = def; } };
	// 用 IIFE 包裹，避免重复加载时顶层声明冲突
	vm.runInContext("(function(){\n" + env.src + "\n})();", env.ctxObj, { filename: env.clientPath });
	if (!captured) throw new Error("未通过 window.__ModuleLoader__.load 注册模块");
	return captured.factory(function () { return {}; });
}

/** 加载 + apply，返回 { mod, cleanup, env } */
function boot(env, clientPath) {
	if (!env.sandbox) buildSandbox(env, env.src || fs.readFileSync(clientPath, "utf8"), clientPath);
	const mod = loadModule(env);
	if (!mod || typeof mod.apply !== "function") throw new Error("模块未导出 apply()");
	let cleanup = null;
	mod.apply({
		effect: function (fn) { cleanup = fn(); },
	});
	if (typeof cleanup !== "function") throw new Error("apply() 未返回 cleanup 函数");
	env.cleanup = cleanup;
	return { mod: mod, cleanup: cleanup, env: env };
}

function makeEnvAndBoot(opts, src, clientPath) {
	const env = makeEnv(opts);
	boot(env, clientPath);
	return env;
}

function countFxInDom(env) {
	return collectDescendants(env.document.documentElement, []).filter(function (c) { return c.id === FX_ID; }).length;
}
function resizeListenerCount(env) {
	return env.winListeners.filter(function (l) { return l.type === "resize"; }).length;
}

/** 静态归因：源码里注册过、却从未被 removeEventListener 移除的 resize 处理函数名 */
function leakedResizeHandlers(src) {
	const added = new Set(), removed = new Set();
	const reAdd = /addEventListener\(\s*["']resize["']\s*,\s*([A-Za-z_$][\w$]*)/g;
	const reDel = /removeEventListener\(\s*["']resize["']\s*,\s*([A-Za-z_$][\w$]*)/g;
	let m;
	while ((m = reAdd.exec(src))) added.add(m[1]);
	while ((m = reDel.exec(src))) removed.add(m[1]);
	return Array.from(added).filter(function (n) { return !removed.has(n); });
}
function lastCtx(env) {
	for (var i = env.canvases.length - 1; i >= 0; i--) if (env.canvases[i].__ctx) return env.canvases[i].__ctx;
	return null;
}

// ─────────────────────────────────────────────────────────────
// 三、断言
// ─────────────────────────────────────────────────────────────

const CHECKS = [];
function addCheck(name, fn) { CHECKS.push({ name: name, fn: fn }); }

/** 预检：目标文件里是否存在特效层的关键符号（缺失时给出「未找到 XXX」而不是崩） */
function missingSymbols(src) {
	const need = [
		["FX_DEFS", /FX_DEFS/],
		["fxRaf", /fxRaf/],
		["设置键 wwp_fx", /wwp_fx/],
		["canvas id " + FX_ID, new RegExp('"wwp' + HY + 'fx"|"wwp"\\s*\\+\\s*HYPHEN\\s*\\+\\s*"fx"')],
		["面板选择器 " + SEL_FX, new RegExp('data' + HY + 'sel="fx"')],
	];
	return need.filter(function (p) { return !p[1].test(src); }).map(function (p) { return p[0]; });
}

// 1. 模块可加载、apply() 不抛
addCheck("1 模块可加载、apply() 不抛异常", function (ctx) {
	const miss = missingSymbols(ctx.src);
	if (miss.length) return { ok: false, detail: "未找到 " + miss.join("、") + " —— 目标文件可能不含视觉特效层" };
	const env = makeEnv({ ls: {} });
	boot(env, ctx.clientPath);
	if (REJECTIONS.length) return { ok: false, detail: "出现未捕获 Promise 拒绝 " + REJECTIONS.length + " 次" };
	if (env.errors.length) return { ok: false, detail: "rAF 回调抛错 " + env.errors.length + " 次: " + env.errors[0].message };
	return { ok: true, detail: "模块加载 + apply 成功，cleanup 已注册" };
});

// 2. #wwp-fx 存在、位于 #wwp-bg 之后、getElementById 稳定
addCheck("2 #wwp-fx 存在且在 #wwp-bg 之后，getElementById 幂等", function (ctx) {
	const env = makeEnvAndBoot({ ls: {} }, ctx.src, ctx.clientPath);
	const fx = env.document.getElementById(FX_ID);
	if (!fx) return { ok: false, detail: "未找到 #" + FX_ID };
	const bg = env.document.getElementById(BG_ID);
	if (!bg) return { ok: false, detail: "未找到 #" + BG_ID };
	const kids = env.document.body.children;
	const iFx = kids.indexOf(fx), iBg = kids.indexOf(bg);
	if (fx.parentNode !== env.document.body) return { ok: false, detail: "#" + FX_ID + " 的 parentNode 不是 body" };
	if (!(iFx > iBg)) return { ok: false, detail: "DOM 顺序错误: #" + BG_ID + " 下标 " + iBg + "，#" + FX_ID + " 下标 " + iFx };
	const again = env.document.getElementById(FX_ID);
	if (again !== fx) return { ok: false, detail: "getElementById 两次返回不同对象" };
	return { ok: true, detail: "body.children 顺序 bg(" + iBg + ") < fx(" + iFx + ")，引用稳定" };
});

// 3. 默认 wwp_fx="none" → 带 off 类且无循环
addCheck("3 默认 none → canvas 带 " + FX_OFF + " 且无 rAF 循环", function (ctx) {
	const env = makeEnvAndBoot({ ls: {} }, ctx.src, ctx.clientPath);
	const fx = env.document.getElementById(FX_ID);
	if (!fx) return { ok: false, detail: "未找到 #" + FX_ID };
	if (!fx.classList.contains(FX_OFF)) return { ok: false, detail: "canvas 未带类 " + FX_OFF + "（实际 className=" + fx.className + "）" };
	if (env.rafQueue.length !== 0) return { ok: false, detail: "rAF 队列长度应为 0，实际 " + env.rafQueue.length };
	env.tick(16.7); env.tick(16.7);
	if (env.rafQueue.length !== 0) return { ok: false, detail: "tick 后 rAF 队列长度应为 0，实际 " + env.rafQueue.length };
	return { ok: true, detail: "类 " + FX_OFF + " 存在，rAF 队列 0" };
});

// 4. 6 个特效逐一：有出图调用 + clearRect
addCheck("4 6 个特效逐一均有出图调用与 clearRect", function (ctx) {
	const bad = [];
	const seen = [];
	FX_IDS.forEach(function (id) {
		const env = makeEnv({ ls: { wwp_fx: id } });
		try { boot(env, ctx.clientPath); } catch (e) { bad.push(id + "(apply 抛错: " + e.message + ")"); return; }
		const before = env.snapshot();
		env.tick(16.7); env.tick(16.7); env.tick(16.7); env.tick(16.7);
		const d = env.diff(before);
		const core = coreSum(d);
		seen.push(id + "={fill:" + d.fill + ",stroke:" + d.stroke + ",fillRect:" + d.fillRect + ",drawImage:" + d.drawImage + ",clearRect:" + d.clearRect + "}");
		if (!(core > 0)) bad.push(id + "(出图调用 " + core + " = 0)");
		else if (!(d.clearRect > 0)) bad.push(id + "(clearRect = 0)");
	});
	if (bad.length) return { ok: false, detail: "未通过: " + bad.join("; ") + " | 全部: " + seen.join(" ") };
	return { ok: true, detail: seen.join(" ") };
});

// 6. 强度 0.2 → 1.5 出图调用数单调不减（20% 容差）
addCheck("6 强度 0.2→0.7→1.5 出图调用数单调不减（容差 20%）", function (ctx) {
	const pts = [];
	[0.2, 0.7, 1.5].forEach(function (v) {
		const env = makeEnv({ ls: { wwp_fx: "snow", wwp_fx_intensity: v } });
		boot(env, ctx.clientPath);
		const before = env.snapshot();
		for (var i = 0; i < 4; i++) env.tick(16.7);
		pts.push({ v: v, n: outSum(env.diff(before)) });
	});
	const bad = [];
	for (var i = 1; i < pts.length; i++) {
		if (pts[i].n < pts[i - 1].n * 0.8) bad.push("强度 " + pts[i].v + " 出图 " + pts[i].n + " < 强度 " + pts[i - 1].v + " 的 80%(" + Math.round(pts[i - 1].n * 0.8) + ")");
	}
	const desc = pts.map(function (p) { return p.v + "→" + p.n; }).join("，");
	if (bad.length) return { ok: false, detail: bad.join("; ") + " | " + desc };
	return { ok: true, detail: desc };
});

// 7. 大视口 + 强度 1.5：粒子数 ≤ 900（粒子出图口径）
addCheck("7 3840×2160 + 强度 1.5 粒子数 ≤ 900（粒子出图口径）", function (ctx) {
	function run(w, h, vw, vh) {
		const env = makeEnv({ ls: { wwp_fx: "snow", wwp_fx_intensity: 1.5 }, vw: vw, vh: vh });
		boot(env, ctx.clientPath);
		const before = env.snapshot();
		env.tick(16.7); env.tick(16.7);
		const d = env.diff(before);
		return { arc: d.arc / 2, fill: d.fill / 2, img: d.drawImage / 2, frames: 2, d: d };
	}
	const big = run(3840, 2160, 3840, 2160);
	const small = run(1920, 1080, 1920, 1080);
	// 粒子数观测口径：精灵化后每粒子每帧 1 次 drawImage（img 即粒子数）；
	// 旧实现没有 drawImage，沿用原 arc/fill 上界口径（与改动前逐字一致）。
	const spriteMode = big.img > 0;
	const perFrame = spriteMode ? big.img : big.fill / big.frames;
	const smallPerFrame = spriteMode ? small.img : small.fill / small.frames;
	const arcPerFrame = big.arc / big.frames;
	const how = spriteMode ? "drawImage/帧" : "fill 上界口径";
	if (!(perFrame > 0)) return { ok: false, detail: "大视口未观测到粒子出图调用（drawImage 与 fill 均为 0）" };
	if (spriteMode && perFrame > 900) return { ok: false, detail: "大视口粒子数 " + perFrame + "（" + how + "）超过硬上限 900" };
	if (arcPerFrame > 900 * 3) return { ok: false, detail: "大视口 arc/帧 " + arcPerFrame + " 超过保守上界 2700（=900 粒子×3 次 arc）" };
	const ratio = perFrame / smallPerFrame;
	if (!(ratio < 2.5)) return { ok: false, detail: "面积放大 4 倍后粒子数放大 " + ratio.toFixed(2) + " 倍（≥2.5），未见硬上限截断" };
	return { ok: true, detail: "大视口粒子/帧=" + perFrame + "（" + how + "）≤ 900、arc/帧=" + arcPerFrame + " ≤ 2700；同参数 1920×1080 粒子/帧=" + smallPerFrame + "，面积 4 倍仅放大 " + ratio.toFixed(2) + " 倍 → 已被 900 上限截断" };
});

// 8. speed 生效：同帧数下位移统计不同
addCheck("8 wwp_fx_speed=2 相对 1 的位移统计显著更大", function (ctx) {
	function run(speed) {
		const env = makeEnv({ ls: { wwp_fx: "snow", wwp_fx_speed: speed, wwp_fx_intensity: 1 } });
		boot(env, ctx.clientPath);
		const marks = [];
		for (var i = 0; i < 4; i++) { env.tick(16.7); marks.push(env.arcLog.length); }
		return yDisplacement(env.arcLog, marks);
	}
	const s1 = run(1), s2 = run(2);
	if (!(s1 > 0)) return { ok: false, detail: "speed=1 位移统计为 " + s1 + "，无法观测（桩局限）" };
	const ratio = s2 / s1;
	if (!(ratio > 1.3)) return { ok: false, detail: "speed=2 位移 " + s2.toFixed(1) + " 相对 speed=1 位移 " + s1.toFixed(1) + " 仅 " + ratio.toFixed(2) + " 倍（阈值 1.3）" };
	return { ok: true, detail: "位移和 speed1=" + s1.toFixed(1) + " speed2=" + s2.toFixed(1) + "，比值 " + ratio.toFixed(2) };
});

// 9. opacity 变小 → 观测到的 globalAlpha 赋值整体变小
addCheck("9 wwp_fx_opacity 变小 → globalAlpha 赋值整体变小", function (ctx) {
	function mean(op) {
		const env = makeEnv({ ls: { wwp_fx: "snow", wwp_fx_opacity: op } });
		boot(env, ctx.clientPath);
		for (var i = 0; i < 3; i++) env.tick(16.7);
		const vals = env.alphaLog.filter(function (v) { return isFinite(v) && v !== 1; });
		if (!vals.length) return null;
		return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
	}
	const hi = mean(1), lo = mean(0.3);
	if (hi === null || lo === null) return { ok: false, detail: "未观测到 globalAlpha 赋值（hi=" + hi + ", lo=" + lo + "）" };
	if (!(lo < hi)) return { ok: false, detail: "opacity 0.3 的平均 alpha " + lo.toFixed(4) + " 未小于 opacity 1 的 " + hi.toFixed(4) };
	return { ok: true, detail: "opacity1 平均 alpha=" + hi.toFixed(4) + "，opacity0.3 平均 alpha=" + lo.toFixed(4) };
});

// 10. document.hidden 暂停 / 恢复
addCheck("10 document.hidden=true 暂停出图，置回 false 恢复", function (ctx) {
	const env = makeEnv({ ls: { wwp_fx: "snow" } });
	boot(env, ctx.clientPath);
	env.tick(16.7); env.tick(16.7);
	const before = env.snapshot();
	env.hidden = true;
	env.tick(16.7);                                  // 这一帧发现 hidden，停止重排
	const afterHide = env.snapshot();
	if (env.rafQueue.length !== 0) return { ok: false, detail: "hidden 后 rAF 队列仍为 " + env.rafQueue.length };
	env.tick(16.7); env.tick(16.7);
	const afterMore = env.snapshot();
	if (outSum(env.diff(afterHide)) !== 0) return { ok: false, detail: "hidden 期间仍新增出图调用 " + outSum(env.diff(afterHide)) };
	env.hidden = false;
	env.document.dispatchEvent({ type: "visibilitychange" });
	if (env.rafQueue.length === 0) return { ok: false, detail: "hidden=false + visibilitychange 后未恢复 rAF 循环" };
	env.tick(16.7);
	const resumed = outSum(env.diff(afterMore));
	if (!(resumed > 0)) return { ok: false, detail: "恢复后出图调用仍为 0" };
	return { ok: true, detail: "hidden 期间新增出图 0（rAF 队列 0），恢复后单帧新增出图 " + resumed };
});

// 11. prefers-reduced-motion 命中 / matchMedia 缺失
addCheck("11 reduced-motion 命中不启动循环；matchMedia 缺失不抛错", function (ctx) {
	const env = makeEnv({ ls: { wwp_fx: "snow" }, reduceMotion: true });
	boot(env, ctx.clientPath);
	if (env.rafQueue.length !== 0) return { ok: false, detail: "reduced-motion 命中后 rAF 队列为 " + env.rafQueue.length };
	const env2 = makeEnv({ ls: { wwp_fx: "snow" }, noMatchMedia: true });
	boot(env2, ctx.clientPath);
	env2.tick(16.7);
	return { ok: true, detail: "reduced-motion: rAF 队列 0；matchMedia 缺失: apply 未抛错且循环照常（队列 " + env2.rafQueue.length + "）" };
});

// 12. cleanup 彻底；反复 apply→cleanup 5 轮不泄漏
addCheck("12 cleanup 彻底；5 轮 apply→cleanup 无 DOM/rAF/监听泄漏", function (ctx) {
	const env = makeEnv({ ls: { wwp_fx: "snow" } });
	const base = resizeListenerCount(env);
	const rounds = [];
	const bad = [];
	for (var i = 0; i < 5; i++) {
		boot(env, ctx.clientPath);
		const inDom = countFxInDom(env);
		const applyLsn = resizeListenerCount(env);
		env.tick(16.7);
		env.cleanup();
		const afterDom = countFxInDom(env);
		const afterLsn = resizeListenerCount(env);
		rounds.push({ r: i + 1, inDom: inDom, applyLsn: applyLsn, removed: applyLsn - afterLsn, afterDom: afterDom, raf: env.rafQueue.length, afterLsn: afterLsn });
		if (inDom > 1) bad.push("第" + (i + 1) + "轮 apply 后 DOM 中 #" + FX_ID + " 有 " + inDom + " 个");
		if (afterDom !== 0) bad.push("第" + (i + 1) + "轮 cleanup 后 DOM 仍残留 #" + FX_ID + " " + afterDom + " 个");
		if (rounds[i].raf !== 0) bad.push("第" + (i + 1) + "轮 cleanup 后 rAF 队列为 " + rounds[i].raf);
	}
	const seq = rounds.map(function (r) { return r.afterLsn; }).join("→");
	const seqApply = rounds.map(function (r) { return r.applyLsn; }).join("→");
	const seqRemoved = rounds.map(function (r) { return r.removed; }).join("→");
	const last = rounds[rounds.length - 1].afterLsn;
	let leakNote = "（特效层监听每轮 apply 后 +1、cleanup 后 -1，即 apply 后 " + seqApply + " → cleanup 后 " + seq + "，每轮移除 " + seqRemoved + " 个）";
	if (last > base) {
		const leak = leakedResizeHandlers(ctx.src);
		leakNote += " | 归因: 残留者为 " + (leak.length ? leak.join(",") : "(静态分析未定位)") + " —— 源码中注册但无对应 removeEventListener，属壁纸层遗留";
		bad.push("cleanup 后 window resize 监听数增长 " + (last - base) + "（" + base + "→" + seq + "）");
	}
	if (bad.length) return { ok: false, detail: bad.join("; ") + leakNote };
	return { ok: true, detail: "5 轮：apply 后 DOM 中 #" + FX_ID + " 恒为 1、cleanup 后 0、rAF 队列 0、resize 监听恒为 " + base + "（每轮新增的 fxOnResizeBound 均被移除）" };
});

/** 手动派发 window 上的某类监听：桩里的 addEventListener 只把处理函数登记进 env.winListeners */
function fireWindowListeners(env, type) {
	const ls = env.winListeners.filter(function (l) { return l.type === type; }).slice();
	for (var i = 0; i < ls.length; i++) {
		try { ls[i].fn({ type: type }); } catch (e) { env.errors.push(e); }
	}
	return ls.length;
}

// 13. dt 钳制 50ms：一次性推进 performance.now() 500ms，位移不得超过 50ms 帧的 1.5 倍
addCheck("13 dt 钳制 50ms：单帧推进 500ms 的位移 ≈ 推进 50ms（非 10 倍）", function (ctx) {
	// 口径：snow 每粒子每帧 arc 一次，env.arcLog 记录了 arc 的 (x,y,r)；
	// yDisplacement 按帧边界对「同索引粒子」求正向 y 位移和 → 该帧的位移量。
	// 首帧 fxLast=0，ms 固定按 16.7 处理，因此先跑一帧作基线，再推进目标时长跑观测帧。
	function oneFrame(stepMs) {
		const env = makeEnv({ ls: { wwp_fx: "snow", wwp_fx_intensity: 1, wwp_fx_speed: 1 } });
		boot(env, ctx.clientPath);
		env.tick(16.7);                                  // 基线帧
		const m0 = env.arcLog.length;
		env.tick(stepMs);                                // 观测帧：now 一次性推进 stepMs
		const m1 = env.arcLog.length;
		return { d: yDisplacement(env.arcLog, [m0, m1]), m0: m0, m1: m1 };
	}
	const a = oneFrame(50), b = oneFrame(500);
	const desc = "推进 50ms 位移=" + a.d.toFixed(1) + "，推进 500ms 位移=" + b.d.toFixed(1);
	if (!(a.d > 0)) return { ok: false, detail: "推进 50ms 的位移统计为 " + a.d.toFixed(1) + "，无法观测（桩局限）；" + desc };
	const ratio = b.d / a.d;
	if (!(ratio <= 1.5)) return { ok: false, detail: "500ms 帧位移是 50ms 帧的 " + ratio.toFixed(2) + " 倍（阈值 1.5）—— dt 未被钳制到 50ms；" + desc };
	return { ok: true, detail: desc + "，比值 " + ratio.toFixed(2) + "（未钳制应≈10 倍）→ dt 上限 50ms 生效" };
});

// 14. dpr 上限 2：devicePixelRatio=3 时 canvas 按 2 倍落盘，改回 1 后跟随
addCheck("14 dpr 上限 2：devicePixelRatio=3 → canvas 按 2 倍尺寸", function (ctx) {
	const env = makeEnv({ ls: { wwp_fx: "snow" }, dpr: 3, vw: 800, vh: 600 });
	boot(env, ctx.clientPath);
	const c = env.document.getElementById(FX_ID);
	if (!c) return { ok: false, detail: "未找到 #" + FX_ID };
	const hi = c.width + "×" + c.height;
	if (c.width !== 1600) return { ok: false, detail: "dpr=3 / 800×600 → canvas.width=" + c.width + "（期望 1600 = 800×2，被上限截断），canvas=" + hi };
	if (c.height !== 1200) return { ok: false, detail: "dpr=3 / 800×600 → canvas.height=" + c.height + "（期望 1200 = 600×2，被上限截断），canvas=" + hi };
	// 改 dpr 后需触发一次尺寸重算：源码在 resize 事件里调 fxSync() → fxResize()
	env.dpr = 1;
	fireWindowListeners(env, "resize");
	const lo = c.width + "×" + c.height;
	if (c.width !== 800 || c.height !== 600) return { ok: false, detail: "dpr 改回 1 + resize 后 canvas=" + lo + "（期望 800×600）" };
	return { ok: true, detail: "dpr=3 → canvas=" + hi + "（800×600 × 上限 2，width 被截断为 1600）；dpr=1 + resize → " + lo };
});

// 15. rAF 幂等：反复切换特效 / 反复 resize 后仍只有一个排队帧
addCheck("15 rAF 幂等：20 次特效切换 + 20 次 resize 后 rafQueue ≤ 1", function (ctx) {
	const env = makeEnv({ ls: { wwp_fx: "none" } });
	boot(env, ctx.clientPath);
	const sel = env.document.querySelector(SEL_FX);
	if (!sel) return { ok: false, detail: "未找到面板控件 " + SEL_FX };
	const ids = ["snow", "stars", "none"];
	for (var i = 0; i < 20; i++) {
		sel.value = ids[i % ids.length];
		sel.trigger("change");                           // 走真实控件路径：change → fxSync()
		env.tick(16.7);
	}
	const afterSwitch = env.rafQueue.length;
	if (afterSwitch > 1) return { ok: false, detail: "20 次切换后 rafQueue=" + afterSwitch + "（应 ≤ 1）—— 循环被重复启动" };
	for (var j = 0; j < 20; j++) {
		env.vw = 800 + (j % 5) * 10;                     // 让每次 resize 都真正触发尺寸重算
		fireWindowListeners(env, "resize");
	}
	const afterResize = env.rafQueue.length;
	if (afterResize > 1) return { ok: false, detail: "20 次 resize 后 rafQueue=" + afterResize + "（应 ≤ 1）—— 切换/尺寸重算未保持幂等" };
	sel.value = "none";
	sel.trigger("change");
	env.tick(16.7);
	const afterNone = env.rafQueue.length;
	if (afterNone !== 0) return { ok: false, detail: "设回 none + tick 后 rafQueue=" + afterNone + "（应为 0）—— 停止时未取消排队帧" };
	return { ok: true, detail: "20 次切换后 rafQueue=" + afterSwitch + "，20 次 resize 后 rafQueue=" + afterResize + "，设回 none + tick 后 rafQueue=" + afterNone };
});

// 16. mainCSS() 的 #wwp-fx 规则必须显式声明 width / height
//     canvas 是替换元素：只写 inset:0 不会拉伸它，width:auto 取内在宽度（= canvas.width）。
//     fxResize 把 canvas.width 设为 round(innerWidth × dpr)，因此 dpr≠1 时 CSS 盒子 = 视口 × dpr，
//     特效层被放大并裁掉（dpr=2 时只看得见左上角 25%，雪花变成大白斑）。
addCheck("16 #" + FX_ID + " 规则含 width:100% 与 height:100%（dpr≠1 不被放大裁切）", function (ctx) {
	const m = new RegExp("#" + FX_ID + "\\s*\\{([^}]*)\\}").exec(ctx.src);
	if (!m) return { ok: false, detail: "源码中找不到 #" + FX_ID + " 的 CSS 规则（规则被删或被改名？）" };
	const body = m[1].replace(/\s+/g, " ").trim();
	const hasW = /(^|[;\s])width\s*:\s*100%\s*(;|$)/.test(body);
	const hasH = /(^|[;\s])height\s*:\s*100%\s*(;|$)/.test(body);
	if (!hasW || !hasH) {
		return { ok: false, detail: "规则缺少 " + (!hasW ? "width: 100%" : "") + (!hasW && !hasH ? " 与 " : "") + (!hasH ? "height: 100%" : "") + " —— 实测: {" + body + "}" };
	}
	return { ok: true, detail: "{" + body + "}" };
});

// ─────────────────────────────────────────────────────────────
// 四、主流程
// ─────────────────────────────────────────────────────────────

function main() {
	const argv = process.argv.slice(2);
	const dump = argv.indexOf("--dump") >= 0;
	const positional = argv.filter(function (a) { return a.charAt(0) !== "-"; });
	const clientPath = path.resolve(positional[0] || path.join(__dirname, "..", "lib", "client.js"));
	if (!fs.existsSync(clientPath)) {
		console.log("[失败] 找不到源文件: " + clientPath);
		console.log("汇总: 共 0 项检查，0 项通过，1 项失败");
		process.exit(1);
	}
	const src = fs.readFileSync(clientPath, "utf8");
	const ctx = { clientPath: clientPath, src: src };

	let pass = 0, fail = 0;
	const envs = [];
	const origBoot = boot;
	CHECKS.forEach(function (c) {
		let r;
		try {
			r = c.fn(ctx);
		} catch (e) {
			r = { ok: false, detail: "检查自身抛异常: " + (e && e.stack ? e.stack.split("\n")[0] : e) };
		}
		if (r === true || r === undefined) r = { ok: true, detail: "" };
		if (r.ok) { pass++; console.log("[通过] " + c.name + (r.detail ? " —— " + r.detail : "")); }
		else { fail++; console.log("[失败] " + c.name + " —— " + (r.detail || "未给出原因")); }
	});

	if (REJECTIONS.length) {
		fail++;
		console.log("[失败] 宿主侧出现 " + REJECTIONS.length + " 次未捕获 Promise 拒绝: " + REJECTIONS.map(function (e) { return e && e.message; }).join("; "));
	}

	if (dump) {
		console.log("");
		console.log("── dump（snow / 1280×800 / 默认参数，跑 4 帧后取样）──");
		let env = null;
		try {
			env = makeEnv({ ls: { wwp_fx: "snow" } });
			boot(env, clientPath);
			for (var i = 0; i < 4; i++) env.tick(16.7);
		} catch (e) {
			console.log("dump 环境构建失败: " + e.message);
		}
		if (!env) console.log("(无可用环境)");
		else {
			const d = env.draw;
			console.log("出图调用: fill=" + d.fill + " stroke=" + d.stroke + " fillRect=" + d.fillRect + " strokeRect=" + d.strokeRect + " fillText=" + d.fillText + " drawImage=" + d.drawImage + " (合计 " + outSum(d) + ")");
			console.log("辅助调用: clearRect=" + d.clearRect + " arc=" + d.arc + " beginPath=" + d.beginPath + " moveTo=" + d.moveTo + " lineTo=" + d.lineTo + " save=" + d.save + " restore=" + d.restore + " gradient=" + (d.createRadialGradient + d.createLinearGradient));
			console.log("rAF 队列长度=" + env.rafQueue.length + "，已取消=" + env.cancelled.length);
			console.log("window 监听=" + env.winListeners.length + "（resize " + resizeListenerCount(env) + "），document 监听=" + env.docListeners.length);
			console.log("DOM 中 #" + FX_ID + " 数量=" + countFxInDom(env) + "，canvas.width×height=" + (env.canvases[0] ? env.canvases[0].width + "×" + env.canvases[0].height : "n/a"));
			console.log("globalAlpha 赋值 " + env.alphaLog.length + " 次，globalCompositeOperation 赋值 " + env.compLog.length + " 次");
		}
	}

	console.log("");
	console.log("汇总: 共 " + (pass + fail) + " 项检查，" + pass + " 项通过，" + fail + " 项失败");
	process.exit(fail === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { makeEnv: makeEnv, boot: boot, FX_ID: FX_ID, FX_OFF: FX_OFF, HY: HY };
