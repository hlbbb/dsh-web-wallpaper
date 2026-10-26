#!/usr/bin/env node
/**
 * dsh-web-wallpaper · MP4/视频动态壁纸 —— 离线自检（回归门）
 *
 * 用法:
 *   node tools/check-video.cjs                  # 默认检查 lib/client.js
 *   node tools/check-video.cjs lib/client.js
 *
 * 做法: 不打开浏览器。用「DOM 桩 + vm 沙箱」真实执行 lib/client.js，
 * 让 apply() / renderBG() / importFiles() / renderGrid() 的真实代码跑起来，
 * 再用增强桩（内存 IndexedDB、Blob、FileReader、URL.createObjectURL、HTMLVideoElement）
 * 断言 10 项视频契约（契约来源: tmp/video-wallpaper-spec.md）。
 *
 * 退出码: 0 = 全部通过；1 = 存在失败。
 *
 * 工具层怪癖: 本会话工具层历史上会吞掉字面连字符及其后 0-3 字符，
 * 所以所有含连字符的标识符（data-act / wwp-bg / video/mp4 属性名 …）
 * 一律用 String.fromCharCode(45) 拼出来，绝不写字面连字符。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── 连字符（一律拼，不写字面量）──
const HY = String.fromCharCode(45);
/** data-xxx */
function attr(name) { return "data" + HY + name; }
/** wwp-xxx */
function wid(name) { return "wwp" + HY + name; }
/** [data-xxx] 或 [data-xxx="value"] */
function sel(name, value) {
  return "[" + attr(name) + (value === undefined ? "" : "=\"" + value + "\"") + "]";
}

const ID_BG = wid("bg");
const ID_VIDEO = wid("video");
const DARK_ATTR = "data" + HY + "ds" + HY + "dark" + HY + "theme";
const HIDDEN_CLASS = wid("hidden");

// ── 命令行 ──
const file = path.resolve(process.argv[2] || "lib/client.js");
const DUMP = process.argv.includes("--dump");

// 读文件：不存在 / 不可读 / 非法 UTF-8 都给出人类可读的中文报告，绝不甩栈。
let src = null;
let readError = null;
try {
  if (!fs.existsSync(file)) throw new Error("文件不存在: " + file);
  if (!fs.statSync(file).isFile()) throw new Error("不是普通文件: " + file);
  src = fs.readFileSync(file, "utf8");
} catch (e) {
  readError = e;
}

// 未捕获的 Promise 拒绝（沙箱与宿主共用一个 Promise realm，能抓到）
const unhandled = [];
process.on("unhandledRejection", function (reason) { unhandled.push(reason); });

// ── 桩: Blob / File ──
class MockBlob {
  constructor(parts, opts) {
    this.parts = parts === undefined ? [] : parts;
    this.type = opts && opts.type ? String(opts.type) : "";
    var arr = Array.isArray(this.parts) ? this.parts : [this.parts];
    var size = 0;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (typeof p === "string") size += p.length;
      else if (p && typeof p.size === "number") size += p.size;
    }
    this.size = size;
  }
}
class MockFile extends MockBlob {
  constructor(parts, name, opts) {
    super(parts, opts);
    this.name = String(name === undefined ? "" : name);
    this.lastModified = 1700000000000;
  }
}

// ── 结构化克隆 / 配额 模拟 ──
const QUOTA_BYTES = 8 * 1024 * 1024;

function findUnclonable(v, seen) {
  if (v === null || v === undefined) return null;
  var t = typeof v;
  if (t === "function" || t === "symbol") return t;
  if (t !== "object") return null;
  if (v instanceof MockBlob) return null;
  if (typeof ArrayBuffer !== "undefined" && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) return null;
  if (v instanceof Date || v instanceof RegExp) return null;
  seen = seen || new Set();
  if (seen.has(v)) return null;
  seen.add(v);
  if (Array.isArray(v)) {
    for (var i = 0; i < v.length; i++) {
      var r = findUnclonable(v[i], seen);
      if (r) return r;
    }
    return null;
  }
  var keys = Object.keys(v);
  for (var k = 0; k < keys.length; k++) {
    var val;
    try { val = v[keys[k]]; } catch (e) { continue; }
    var rr = findUnclonable(val, seen);
    if (rr) return keys[k] + " -> " + rr;
  }
  return null;
}

function findHugeString(v, seen) {
  if (v === null || v === undefined) return 0;
  var t = typeof v;
  if (t === "string") return v.length > QUOTA_BYTES ? v.length : 0;
  if (t !== "object") return 0;
  if (v instanceof MockBlob) return 0;
  seen = seen || new Set();
  if (seen.has(v)) return 0;
  seen.add(v);
  var all = Array.isArray(v) ? v : Object.keys(v).map(function (k) { try { return v[k]; } catch (e) { return null; } });
  for (var i = 0; i < all.length; i++) {
    var n = findHugeString(all[i], seen);
    if (n) return n;
  }
  return 0;
}

// ── 桩: DOM 元素 ──
function makeStyle() {
  var vars = {};
  var st = {};
  st.setProperty = function (k, v) { vars[k] = String(v); st[k] = String(v); };
  st.removeProperty = function (k) { delete vars[k]; };
  st.getPropertyValue = function (k) { return vars[k] === undefined ? "" : vars[k]; };
  st._vars = vars;
  return st;
}

function makeClassList(el) {
  return {
    add: function () { for (var i = 0; i < arguments.length; i++) el._classes.add(arguments[i]); },
    remove: function () { for (var i = 0; i < arguments.length; i++) el._classes.delete(arguments[i]); },
    contains: function (c) { return el._classes.has(c); },
    toggle: function (c, on) {
      if (on === undefined) { if (el._classes.has(c)) el._classes.delete(c); else el._classes.add(c); }
      else if (on) el._classes.add(c); else el._classes.delete(c);
    },
    get length() { return el._classes.size; }
  };
}

/** 选择器解析（不用带连字符字符类的正则，规避工具层吞字） */
function parseSelector(s) {
  var conds = [];
  var str = String(s === undefined || s === null ? "" : s).trim();
  var i = 0;
  while (i < str.length) {
    var ch = str.charAt(i);
    if (ch === "[") {
      var end = str.indexOf("]", i);
      if (end === -1) break;
      var body = str.slice(i + 1, end);
      var eq = body.indexOf("=");
      if (eq === -1) conds.push({ kind: "has", name: body.trim() });
      else {
        var v = body.slice(eq + 1).trim();
        var q0 = v.charAt(0), q1 = v.charAt(v.length - 1);
        if ((q0 === '"' && q1 === '"') || (q0 === "'" && q1 === "'")) v = v.slice(1, -1);
        conds.push({ kind: "eq", name: body.slice(0, eq).trim(), value: v });
      }
      i = end + 1;
    } else if (ch === ".") {
      var j = i + 1;
      while (j < str.length && str.charAt(j) !== "." && str.charAt(j) !== "[") j++;
      conds.push({ kind: "class", value: str.slice(i + 1, j) });
      i = j;
    } else {
      var k = i;
      while (k < str.length && str.charAt(k) !== "." && str.charAt(k) !== "[") k++;
      conds.push({ kind: "tag", value: str.slice(i, k) });
      i = k;
    }
  }
  return conds;
}

function matchesEl(el, conds) {
  for (var i = 0; i < conds.length; i++) {
    var c = conds[i];
    if (c.kind === "tag") { if (el.tagName !== c.value.toUpperCase()) return false; }
    else if (c.kind === "class") { if (!el._classes.has(c.value)) return false; }
    else if (c.kind === "has") { if (!Object.prototype.hasOwnProperty.call(el._attrs, c.name)) return false; }
    else if (c.kind === "eq") { if (String(el._attrs[c.name]) !== c.value) return false; }
  }
  return true;
}

/** 简易 HTML 解析（只覆盖插件 innerHTML 用到的那套标签） */
function parseAttrs(s) {
  var attrs = {};
  var i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    if (i >= s.length) break;
    var j = i;
    while (j < s.length && s.charAt(j) !== "=" && !/\s/.test(s.charAt(j))) j++;
    var name = s.slice(i, j);
    i = j;
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    var val = "";
    if (s.charAt(i) === "=") {
      i++;
      while (i < s.length && /\s/.test(s.charAt(i))) i++;
      var q = s.charAt(i);
      if (q === '"' || q === "'") {
        i++;
        var end = s.indexOf(q, i);
        if (end === -1) { val = s.slice(i); i = s.length; }
        else { val = s.slice(i, end); i = end + 1; }
      } else {
        var k = i;
        while (k < s.length && !/\s/.test(s.charAt(k))) k++;
        val = s.slice(i, k);
        i = k;
      }
    }
    if (name) attrs[name] = val;
  }
  return attrs;
}

var VOID_TAGS = { input: 1, img: 1, br: 1, hr: 1, meta: 1, link: 1, source: 1, track: 1 };

function parseHTML(html, createEl) {
  var roots = [];
  var stack = [];
  function push(el) { if (stack.length) stack[stack.length - 1].appendChild(el); else roots.push(el); }
  function text(t) { if (!t) return; if (stack.length) { var p = stack[stack.length - 1]; p.textContent += t; } }
  var i = 0;
  while (i < html.length) {
    var lt = html.indexOf("<", i);
    if (lt === -1) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    var gt = html.indexOf(">", lt);
    if (gt === -1) break;
    var raw = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (raw.charAt(0) === "/") {
      var closeName = raw.slice(1).trim().toLowerCase();
      for (var k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tagName.toLowerCase() === closeName) { stack.length = k; break; }
      }
      continue;
    }
    var m = /^([a-zA-Z0-9]+)/.exec(raw);
    if (!m) continue;
    var tag = m[1].toLowerCase();
    var el = createEl(tag);
    var a = parseAttrs(raw.slice(m[1].length));
    for (var key in a) { if (Object.prototype.hasOwnProperty.call(a, key)) el.setAttribute(key, a[key]); }
    push(el);
    if (!VOID_TAGS[tag] && raw.charAt(raw.length - 1) !== "/") stack.push(el);
  }
  return roots;
}

/** 建一个全新 DOM 元素桩 */
function makeEl(tag, env) {
  var el = {
    tagName: String(tag).toUpperCase(),
    parentNode: null,
    children: [],
    _attrs: {},
    _classes: new Set(),
    _listeners: Object.create(null),
    _innerHTMLSrc: "",
    style: makeStyle(),
    dataset: {},
    textContent: "",
    value: "",
    checked: false,
    type: "",
    accept: "",
    multiple: false,
    title: "",
    id: "",
    className: "",
    hidden: false,
    disabled: false,
    files: null,
    loading: "",
    options: [],
    playsInline: false,
    preload: "",
    muted: false,
    loop: false,
    playbackRate: 1,
    currentTime: 0,
    readyState: 0,
    duration: NaN,
    volume: 1,
    paused: true,
    videoWidth: 0,
    videoHeight: 0
  };
  el.classList = makeClassList(el);

  Object.defineProperty(el, "id", {
    get: function () { return el._attrs.id === undefined ? "" : String(el._attrs.id); },
    set: function (v) { el.setAttribute("id", v); },
    configurable: true, enumerable: true
  });
  Object.defineProperty(el, "className", {
    get: function () { return el._attrs["class"] === undefined ? "" : String(el._attrs["class"]); },
    set: function (v) {
      el._attrs["class"] = String(v);
      el._classes.clear();
      String(v).split(/\s+/).forEach(function (c) { if (c) el._classes.add(c); });
    },
    configurable: true, enumerable: true
  });
  Object.defineProperty(el, "innerHTML", {
    get: function () { return el._innerHTMLSrc; },
    set: function (v) {
      el._innerHTMLSrc = String(v);
      el.children.length = 0;
      el.textContent = "";
      var roots = parseHTML(el._innerHTMLSrc, function (t) { return createElementFn(env, t); });
      for (var i = 0; i < roots.length; i++) el.appendChild(roots[i]);
    },
    configurable: true, enumerable: true
  });

  // 字符串属性反射：真实 DOM 里 `el.type = "file"` 等价于 setAttribute("type","file")，
  // 所以必须镜像到 _attrs，否则 `input[type="file"]` 之类的选择器选不中。
  // 注意 value / checked 刻意不反射（真实 DOM 亦不反射到 attribute）。
  ["type", "accept", "placeholder", "title", "name", "min", "max", "step", "loading", "rel", "href"].forEach(function (p) {
    Object.defineProperty(el, p, {
      get: function () { return el._attrs[p] === undefined ? "" : String(el._attrs[p]); },
      set: function (v) { if (v === null || v === undefined) delete el._attrs[p]; else el._attrs[p] = String(v); },
      configurable: true, enumerable: true
    });
  });
  // 布尔属性反射为 attribute 存在性
  ["multiple", "disabled", "hidden"].forEach(function (p) {
    Object.defineProperty(el, p, {
      get: function () { return Object.prototype.hasOwnProperty.call(el._attrs, p); },
      set: function (v) { if (v) el._attrs[p] = ""; else delete el._attrs[p]; },
      configurable: true, enumerable: true
    });
  });

  el.setAttribute = function (k, v) {
    el._attrs[k] = String(v);
    if (k === "id") env.byId.set(String(v), el);
  };
  el.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null;
  };
  el.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(el._attrs, k); };
  el.removeAttribute = function (k) {
    delete el._attrs[k];
    if (k === "id") { /* 保留注册，简化 */ }
  };
  el.appendChild = function (c) {
    if (!c) return c;
    if (c.parentNode && c.parentNode !== el) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.removeChild = function (c) {
    el.children = el.children.filter(function (x) { return x !== c; });
    if (c) c.parentNode = null;
    return c;
  };
  el.remove = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  el.addEventListener = function (type, fn) {
    if (typeof fn !== "function") return;
    (el._listeners[type] || (el._listeners[type] = [])).push(fn);
  };
  el.removeEventListener = function (type, fn) {
    var hs = el._listeners[type];
    if (!hs) return;
    el._listeners[type] = hs.filter(function (h) { return h !== fn; });
  };
  el.dispatchEvent = function (evt) {
    var hs = (el._listeners[evt && evt.type] || []).slice();
    for (var i = 0; i < hs.length; i++) {
      try { hs[i].call(el, evt); } catch (e) { env.errors.push(e); }
    }
    return true;
  };
  el.click = function () { el.dispatchEvent(makeEvent("click", el)); };
  el.focus = function () {};
  el.blur = function () {};
  el.contains = function (other) {
    var cur = other;
    while (cur) { if (cur === el) return true; cur = cur.parentNode; }
    return false;
  };
  el.getBoundingClientRect = function () { return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 }; };
  el.setPointerCapture = function () {};
  el.releasePointerCapture = function () {};
  el.hasPointerCapture = function () { return false; };
  el.querySelector = function (s) { var r = el.querySelectorAll(s); return r.length ? r[0] : null; };
  el.querySelectorAll = function (s) {
    var conds = parseSelector(s);
    var out = [];
    (function walk(node) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (matchesEl(c, conds)) out.push(c);
        walk(c);
      }
    })(el);
    return out;
  };
  el.closest = function (s) {
    var conds = parseSelector(s);
    var cur = el;
    while (cur) { if (matchesEl(cur, conds)) return cur; cur = cur.parentNode; }
    return null;
  };
  return el;
}

function makeEvent(type, target, props) {
  var evt = {
    type: type, target: target, currentTarget: target, defaultPrevented: false,
    stopPropagation: function () {}, stopImmediatePropagation: function () {},
    preventDefault: function () { evt.defaultPrevented = true; }
  };
  if (props) for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) evt[k] = props[k];
  return evt;
}

/** 视频元素桩：可控的 play() Promise + 调用序列记录 */
function makeVideoEl(env) {
  var el = makeEl("video", env);
  var origSetAttr = el.setAttribute;
  el.setAttribute = function (k, v) {
    origSetAttr(k, v);
    // 修复版 makePoster 可能走 setAttribute("src", …) 而不是属性赋值，
    // 两条路径都要能补发媒体事件，否则截帧链路跑不完。
    if (String(k) === "src" && env.autoVideoEvents) scheduleMediaEvents(env, el);
  };
  Object.defineProperty(el, "src", {
    get: function () { return el._attrs.src === undefined ? "" : String(el._attrs.src); },
    set: function (v) { el._attrs.src = String(v); if (env.autoVideoEvents) scheduleMediaEvents(env, el); },
    configurable: true, enumerable: true
  });
  el.playCalls = 0;
  el.pauseCalls = 0;
  el.loadCalls = 0;
  el.playReturns = [];
  el.play = function () {
    el.playCalls++;
    env.videoCalls.push({ op: "play", el: el });
    el.paused = false;
    if (env.playReject) {
      var err = new Error("play() failed because the user didn't interact with the document first");
      err.name = "NotAllowedError";
      el.playReturns.push("reject");
      return Promise.reject(err);
    }
    el.playReturns.push("resolve");
    el.readyState = 4;
    return Promise.resolve();
  };
  el.pause = function () {
    el.pauseCalls++;
    env.videoCalls.push({ op: "pause", el: el });
    el.paused = true;
  };
  el.load = function () {
    el.loadCalls++;
    env.videoCalls.push({ op: "load", el: el });
    if (env.autoVideoEvents) scheduleMediaEvents(env, el);
  };
  el.canPlayType = function () { return "maybe"; };
  // makePoster() 截帧链路需要 videoWidth/videoHeight 非零才会走 drawImage + toDataURL
  if (env.autoVideoEvents) {
    el.videoWidth = env.videoDims[0];
    el.videoHeight = env.videoDims[1];
    el.duration = 10;
    Object.defineProperty(el, "currentTime", {
      get: function () { return el._currentTime || 0; },
      set: function (v) {
        el._currentTime = Number(v);
        if (env.autoVideoEvents) {
          setTimeout(function () {
            fire(el, "seeked");
            fireMedia(env, el, "seeked");
          }, 0);
        }
      },
      configurable: true, enumerable: true
    });
  }
  env.videos.push(el);
  return el;
}

/**
 * 异步补发媒体事件（仅在 opts.autoVideoEvents 时）。
 * 这样 makePoster() 不必等 8 秒超时降级，而是真的走到 drawImage + toDataURL。
 */
function scheduleMediaEvents(env, el) {
  setTimeout(function () {
    if (!el || !el._attrs || !Object.prototype.hasOwnProperty.call(el._attrs, "src")) return;
    el.readyState = 4;
    fire(el, "loadedmetadata");
    fireMedia(env, el, "loadedmetadata");
    fire(el, "loadeddata");
    fireMedia(env, el, "loadeddata");
  }, 0);
}

/** 应用自己挂的监听器走 el._listeners，fire() 已经覆盖；这里保留占位便于阅读 */
function fireMedia(env, el, type) { return type; }

/** canvas 桩（实现可能用它截帧生成 poster） */
function makeCanvasEl(env) {
  var el = makeEl("canvas", env);
  el.width = 0;
  el.height = 0;
  el.getContext = function () {
    return {
      drawImage: function () {
        env.canvasCalls.drawImage++;
        if (env.canvasDrawThrows) {
          var e = new Error("Failed to execute 'drawImage': tainted canvas");
          e.name = "SecurityError";
          throw e;
        }
      },
      fillRect: function () {}, clearRect: function () {}, drawImageData: function () {}
    };
  };
  el.toDataURL = function (mime) {
    env.canvasCalls.toDataURL++;
    // 跨域污染的画布：真实浏览器里 toDataURL() 也会抛 SecurityError。
    if (env.canvasDrawThrows) {
      var e = new Error("Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
      e.name = "SecurityError";
      throw e;
    }
    return "data:" + (mime || "image/jpeg") + ";base64,UE9TVEVS";
  };
  return el;
}

function createElementFn(env, tag) {
  var t = String(tag).toLowerCase();
  if (t === "video") return makeVideoEl(env);
  if (t === "canvas") return makeCanvasEl(env);
  return makeEl(t, env);
}

// ── 桩: 内存 IndexedDB ──
function makeReq() {
  return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onabort: null, readyState: "pending" };
}

function makeIndexedDB(env) {
  var dbs = new Map();

  function makeTx(stores, storeName, mode) {
    var tx = { mode: mode, oncomplete: null, onerror: null, onabort: null, error: null, _pending: [], _scheduled: false };
    function schedule() {
      if (tx._scheduled) return;
      tx._scheduled = true;
      setTimeout(function () {
        var map = stores.get(storeName);
        if (!map) map = new Map();
        for (var i = 0; i < tx._pending.length; i++) {
          var op = tx._pending[i];
          if (op.type === "put") { map.set(op.rec.id, op.rec); env.idbStored.set(op.rec.id, op.rec); }
          else if (op.type === "delete") { map.delete(op.key); env.idbStored.delete(op.key); }
        }
        tx._pending.length = 0;
        if (typeof tx.oncomplete === "function") {
          try { tx.oncomplete({ target: tx }); } catch (e) { env.errors.push(e); }
        }
      }, 0);
    }
    tx.objectStore = function (n) {
      var map = stores.get(n);
      if (!map) { map = new Map(); stores.set(n, map); }
      var facade = {
        name: n,
        keyPath: "id",
        getAll: function () {
          var req = makeReq();
          setTimeout(function () {
            req.result = Array.from(map.values());
            if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
          }, 0);
          return req;
        },
        get: function (key) {
          var req = makeReq();
          setTimeout(function () {
            req.result = map.get(key);
            if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
          }, 0);
          return req;
        },
        put: function (rec) {
          env.idbPuts.push({ store: n, rec: rec });
          var unclonable = findUnclonable(rec);
          if (unclonable) {
            var e1 = new Error("DataCloneError: " + unclonable + " could not be cloned.");
            e1.name = "DataCloneError";
            env.idbErrors.push({ name: e1.name, message: e1.message });
            throw e1; // 真实 IndexedDB 的 DataCloneError 是同步抛
          }
          var huge = findHugeString(rec);
          if (huge) {
            var e2 = new Error("QuotaExceededError: record contains a " + huge + " byte string");
            e2.name = "QuotaExceededError";
            env.idbErrors.push({ name: e2.name, message: e2.message });
            tx.error = e2;
            setTimeout(function () {
              if (typeof tx.onerror === "function") { try { tx.onerror({ target: tx }); } catch (e) { env.errors.push(e); } }
              if (typeof tx.onabort === "function") { try { tx.onabort({ target: tx }); } catch (e) { env.errors.push(e); } }
            }, 0);
            return makeReq();
          }
          tx._pending.push({ type: "put", rec: rec });
          schedule();
          return makeReq();
        },
        delete: function (key) {
          tx._pending.push({ type: "delete", key: key });
          schedule();
          return makeReq();
        },
        clear: function () { map.clear(); schedule(); return makeReq(); }
      };
      return facade;
    };
    return tx;
  }

  function makeDb(name) {
    var stores = new Map();
    var db = {
      name: name,
      version: 1,
      _stores: stores,
      _seeded: false
    };
    db.objectStoreNames = {
      contains: function (n) { return stores.has(n); },
      item: function (i) { return Array.from(stores.keys())[i]; },
      get length() { return stores.size; }
    };
    Object.defineProperty(db, "objectStoreNames", { value: db.objectStoreNames, enumerable: true });
    db.createObjectStore = function (n, opts) {
      if (!stores.has(n)) stores.set(n, new Map());
      return { name: n, keyPath: opts && opts.keyPath ? opts.keyPath : null };
    };
    db.transaction = function (n, mode) { return makeTx(stores, n, mode); };
    db.close = function () { db._closed = true; };
    return db;
  }

  return {
    open: function (name, version) {
      var req = makeReq();
      setTimeout(function () {
        try {
          var db = dbs.get(name);
          var oldVersion = db ? db.version : 0;
          if (!db) { db = makeDb(name); dbs.set(name, db); }
          req.result = db;
          var v = Number(version) || 1;
          if (v > oldVersion) {
            db.version = v;
            if (typeof req.onupgradeneeded === "function") {
              try { req.onupgradeneeded({ target: req, oldVersion: oldVersion, newVersion: v }); } catch (e) { env.errors.push(e); }
            }
          }
          if (!db._seeded) {
            db._seeded = true;
            var seeds = env.seedRecords || [];
            var store = db._stores.get(env.storeName);
            if (!store) { store = new Map(); db._stores.set(env.storeName, store); }
            for (var i = 0; i < seeds.length; i++) {
              store.set(seeds[i].id, seeds[i]);
              env.idbStored.set(seeds[i].id, seeds[i]);
            }
          }
          if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
        } catch (e) {
          req.error = e;
          env.errors.push(e);
          if (typeof req.onerror === "function") req.onerror({ target: req });
        }
      }, 0);
      return req;
    },
    deleteDatabase: function () { var r = makeReq(); setTimeout(function () { if (typeof r.onsuccess === "function") r.onsuccess({ target: r }); }, 0); return r; },
    _dbs: dbs
  };
}

// ── 桩: FileReader ──
function makeFileReader(env) {
  function FR() {
    this.result = null;
    this.error = null;
    this.readyState = 0;
    this.onload = null;
    this.onerror = null;
    this.onloadend = null;
    this.onabort = null;
  }
  FR.prototype._finish = function (result) {
    var self = this;
    setTimeout(function () {
      self.result = result;
      self.readyState = 2;
      env.fileReaderCalls.push({ result: String(result).slice(0, 48) });
      if (typeof self.onload === "function") { try { self.onload({ target: self }); } catch (e) { env.errors.push(e); } }
      if (typeof self.onloadend === "function") { try { self.onloadend({ target: self }); } catch (e) { env.errors.push(e); } }
    }, 0);
  };
  FR.prototype.readAsDataURL = function (file) {
    var mime = (file && file.type) || "application/octet-stream";
    this._finish("data:" + mime + ";base64,QUFBQQ==");
  };
  FR.prototype.readAsArrayBuffer = function () { this._finish(new ArrayBuffer(64)); };
  FR.prototype.readAsText = function () { this._finish("mock"); };
  FR.prototype.abort = function () {};
  return FR;
}

// ── 沙箱搭建 ──
function boot(opts) {
  opts = opts || {};
  var env = {
    opts: opts,
    storeName: opts.storeName || "wallpapers",
    byId: new Map(),
    seedRecords: opts.records || [],
    idbPuts: [],
    idbStored: new Map(),
    idbErrors: [],
    fileReaderCalls: [],
    // objectUrls.created / revoked 沿用既有语义（配平断言用）；
    // calls 记录「每一次 createObjectURL 调用」（含被类型校验拒绝的），
    // 供 URL 视频路径取证：P1 的特征就是这里出现一次 argType === "string" 的调用。
    objectUrls: { created: [], revoked: [], calls: [], rejected: [] },
    videoCalls: [],
    videos: [],
    errors: [],
    styles: [],
    playReject: !!opts.playReject,
    canvasDrawThrows: !!opts.canvasDrawThrows,
    // 默认关闭：既有场景（s1~s5）的媒体事件行为必须保持不变。
    // 打开后 video 桩会在 src 赋值 / load() 之后异步补发
    // loadedmetadata → loadeddata，并在 currentTime 赋值后补发 seeked，
    // 让 makePoster() 的截帧链路能真正跑到底（否则只会等到 8s 超时降级）。
    autoVideoEvents: !!opts.autoVideoEvents,
    videoDims: Array.isArray(opts.videoDims) ? opts.videoDims : [640, 360],
    // canvas 调用计数：用来证明「poster 是 canvas 真截出来的」，
    // 而不是断言空转（例如 makePoster 根本没跑、或走了别的路径）。
    canvasCalls: { drawImage: 0, toDataURL: 0 },
    cleanup: null,
    mod: null,
    def: null,
    applyError: null
  };
  env.document = null; // 稍后填

  var head = makeEl("head", env);
  var body = makeEl("body", env);
  var html = makeEl("html", env);

  var origHeadAppend = head.appendChild.bind(head);
  head.appendChild = function (c) {
    if (c && c.tagName === "STYLE") env.styles.push(c);
    return origHeadAppend(c);
  };

  if (opts.dark) body.setAttribute(DARK_ATTR, "");

  var storage = new Map();
  var preset = opts.storage || [];
  for (var i = 0; i < preset.length; i++) storage.set(preset[i][0], preset[i][1]);

  var urlCounter = 0;
  function MockURL(u) { this.href = String(u); this.origin = ""; this.pathname = String(u); this.search = ""; }
  // 判定 createObjectURL 的入参种类 —— 必须贴近真实浏览器的重载解析。
  // 真实 Chromium：接受 Blob / File（以及 MediaSource、MediaStream）。
  // 传字符串会抛：
  //   TypeError: Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.
  // 桩若「无条件接受任何参数」就永远抓不到 addUrl() 把 URL 字符串当 Blob 传的 P1 回归，
  // 所以这里刻意做类型校验（断言 12 就是钉死这个语义）。
  function urlArgKind(v) {
    if (typeof v === "string") return "string";
    if (v instanceof MockBlob) return "Blob";
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (typeof v === "object") return "object(plain:" + (v.name ? String(v.name) : "no-name") + ")";
    return typeof v;
  }
  function isObjectUrlAcceptable(v) {
    if (v instanceof MockBlob) return true;              // Blob / File
    if (typeof MediaSource !== "undefined" && MediaSource && v instanceof MediaSource) return true;
    return false;
  }
  MockURL.createObjectURL = function (blob) {
    var kind = urlArgKind(blob);
    var entry = { seq: env.objectUrls.calls.length + 1, argKind: kind, blob: blob,
      argPreview: kind === "string" ? String(blob).slice(0, 80) : null };
    env.objectUrls.calls.push(entry);
    if (!isObjectUrlAcceptable(blob)) {
      var err = new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
      entry.rejected = true;
      entry.errorName = err.name;
      env.objectUrls.rejected.push({ argKind: kind, argPreview: entry.argPreview, message: err.message });
      throw err;                                          // 真实浏览器是同步抛 TypeError
    }
    urlCounter++;
    var u = "blob:mock/" + urlCounter;
    entry.url = u;
    env.objectUrls.created.push({ url: u, blob: blob, tag: blob && blob.name ? blob.name : null });
    return u;
  };
  MockURL.revokeObjectURL = function (u) {
    env.objectUrls.revoked.push(String(u));
  };

  env.document = {
    head: head,
    body: body,
    documentElement: html,
    createElement: function (t) { return createElementFn(env, t); },
    createTextNode: function (t) { var e = makeEl("span", env); e.textContent = String(t); return e; },
    getElementById: function (id) { return env.byId.get(String(id)) || null; },
    querySelector: function (s) {
      var r = env.document.querySelectorAll(s);
      return r.length ? r[0] : null;
    },
    querySelectorAll: function (s) {
      var conds = parseSelector(s);
      var out = [];
      var roots = [body, html, head];
      for (var i = 0; i < roots.length; i++) {
        (function walk(node) {
          for (var j = 0; j < node.children.length; j++) {
            var c = node.children[j];
            if (matchesEnvRoot(env, c) && matchesEl(c, conds)) out.push(c);
            walk(c);
          }
        })(roots[i]);
      }
      return out;
    },
    addEventListener: function (type, fn) { body.addEventListener(type, fn); },
    removeEventListener: function (type, fn) { body.removeEventListener(type, fn); },
    dispatchEvent: function (e) { return body.dispatchEvent(e); }
  };
  head._ownerDocument = env.document;
  body._ownerDocument = env.document;

  var sandbox = {
    document: env.document,
    localStorage: {
      getItem: function (k) { return storage.has(k) ? storage.get(k) : null; },
      setItem: function (k, v) { storage.set(k, String(v)); },
      removeItem: function (k) { storage.delete(k); },
      clear: function () { storage.clear(); },
      key: function (i) { return Array.from(storage.keys())[i]; },
      get length() { return storage.size; }
    },
    console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} },
    setTimeout: function (fn, ms) { var t = setTimeout(fn, ms || 0); if (t && typeof t.unref === "function") t.unref(); return t; },
    clearTimeout: function (t) { clearTimeout(t); },
    setInterval: function (fn, ms) { var t = setInterval(fn, ms || 0); if (t && typeof t.unref === "function") t.unref(); return t; },
    clearInterval: function (t) { clearInterval(t); },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} takeRecords() { return []; } },
    indexedDB: opts.noIdb ? undefined : makeIndexedDB(env),
    FileReader: opts.noFileReader ? undefined : makeFileReader(env),
    Blob: MockBlob,
    File: MockFile,
    URL: MockURL,
    Math: Math, Date: Date, Promise: Promise, JSON: JSON, String: String, Number: Number,
    Array: Array, Object: Object, Set: Set, Map: Map, WeakSet: WeakSet, Error: Error, TypeError: TypeError,
    Boolean: Boolean, RegExp: RegExp, ArrayBuffer: ArrayBuffer, Uint8Array: Uint8Array,
    parseFloat: parseFloat, parseInt: parseInt, isNaN: isNaN, isFinite: isFinite,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    NaN: NaN, Infinity: Infinity, undefined: undefined
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.window.addEventListener = function (type, fn) { (sandbox.window._listeners || (sandbox.window._listeners = {})); var L = sandbox.window._listeners; (L[type] || (L[type] = [])).push(fn); };
  sandbox.window.removeEventListener = function () {};
  sandbox.window.dispatchEvent = function () { return true; };
  sandbox.window.innerWidth = 1440;
  sandbox.window.innerHeight = 900;
  sandbox.window.devicePixelRatio = 1;
  sandbox.localStorage = sandbox.localStorage;
  env.storage = storage;
  env.sandbox = sandbox;

  var captured = null;
  sandbox.window.__ModuleLoader__ = { load: function (def) { captured = def; } };

  var ctxObj = vm.createContext(sandbox);
  var loadError = null;
  try {
    vm.runInContext(src, ctxObj, { filename: file });
  } catch (e) {
    loadError = e;
  }
  env.loadError = loadError;
  env.captured = captured;

  if (captured && typeof captured.factory === "function") {
    try {
      env.mod = captured.factory(function () { return {}; });
    } catch (e) { env.factoryError = e; }
  }

  if (env.mod && typeof env.mod.apply === "function") {
    try {
      env.mod.apply({
        effect: function (fn) {
          try { env.cleanup = fn(); } catch (e) { env.applyError = e; }
          return function () {};
        }
      });
    } catch (e) { env.applyError = e; }
  }

  return env;
}

function matchesEnvRoot(env, el) { return true; }

/** 推进宏任务队列，让 IndexedDB / FileReader 的 Promise 链跑完 */
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 12); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}

function fire(el, type, props) {
  var evt = makeEvent(type, el, props);
  el.dispatchEvent(evt);
  return evt;
}

function findByClass(env, cls) {
  var body = env.document.body;
  var out = [];
  (function walk(node) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c._classes.has(cls)) out.push(c);
      walk(c);
    }
  })(body);
  return out;
}

function findVideoEl(env) {
  var byId = env.document.getElementById(ID_VIDEO);
  if (byId) return byId;
  var bg = env.document.getElementById(ID_BG);
  if (bg) {
    for (var i = 0; i < bg.children.length; i++) if (bg.children[i].tagName === "VIDEO") return bg.children[i];
  }
  if (env.videos.length) return env.videos[env.videos.length - 1];
  return null;
}

/** 把元素子树序列化成一段 HTML（供人类可读的信息行，替代空串 innerHTML） */
function serializeEl(el) {
  if (!el) return "";
  var tag = String(el.tagName || "div").toLowerCase();
  var attrs = "";
  var keys = Object.keys(el._attrs || {});
  for (var i = 0; i < keys.length; i++) {
    attrs += " " + keys[i] + "=\"" + String(el._attrs[keys[i]]).replace(/"/g, "&quot;") + "\"";
  }
  var text = "";
  if (VOID_TAGS[tag]) return "<" + tag + attrs + ">";
  if (!el.children.length) return "<" + tag + attrs + ">" + String(el.textContent || "") + "</" + tag + ">";
  var inner = "";
  for (var k = 0; k < el.children.length; k++) inner += serializeEl(el.children[k]);
  return "<" + tag + attrs + ">" + text + inner + "</" + tag + ">";
}

function videoVisible(el) {  if (!el) return false;
  if (el.hidden) return false;
  if (el.hasAttribute("hidden")) return false;
  if (el.style.display === "none") return false;
  if (el.style.visibility === "hidden") return false;
  if (el.style.opacity !== undefined && el.style.opacity !== null && Number(el.style.opacity) === 0) return false;
  return true;
}

// ══════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════
const S_VIDEO = { id: "v_sample", name: "sample.mp4", kind: "file", type: "video", mime: "video/mp4",
  bytes: 1048576, blob: new MockBlob(["MP4DATA"], { type: "video/mp4" }), added: 1 };
const S_IMAGE = { id: "i_sample", name: "photo.png", kind: "file", type: "image", mime: "image/png",
  bytes: 2048, data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==", added: 2 };
// 老记录：无 type、无 poster，data 为 data URI
const S_OLD = { id: "old_legacy", name: "legacy.png", kind: "file", mime: "image/png",
  bytes: 4096, data: "data:image/png;base64,LEGACYIMAGE", added: 1 };

// ── 新增场景用常量 ──
// URL 视频：kind 为 url，data 就是 URL 字符串本身（没有 blob 字段）。
const URL_VIDEO = "http://example.com/clip.mp4";
const S_URL_VIDEO = { id: "u_urlvid", name: "clip.mp4", kind: "url", type: "video",
  mime: "video/*", data: URL_VIDEO, added: 3 };
// P2 回归用：type=video 但既无 blob、kind 也不是 url（data 为空）的损坏记录。
const S_BROKEN_VIDEO = { id: "v_broken", name: "broken.mp4", kind: "file", type: "video",
  mime: "video/mp4", bytes: 0, data: "", added: 4 };

const VIDEO_LS = [
  ["wwp_migrated", "4"],
  ["wwp_enabled", "true"],
  ["wwp_video_muted", "false"],
  ["wwp_video_loop", "false"],
  ["wwp_video_rate", "1.5"]
];
const OLD_LS = [["wwp_migrated", "4"], ["wwp_enabled", "true"]];
const PLAIN_LS = [["wwp_migrated", "4"], ["wwp_enabled", "true"]];

var scenes = {};

/**
 * 造一个「像真 File 一样」的测试文件。
 * 必须用 MockFile（而不是手写 {name,type,size} 字面量）：
 * 真实浏览器里 importFiles() 收到的是 File 实例，而 createObjectURL() 只接受
 * Blob/File —— 普通对象会被重载解析拒绝（TypeError）。桩若用字面量喂进去，
 * 就会在「文件视频」路径上误报，掩盖真正的 URL 路径回归。
 */
function makeTestFile(name, type, size) {
  var f = new MockFile([""], name, { type: type });
  f.size = size;              // MockBlob 的 size 是自有属性，可直接覆盖，避免真分配大字符串
  return f;
}

/**
 * 向「添加 URL」输入框填入 URL 并点击按钮，驱动真实的 addUrl() 流程。
 * 注意：桩的 querySelector 每次返回新对象，所以这里必须在同一场景里
 * 重新取一次 urlInput / addurl 按钮再操作（模块内部持有自己的引用，不受影响）。
 */
function driveAddUrl(env, url) {
  var out = { ok: false, url: url, notes: [] };
  var panel = panelOf(env);
  if (!panel) { out.notes.push("未找到 .wwp-panel 元素"); return out; }
  var input = panel.querySelector(sel("url"));
  var btn = panel.querySelector(sel("act", "addurl"));
  if (!input) { out.notes.push("未找到 URL 输入框 " + sel("url")); return out; }
  if (!btn) { out.notes.push("未找到「添加 URL」按钮 " + sel("act", "addurl")); return out; }
  input.value = String(url);
  fire(btn, "click");
  out.ok = true;
  return out;
}

/** 取某场景最终落库的记录（以 idbStored 为准，最后一次 put 覆盖前一次） */
function storedById(env, id) {
  var v = env.idbStored.get(id);
  return v === undefined ? null : v;
}
/** 取某场景对某 id 的全部 put 记录 */
function putsById(env, id) {
  return (env.idbPuts || []).filter(function (p) { return p.rec && p.rec.id === id; });
}
/** 把 createObjectURL 调用列表压成人类可读摘要 */
function describeUrlCalls(env) {
  var calls = (env.objectUrls && env.objectUrls.calls) || [];
  if (!calls.length) return "(无调用)";
  return calls.map(function (c) {
    var tail = c.rejected ? "→抛TypeError" : "→" + c.url;
    return "#" + c.seq + " 参数类型=" + c.argKind + (c.argPreview ? " 值=" + JSON.stringify(c.argPreview) : "") + " " + tail;
  }).join(" | ");
}

async function runScenes() {
  // S1: 视频记录为 current（图片记录同在，供切换用）+ 预置三项 localStorage
  scenes.s1 = boot({ records: [S_VIDEO, S_IMAGE], storage: VIDEO_LS.concat([["wwp_current", JSON.stringify(S_VIDEO.id)]]) });
  await tick(16);

  // S2: 老图片记录为 current（向后兼容）
  scenes.s2 = boot({ records: [S_OLD], storage: OLD_LS.concat([["wwp_current", JSON.stringify(S_OLD.id)]]) });
  await tick(16);

  // S3: 导入（1 个正常 mp4 + 1 个 250MB mp4）
  scenes.s3 = boot({ records: [], storage: PLAIN_LS });
  await tick(16);
  var fi = scenes.s3.document.querySelector('input[type="file"]');
  if (fi) {
    fi.files = [
      makeTestFile("fresh.mp4", "video/mp4", 1048576),
      makeTestFile("huge.mp4", "video/mp4", 250 * 1024 * 1024)
    ];
    scenes.s3.fileInput = fi;
    fire(fi, "change");
    await tick(24);
  }

  // S4: play() 被拒绝（NotAllowedError）
  var unhandledBefore = unhandled.length;
  scenes.s4 = boot({ records: [S_VIDEO], storage: VIDEO_LS.concat([["wwp_current", JSON.stringify(S_VIDEO.id)]]), playReject: true });
  scenes.s4.unhandledBefore = unhandledBefore;
  await tick(16);

  // S5: indexedDB 缺失（既有 check-contrast.cjs 的运行环境）
  scenes.s5 = boot({ records: [], storage: PLAIN_LS, noIdb: true, noFileReader: true });
  await tick(8);

  // ── S6: URL 视频导入（断言 11 主场景）──
  // 向 URL 输入框填一个视频 URL 并点「添加 URL」，驱动真实 addUrl()。
  // autoVideoEvents 让 video 桩补发 loadedmetadata/loadeddata/seeked，
  // 使 makePoster() 的截帧链路能真正跑到底（否则只会等到 8s 定时器降级）。
  scenes.s6 = boot({ records: [S_IMAGE], storage: PLAIN_LS, autoVideoEvents: true });
  await tick(16);
  scenes.s6.drive = driveAddUrl(scenes.s6, URL_VIDEO);
  scenes.s6.unhandledBefore = unhandled.length;
  await tick(40);

  // ── S7: URL 视频 + canvas 跨域污染（断言 13）──
  // canvasDrawThrows 让 drawImage 抛 SecurityError，模拟跨域视频截帧失败。
  scenes.s7 = boot({ records: [], storage: PLAIN_LS, autoVideoEvents: true, canvasDrawThrows: true });
  await tick(16);
  scenes.s7.drive = driveAddUrl(scenes.s7, URL_VIDEO);
  scenes.s7.unhandledBefore = unhandled.length;
  await tick(40);

  // ── S8: 损坏视频记录为 current（断言 14，P2 回归）──
  // type=video 但既无 blob 又 kind!=="url"，renderVideoBG() 会提前 return；
  // 面板 [data-row="video"] 必须保持 display:none。
  scenes.s8 = boot({ records: [S_BROKEN_VIDEO, S_IMAGE],
    storage: PLAIN_LS.concat([["wwp_current", JSON.stringify(S_BROKEN_VIDEO.id)]]) });
  await tick(16);
  // 再补一次显式点击「play」按钮，验证损坏记录下不会误触发播放
  var p8 = panelOf(scenes.s8);
  var btn8 = p8 ? p8.querySelector(sel("act", "vidplay")) : null;
  if (btn8) { fire(btn8, "click"); await tick(8); }
  scenes.s8.rowFound = !!btn8;
}

// ══════════════════════════════════════════════════════════
// 断言
// ══════════════════════════════════════════════════════════
var results = [];

function report(no, title, ok, details) {
  results.push({ no: no, title: title, ok: ok, details: details || [] });
}

/** --dump: 打印沙箱内部状态，供定位「为什么这个元素找不到」 */
function dumpScene(name, env) {
  console.log("---- dump " + name + " ----");
  console.log("  loadError=" + (env.loadError ? env.loadError.message : "null") +
    "  applyError=" + (env.applyError ? env.applyError.message : "null") +
    "  factoryError=" + (env.factoryError ? env.factoryError.message : "null"));
  console.log("  env.errors=" + JSON.stringify(env.errors.map(function (x) { return x.message; })));
  console.log("  videoCalls=" + JSON.stringify(env.videoCalls.map(function (c) { return c.op; })));
  console.log("  videos 桩数=" + env.videos.length);
  console.log("  body 直接子元素=" + JSON.stringify(env.document.body.children.map(function (c) { return c.tagName + "#" + (c.id || "") + "." + c.className; })));
  var bg = env.document.getElementById(ID_BG);
  console.log("  #" + ID_BG + "=" + (bg ? "存在" : "缺失"));
  if (bg) {
    console.log("    bg 子元素=" + JSON.stringify(bg.children.map(function (c) { return c.tagName + "#" + (c.id || ""); })));
    console.log("    bg.style.backgroundImage=" + JSON.stringify(bg.style.backgroundImage));
    console.log("    bg classes=" + JSON.stringify(Array.from(bg._classes)));
  }
  console.log("  byId 注册表=" + JSON.stringify(Array.from(env.byId.keys())));
  console.log("  idbPuts=" + JSON.stringify(env.idbPuts.map(function (p) { return p.rec && p.rec.name; })));
  console.log("  fileInput=" + (env.fileInput ? "accept=" + JSON.stringify(env.fileInput.accept) : "(未取到)"));
}

function safe(fn) {
  try { return fn(); } catch (e) { return { __error: e }; }
}

/** 取面板元素 */
function panelOf(env) {
  var ps = findByClass(env, "wwp-panel");
  return ps.length ? ps[0] : null;
}
function noteOf(env) {
  var panel = panelOf(env);
  if (panel) { var n = panel.querySelector(sel("note")); if (n) return n; }
  return null;
}

function checkAll() {
  var e1 = scenes.s1, e2 = scenes.s2, e3 = scenes.s3, e4 = scenes.s4, e5 = scenes.s5;

  // ── 1. 模块可加载 ──
  (function () {
    var d = [];
    if (e1.loadError) d.push("vm 执行 client.js 抛错: " + e1.loadError.message);
    if (!e1.captured) d.push("未观察到 window.__ModuleLoader__.load 被调用（captured = null）");
    else if (e1.captured.id !== "dsh-web-wallpaper") d.push("模块 id 异常: " + JSON.stringify(e1.captured.id));
    if (!e1.mod) d.push("factory() 未返回对象" + (e1.factoryError ? "（" + e1.factoryError.message + "）" : ""));
    else if (typeof e1.mod.apply !== "function") d.push("exports.apply 不是函数，实际类型: " + typeof e1.mod.apply);
    if (e1.applyError) d.push("apply() 抛错: " + e1.applyError.message);
    report(1, "模块可加载（__ModuleLoader__.load + factory + apply）", d.length === 0, d);
  })();

  // ── 2. 视频渲染路径 ──
  (function () {
    var d = [];
    var bg = e1.document.getElementById(ID_BG);
    var v = findVideoEl(e1);
    if (!bg) d.push("未找到 #" + ID_BG + " 元素");
    if (!v) d.push("未找到视频元素 #" + ID_VIDEO + "（apply() 后 #" + ID_BG + " 子树里没有 <video>）");
    if (!bg) { report(2, "视频渲染路径（背景置空 + 视频可见 + blob src + play()）", false, d); return; }
    var bi = bg.style.backgroundImage;
    if (String(bi || "").indexOf("url(") !== -1) d.push("backgroundImage 未置空，实际值: " + JSON.stringify(bi === undefined ? null : bi));
    if (!v) { report(2, "视频渲染路径（背景置空 + 视频可见 + blob src + play()）", false, d); return; }
    if (!videoVisible(v)) d.push("视频元素不可见（hidden=" + v.hidden + ", style.display=" + JSON.stringify(v.style.display === undefined ? null : v.style.display) + "）");
    if (String(v.src || "").indexOf("blob:") !== 0) d.push("视频 src 未指向 blob: URL，实际: " + JSON.stringify(v.src === undefined ? null : v.src) + "（createObjectURL 调用次数=" + e1.objectUrls.created.length + "）");
    if (!(v.playCalls > 0)) d.push("video.play() 未被调用（playCalls=" + v.playCalls + "）");
    d.push("[信息] video 调用序列: " + JSON.stringify(e1.videoCalls.map(function (c) { return c.op; })) +
      " | createObjectURL=" + e1.objectUrls.created.length + " | muted=" + v.muted + " loop=" + v.loop + " rate=" + v.playbackRate);
    // 同一元素多次访问必须是同一个对象（模块用模块级变量持有 videoEl，桩必须稳定）
    var a = e1.document.getElementById(ID_VIDEO);
    var b = e1.document.getElementById(ID_VIDEO);
    if (!a) d.push("视频元素没有以 id=\"" + ID_VIDEO + "\" 注册到文档（byId 缺项），模块级 videoEl 无法被稳定取回");
    else {
      if (a !== b) d.push("DOM 桩不稳定: getElementById 两次返回不同对象");
      if (a !== v) d.push("getElementById(\"" + ID_VIDEO + "\") 与 #" + ID_BG + " 子树里的 <video> 不是同一对象");
    }
    d.push("[信息] 视频元素对象稳定性: byId=" + (a ? "命中" : "未命中") + "，与子树元素同一对象=" + (a === v));
    report(2, "视频渲染路径（背景置空 + 视频可见 + blob src + play()）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 3. 老图片记录向后兼容 ──
  (function () {
    var d = [];
    var bg = e2.document.getElementById(ID_BG);
    var v = findVideoEl(e2);
    if (e2.loadError) d.push("vm 执行抛错: " + e2.loadError.message);
    if (e2.applyError) d.push("apply() 抛错: " + e2.applyError.message);
    if (!bg) d.push("未找到 #" + ID_BG + " 元素");
    else {
      var bi = String(bg.style.backgroundImage || "");
      if (bi.indexOf("data:image/png;base64,LEGACYIMAGE") === -1) d.push("老记录的 data URI 未被设为背景，实际 backgroundImage: " + JSON.stringify(bg.style.backgroundImage === undefined ? null : bg.style.backgroundImage));
    }
    if (!v) d.push("未找到视频元素，无法断言「暂停 + 清空 src」");
    else {
      if (String(v.src || "") !== "") d.push("视频 src 未清空，实际: " + JSON.stringify(v.src));
      if (v.paused !== true) d.push("视频未处于暂停状态（paused=" + v.paused + "）");
      if (!(v.pauseCalls >= 1)) d.push("视频分支未调用 pause()（pauseCalls=" + v.pauseCalls + "），spec §2 要求图片记录下暂停视频");
      if (!(v.loadCalls >= 1)) d.push("清空 src 后未调用 load()（loadCalls=" + v.loadCalls + "），spec §2 要求 removeAttribute(\"src\") 后 load()");
      if (videoVisible(v)) d.push("视频元素仍可见（应隐藏）");
      d.push("[信息] video 调用序列: " + JSON.stringify(e2.videoCalls.map(function (c) { return c.op; })));
    }
    if (e2.errors.length) d.push("执行期间监听器抛错 " + e2.errors.length + " 次: " + e2.errors.map(function (x) { return x.message; }).join(" / "));
    report(3, "老图片记录向后兼容（data URI 背景 + 视频暂停清空 src + 无异常）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 5. 视频不落 base64 ──
  (function () {
    var d = [];
    var puts = e3.idbPuts || [];
    var vidRecs = puts.filter(function (p) {
      var r = p.rec || {};
      return r.type === "video" || /^video\//.test(String(r.mime || ""));
    });
    if (!e3.fileInput) d.push("未找到 file input（无法驱动导入路径）");
    if (!vidRecs.length) {
      d.push("IndexedDB put 里没有视频记录（导入的 video/mp4 未被存库）。共收到 " + puts.length + " 次 put，name: " +
        JSON.stringify(puts.map(function (p) { return p.rec && p.rec.name; })));
    } else {
      for (var i = 0; i < vidRecs.length; i++) {
        var rec = vidRecs[i].rec;
        if (!rec.blob) d.push("视频记录 [" + rec.name + "] 缺 blob 字段（字段: " + JSON.stringify(Object.keys(rec)) + "）");
        var data = rec.data === undefined ? "" : String(rec.data);
        if (data.indexOf("data:video/") === 0) d.push("视频记录 [" + rec.name + "] 的 data 落成了 data URI: " + JSON.stringify(data.slice(0, 60)) + "…（严禁 base64）");
        if (data.indexOf("base64") !== -1) d.push("视频记录 [" + rec.name + "] 的 data 含 base64: " + JSON.stringify(data.slice(0, 60)) + "…");
      }
      d.push("[信息] 视频 put 记录字段: " + JSON.stringify(vidRecs.map(function (p) { return Object.keys(p.rec); })));
      d.push("[信息] FileReader.readAsDataURL 调用次数: " + e3.fileReaderCalls.length + "（视频不应走 data URI）");
    }
    report(5, "视频不落 base64（记录含 blob，data 不是 data:video/…;base64）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 6. 视频文件大小上限 200MB ──
  (function () {
    var d = [];
    var puts = e3.idbPuts || [];
    var hugePuts = puts.filter(function (p) { return p.rec && p.rec.name === "huge.mp4"; });
    if (hugePuts.length) d.push("250MB 的 huge.mp4 被写入了 IndexedDB（应跳过），put 记录: " + JSON.stringify(hugePuts.map(function (p) { return Object.keys(p.rec); })));
    if (e3.idbStored.get("huge.mp4")) d.push("250MB 的 huge.mp4 出现在已落库集合里");
    var storedHuge = Array.from(e3.idbStored.values()).filter(function (r) { return r && r.name === "huge.mp4"; });
    if (storedHuge.length) d.push("IndexedDB 实际存下了 huge.mp4");
    var note = noteOf(e3);
    var txt = note ? String(note.textContent || "") : "";
    if (!note) d.push("未找到面板 .wwp-note 元素（无法断言跳过提示）");
    else if (txt.indexOf("跳过") === -1) d.push("导入完成提示未提到「跳过」，实际 note 文案: " + JSON.stringify(txt));
    d.push("[信息] 导入后 note 文案: " + JSON.stringify(txt));
    d.push("[信息] put 的名称清单: " + JSON.stringify(puts.map(function (p) { return p.rec && p.rec.name; })));
    if (e3.fileInput) d.push("[信息] fileInput.accept = " + JSON.stringify(e3.fileInput.accept) + "（spec §4.2 要求 image/*,video/*）");
    report(6, "视频文件大小上限（>200MB 跳过且不写 IndexedDB）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 7. play() reject 不炸 ──
  (function () {
    var d = [];
    var fresh = unhandled.slice(e4.unhandledBefore || 0);
    if (e4.applyError) d.push("apply() 抛错: " + e4.applyError.message);
    if (e4.errors.length) d.push("执行期间抛错 " + e4.errors.length + " 次: " + e4.errors.map(function (x) { return x.message; }).join(" / "));
    if (fresh.length) d.push("出现 " + fresh.length + " 个未捕获 Promise 拒绝: " + fresh.map(function (r) { return (r && r.name ? r.name + ": " : "") + (r && r.message ? r.message : String(r)); }).join(" / "));
    var note = noteOf(e4);
    var txt = note ? String(note.textContent || "") : "";
    if (!note) d.push("未找到面板 .wwp-note 元素");
    else if (!txt.trim()) d.push("play() 被拒绝后未写出任何提示文案（.wwp-note 为空）");
    else d.push("[信息] 提示文案: " + JSON.stringify(txt));
    var v = findVideoEl(e4);
    if (!v) d.push("未找到视频元素");
    else if (v.playCalls === 0) d.push("play() 从未被调用，无法验证拒绝路径");
    report(7, "play() 被拒（NotAllowedError）不产生未捕获异常且给出提示", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 8. localStorage 键名契约 ──
  (function () {
    var d = [];
    var panel = panelOf(e1);
    if (!panel) { report(8, "localStorage 键名契约（wwp_video_muted / wwp_video_loop / wwp_video_rate）", false, ["未找到 .wwp-panel 元素"]); return; }
    var chkMuted = panel.querySelector(sel("chk", "vidmuted"));
    var chkLoop = panel.querySelector(sel("chk", "vidloop"));
    var selRate = panel.querySelector(sel("sel", "vidrate"));
    if (!chkMuted) d.push("未找到面板控件 " + sel("chk", "vidmuted"));
    else if (chkMuted.checked !== false) d.push(sel("chk", "vidmuted") + ".checked 期望 false（wwp_video_muted=false），实际 " + JSON.stringify(chkMuted.checked) + "（键名拼错或未并入 S 都会落成默认 true）");
    if (!chkLoop) d.push("未找到面板控件 " + sel("chk", "vidloop"));
    else if (chkLoop.checked !== false) d.push(sel("chk", "vidloop") + ".checked 期望 false（wwp_video_loop=false），实际 " + JSON.stringify(chkLoop.checked));
    if (!selRate) d.push("未找到面板控件 " + sel("sel", "vidrate"));
    else if (String(selRate.value) !== "1.5") d.push(sel("sel", "vidrate") + ".value 期望 \"1.5\"（wwp_video_rate=1.5），实际 " + JSON.stringify(String(selRate.value)));
    var v = findVideoEl(e1);
    if (v) d.push("[信息] 视频元素实际属性: muted=" + v.muted + " loop=" + v.loop + " playbackRate=" + v.playbackRate);
    d.push("[信息] localStorage 预置读回: " + JSON.stringify([
      ["wwp_video_muted", e1.storage.get("wwp_video_muted")],
      ["wwp_video_loop", e1.storage.get("wwp_video_loop")],
      ["wwp_video_rate", e1.storage.get("wwp_video_rate")]
    ]));
    report(8, "localStorage 键名契约（wwp_video_muted / wwp_video_loop / wwp_video_rate）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 9. 面板控件存在 ──
  (function () {
    var d = [];
    var panel = panelOf(e1);
    if (!panel) { report(9, "面板控件存在（vidplay / vidmuted / vidloop / vidrate / data-row=video）", false, ["未找到 .wwp-panel 元素"]); return; }
    var need = [
      [sel("act", "vidplay"), "播放/暂停按钮"],
      [sel("chk", "vidmuted"), "静音复选框"],
      [sel("chk", "vidloop"), "循环复选框"],
      [sel("sel", "vidrate"), "速度下拉"]
    ];
    for (var i = 0; i < need.length; i++) {
      var el = panel.querySelector(need[i][0]);
      if (!el) d.push("缺少控件 " + need[i][0] + "（" + need[i][1] + "）");
    }
    var row = panel.querySelector(sel("row", "video"));
    if (!row) d.push("缺少容器 " + sel("row", "video"));
    else {
      var opts = row.querySelectorAll("option").map(function (o) { return o.getAttribute("value"); });
      var want = ["0.5", "1", "1.5", "2"];
      if (!opts.length) d.push(sel("sel", "vidrate") + " 里没解析出任何 <option>（速度下拉无选项）");
      else {
        var missing = want.filter(function (w) { return opts.indexOf(w) === -1; });
        if (missing.length) d.push(sel("sel", "vidrate") + " 缺少速度选项 " + JSON.stringify(missing) + "，实际选项 " + JSON.stringify(opts));
      }
      // innerHTML getter 对「由解析生成」的元素是空串，这里改用子树序列化，信息才真实
      d.push("[信息] " + sel("row", "video") + " 子树: " + JSON.stringify(serializeEl(row).slice(0, 340)));
    }
    // 归一化后再做一次字符串兜底检查（规避连字符被吞的风险）
    var norm = String(panel.innerHTML).replace(/\s+/g, " ");
    var needles = [attr("act") + '="vidplay"', attr("chk") + '="vidmuted"', attr("chk") + '="vidloop"', attr("sel") + '="vidrate"', attr("row") + '="video"'];
    var lostNeedles = needles.filter(function (n) { return norm.indexOf(n) === -1; });
    if (lostNeedles.length) d.push("面板 innerHTML 字符串里找不到: " + JSON.stringify(lostNeedles));
    report(9, "面板控件存在（vidplay / vidmuted / vidloop / vidrate / data-row=video）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 10. indexedDB / FileReader 缺失时的健壮性 ──
  (function () {
    var d = [];
    if (e5.loadError) d.push("vm 执行抛错: " + e5.loadError.message);
    if (!e5.mod) d.push("模块未加载");
    if (e5.applyError) d.push("indexedDB 缺失时 apply() 抛错: " + e5.applyError.message + (e5.applyError.stack ? "\n      " + String(e5.applyError.stack).split("\n")[1] : ""));
    if (e5.errors.length) d.push("执行期间抛错 " + e5.errors.length + " 次: " + e5.errors.map(function (x) { return x.message; }).join(" / "));
    var bg = e5.document.getElementById(ID_BG);
    if (!bg) d.push("未找到 #" + ID_BG + " 元素（apply 未跑完）");
    // v4 起语义变更：启用中但无壁纸（本场景即无 currentId）→ 不再隐藏，而是显示
    // 纯色底衬（wwp-on 挂上、无 wwp-hidden），盖住主题自带的点阵底纹；
    // 只有「停用」才走真正的隐藏路径。此处的核心断言是「不抛异常 + 状态自洽」。
    else {
      var hasOn = e5.document.documentElement._classes.has("wwp" + HY + "on");
      var isHidden = bg._classes.has(HIDDEN_CLASS);
      if (!hasOn && !isHidden) d.push("既未挂 wwp-on 也未隐藏（状态不自洽），实际 class: " + JSON.stringify(Array.from(bg._classes)));
      d.push("[信息] 底衬路径: wwp-on=" + hasOn + " hidden=" + isHidden + " bg=" + JSON.stringify(bg.style.backgroundColor));
    }
    report(10, "indexedDB / FileReader 缺失时不抛异常（双向兼容既有环境）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 11. URL 视频能拿到 poster（核心回归门，守住 P1）──
  (function () {
    var TITLE = "URL 视频导入（type=video / kind=url / poster 落 data:image/ / 不误用 createObjectURL）";
    var d = [];
    var e = scenes.s6;
    if (!e) { report(11, TITLE, false, ["场景 s6 未构造"]); return; }
    if (e.loadError) d.push("vm 执行抛错: " + e.loadError.message);
    if (e.applyError) d.push("apply() 抛错: " + e.applyError.message);
    if (!e.drive || !e.drive.ok) {
      d.push("无法驱动「添加 URL」流程: " + JSON.stringify(e.drive ? e.drive.notes : null));
    }

    // ① 不得产生未捕获异常（P1 的特征：TypeError … createObjectURL）
    var fresh = unhandled.slice(e.unhandledBefore === undefined ? 0 : e.unhandledBefore);
    var typeErrs = fresh.filter(function (r) {
      var msg = String((r && r.message) || r || "");
      return (r && r.name === "TypeError") || /createObjectURL/.test(msg);
    });
    if (fresh.length) {
      d.push("出现 " + fresh.length + " 个未捕获异常: " + fresh.map(function (r) {
        return ((r && r.name) ? r.name + ": " : "") + ((r && r.message) ? r.message : String(r));
      }).join(" / "));
    }
    if (typeErrs.length) d.push("未捕获 TypeError（疑似 createObjectURL 重载失败）: " + typeErrs.map(function (r) { return String(r && r.message || r); }).join(" / "));
    // 监听器内部抛错也会被桩收集到 env.errors
    var ctorErrs = (e.errors || []).filter(function (x) {
      return x && (/createObjectURL/.test(String(x.message || "")) || x.name === "TypeError");
    });
    if (ctorErrs.length) d.push("执行期间捕获到 createObjectURL 相关异常 " + ctorErrs.length + " 次: " + ctorErrs.map(function (x) { return x.name + ": " + x.message; }).join(" / "));

    // ② 记录契约：type === "video" && kind === "url" && data === 该 URL
    var recs = (e.idbPuts || []).filter(function (p) { return p.rec && p.rec.kind === "url"; });
    if (!recs.length) {
      d.push("没有任何 kind=\"url\" 的记录被写库（addUrl() 未生效）。共 " + (e.idbPuts || []).length + " 次 put，name=" +
        JSON.stringify((e.idbPuts || []).map(function (p) { return p.rec && p.rec.name; })));
    } else {
      var last = recs[recs.length - 1].rec;
      var stored = storedById(e, last.id);
      var final = stored || last;
      if (final.type !== "video") d.push("URL 视频记录 type 期望 \"video\"，实际 " + JSON.stringify(final.type) + "（isVideoUrl 未识别 .mp4）");
      if (final.kind !== "url") d.push("URL 视频记录 kind 期望 \"url\"，实际 " + JSON.stringify(final.kind));
      if (String(final.data || "") !== URL_VIDEO) d.push("URL 视频记录 data 期望 " + JSON.stringify(URL_VIDEO) + "，实际 " + JSON.stringify(final.data));
      if (!final.blob) d.push("[信息] URL 视频记录无 blob 字段（符合预期，kind=url 时 data 即 URL）");

      // ③ poster 必须成功写入（canvas 桩正常返回 jpeg data URI）
      var posterRec = null;
      var puts = putsById(e, last.id);
      for (var i = puts.length - 1; i >= 0; i--) { if (puts[i].rec && puts[i].rec.poster) { posterRec = puts[i].rec; break; } }
      var poster = final.poster || (posterRec && posterRec.poster) || "";
      if (!poster) {
        d.push("URL 视频最终没有 poster（卡片只能显示 🎬 占位）。put 次数=" + puts.length +
          "，各次 poster=" + JSON.stringify(puts.map(function (p) { return p.rec && p.rec.poster ? String(p.rec.poster).slice(0, 24) : null; })));
      } else if (String(poster).indexOf("data:image/") !== 0) {
        d.push("poster 不是 data:image/ 开头的 data URI，实际: " + JSON.stringify(String(poster).slice(0, 60)));
      } else {
        d.push("[信息] poster 写入成功: " + JSON.stringify(String(poster).slice(0, 40)) + "…（长度 " + String(poster).length + "）");
      }
      // 反空转：证明 poster 真的是 canvas 从视频帧截出来的，而不是断言恰好过关。
      // 若 drawImage/toDataURL 从未被调用（例如 makePoster 根本没跑），poster 不可能出现，
      // 所以这里只在「有 poster」时才反过来要求调用链有痕迹。
      if (poster) {
        var cc = e.canvasCalls || { drawImage: 0, toDataURL: 0 };
        if (!cc.drawImage || !cc.toDataURL) {
          d.push("poster 出现了但 canvas 截帧链路没有留下调用痕迹（drawImage=" + cc.drawImage +
            ", toDataURL=" + cc.toDataURL + "）—— poster 来源可疑，可能断言空转");
        }
        d.push("[信息] canvas 截帧链路证据: drawImage=" + cc.drawImage + " 次, toDataURL=" + cc.toDataURL + " 次（videoDims=" + JSON.stringify(e.videoDims) + "）");
      }
      // ④ 卡片缩略图应指向该 poster，而不是裂图 / 占位
      var grid = panelOf(e) ? panelOf(e).querySelector(sel("grid")) : null;
      if (grid) {
        var card = null;
        for (var k = 0; k < grid.children.length; k++) if (grid.children[k].title === final.name) card = grid.children[k];
        var cardImg = card ? card.querySelector("img") : null;
        if (card && cardImg) {
          var isrc = String(cardImg.src || "");
          if (poster && isrc !== String(poster)) d.push("卡片缩略图 img.src 未使用 poster，实际: " + JSON.stringify(isrc.slice(0, 60)));
          d.push("[信息] 卡片 img.src = " + JSON.stringify(isrc.slice(0, 48)) + "…");
        } else {
          d.push("[信息] 网格里未定位到卡片（title=" + JSON.stringify(final.name) + "），跳过缩略图指向校验");
        }
      }
    }

    // ⑤ URL 分支不得调用 createObjectURL(string) —— 区分「真修好」与「绕过问题」的关键证据
    var calls = (e.objectUrls && e.objectUrls.calls) || [];
    var callsInUrlVideo = calls.filter(function (c) {
      // 任何 createObjectURL(字符串) 都不合法；恰好等于该 URL 的更是 P1 的铁证
      return c.argKind === "string";
    });
    if (callsInUrlVideo.length) {
      d.push("URL 视频路径里出现了 createObjectURL(字符串) 调用（应直接把 URL 赋给 v.src）: " +
        callsInUrlVideo.map(function (c) { return "#" + c.seq + " " + JSON.stringify(c.argPreview); }).join(" / "));
    }
    var rejected = (e.objectUrls && e.objectUrls.rejected) || [];
    if (rejected.length) {
      d.push("createObjectURL 被类型校验拒绝 " + rejected.length + " 次（参数类型 " +
        JSON.stringify(rejected.map(function (r) { return r.argKind; })) + "）：这正是 P1 的特征，URL 视频拿不到缩略图");
    }
    var v = findVideoEl(e);
    if (v) {
      var src = String(v.src || "");
      if (src !== URL_VIDEO) d.push("URL 视频的 <video>.src 期望直接等于 " + JSON.stringify(URL_VIDEO) + "，实际 " + JSON.stringify(src));
      d.push("[信息] <video>.src = " + JSON.stringify(src));
    } else {
      d.push("未找到视频元素，无法断言 v.src 直接使用 URL");
    }

    d.push("[信息] createObjectURL 调用明细: " + describeUrlCalls(e));
    d.push("[信息] 桩内 createObjectURL 被拒记录: " + JSON.stringify(rejected.map(function (r) { return r.argKind + " " + (r.argPreview || ""); })));
    report(11, TITLE, d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 12. createObjectURL 桩必须贴近真实语义 ──
  (function () {
    var TITLE = "createObjectURL 桩语义贴近真实浏览器（非 Blob/MediaSource 参数抛 TypeError）";
    var d = [];
    // 注意：刻意借用 s5 的沙箱做探针，绝不污染 s1 的 objectUrls 计数
    // —— 断言 4（check4）依赖 s1 的 create/revoke 配平。
    var probeURL = scenes.s5.sandbox.URL;
    var info = [];
    // ① 传 Blob 不抛
    var blobOk = false, blobErr = null, blobUrl = null;
    try {
      blobUrl = probeURL.createObjectURL(new MockBlob(["X"], { type: "video/mp4" }));
      blobOk = typeof blobUrl === "string" && blobUrl.indexOf("blob:") === 0;
      info.push("传 Blob → 返回 " + JSON.stringify(blobUrl));
    } catch (err) { blobErr = err; info.push("传 Blob → 抛 " + err.name + ": " + err.message); }
    if (!blobOk) d.push("传 Blob 应成功返回 blob: URL，实际 " + (blobErr ? "抛 " + blobErr.name + ": " + blobErr.message : JSON.stringify(blobUrl)));

    // ② 传字符串必须抛 TypeError（模拟 Chromium 的 Overload resolution failed）
    var strThrew = null;
    try {
      var u = probeURL.createObjectURL("http://example.com/clip.mp4");
      info.push("传 字符串 → 未抛错，返回 " + JSON.stringify(u) + "（桩太宽松，抓不到 P1）");
    } catch (err) { strThrew = err; info.push("传 字符串 → 抛 " + err.name + ": " + err.message); }
    if (!strThrew) d.push("createObjectURL(\"http://…mp4\") 未抛错 —— 桩会放行 P1，断言 11 将空转");
    else if (strThrew.name !== "TypeError") d.push("传字符串期望抛 TypeError，实际抛 " + strThrew.name + ": " + strThrew.message);
    else if (!/Overload resolution failed/.test(String(strThrew.message))) d.push("TypeError 文案未包含 \"Overload resolution failed\"，实际: " + strThrew.message);

    // ③ 传 null / undefined 也必须抛 TypeError
    var nullThrew = false;
    try { probeURL.createObjectURL(null); } catch (err) { nullThrew = err && err.name === "TypeError"; }
    info.push("传 null → " + (nullThrew ? "抛 TypeError" : "未抛 TypeError"));
    if (!nullThrew) d.push("createObjectURL(null) 期望抛 TypeError，实际未抛");

    d.push("[信息] 桩实际行为: " + info.join(" ； "));
    d.push("[信息] 调用留痕启用后，s6 里 createObjectURL 调用明细: " + describeUrlCalls(scenes.s6));
    report(12, TITLE, d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 13. URL 视频缩略图失败时静默降级 ──
  (function () {
    var TITLE = "URL 视频缩略图失败（跨域 canvas SecurityError）静默降级且仍入库";
    var d = [];
    var e = scenes.s7;
    if (!e) { report(13, TITLE, false, ["场景 s7 未构造"]); return; }
    if (e.loadError) d.push("vm 执行抛错: " + e.loadError.message);
    if (!e.drive || !e.drive.ok) d.push("无法驱动「添加 URL」流程: " + JSON.stringify(e.drive ? e.drive.notes : null));

    var fresh = unhandled.slice(e.unhandledBefore === undefined ? 0 : e.unhandledBefore);
    if (fresh.length) {
      d.push("出现 " + fresh.length + " 个未捕获异常: " + fresh.map(function (r) {
        return ((r && r.name) ? r.name + ": " : "") + ((r && r.message) ? r.message : String(r));
      }).join(" / "));
    }
    var secErrs = (e.errors || []).filter(function (x) { return x && x.name === "SecurityError"; });
    if (secErrs.length) d.push("SecurityError 逃逸到监听器层 " + secErrs.length + " 次: " + secErrs.map(function (x) { return x.message; }).join(" / "));

    // 仍成功入库（只是没有 poster）
    var recs = (e.idbPuts || []).filter(function (p) { return p.rec && p.rec.kind === "url"; });
    if (!recs.length) {
      d.push("缩略图失败后 URL 视频没有入库（必须静默降级、照常保存）。put=" +
        JSON.stringify((e.idbPuts || []).map(function (p) { return p.rec && p.rec.name; })));
    } else {
      var last = recs[recs.length - 1].rec;
      var stored = storedById(e, last.id) || last;
      if (stored.type !== "video") d.push("入库记录 type 期望 \"video\"，实际 " + JSON.stringify(stored.type));
      if (String(stored.data || "") !== URL_VIDEO) d.push("入库记录 data 期望 " + JSON.stringify(URL_VIDEO) + "，实际 " + JSON.stringify(stored.data));
      if (stored.poster) d.push("canvas 污染场景下不应有 poster，实际 " + JSON.stringify(String(stored.poster).slice(0, 40)));
      else d.push("[信息] 已静默降级：记录入库且无 poster（符合预期）");
      // 网格应回退到 🎬 占位，而不是裂图（空 src / rec.data）
      var panel = panelOf(e);
      var grid = panel ? panel.querySelector(sel("grid")) : null;
      if (grid) {
        var card = null;
        for (var i = 0; i < grid.children.length; i++) if (grid.children[i].title === stored.name) card = grid.children[i];
        var img = card ? card.querySelector("img") : null;
        if (img) {
          var isrc = String(img.src || "");
          if (!isrc) d.push("占位缩略图 img.src 为空（真实浏览器会显示裂图图标）");
          else if (isrc.indexOf("data:image/svg+xml") !== 0 && isrc.indexOf("data:image/") !== 0) d.push("占位缩略图 src 既不是内联 SVG 也不是 data URI: " + JSON.stringify(isrc.slice(0, 60)));
          d.push("[信息] 占位缩略图 img.src = " + JSON.stringify(isrc.slice(0, 60)) + "…");
        }
      }
    }

    // object URL 不得泄漏：create 必须与 revoke 配平
    var created = (e.objectUrls && e.objectUrls.created ? e.objectUrls.created.length : 0);
    var revoked = (e.objectUrls && e.objectUrls.revoked ? e.objectUrls.revoked.length : 0);
    if (created !== revoked) {
      d.push("object URL 泄漏：create " + created + " 次 / revoke " + revoked + " 次（缩略图失败路径也必须 revoke）");
    }
    var strCalls = ((e.objectUrls && e.objectUrls.calls) || []).filter(function (c) { return c.argKind === "string"; });
    if (strCalls.length) d.push("仍出现 createObjectURL(字符串) 调用 " + strCalls.length + " 次: " + strCalls.map(function (c) { return JSON.stringify(c.argPreview); }).join(" / "));

    // 反空转：必须证明真的走到了 canvas 截帧并撞上 SecurityError。
    // 否则「静默降级」可能只是因为 makePoster 压根没跑（本断言会假通过）。
    var cc = e.canvasCalls || { drawImage: 0, toDataURL: 0 };
    if (!cc.drawImage) {
      d.push("canvas 跨域污染路径没有被真正触发（drawImage 调用 0 次）—— 无法证明降级逻辑生效，断言可能空转");
    }
    d.push("[信息] canvas 截帧链路证据: drawImage=" + cc.drawImage + " 次, toDataURL=" + cc.toDataURL + " 次（drawImage 抛出后应跳过 toDataURL）");
    d.push("[信息] createObjectURL create=" + created + " / revoke=" + revoked + "，明细: " + describeUrlCalls(e));
    d.push("[信息] canvas 桩: canvasDrawThrows=" + e.canvasDrawThrows + "（drawImage / toDataURL 均抛 SecurityError）");
    report(13, TITLE, d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();

  // ── 14. 损坏视频记录时面板不显示「视频」行（P2 回归）──
  (function () {
    var TITLE = "损坏视频记录（type=video 但无 blob 且 kind!=url）不播放且视频行隐藏";
    var d = [];
    var e = scenes.s8;
    if (!e) { report(14, TITLE, false, ["场景 s8 未构造"]); return; }
    if (e.loadError) d.push("vm 执行抛错: " + e.loadError.message);
    if (e.applyError) d.push("apply() 抛错: " + e.applyError.message);
    if (e.errors.length) d.push("执行期间抛错 " + e.errors.length + " 次: " + e.errors.map(function (x) { return x.message; }).join(" / "));

    var panel = panelOf(e);
    if (!panel) { report(14, TITLE, false, ["未找到 .wwp-panel 元素"]); return; }
    var row = panel.querySelector(sel("row", "video"));
    if (!row) {
      d.push("未找到 " + sel("row", "video") + " 容器");
    } else {
      var disp = row.style.display;
      if (disp !== "none") d.push("损坏视频记录下面板视频行期望 display=\"none\"，实际 " + JSON.stringify(disp === undefined ? null : disp) + "（currentIsVideo 未回滚会让该行错误显示为 flex）");
      d.push("[信息] " + sel("row", "video") + ".style.display = " + JSON.stringify(disp === undefined ? null : disp));
    }

    // 视频不得播放 / 不得可见
    var v = findVideoEl(e);
    if (!v) {
      d.push("[信息] 损坏记录下未取到视频元素（若为 null 需结合 bg 子元素判断）");
    } else {
      if (v.playCalls > 0) d.push("损坏视频记录下 video.play() 被调用 " + v.playCalls + " 次（应完全不动）");
      if (videoVisible(v)) d.push("损坏视频记录下视频元素仍可见（hidden=" + v.hidden + ", display=" + JSON.stringify(v.style.display === undefined ? null : v.style.display) + ", opacity=" + JSON.stringify(v.style.opacity === undefined ? null : v.style.opacity) + "）");
      d.push("[信息] 视频元素: playCalls=" + v.playCalls + " visible=" + videoVisible(v) + " src=" + JSON.stringify(String(v.src || "")));
    }

    // 背景不得被当成视频渲染
    var bg = e.document.getElementById(ID_BG);
    if (bg && bg.style.backgroundImage && String(bg.style.backgroundImage).indexOf("url(") === 0) {
      d.push("[信息] bg.backgroundImage = " + JSON.stringify(String(bg.style.backgroundImage).slice(0, 60)) + "（损坏记录不应走图片分支）");
    }
    // 播放按钮点击后也不得播放
    if (e.rowFound) d.push("[信息] 已点击 " + sel("act", "vidplay") + " 一次用于验证误触发");
    // 反空转对照：同一份 client.js 在「正常视频记录」场景（s1）里该行必须是可见的。
    // 若 s1 也是 none，说明这条断言只是恒真，抓不到 P2。
    var rowS1 = panelOf(scenes.s1) ? panelOf(scenes.s1).querySelector(sel("row", "video")) : null;
    var dispS1 = rowS1 ? rowS1.style.display : "(未取到)";
    d.push("[信息] 对照 s1（正常视频记录）该行 display = " + JSON.stringify(dispS1) + "（应为 flex）");
    if (!rowS1) d.push("反空转对照失败：s1 里取不到 " + sel("row", "video") + " 容器");
    else if (dispS1 !== "flex") d.push("反空转对照失败：s1（正常视频）该行 display 期望 \"flex\"，实际 " + JSON.stringify(dispS1) +
      " —— 该断言在此环境下恒为 none，无法区分 P2 是否回归");
    var pending = unhandled.length;
    d.push("[信息] 当前累计未捕获拒绝数 = " + pending);
    report(14, TITLE, d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
  })();
}

async function check4() {
  var e1 = scenes.s1;
  var d = [];
  if (e1.applyError) d.push("apply() 抛错: " + e1.applyError.message);
  var createdBefore = e1.objectUrls.created.length;
  var revokedBefore = e1.objectUrls.revoked.length;
  var v = findVideoEl(e1);
  var srcBefore = v ? String(v.src || "") : null;

  // 点图片卡片 → 切换
  var grid = null;
  var panel = panelOf(e1);
  if (panel) grid = panel.querySelector(sel("grid"));
  var card = null;
  if (grid) {
    for (var i = 0; i < grid.children.length; i++) {
      if (grid.children[i].title === S_IMAGE.name) { card = grid.children[i]; break; }
    }
  }
  if (!card) d.push("缩略图网格里未找到图片卡片（" + S_IMAGE.name + "），无法验证切换；网格子元素: " + JSON.stringify(grid ? grid.children.map(function (c) { return c.title; }) : null));
  else {
    fire(card, "click");
    await tick(16);
  }

  if (srcBefore && srcBefore.indexOf("blob:") === 0) {
    if (e1.objectUrls.revoked.indexOf(srcBefore) === -1) {
      d.push("切到图片后旧的 blob URL 未被 revoke: " + JSON.stringify(srcBefore) + "，revoked 列表 = " + JSON.stringify(e1.objectUrls.revoked));
    }
  } else if (!srcBefore) {
    d.push("切换前视频 src 不是 blob: URL，切换 revoke 无法验证（src=" + JSON.stringify(srcBefore) + "）");
  }

  // cleanup：create / revoke 必须配平
  if (typeof e1.cleanup === "function") {
    try { e1.cleanup(); } catch (e) { d.push("cleanup() 抛错: " + e.message); }
    await tick(8);
  } else {
    d.push("ctx.effect 未捕获到 cleanup 函数");
  }
  var created = e1.objectUrls.created.length;
  var revoked = e1.objectUrls.revoked.length;
  if (created !== revoked) {
    d.push("object URL 泄漏：create " + created + " 次 / revoke " + revoked + " 次（cleanup 后必须配平）");
  }
  d.push("[信息] createObjectURL " + created + " 次（切换前 " + createdBefore + "），revokeObjectURL " + revoked + " 次（切换前 " + revokedBefore + "）");
  d.push("[信息] created = " + JSON.stringify(e1.objectUrls.created.map(function (c) { return c.url + (c.tag ? "(" + c.tag + ")" : ""); })));
  d.push("[信息] revoked = " + JSON.stringify(e1.objectUrls.revoked));
  report(4, "object URL 生命周期（切换 revoke + cleanup 后 create/revoke 配平）", d.filter(function (x) { return x.indexOf("[信息]") !== 0; }).length === 0, d);
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════
async function main() {
  console.log("dsh-web-wallpaper · 视频动态壁纸 离线自检（不打开浏览器）");
  console.log("被检查文件: " + file);
  if (readError) {
    console.log(HY.repeat(72));
    console.log("");
    console.log("[失败] 无法读取被检查文件");
    console.log("      · " + readError.message);
    console.log("");
    console.log("汇总: 共 0 项检查，0 项通过，1 项失败（读文件阶段终止）");
    console.log("存在 1 项未通过 ✘");
    process.exit(1);
  }
  console.log("源码行数: " + src.split("\n").length + "  字符数: " + src.length);
  console.log(HY.repeat(72));
  console.log("");

  try {
    await runScenes();
  } catch (e) {
    console.log("[失败] 场景执行阶段脚本内部异常: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }

  // 场景 1-3、5-10（同步断言）
  try {
    checkAll();
  } catch (e) {
    report(0, "断言执行阶段脚本内部异常", false, [String(e && e.stack ? e.stack : e)]);
  }
  // 场景 4（异步断言）
  try {
    await check4();
  } catch (e) {
    report(4, "object URL 生命周期（切换 revoke + cleanup 后 create/revoke 配平）", false, ["断言内部异常: " + String(e && e.stack ? e.stack : e)]);
  }

  results.sort(function (a, b) { return a.no - b.no; });

  if (DUMP) {
    dumpScene("S1 视频为 current", scenes.s1);
    dumpScene("S2 老图片记录", scenes.s2);
    dumpScene("S3 导入", scenes.s3);
    dumpScene("S4 play 被拒", scenes.s4);
    dumpScene("S5 无 indexedDB", scenes.s5);
    console.log("");
  }

  var fail = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.ok) {
      console.log("[通过] " + r.no + ". " + r.title);
      for (var j = 0; j < r.details.length; j++) if (r.details[j].indexOf("[信息]") === 0) console.log("      " + r.details[j]);
    } else {
      fail++;
      console.log("[失败] " + r.no + ". " + r.title);
      for (var k = 0; k < r.details.length; k++) console.log("      · " + r.details[k]);
    }
  }

  console.log("");
  console.log(HY.repeat(72));
  var total = results.length;
  console.log("汇总: 共 " + total + " 项检查，" + (total - fail) + " 项通过，" + fail + " 项失败");
  if (fail === 0) {
    console.log("全部检查通过 ✔");
  } else {
    console.log("存在 " + fail + " 项未通过 ✘");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
