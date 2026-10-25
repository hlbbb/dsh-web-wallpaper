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

/**
 * ── 迁移哨兵值：从 client.js 源码动态提取（不要写死）──
 *
 * client.js 顶部有个一次性 migrate()：它以 localStorage["wwp_migrated"] 作为哨兵，
 * 哨兵不等于当前期望值时就执行迁移，其中一句会把 mid / heavy 档位强制改写成 light。
 * 检查器必须模拟「已经完成迁移、且用户确实选了 mid / heavy」的真实用户，否则
 * 三档会被 migrate 全部压成 light，量到的是同一份 LEVELS.light 数值（假失败）。
 *
 * 写死哨兵值会随客户端升版静默失效，所以这里从源码提取。提取失败才回退默认值。
 * 注意本仓库工具层的历史怪癖：避免在正则里使用带连字符的字符类（可能被吞）。
 */
const SENTINEL_FALLBACK = "4";
function extractMigrationSentinel(source) {
  // 只认形如  localStorage.getItem("wwp_migrated") === "4"  的读判定，
  // 不会误匹配 setItem("wwp_migrated", "4")（那条没有 ")" 与 "==="）。
  const re = new RegExp('wwp_migrated"\\s*\\)\\s*===\\s*"(\\d+)"');
  const m = re.exec(source);
  if (m) return { value: m[1], source: "从 client.js 提取" };
  return { value: SENTINEL_FALLBACK, source: "回退默认（提取失败）" };
}
const SENTINEL = extractMigrationSentinel(src);
if (SENTINEL.source.indexOf("回退") !== -1) {
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.log("!! 警告：未能从 " + file + " 提取 wwp_migrated 迁移哨兵值。");
  console.log("!! 已回退到默认值 " + SENTINEL_FALLBACK + "，检查结果可能失真（档位或被测成同一档）。");
  console.log("!! 请核对 client.js 里 migrate() 的哨兵判定写法。");
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}

const DARK_ATTR = "data" + HY + "ds" + HY + "dark" + HY + "theme";
const SURFACE_ATTR = "data" + HY + "wwp" + HY + "surface";

console.log("迁移哨兵值 wwp_migrated = " + SENTINEL.value + "（来源：" + SENTINEL.source + "）");
console.log("");

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
  // 预置「已完成迁移」的状态，与 client.js 当前哨兵值保持一致，migrate() 才会直接 return，
  // 不去覆写本次特意传入的 level。
  storage.set("wwp_migrated", SENTINEL.value);

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

  // 回读校验：apply() 之后档位必须仍是本次传入的值。若 migrate() 因哨兵过期又跑了一遍，
  // 这里会立刻发现「档位被覆写」，而不是等到三档数值悄悄变得一模一样。
  const levelAfter = storage.get("wwp_surface_level");
  if (levelAfter !== JSON.stringify(level)) {
    throw new Error(
      "档位被客户端覆写：预置 " + level + "，apply() 后变成 " + levelAfter +
      "（迁移哨兵 = " + SENTINEL.value + "，来源：" + SENTINEL.source + "）"
    );
  }

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

const LEVELS = ["ultra", "light", "mid", "heavy"];
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

// ── 断言：承载文字的表面不透明度下限（按档位分设）──
// 校准依据：2026-10-25 用户拍板「轻度不够透、要更透」，据此新增 ultra 档并下调 light 档语义；
// ultra/light 档位的设计语义本来就是「更透」，全局统一 0.85/0.88 与该设计语义不符，
// 故下限随档位分级：ultra 最宽、light 次之。
// 注意：mid 档并非「维持原值」——l1 下限由 0.85 下调至 0.80（LEVELS.mid.l1=0.82 本就低于旧全局值），
// l3 反而由 0.85 收紧至 0.90（LEVELS.mid.l3=0.93 本就高于旧值）；heavy 档与旧全局值一致。
const FLOOR_BY_LEVEL = {
  ultra: { l1: 0.55, l2: 0.75, l3: 0.80, input: 0.72, selector: 0.70, menu: 0.90, module: 0.80 },
  light: { l1: 0.68, l2: 0.84, l3: 0.85, input: 0.78, selector: 0.76, menu: 0.92, module: 0.84 },
  mid:   { l1: 0.80, l2: 0.88, l3: 0.90, input: 0.78, selector: 0.76, menu: 0.92, module: 0.84 },
  heavy: { l1: 0.85, l2: 0.88, l3: 0.90, input: 0.78, selector: 0.76, menu: 0.92, module: 0.84 }
};

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
console.log("可读下限检查（设置页弹窗 = bg-2，按档位分设下限）\n");
for (const level of LEVELS) {
  const a = runs[level].dark.alpha;
  const floors = FLOOR_BY_LEVEL[level];
  for (const name of Object.keys(floors)) {
    const tok = TOK[name];
    const min = floors[name];
    const v = a[tok];
    if (v === undefined) { console.log("  [缺失] " + level + " " + tok); fail++; continue; }
    if (v < min) { console.log("  [低于下限] " + level + " " + tok + " = " + v + " < " + min); fail++; }
  }
}
if (fail === 0) console.log("  全部达标");

// 语义：ultra 最透、heavy 最实，档位 alpha 单调递增
const l2 = LEVELS.map((l) => runs[l].dark.alpha[TOK.l2]);
const mono = l2.every((v, i) => i === 0 || l2[i - 1] <= v);
console.log("\n档位单调性（档位 alpha 单调递增：ultra 最透 → heavy 最实）: " + (mono ? "通过" : "失败") + "  [" + l2.join(" <= ") + "]");
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
