/**
 * 离线验证 dshpaper 的「面板透明化」档位是否可读。
 *
 * 做法：为每个档位建一个全新的 vm 沙箱（模块状态在 load 时读取 localStorage，
 * 必须每档重建），用最小 DOM 桩真实执行 lib/client.js 的 apply()，
 * 抓出它实际注入的 <style>，解析令牌 alpha，再按 WCAG 2.1 算对比度。
 *
 * 用法: node tools/verify.js <client.js> [--dump]
 */
const fs = require("fs");
const vm = require("vm");

const HY = String.fromCharCode(45);
const file = process.argv[2];
const DUMP = process.argv.includes("--dump");
const src = fs.readFileSync(file, "utf8");

const DARK_ATTR = "data" + HY + "ds" + HY + "dark" + HY + "theme";
const SURFACE_ATTR = "data" + HY + "wwp" + HY + "surface";

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
      else if (on) set.add(c); else set.delete(c);
    }
  };
}

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: makeClassList(),
    attributes: {},
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    type: "",
    accept: "",
    multiple: false,
    id: "",
    title: "",
    className: "",
    files: [],
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return makeEl("div"); },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return false; },
    click() {},
    focus() {}
  };
}

/** 建一个全新沙箱并执行插件，返回该档位注入的 surface CSS 与主 CSS。 */
function runOnce(level, dark) {
  const head = makeEl("head");
  const body = makeEl("body");
  const html = makeEl("html");
  const collected = [];

  const origAppend = head.appendChild.bind(head);
  head.appendChild = (c) => { if (c.tagName === "STYLE") collected.push(c); return origAppend(c); };

  if (dark) body.attributes[DARK_ATTR] = "";

  const storage = new Map();
  storage.set("wwp_surface_level", JSON.stringify(level));
  storage.set("wwp_surface", "true");
  storage.set("wwp_enabled", "true");
  storage.set("wwp_migrated", "2");

  const sandbox = {
    document: {
      head, body, documentElement: html,
      createElement: (t) => makeEl(t),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    indexedDB: undefined,
    FileReader: class {},
    Math, Date, Promise, JSON, String, Number, Array, Object, Set, Error, Boolean, RegExp
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.window.innerWidth = 1440;
  sandbox.window.innerHeight = 900;

  let captured = null;
  sandbox.window.__ModuleLoader__ = { load: (def) => { captured = def; } };

  const ctxObj = vm.createContext(sandbox);
  vm.runInContext(src, ctxObj, { filename: file });
  if (!captured) throw new Error("模块未通过 __ModuleLoader__.load 注册");

  const mod = captured.factory(() => ({}));
  if (typeof mod.apply !== "function") throw new Error("exports.apply 不是函数");

  let cleanup = null;
  mod.apply({ effect: (fn) => { cleanup = fn(); } });

  const surfaceStyle = collected.find((s) => s.getAttribute(SURFACE_ATTR) !== null);
  const mainStyle = collected.find((s) => s.getAttribute("data" + HY + "wwp") !== null);
  if (!surfaceStyle) throw new Error("未找到 surface <style>（档位 " + level + "）");

  // 解析令牌 alpha。刻意不用复杂正则：本会话的工具层会吞掉字面连字符，
  // 正则里的字符类（如 [a0-9-]）会被破坏，改用 split + 字符串比较，稳。
  const alpha = {};
  const decls = surfaceStyle.textContent.split(";");
  for (const decl of decls) {
    // 用 lastIndexOf：首段里选择器本身含冒号（":root"），值里不会再有冒号。
    const i = decl.lastIndexOf(":");
    if (i === -1) continue;
    const name = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (name.indexOf("--dsw") !== 0) continue;
    if (value.indexOf("rgba(") !== 0) continue;
    const inner = value.slice(value.indexOf("(") + 1, value.indexOf(")"));
    const nums = inner.split(",").map((s) => Number(s.trim()));
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) alpha[name] = nums[3];
  }

  return {
    level, dark,
    surfaceCSS: surfaceStyle.textContent,
    mainCSS: mainStyle ? mainStyle.textContent : "",
    alpha,
    styleCount: collected.length
  };
}

const LEVELS = ["light", "mid", "heavy"];
const runs = {};
for (const level of LEVELS) {
  runs[level] = { dark: runOnce(level, true), light: runOnce(level, false) };
}

if (DUMP) {
  console.log("===== 档位 light 的 surface CSS =====");
  console.log(runs.light.dark.surfaceCSS);
}

// 令牌名一律由片段拼出来：本会话的工具层会吞掉字面连字符及其后 0-3 个字符，
// 直接写 "--dswiasg-2" 会被破坏成 "--dswiasg-2"。
const T = (...parts) => "--dsw" + HY + parts.join(HY);

const TOK = {
  base: T("alias", "bg", "base"),
  l1: T("alias", "bg", "layer", "1"),
  l2: T("alias", "bg", "layer", "2"),
  l3: T("alias", "bg", "layer", "3"),
  module: T("alias", "bg", "module", "platform"),
  input: T("specific", "input", "major"),
  selector: T("specific", "selector"),
  menu: T("specific", "menu"),
  sidebar: T("specific", "sidebar", "fill"),
  bubble: T("specific", "bubble")
};

// ── 断言：承载文字的表面不透明度下限 ──
const FLOOR = [
  [TOK.l1, 0.85, "卡片 / 预览面"],
  [TOK.l2, 0.88, "设置页弹窗 / 浮动面板"],
  [TOK.l3, 0.85, "输入框 / 选中态"],
  [TOK.input, 0.78, "主输入框"],
  [TOK.selector, 0.76, "下拉选择器"],
  [TOK.menu, 0.92, "弹出菜单"],
  [TOK.module, 0.84, "导航条 / 标签栏"]
];

console.log("各档位解析出的令牌不透明度（来自真实注入的 CSS）\n");
const cols = [TOK.base, TOK.l1, TOK.l2, TOK.l3, TOK.module, TOK.input, TOK.selector, TOK.menu, TOK.sidebar, TOK.bubble];
const short = (c) => c.slice(6).replace(/aliasbg|specific/g, "").slice(0, 14).padEnd(15);
console.log("档位".padEnd(8) + cols.map(short).join(""));
console.log(HY.repeat(8 + cols.length * 15));
for (const level of LEVELS) {
  const a = runs[level].dark.alpha;
  console.log(level.padEnd(8) + cols.map((c) => String(a[c] === undefined ? "-" : a[c]).padEnd(15)).join(""));
}
console.log("");

let fail = 0;
console.log("可读下限检查（设置页弹窗 = bg-2）\n");
for (const level of LEVELS) {
  const a = runs[level].dark.alpha;
  for (const [tok, min, label] of FLOOR) {
    const v = a[tok];
    if (v === undefined) { console.log("  [缺失] " + level + " " + tok); fail++; continue; }
    if (v < min) { console.log("  [低于下限] " + level + " " + tok + " = " + v + " < " + min + "  (" + label + ")"); fail++; }
  }
}
if (fail === 0) console.log("  全部达标");

// 语义：轻度最不透、重度最透
const l2 = LEVELS.map((l) => runs[l].dark.alpha[TOK.l2]);
const mono = l2[0] >= l2[1] && l2[1] >= l2[2];
console.log("\n档位单调性（轻度 >= 中度 >= 重度，越重越透）: " + (mono ? "通过" : "失败") + "  [" + l2.join(" >= ") + "]");
if (!mono) fail++;

// 深浅色都要有
for (const level of LEVELS) {
  if (!runs[level].dark.surfaceCSS || !runs[level].light.surfaceCSS) { console.log("  [缺失] " + level + " 深浅色 CSS"); fail++; }
}

// ── WCAG 2.1 对比度 ──
function srgbToLin(c) { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function lum(rgb) { return 0.2126 * srgbToLin(rgb[0]) + 0.7152 * srgbToLin(rgb[1]) + 0.0722 * srgbToLin(rgb[2]); }
function contrast(a, b) { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }
function over(fg, al, bg) { return [0, 1, 2].map((i) => al * fg[i] + (1 - al) * bg[i]); }

const THEMES = {
  dark: { surface: [13, 17, 23], text: [0xf9, 0xfa, 0xfb], text2: [0xcf, 0xd3, 0xd6], text3: [0xad, 0xb2, 0xb8], mask: 0.50 },
  light: { surface: [248, 250, 252], text: [0x0f, 0x11, 0x15], text2: [0x61, 0x66, 0x6b], text3: [0x81, 0x85, 0x8c], mask: 0.24 }
};
const WALLS = [["白壁纸", [255, 255, 255]], ["亮照片", [200, 200, 200]], ["中灰", [128, 128, 128]], ["暗照片", [60, 60, 60]], ["黑壁纸", [0, 0, 0]]];

console.log("\n设置页弹窗正文对比度（WCAG AA 正文要求 4.5:1）\n");
for (const tk of ["dark", "light"]) {
  const T = THEMES[tk];
  console.log("  " + tk + " 主题");
  console.log("    " + ["档位".padEnd(8), ...WALLS.map(([n]) => n.padEnd(11)), "判定"].join(""));
  for (const level of LEVELS) {
    const al = runs[level][tk].alpha[TOK.l2];
    const row = WALLS.map(([, wp]) => {
      const backdrop = over([0, 0, 0], T.mask, wp);
      const panel = over(T.surface, al, backdrop);
      return contrast(T.text, panel);
    });
    const worst = Math.min(...row);
    const verdict = worst >= 4.5 ? "AA 达标" : worst >= 3 ? "仅大字" : "不合格";
    console.log("    " + level.padEnd(8) + row.map((c) => (c.toFixed(1) + ":1").padEnd(11)).join("") + verdict);
    if (worst < 4.5) fail++;
  }
  console.log("");
}

console.log("三级文字（说明 / hint）对比度，最差白壁纸\n");
for (const tk of ["dark", "light"]) {
  const T = THEMES[tk];
  console.log("  " + tk + " 主题   " + ["档位".padEnd(8), "正文".padEnd(10), "次要".padEnd(10), "三级".padEnd(10), "三级判定"].join(""));
  for (const level of LEVELS) {
    const al = runs[level][tk].alpha[TOK.l2];
    const backdrop = over([0, 0, 0], T.mask, WALLS[0][1]);
    const panel = over(T.surface, al, backdrop);
    const c1 = contrast(T.text, panel), c2 = contrast(T.text2, panel), c3 = contrast(T.text3, panel);
    const v = c3 >= 4.5 ? "AA 达标" : c3 >= 3 ? "仅大字" : "不合格";
    console.log("           " + level.padEnd(8) + [c1, c2, c3].map((c) => (c.toFixed(1) + ":1").padEnd(10)).join("") + v);
  }
}

console.log("\n注入的 style 元素数: " + LEVELS.map((l) => l + "=" + runs[l].dark.styleCount).join(", "));
console.log(fail === 0 ? "\n全部检查通过" : "\n存在 " + fail + " 项未通过");
process.exit(fail === 0 ? 0 : 1);
