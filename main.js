const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { scanFolder, parseCode, readSidecarMeta, VIDEO_EXT } = require('./lib/scanner');
const scraper = require('./lib/scraper');

let mainWindow = null;

// 简易文件日志。开发时写项目目录 run.log；打包后写入用户数据目录（安装目录只读，且方便用户反馈问题）。
function logFilePath() {
  try {
    return app.isPackaged ? path.join(app.getPath('userData'), 'run.log') : path.join(__dirname, 'run.log');
  } catch { return path.join(__dirname, 'run.log'); }
}
function logLine(msg) {
  try { fs.appendFileSync(logFilePath(), new Date().toISOString().slice(11, 19) + ' ' + msg + '\n'); } catch {}
  console.log(msg);
}

// GPU 策略（决定拖动是否跟手的关键）：
//  - 默认开启硬件加速。本机是 165Hz 屏，软件渲染根本喂不满帧，拖动会明显发滞。
//  - 以管理员身份运行时 Chromium 沙箱与 GPU 进程冲突（渲染进程 0xC0000005 崩溃），
//    因此默认加 --no-sandbox（本地应用、只加载本地页面，可接受）。NAVI_KEEP_SANDBOX=1 可保留沙箱。
//  - 个别机器 GPU 不可用：NAVI_NO_GPU=1 或 --no-gpu 走 SwiftShader 软渲染兜底。
const NO_GPU = !!(process.env.NAVI_NO_GPU || process.argv.includes('--no-gpu'));
if (NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
} else {
  if (!process.env.NAVI_KEEP_SANDBOX) app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

const startedAt = Date.now();

// 是否处于软件渲染（软渲染下才需要拖动降级；GPU 合成时降级只会让模糊闪动，反而更差）
let _softRender = null;
function isSoftwareRendering() {
  if (_softRender === null) {
    let compositing = '';
    try { compositing = app.getGPUFeatureStatus().gpu_compositing || ''; } catch {}
    _softRender = NO_GPU || compositing !== 'enabled';
  }
  return _softRender;
}

// ---------- 数据目录 ----------
// 程序数据（设置/媒体库索引/封面缓存/壁纸）根目录，优先级：
//   1) 环境变量 NAVI_DATA_DIR（便携部署可指定到 U 盘等）；
//   2) 历史默认位置 E:\JavManger —— 仅当该目录里已有 settings.json / library.json 时才沿用，避免老用户数据"消失"；
//   3) 默认 %APPDATA%\navi-media\data（发行版默认，无需管理员权限、任何机器都可用）。
// 目录不可写（拔盘/权限不足）会自动回退到默认位置，避免程序打不开。
// 注意：Chromium 运行时缓存仍留在默认 userData（C 盘），不污染数据目录。
const LEGACY_DATA_DIR = 'E:\\JavManger';
function defaultDataRoot() {
  if (process.env.NAVI_DATA_DIR) return process.env.NAVI_DATA_DIR;
  try {
    if (fs.existsSync(LEGACY_DATA_DIR) &&
        (fs.existsSync(path.join(LEGACY_DATA_DIR, 'settings.json')) ||
         fs.existsSync(path.join(LEGACY_DATA_DIR, 'library.json')))) return LEGACY_DATA_DIR;
  } catch {}
  return path.join(app.getPath('userData'), 'data');
}
const DATA_ROOT_PREF = defaultDataRoot();
let _dataRoot = null;
function resolveDataRoot() {
  try {
    fs.mkdirSync(DATA_ROOT_PREF, { recursive: true });
    fs.accessSync(DATA_ROOT_PREF, fs.constants.W_OK);
    return DATA_ROOT_PREF;
  } catch (e) {
    try { logLine('[data] 数据目录不可用(' + DATA_ROOT_PREF + ')，回退默认位置: ' + e.message); } catch {}
    return path.join(app.getPath('userData'), 'data');
  }
}
const dataDir = () => (_dataRoot || (_dataRoot = resolveDataRoot()));
const coversDir = () => path.join(dataDir(), 'covers');
const wallpapersDir = () => path.join(dataDir(), 'wallpapers');
const dbFile = () => path.join(dataDir(), 'library.json');
const settingsFile = () => path.join(dataDir(), 'settings.json');

function ensureDirs() {
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.mkdirSync(wallpapersDir(), { recursive: true });
}

// ---------- 媒体资产（刮削结果归档到视频所在文件夹） ----------
// 命名约定：cover.<ext> / fanart-01.<ext>… / metadata.json
const ASSET_COVER = 'cover';
const ASSET_FANART = 'fanart';
const ASSET_META = 'metadata.json';
const ASSET_NFO = 'movie.nfo';   // Emby/Kodi 兼容输出

// 绝对路径 → cover:// 地址（cover://local/<encodeURIComponent(绝对路径)>）
// 兼容旧的 cover://<文件名>：仍从中央缓存目录 covers/ 取
function fileUrl(absPath) {
  return 'cover://local/' + encodeURIComponent(absPath);
}

// 计算/创建资产文件夹（只建目录，不移动视频）——用户手动加图/换封面用
async function assetDirForPath(videoPath) {
  const parent = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  if (path.basename(parent).toLowerCase() === stem.toLowerCase()) return parent;
  const target = path.join(parent, stem);
  await fsp.mkdir(target, { recursive: true });
  return target;
}

// 刮削用：确保视频处于自己的同名文件夹中
//  - 已在同名文件夹内 → 直接用
//  - 否则 → 把视频移入同名文件夹（文件夹不存在则新建）。
//    旧版只在「所在文件夹只有这一个视频」时才移动，多视频同目录时会留下散落视频，
//    现统一按「同名文件夹」归档——文件夹名与视频名一一对应，移动总是安全的。
async function ensureAssetsDir(item) {
  const videoPath = item.path;
  const parent = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  if (path.basename(parent).toLowerCase() === stem.toLowerCase()) {
    item.dir = parent;
    return parent;
  }
  const target = path.join(parent, stem);
  await fsp.mkdir(target, { recursive: true });
  const dest = path.join(target, path.basename(videoPath));
  if (!fs.existsSync(dest)) {
    try {
      await fsp.rename(videoPath, dest);
    } catch {
      await fsp.copyFile(videoPath, dest);
      await fsp.unlink(videoPath);
    }
    logLine('[archive] 视频已移入独立文件夹: ' + dest);
  }
  item.path = dest;
  item.moved = true;
  item.dir = target;
  return target;
}

// 启动修复：旧规则（多视频同目录不移动）遗留的散落视频 —— 资产文件夹已存在
// （有 metadata.json）但视频还在外面，把它移进去并更新库记录与 metadata。
async function repairLooseVideos() {
  const db = loadDb();
  const embyOn = !!(loadSettings().scrape || {}).embyCompat;
  let changed = false;
  for (const item of db.items) {
    try {
      if (!item.path || !fs.existsSync(item.path)) continue;
      const parent = path.dirname(item.path);
      const stem = path.basename(item.path, path.extname(item.path));
      if (path.basename(parent).toLowerCase() === stem.toLowerCase()) continue;
      const target = path.join(parent, stem);
      if (!fs.existsSync(path.join(target, ASSET_META))) continue; // 没归档过资产的不动
      const dest = path.join(target, path.basename(item.path));
      if (!fs.existsSync(dest)) {
        try {
          await fsp.rename(item.path, dest);
        } catch {
          await fsp.copyFile(item.path, dest);
          await fsp.unlink(item.path);
        }
        logLine('[archive] 修复: 视频移入既有资产文件夹: ' + dest);
      }
      item.movedFrom = item.path;
      item.path = dest;
      item.moved = true;
      item.dir = target;
      await writeMetadata(item, target);
      if (embyOn) await writeEmbyAssets(item, target);
      changed = true;
    } catch (e) { logLine('[archive] 修复失败 ' + (item.path || '?') + ': ' + e.message); }
  }
  if (changed) saveDb(db);
}

// 启动自愈：库里资料不全的条目（刮削失败 / 曾经丢过库），
// 用视频同目录的 metadata.json 把标题、演员、标签、简介、封面、截图补回来。
// 只在条目「缺封面或缺简介」时才动它，已经有完整资料的条目一律跳过，不会覆盖新数据。
async function restoreSidecars() {
  let db;
  try { db = loadDb(); } catch { return; }
  let n = 0;
  for (const item of (db.items || [])) {
    try {
      if (!item.path || !fs.existsSync(item.path)) continue;
      if (item.cover && item.synopsis) continue;   // 资料完整，跳过
      const side = await readSidecarMeta(item.path);
      if (!side) continue;
      applySidecar(item, side);
      n++;
    } catch (e) { logLine('[restore] 补全失败 ' + (item.path || '?') + ': ' + e.message); }
  }
  if (n) {
    saveDb(db);
    rememberTags(db.items);
    logLine('[restore] 启动自愈：从 metadata.json 补全 ' + n + ' 条');
  }
}

// 写入 metadata.json（不存绝对路径，避免换盘后失效）
async function writeMetadata(item, dir) {
  try {
    const meta = {
      code: item.code || '', title: item.title || '', date: item.date || '',
      actresses: item.actresses || [], actressAlias: item.actressAlias || {},
      tags: item.tags || [], category: item.category || '',
      synopsis: item.synopsis || '', rating: item.rating || 0,
      duration: item.duration || '', director: item.director || '',
      studio: item.studio || '', publisher: item.publisher || '',
      detailUrl: item.detailUrl || '', provider: item.provider || '',
      videoFile: path.basename(item.path),
      cover: item.cover && item.cover.startsWith('cover://local/') ? ASSET_COVER + path.extname(item.cover) : '',
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(path.join(dir, ASSET_META), JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) { logLine('[archive] metadata 写入失败: ' + e.message); }
}

// ---------- Emby / Jellyfin / Kodi 兼容输出 ----------
// 依据 Emby 官方 Movie Naming 文档，本地图片命名只认这些形式：
//   Primary ：{name}.ext / {name}-poster.ext / poster.ext / cover.ext / folder.ext / movie.ext
//   Backdrop：backdrop.ext、backdropX.ext / fanart.ext、fanart-X.ext / background.ext、background-X.ext
//   NFO     ：Kodi 格式 movie.nfo
// 程序自身用 cover.jpg + fanart-01.jpg，其中 backdrop 的「数字前面带连字符 + 前导零」
// 不在官方示例里，所以兼容输出额外生成 poster.* / backdrop1..N.* / movie.nfo。
// 原文件一律保留，程序自身逻辑完全不受影响；图片优先硬链接，不额外占用磁盘空间。
const IMG_EXT_RE = '\\.(jpe?g|png|gif|webp|tbn)';
const RE_EMBY_IMG = new RegExp('^(poster|backdrop\\d*)' + IMG_EXT_RE + '$', 'i');
const isEmbyAssetFile = (f) => RE_EMBY_IMG.test(f) || /^movie\.nfo$/i.test(f);

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// 与渲染层 displayTitle() 保持一致：番号在前、标题在后（标题已含番号时不重复）
function displayTitleOf(it) {
  const title = String(it && (it.title || it.name) || '').trim();
  const code = String(it && it.code || '').trim();
  if (!code) return title;
  const norm = (s) => s.toLowerCase().replace(/ppv/g, '').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  if (!title || norm(title).includes(norm(code))) return title;
  return code + ' ' + title;
}

// 生成 Kodi/Emby 通用的 movie.nfo
function buildNfo(item) {
  const code = String(item.code || '').trim();
  const title = displayTitleOf(item);
  const rawTitle = String(item.title || '').trim();
  const date = String(item.date || '').trim();
  const year = (date.match(/\d{4}/) || [])[0] || '';
  const dur = parseInt(item.duration, 10);
  const rating = Number(item.rating) || 0;
  const studio = String(item.studio || item.publisher || '').trim();
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  L.push('<movie>');
  if (title) L.push('  <title>' + escapeXml(title) + '</title>');
  if (rawTitle && rawTitle !== title) L.push('  <originaltitle>' + escapeXml(rawTitle) + '</originaltitle>');
  if (code) L.push('  <sorttitle>' + escapeXml(code) + '</sorttitle>');
  if (code) L.push('  <num>' + escapeXml(code) + '</num>');
  if (item.synopsis) L.push('  <plot>' + escapeXml(item.synopsis) + '</plot>');
  if (rating > 0) L.push('  <rating>' + rating + '</rating>');
  if (year) L.push('  <year>' + year + '</year>');
  if (date) L.push('  <premiered>' + escapeXml(date) + '</premiered>');
  if (dur > 0) L.push('  <runtime>' + dur + '</runtime>');
  if (item.director) L.push('  <director>' + escapeXml(item.director) + '</director>');
  if (studio) L.push('  <studio>' + escapeXml(studio) + '</studio>');
  if (item.category) L.push('  <genre>' + escapeXml(item.category) + '</genre>');
  for (const tg of (item.tags || [])) L.push('  <tag>' + escapeXml(tg) + '</tag>');
  (item.actresses || []).forEach((a, i) => {
    const nm = String(a || '').trim();
    if (!nm) return;
    L.push('  <actor><name>' + escapeXml(nm) + '</name><order>' + i + '</order></actor>');
  });
  if (code) L.push('  <uniqueid type="navi" default="true">' + escapeXml(code) + '</uniqueid>');
  if (item.detailUrl) L.push('  <website>' + escapeXml(item.detailUrl) + '</website>');
  L.push('</movie>');
  return L.join('\n') + '\n';
}

// 单个文件：优先硬链接（同盘同目录，零空间占用），失败退回复制
async function linkOrCopy(src, dst) {
  try { await fsp.unlink(dst); } catch {}
  try { await fsp.link(src, dst); }
  catch { await fsp.copyFile(src, dst); }
}

// 清掉旧的兼容文件（重新刮削 / 改成手动图后避免残留过期数据）
async function clearEmbyAssets(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  try {
    for (const f of await fsp.readdir(dir)) {
      if (isEmbyAssetFile(f)) await fsp.rm(path.join(dir, f), { force: true });
    }
  } catch {}
}

// 写入 Emby 兼容资源：poster.*（主图）+ backdrop1..N.*（背景图，来自截图）+ movie.nfo
async function writeEmbyAssets(item, dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    await clearEmbyAssets(dir);
    const files = await fsp.readdir(dir);
    const cover = files.find(f => new RegExp('^cover' + IMG_EXT_RE + '$', 'i').test(f));
    if (cover) {
      await linkOrCopy(path.join(dir, cover), path.join(dir, 'poster' + path.extname(cover).toLowerCase()));
    }
    const byNum = (re) => files.filter(f => re.test(f))
      .map(f => ({ f, n: parseInt((/(\d+)/.exec(f) || [0, 999])[1], 10) }))
      .sort((a, b) => a.n - b.n).map(o => o.f);
    // 刮削截图排前、用户手动加的图排后，统一编号避免冲突
    const ordered = [
      ...byNum(new RegExp('^fanart-\\d+' + IMG_EXT_RE + '$', 'i')),
      ...byNum(new RegExp('^fanart-user\\d+' + IMG_EXT_RE + '$', 'i'))
    ];
    let i = 1;
    for (const f of ordered) {
      await linkOrCopy(path.join(dir, f), path.join(dir, 'backdrop' + i + path.extname(f).toLowerCase()));
      i++;
    }
    await fsp.writeFile(path.join(dir, ASSET_NFO), buildNfo(item), 'utf-8');
    return true;
  } catch (e) {
    logLine('[emby] 兼容输出失败: ' + (item.code || item.name || '?') + ' — ' + e.message);
    return false;
  }
}

// 只重写 movie.nfo（条目元数据被编辑后同步，不碰图片）
async function refreshNfoOnly(item) {
  try {
    const dir = item.dir && fs.existsSync(item.dir) ? item.dir : null;
    if (!dir || !fs.existsSync(path.join(dir, ASSET_META))) return;
    await fsp.writeFile(path.join(dir, ASSET_NFO), buildNfo(item), 'utf-8');
  } catch {}
}

// 按视频路径找库里的条目（手动换图后同步 Emby 资源用）
function findItemByPath(p) {
  if (!p) return null;
  const norm = (x) => String(x || '').replace(/\//g, '\\').toLowerCase();
  const target = norm(p);
  return loadDb().items.find(it => norm(it.path) === target || norm(it.movedFrom) === target) || null;
}

const DEFAULT_SETTINGS = {
  theme: 'light',          // light | dark | glass(系统级毛玻璃，透视并模糊背后内容)；默认浅白
  language: 'zh',           // 界面语言：zh 中文 | en English，设置→通用 可选
  accent: '#2fb37a',        // 主色（强调色）：按钮/选中项/进度条，默认浅绿，设置→主题 可选
  playerPath: '',            // 留空 = 系统默认播放器
  categories: [],
  dirs: [],                  // 刮削目录 [{ path, watch }]，watch=监测新文件自动入库刮削
  scrape: {
    provider: 'auto',        // auto=自动（FC2 番号走 FC2 专用链，其余走 JavBus）/ javbus / fc2
    baseUrl: 'https://www.javbus.com',
    autoScrape: true,        // 导入后自动按默认规则刮削一遍
    archiveToFolder: true,   // 刮削结果归档到视频所在文件夹（视频会移入同名文件夹）
    embyCompat: false,       // 额外输出 Emby 兼容文件（movie.nfo + poster.* + backdropN.*）
    timeout: 15000
  },
  network: {
    proxyEnabled: false,     // 是否启用代理（如 Clash Verge 混合端口）
    proxyMode: 'manual',     // manual=手动指定 / system=跟随系统代理
    proxyUrl: 'http://127.0.0.1:7897'
  },
  wallpaper: { light: '', dark: '' },  // 自定义壁纸（wallpaper://xxx，仅浅白/暗黑）
  glassTint: 35,                       // 毛玻璃背景色调浓度 %（越大越暗、越不透）
  lock: { enabled: false, salt: '', hash: '' },  // 启动密码锁：sha256(salt::password)，只在主进程校验
  modesV3: false                       // 主题模式迁移标记（v3：移除透明模式，transparent→glass）
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

const loadDb = () => readJson(dbFile(), { items: [], trash: [] });
const saveDb = (db) => writeJson(dbFile(), db);
function loadSettings() {
  const saved = readJson(settingsFile(), {});
  const s = {
    ...DEFAULT_SETTINGS,
    ...saved,
    scrape: { ...DEFAULT_SETTINGS.scrape, ...(saved.scrape || {}) },
    network: { ...DEFAULT_SETTINGS.network, ...(saved.network || {}) },
    wallpaper: { ...DEFAULT_SETTINGS.wallpaper, ...(saved.wallpaper || {}) },
    lock: { ...DEFAULT_SETTINGS.lock, ...(saved.lock || {}) }
  };
  // 迁移 v3：移除透明模式，旧 transparent / 旧 glass(=透明) 统一转为新 glass
  if (!saved.modesV3) {
    if (saved.theme === 'transparent' || saved.theme === 'glass') s.theme = 'glass';
    delete s.transparentOpacity;
    delete s.glassBlur;
    s.modesV3 = true;
    writeJson(settingsFile(), s);
  }
  return s;
}
// 热路径（窗口 move/resize 事件等）用内存缓存，避免每次事件都读盘 + JSON 解析
let _settingsCache = null;
function settings() {
  if (!_settingsCache) _settingsCache = loadSettings();
  return _settingsCache;
}
const saveSettings = (s) => { _settingsCache = null; writeJson(settingsFile(), s); };

// ---------- 网络代理 ----------
// enabled+manual → 固定代理规则；enabled+system → 跟随系统；关闭 → 恢复系统默认
async function applyProxyConfig(cfg) {
  try {
    cfg = cfg || {};
    if (cfg.proxyEnabled && cfg.proxyMode === 'manual' && cfg.proxyUrl) {
      await session.defaultSession.setProxy({ proxyRules: cfg.proxyUrl });
      logLine('[proxy] 已启用手动代理 ' + cfg.proxyUrl);
    } else if (cfg.proxyEnabled && cfg.proxyMode === 'system') {
      await session.defaultSession.setProxy({ mode: 'system' });
      logLine('[proxy] 已启用系统代理');
    } else {
      await session.defaultSession.setProxy({ mode: 'system' });
      logLine('[proxy] 代理已关闭，恢复系统默认');
    }
    return true;
  } catch (e) {
    logLine('[proxy] 设置失败: ' + e.message);
    return false;
  }
}

// ---------- Win10 系统级毛玻璃 ----------
// 通过 user32!SetWindowCompositionAttribute 启用 ACCENT_ENABLE_ACRYLICBLURBEHIND，
// 由系统合成器（DWM）模糊窗口背后的内容——Electron 的 CSS 无法模糊页面外内容，必须走这里。
let koffi = null;
let wcaSetAttr = null;
let getAsyncKeyState = null;
try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  wcaSetAttr = user32.func('SetWindowCompositionAttribute', 'int', ['intptr', 'void*']);
  getAsyncKeyState = user32.func('GetAsyncKeyState', 'int16', ['int']);
  koffi.struct('NAVI_ACCENT_POLICY', {
    AccentState: 'int32',    // 4 = ACCENT_ENABLE_ACRYLICBLURBEHIND, 0 = 关闭
    AccentFlags: 'int32',
    GradientColor: 'uint32', // AABBGGRR 色调
    AnimationId: 'int32'
  });
  koffi.struct('NAVI_WCA_DATA', {
    Attribute: 'int32',      // 19 = WCA_ACCENT_POLICY
    Data: koffi.pointer('NAVI_ACCENT_POLICY'),
    SizeOfData: 'size_t'
  });
  logLine('[acrylic] koffi 就绪');
} catch (e) {
  logLine('[acrylic] koffi 不可用: ' + e.message);
}

// enabled=true 开启系统级毛玻璃；tintPct=背景色调浓度 0-90（越大越暗越不透）
// stateOverride：强制指定 AccentState（4=acrylic 高质量模糊，3=旧版 BLURBEHIND 轻量模糊，0=关闭）
function applyAcrylic(win, enabled, tintPct = 35, quiet = false, stateOverride = null) {
  if (!wcaSetAttr || !win) return false;
  if (process.env.NAVI_NO_ACRYLIC) return false;
  try {
    const a = Math.round(255 * Math.min(90, Math.max(0, Number(tintPct) || 0)) / 100);
    // 测试/调优开关：NAVI_ACCENT_STATE=1|2|4 强制指定合成状态，NAVI_ACCENT_ALPHA 覆盖透明度
    const state = process.env.NAVI_ACCENT_STATE ? Number(process.env.NAVI_ACCENT_STATE)
      : (stateOverride != null ? stateOverride : (enabled ? 3 : 0));
    const alpha = process.env.NAVI_ACCENT_ALPHA ? Number(process.env.NAVI_ACCENT_ALPHA) : a;
    const colorX = (((alpha & 0xff) << 24) | (0x1c << 16) | (0x14 << 8) | 0x10) >>> 0;  // 深蓝灰 #10141c → AABBGGRR
    const policy = {
      AccentState: state,          // 0 = ACCENT_DISABLED（关闭时必须传有效结构体才能真正清除，
      AccentFlags: state ? 2 : 0,  //   传 Data:null/SizeOfData:0 会被 API 判为无效参数而失败）
      GradientColor: state ? colorX : 0,
      AnimationId: 0
    };
    const data = {
      Attribute: 19,
      Data: koffi.as(policy, koffi.pointer('NAVI_ACCENT_POLICY')),
      SizeOfData: 16
    };
    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
    const ok = !!wcaSetAttr(hwnd, koffi.as(data, koffi.pointer('NAVI_WCA_DATA')));
    if (!quiet) logLine('[acrylic] ' + (enabled ? 'on' : 'off') + ' tint=' + tintPct + ' -> ' + (ok ? 'ok' : 'failed'));
    return ok;
  } catch (e) {
    logLine('[acrylic] 调用失败: ' + e.message);
    return false;
  }
}

// ---------- 毛玻璃合成状态（2026-10-05 定稿：全程统一轻量模糊） ----------
// 静止与拖动/缩放全程统一使用 AccentState=3（BLURBEHIND，旧版轻量模糊）。
// 原因：高质量 acrylic（state=4）的模糊半径极大，背后的文字/窗口细节会被平均成均匀色块
// （实测 tint=0 时也看不到背后文字），而轻量模糊半径小、背后内容可读——这正是用户反复
// 反馈的「拖动时能看见背后模糊文字、停下就看不见」的根源，与色调浓度无关。
// 统一 state=3 后：静止 = 拖动 = 缩放，观感绝对一致；背后内容弱模糊可见；拖动性能与
// 不透明窗口持平（实测 11.5px 滞后 vs state4 的 15.3px），拖动/缩放降级切换随之取消，
// 也不再需要降级恢复兜底（自愈看门狗保留，防 DWM 丢策略）。
// 想要高质量 acrylic 观感：NAVI_ACCENT_STATE=4 启动（拖动滞后且停下后背后细节不可见）。
let effectsOff = false;   // 兼容保留：旧降级机制开关，恒为 false

function beginDragEffects(why) {
  // 全程 state=3，拖动/缩放无需任何切换（保留空函数以免改动全部调用点）
}

function endDragEffects(why) {
}

// acrylic 自愈看门狗：DWM 偶发会丢掉第三方窗口的 accent 策略（表现：毛玻璃突然消失、
// 透明窗口直接透出锐利桌面），且无法主动查询当前状态。每 2s 幂等重贴一次策略
// （同一参数重复设置对 DWM 是 no-op，开销可忽略），丢了能在 2s 内自动恢复。
let watchdogTick = 0;
setInterval(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const s = settings();
  if (s.theme === 'glass') {
    applyAcrylic(mainWindow, true, s.glassTint, true);
    if (process.env.NAVI_DEBUG_EVENTS && (++watchdogTick % 5 === 0)) {
      logLine('[perf] watchdog reapply #' + watchdogTick);
    }
  }
}, 2000);

// ---------- 窗口 ----------
// 窗口始终 transparent:true：毛玻璃主题靠它透视+系统模糊；浅白/暗黑主题页面自身画不透明底色，
// 观感不变但保留了「设置里预览毛玻璃主题」等场景的正确表现。
// （GPU 合成开启时透明窗口的拖动开销可忽略；软件渲染下由拖动降级兜底。）
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')  // 打包后由 electron-builder 放进 resources
      : path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  attachWindowHooks(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function attachWindowHooks(win) {
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    logLine('[renderer] ' + message + ' ' + sourceId + ':' + line);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    logLine('[renderer-gone] ' + JSON.stringify(details));
    // 启动初期就崩（多半是 GPU 驱动/沙箱问题）→ 自动切软件渲染重启一次，避免用户看到白屏
    if (details.reason === 'crashed' && !NO_GPU && Date.now() - startedAt < 20000) {
      logLine('[gpu] 渲染进程异常，自动改用软件渲染重启 ' + (NO_GPU ? '' : '(一次)'));
      app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--no-gpu').concat('--no-gpu') });
      app.exit(0);
    }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logLine('[did-fail-load] ' + code + ' ' + desc + ' ' + url);
  });
  win.webContents.on('did-finish-load', () => {
    logLine('[did-finish-load] ' + path.join(__dirname, 'renderer', 'index.html'));
    // 按保存的主题启用/关闭系统级毛玻璃，并告知渲染层是否生效（失败则回退内置壁纸）
    const s = settings();
    const ok = s.theme === 'glass' ? applyAcrylic(win, true, s.glassTint) : applyAcrylic(win, false, 0);
    win.webContents.send('glass:acrylic', s.theme === 'glass' && ok);
  });
  // 拖动 / 缩放：进入降级模式（关 acrylic），松开鼠标自动恢复（仅 glass 主题有意义）
  ['will-move', 'move', 'will-resize', 'resize'].forEach(ev => {
    try { win.on(ev, () => beginDragEffects(ev)); } catch {}
  });
  ['moved', 'resized'].forEach(ev => {
    try { win.on(ev, () => setTimeout(() => endDragEffects(ev), 80)); } catch {}
  });
  // 最大化/还原/全屏后 DWM 属性可能被重置，重贴一次
  ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'].forEach(ev => {
    try {
      win.on(ev, () => setTimeout(() => {
        if (settings().theme === 'glass') applyAcrylic(win, true, settings().glassTint, true);
      }, 150));
    } catch {}
  });
  setupDebugProbes();
}

// 调试探针（NAVI_DEBUG_FPS / NAVI_DEBUG_MARKER / NAVI_DEBUG_SHOT），did-finish-load 后挂载
function setupDebugProbes() {
  // 调试：NAVI_DEBUG_FPS=1 时在渲染层跑一个持续重绘的 rAF 循环并每秒打印帧率
  // （用于量化「拖动窗口时渲染是否跟得上」）
  if (process.env.NAVI_DEBUG_FPS) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(`
          (() => {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;left:0;top:0;width:3px;height:3px;z-index:99999;pointer-events:none';
            document.body.appendChild(el);
            let n = 0, last = performance.now();
            (function loop(t) {
              n++;
              el.style.transform = 'translateX(' + (n % 2) + 'px)';   // 每帧都产生新绘制
              if (t - last >= 1000) { console.log('FPS ' + n); n = 0; last = t; }
              requestAnimationFrame(loop);
            })(last);
            return 'fps-probe-started';
          })()
        `).then(r => logLine('[debug] ' + r)).catch(e => logLine('[debug] fps probe failed: ' + e.message));
      }, 1500);
    });
  }

  // 调试：NAVI_DEBUG_MARKER=1 时在页面左上角画一个纯品红方块，并在 0-200px 间循环平移
  // （外部截屏工具据此判断：①渲染出来的窗口位置 ②拖动时画面是否还在刷新）
  if (process.env.NAVI_DEBUG_MARKER) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(`
          (() => {
            const m = document.createElement('div');
            m.id = '__perf_marker';
            m.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;background:#ff00ff;z-index:2147483647;pointer-events:none';
            document.body.appendChild(m);
            let n = 0;
            (function loop() { n += 2; m.style.left = (n % 200) + 'px'; requestAnimationFrame(loop); })();
            return 'marker-added';
          })()
        `).then(r => logLine('[debug] ' + r)).catch(e => logLine('[debug] marker failed: ' + e.message));
      }, 1200);
    });
  }

  // 调试/测试：NAVI_TEST_JS=「渲染层 JS」时，启动 3s 后在页面里执行并打印结果到 run.log
  // 读取后立刻从环境变量移除：app.relaunch() 重启会继承 env，避免测试脚本在新实例里重放
  // 注：以下注入/调试钩子仅在未打包（开发）时生效，发行版忽略同名环境变量
  if (!app.isPackaged && process.env.NAVI_TEST_JS) {
    const testJs = process.env.NAVI_TEST_JS;
    delete process.env.NAVI_TEST_JS;
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const r = await mainWindow.webContents.executeJavaScript(testJs);
          logLine('[test] ' + r);
        } catch (e) { logLine('[test] failed: ' + e.message); }
      }, 3000);
    });
  }

  // 调试：NAVI_DEBUG_SHOT=1 时启动后自动截屏保存（验证渲染是否正常）
  // 可用 NAVI_DEBUG_SECTION=network 等指定打开某个设置面板
  if (!app.isPackaged && process.env.NAVI_DEBUG_SHOT) {
    mainWindow.webContents.once('did-finish-load', async () => {
      setTimeout(async () => {
        try {
          const sec = process.env.NAVI_DEBUG_SECTION;
          const theme = process.env.NAVI_DEBUG_THEME;
          if (theme) {
            await mainWindow.webContents.executeJavaScript(
              `const _t=document.body.dataset.theme; applyTheme('${theme}'); window._restoreTheme=_t; 'ok'`
            );
            logLine('[debug] temp theme: ' + theme);
          }
          if (sec) {
            const r = await mainWindow.webContents.executeJavaScript(
              `openSettings(); currentSection='${sec}'; renderSettingsNav(); renderSettingsSection(); 'ok'`
            );
            logLine('[debug] openSettings result: ' + r);
          }
          await new Promise(res => setTimeout(res, 800));
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'screen.png'), img.toPNG());
          logLine('[debug] screenshot saved');
        } catch (e) { logLine('[debug] screenshot failed: ' + e.message); }
      }, 2500);
    });
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'cover', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'wallpaper', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// 封面/资产协议：cover://local/<绝对路径>（视频文件夹内的资产）或 cover://<文件名>（旧中央缓存）
function registerCoverProtocol() {
  const serve = async (file) => {
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/jpeg';
    const data = await fsp.readFile(file);
    return new Response(data, { headers: { 'content-type': mime } });
  };
  protocol.handle('cover', async (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname === 'local') {
        const abs = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
        return await serve(abs);
      }
      const name = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
      return await serve(path.join(coversDir(), path.basename(name)));
    } catch {
      return new Response('', { status: 404 });
    }
  });
}

// 自定义壁纸协议 wallpaper://light.jpg
function registerWallpaperProtocol() {
  protocol.handle('wallpaper', async (request) => {
    try {
      const u = new URL(request.url);
      const name = path.basename(decodeURIComponent(u.hostname + u.pathname));
      const file = path.join(wallpapersDir(), name);
      const ext = path.extname(file).toLowerCase();
      const mime = { '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/jpeg';
      const data = await fsp.readFile(file);
      return new Response(data, { headers: { 'content-type': mime } });
    } catch {
      return new Response('', { status: 404 });
    }
  });
}

// ---------- 后台自动刮削 ----------
let autoScrapeRunning = false;
let scrapeProgress = { running: false, done: 0, total: 0, title: '' };

function pushProgress(patch) {
  Object.assign(scrapeProgress, patch);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scrape:progress', { ...scrapeProgress });
  }
}

async function autoScrapeQueue(newItems) {
  if (autoScrapeRunning) return;
  autoScrapeRunning = true;
  let done = 0;
  const total = newItems.length;
  pushProgress({ running: true, done: 0, total, title: '准备中...' });
  try {
    const db = loadDb();
    const settings = loadSettings();
    const byPath = new Map(db.items.map(i => [i.path, i]));
    for (const fresh of newItems) {
      let item = byPath.get(fresh.path) || loadDb().items.find(i => i.path === fresh.path || i.movedFrom === fresh.path);
      pushProgress({ done, total, title: (item && (item.code || item.title)) || fresh.name || '' });
      if (!item || item.status !== 'pending' || !item.code) { done++; continue; }
      try {
        const cands = await scraper.searchCandidates(item.code, settings.scrape);
        if (cands.length > 0) {
          const updated = await applyCandidate(item, cands[0]);
          updateAndPush(updated);
          byPath.set(updated.path, updated);
        } else {
          item.status = 'failed';
          item.error = '未找到匹配条目';
          logLine('[scrape] 失败(无结果): ' + (item.code || item.name));
          updateAndPush(item);
        }
      } catch (e) {
        item.status = 'failed';
        item.error = String(e.message || e);
        logLine('[scrape] 失败: ' + (item.code || item.name) + ' — ' + item.error);
        updateAndPush(item);
      }
      done++;
      pushProgress({ done, total });
      await new Promise(r => setTimeout(r, 800)); // 温和限速
    }
  } finally {
    autoScrapeRunning = false;
    pushProgress({ running: false, done, total, title: '' });
  }
}

async function applyCandidate(item, cand) {
  const conf = loadSettings().scrape || {};
  item.code = cand.code || item.code;
  item.title = cand.title || item.title;
  item.date = cand.date || item.date || '';
  item.actresses = cand.actresses || [];
  if (cand.tags && cand.tags.length) item.tags = cand.tags;
  if (cand.duration) item.duration = cand.duration;
  if (cand.director) item.director = cand.director;
  if (cand.studio) item.studio = cand.studio;
  if (cand.publisher) item.publisher = cand.publisher;
  item.detailUrl = cand.detailUrl || '';
  item.provider = cand.provider || '';
  item.status = 'manual';
  // 资产目录：刮削结果存到视频所在文件夹（必要时新建同名文件夹并把视频移入）
  let dir = null;
  const oldPath = item.path;
  if (conf.archiveToFolder !== false) {
    try { dir = await ensureAssetsDir(item); }
    catch (e) { logLine('[archive] 建立资产目录失败，回退中央缓存: ' + e.message); dir = null; }
  }
  if (item.path !== oldPath) item.movedFrom = oldPath;
  const imgDir = dir || coversDir();
  const base = dir ? ASSET_COVER : safeName(item.code || item.name);
  if (cand.coverUrl) {
    try {
      const name = await scraper.downloadImage(cand.coverUrl, imgDir, base);
      item.cover = dir ? fileUrl(path.join(dir, name)) : 'cover://' + name;
    } catch {
      item.cover = cand.coverUrl; // 退化为远程直链
    }
  } else if (cand.cover) {
    item.cover = cand.cover;
  }
  // 预览截图：并行下载（最多 10 张），单张失败/为站方占位图则跳过，不影响整体
  if (Array.isArray(cand.previews) && cand.previews.length) {
    const jobs = cand.previews.slice(0, 10).map((pv, i) => {
      const nm = dir ? ASSET_FANART + '-' + String(i + 1).padStart(2, '0') : safeName(item.code || item.name) + '-pv' + String(i + 1).padStart(2, '0');
      return scraper.downloadPreview(pv, imgDir, nm)
        .then(f => (f ? (dir ? fileUrl(path.join(dir, f)) : 'cover://' + f) : null))
        .catch(() => null);
    });
    const got = (await Promise.all(jobs)).filter(Boolean);
    if (got.length) item.previews = got;
  }
  if (cand.synopsis) item.synopsis = cand.synopsis;
  // 演员 别名（英文/日文名）：语言版详情页按 star id 对齐，best-effort 不阻塞刮削主流程
  // （FC2 系列站点没有 JavBus 那种多语言详情页，跳过以免无谓请求）
  const isFc2Provider = String(item.provider || '').startsWith('fc2');
  if (!isFc2Provider && Array.isArray(item.actresses) && item.actresses.length && (item.detailUrl || cand.detailUrl)) {
    try {
      const alias = await scraper.fetchActressAliases(item.detailUrl || cand.detailUrl, cand.starMap, conf);
      if (alias) item.actressAlias = { ...(item.actressAlias || {}), ...alias };
    } catch {}
  }
  if (dir) {
    await writeMetadata(item, dir);
    // Emby 兼容输出（可选）：开启则补写 movie.nfo / poster / backdropN，关闭则清掉遗留文件
    if (conf.embyCompat) await writeEmbyAssets(item, dir);
    else await clearEmbyAssets(dir);
  }
  return item;
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'cover';
}

// ---------- 刮削目录 + 新文件监测 ----------
let watchers = new Map();     // dir → FSWatcher
let watchTimers = new Map();  // dir → debounce timer

function stopWatchers() {
  for (const w of watchers.values()) { try { w.close(); } catch {} }
  watchers.clear();
  for (const t of watchTimers.values()) clearTimeout(t);
  watchTimers.clear();
}

function startWatchers() {
  stopWatchers();
  const s = loadSettings();
  for (const d of (s.dirs || [])) {
    if (d && d.watch && d.path && fs.existsSync(d.path)) watchDir(d.path);
  }
  logLine('[watch] 已监测目录: ' + [...watchers.keys()].join(' | ') || '[watch] 无监测目录');
}

function watchDir(dir) {
  if (watchers.has(dir)) return;
  try {
    const w = fs.watch(dir, { recursive: true }, () => scheduleWatchScan(dir));
    watchers.set(dir, w);
    logLine('[watch] 开始监测: ' + dir);
  } catch (e) {
    logLine('[watch] 监测失败 ' + dir + ': ' + e.message);
  }
}

function scheduleWatchScan(dir) {
  if (watchTimers.has(dir)) clearTimeout(watchTimers.get(dir));
  watchTimers.set(dir, setTimeout(() => {
    watchTimers.delete(dir);
    importFolder(dir).then(r => {
      if (r.added) {
        logLine('[watch] 监测到新文件 ' + r.added + ' 个（' + dir + '）');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('library:changed', { added: r.added });
        }
      }
    }).catch(() => {});
  }, 2000));   // 等文件拷贝完成再扫，避免读到半截文件
}

// 把同目录 metadata.json 里的刮削成果填进新条目（重扫/重建库用）
// 覆盖掉「只有番号+文件名」的初始值，并把状态置为 manual，
// 这样自动刮削队列会跳过它（不会把已经刮好的资料再刮一遍）。
function applySidecar(item, side) {
  const m = side.meta || {};
  const txt = (v) => (v === undefined || v === null ? '' : String(v));
  if (m.code) item.code = txt(m.code).trim();
  if (m.title) item.title = txt(m.title).trim();
  if (!item.code && !String(item.title || '').trim()) item.title = item.name.replace(/\.[^.]+$/, '');
  item.date = txt(m.date);
  item.actresses = Array.isArray(m.actresses) ? m.actresses : [];
  item.actressAlias = (m.actressAlias && typeof m.actressAlias === 'object') ? m.actressAlias : {};
  item.tags = Array.isArray(m.tags) ? m.tags : [];
  item.category = txt(m.category);
  item.synopsis = txt(m.synopsis);
  item.rating = Number(m.rating) || 0;
  item.duration = m.duration || '';
  item.director = txt(m.director);
  item.studio = txt(m.studio);
  item.publisher = txt(m.publisher);
  item.detailUrl = txt(m.detailUrl);
  item.provider = txt(m.provider);
  item.dir = side.dir;
  // 图片一律用绝对路径引用（cover://local/…），文件不存在就不设，避免黑图
  if (side.coverName) item.cover = fileUrl(path.join(side.dir, side.coverName));
  if (side.previews && side.previews.length) {
    item.previews = side.previews.map(f => fileUrl(path.join(side.dir, f)));
  }
  item.status = item.code ? 'manual' : 'none';
  item.restoredAt = new Date().toISOString();
}

// 扫描目录并入库（含自动刮削），返回新增条目
async function importFolder(folder) {
  const files = await scanFolder(folder);
  const db = loadDb();
  const known = new Set(db.items.map(i => i.path));
  // 回收站里的影片不重新入库（文件仍在硬盘原位，等用户在回收站里做最终处理）
  const trashed = new Set((db.trash || []).map(t => path.normalize(t.item && t.item.path || '')));
  const fresh = [], restored = [];
  for (const f of files) {
    if (known.has(f.path) || trashed.has(path.normalize(f.path))) continue;
    const item = {
      path: f.path,
      name: f.name,
      size: f.size,
      mtime: f.mtime,
      code: parseCode(f.name),
      title: f.name.replace(/\.[^.]+$/, ''),
      cover: '',
      actresses: [],
      tags: [],
      date: '',
      status: 'pending',   // pending → manual(已刮) / failed / none(无番号)
      rating: 0
    };
    if (!item.code) item.status = 'none';
    // 同目录已有 metadata.json（之前刮过 / 从别处搬来的资产）→ 直接读回来，不重复刮削
    try {
      const side = await readSidecarMeta(f.path);
      if (side) {
        // 资产在「同级同名子目录」里、视频还留在外面 → 顺手把视频移进去（与刮削归档规则一致）
        if (path.normalize(side.dir) !== path.normalize(path.dirname(item.path))) {
          try { await ensureAssetsDir(item); }
          catch (e) { logLine('[restore] 视频归位失败 ' + f.path + ': ' + e.message); }
        }
        applySidecar(item, side);
        restored.push(item);
      }
    } catch (e) { logLine('[restore] 读取 metadata 失败 ' + f.path + ': ' + e.message); }
    db.items.push(item);
    fresh.push(item);
  }
  saveDb(db);
  if (restored.length) logLine('[restore] 从 metadata.json 恢复 ' + restored.length + ' 条已有刮削结果');
  // 已经有刮削结果的条目（status=manual）会被队列自动跳过，只处理真正没刮过的
  if (fresh.length && loadSettings().scrape.autoScrape) {
    autoScrapeQueue(fresh); // 后台执行，不阻塞
  }
  return { added: fresh.length, total: db.items.length, fresh, restored: restored.length };
}

function updateAndPush(item) {
  const db = loadDb();
  // 刮削归档时视频被移入新建文件夹，路径变了：先清掉旧路径的记录，避免重复
  if (item.movedFrom) {
    db.items = db.items.filter(i => i.path !== item.movedFrom);
  }
  const idx = db.items.findIndex(i => i.path === item.path);
  if (idx >= 0) db.items[idx] = item;
  else db.items.push(item);
  saveDb(db);
  rememberTags([item]);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('item:update', item);
  }
}

// 记住条目用过的分类标签（供详情页「分类」下拉选择），去重、上限 300
function rememberTags(items) {
  try {
    const s = loadSettings();
    const known = new Set(s.knownTags || []);
    let changed = false;
    for (const it of items) {
      for (const t of (it.tags || [])) {
        if (t && !known.has(t)) { known.add(t); changed = true; }
      }
    }
    if (changed) {
      s.knownTags = [...known].slice(-300);
      saveSettings(s);
    }
  } catch {}
}

// ---------- IPC ----------
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow.close());

ipcMain.handle('dialog:selectFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:selectPlayer', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择播放器 exe',
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe', 'mpv', 'app', 'desktop'] }, { name: '所有文件', extensions: ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:selectImage', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择壁纸图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

// 壁纸：复制进数据目录，返回 wallpaper:// 地址
ipcMain.handle('wallpaper:set', async (e, { theme, src }) => {
  await fsp.mkdir(wallpapersDir(), { recursive: true });
  const ext = (path.extname(src) || '.jpg').toLowerCase();
  const dest = path.join(wallpapersDir(), theme + ext);
  await fsp.copyFile(src, dest);
  return 'wallpaper://' + theme + ext;
});

ipcMain.handle('wallpaper:reset', async (e, { theme }) => {
  try {
    const files = await fsp.readdir(wallpapersDir());
    for (const f of files) {
      if (f.startsWith(theme + '.')) await fsp.rm(path.join(wallpapersDir(), f), { force: true });
    }
  } catch {}
  return '';
});

ipcMain.handle('scan:folder', async (e, folder) => {
  // 手动拖入文件夹：登记为刮削目录（默认开启监测）后扫描
  if (folder) {
    const s = loadSettings();
    s.dirs = s.dirs || [];
    if (!s.dirs.some(d => path.resolve(d.path) === path.resolve(folder))) {
      s.dirs.push({ path: folder, watch: true });
      saveSettings(s);
      startWatchers();
    }
  }
  return await importFolder(folder);
});

// ---------- 刮削目录管理 ----------
ipcMain.handle('dirs:list', () => loadSettings().dirs || []);

ipcMain.handle('dirs:add', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择刮削目录（影片所在文件夹）',
    properties: ['openDirectory', 'multiSelections']
  });
  if (r.canceled || !r.filePaths.length) return { added: 0, dirs: loadSettings().dirs || [] };
  const s = loadSettings();
  s.dirs = s.dirs || [];
  let added = 0;
  for (const p of r.filePaths) {
    if (!s.dirs.some(d => path.resolve(d.path) === path.resolve(p))) {
      s.dirs.push({ path: p, watch: true });
      added++;
    }
  }
  saveSettings(s);
  startWatchers();
  return { added, dirs: s.dirs };
});

ipcMain.handle('dirs:remove', (e, dirPath) => {
  const s = loadSettings();
  s.dirs = (s.dirs || []).filter(d => path.resolve(d.path) !== path.resolve(dirPath));
  saveSettings(s);
  startWatchers();
  return s.dirs;
});

ipcMain.handle('dirs:setWatch', (e, { dirPath, watch }) => {
  const s = loadSettings();
  for (const d of (s.dirs || [])) {
    if (path.resolve(d.path) === path.resolve(dirPath)) d.watch = !!watch;
  }
  saveSettings(s);
  startWatchers();
  return s.dirs;
});

// 扫描全部已登记目录（新文件入库 + 自动刮削）
ipcMain.handle('dirs:scanAll', async () => {
  const s = loadSettings();
  let added = 0, failed = [];
  for (const d of (s.dirs || [])) {
    if (!fs.existsSync(d.path)) { failed.push(d.path); continue; }
    try {
      const r = await importFolder(d.path);
      added += r.added;
    } catch (err) { failed.push(d.path); }
  }
  const db = loadDb();
  return { added, total: db.items.length, failed };
});

ipcMain.handle('library:load', () => {
  return { ...loadDb(), settings: loadSettings(), dataDir: dataDir() };
});

ipcMain.handle('library:saveItems', (e, items) => {
  const db = loadDb();
  const before = new Map(db.items.map(i => [i.path, i]));
  const map = new Map(before);
  for (const it of items) map.set(it.path, it);
  db.items = [...map.values()];
  saveDb(db);
  rememberTags(items);
  // Emby 兼容：条目被编辑过（标题/演员/标签等）→ 同步重写 movie.nfo
  if ((loadSettings().scrape || {}).embyCompat) {
    for (const it of (items || [])) {
      const o = before.get(it.path);
      if (o && JSON.stringify(o) === JSON.stringify(it)) continue;
      refreshNfoOnly(it).catch(() => {});
    }
  }
  return true;
});

// 删除影片：条目进软件回收站（记录快照，文件暂不动），主界面不再显示；
// 扫描/监测会跳过回收站里的路径。最终处理在回收站视图里进行：
//   trash:purgeData  — 仅清除软件内记录（文件不动，若仍在扫描目录内会重新入库 ≈ 恢复）
//   trash:purgeFiles — 视频 + 刮削资产移入系统回收站，并清除记录
function trashTargets(item, videoPath) {
  // 统一成 Windows 原生分隔符：混合正斜杠会让回收站 API 报 "Failed to parse path"
  videoPath = path.normalize(String(videoPath || ''));
  const parent = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const ownFolder = path.basename(parent).toLowerCase() === stem.toLowerCase();
  const assetDir = path.normalize((item && item.dir) || path.join(parent, stem));
  const targets = [];
  if (ownFolder) {
    if (fs.existsSync(parent)) targets.push({ p: parent, desc: '影片文件夹（视频+刮削数据）' });
  } else {
    if (fs.existsSync(videoPath)) targets.push({ p: videoPath, desc: '视频文件' });
    if (fs.existsSync(assetDir)) targets.push({ p: assetDir, desc: '刮削数据文件夹' });
  }
  return targets;
}

ipcMain.handle('media:delete', async (e, rawPath) => {
  const videoPath = path.normalize(String(rawPath || ''));
  const db = loadDb();
  const idx = db.items.findIndex(i => path.normalize(i.path) === videoPath);
  if (idx < 0) return { ok: false, errors: ['库中找不到该影片：' + videoPath] };
  const item = db.items[idx];
  db.items.splice(idx, 1);
  db.trash = db.trash || [];
  // 同一路径重复删除时只保留最新一条快照
  db.trash = db.trash.filter(t => path.normalize((t.item && t.item.path) || '') !== videoPath);
  db.trash.unshift({ item, trashedAt: new Date().toISOString() });
  saveDb(db);
  logLine('[delete] 进软件回收站: ' + videoPath + '（文件暂保留在硬盘原位）');
  return { ok: true, item };
});

ipcMain.handle('trash:list', () => loadDb().trash || []);

// 仅清除记录：文件不动。若视频仍在扫描目录内，下次扫描会重新入库（≈ 恢复）
ipcMain.handle('trash:purgeData', (e, rawPath) => {
  const videoPath = path.normalize(String(rawPath || ''));
  const db = loadDb();
  const before = (db.trash || []).length;
  db.trash = (db.trash || []).filter(t => path.normalize((t.item && t.item.path) || '') !== videoPath);
  saveDb(db);
  return { ok: true, removed: before - db.trash.length };
});

// 彻底删除：视频 + 刮削数据移入系统回收站（可从系统回收站找回），再清除记录
ipcMain.handle('trash:purgeFiles', async (e, rawPath) => {
  const videoPath = path.normalize(String(rawPath || ''));
  const db = loadDb();
  const tIdx = (db.trash || []).findIndex(t => path.normalize((t.item && t.item.path) || '') === videoPath);
  if (tIdx < 0) return { ok: false, errors: ['回收站中找不到该记录'] };
  const targets = trashTargets(db.trash[tIdx].item, videoPath);
  const done = [], errors = [];
  for (const t of targets) {
    try { await shell.trashItem(t.p); done.push(t.p); }
    catch (err) {
      // Windows 上 trashItem 常常在文件已成功移入回收站后仍抛 "Operation was aborted"，
      // 因此以磁盘实际状态为准：路径不存在即视为成功。
      if (!fs.existsSync(t.p)) {
        done.push(t.p);
        logLine('[trash] trashItem 报错但文件已移入回收站: ' + t.p + ' (' + (err.message || err) + ')');
      } else {
        errors.push(t.p + '：' + (err.message || err));
      }
    }
  }
  if (errors.length === 0) {
    db.trash.splice(tIdx, 1);
    saveDb(db);
  }
  logLine('[trash] 删除硬盘源文件 候选=' + targets.length + ' 成功=' + done.length +
    (done.length ? ' → ' + done.join(' | ') : '（文件不存在，仅清理记录）') +
    (errors.length ? ' 失败: ' + errors.join(' | ') : ''));
  return { ok: errors.length === 0, trashed: done, errors };
});

ipcMain.handle('settings:save', async (e, s) => {
  // knownTags 做并集合并：渲染层持有的是打开时的旧快照，直接覆盖会丢掉主进程新记住的标签
  const cur = loadSettings();
  s.knownTags = [...new Set([...(s.knownTags || []), ...(cur.knownTags || [])])].slice(-300);
  saveSettings(s);
  await applyProxyConfig(s.network);
  return true;
});

// 毛玻璃实时调节：主题切换/滑块拖动时调用。
// 必须把结果推回渲染层：运行中切到 glass 主题时 did-finish-load 的那次通知早已发过（false），
// 渲染层若不知道 acrylic 已生效，会一直显示不透明的回退壁纸，看起来就是"没有毛玻璃效果"。
ipcMain.handle('glass:setTint', (e, { enabled, tint }) => {
  const ok = applyAcrylic(mainWindow, !!enabled, enabled ? tint : 0);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('glass:acrylic', !!enabled && ok);
  }
  return ok;
});

// 网络测试：先临时应用传入的代理配置再测，测完恢复已保存配置
ipcMain.handle('net:test', async (e, { url, proxy }) => {
  await applyProxyConfig(proxy || loadSettings().network);
  const t0 = Date.now();
  try {
    const res = await net.fetch(url, { method: 'GET', headers: { 'User-Agent': UA_X() } });
    const ms = Date.now() - t0;
    await applyProxyConfig(loadSettings().network);
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    await applyProxyConfig(loadSettings().network);
    return { ok: false, error: String(err.message || err), ms: Date.now() - t0 };
  }
});

function UA_X() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0';
}

// ---------- 浏览器兜底抓取（Cloudflare 挑战页用） ----------
// 普通网络请求拿不到正文（403/挑战页）时，用隐藏窗口加载页面：
// 真实 Chromium 能执行站点 JS，Cloudflare 的 JS 挑战通常会自动放行。
let auxBrowser = null;
function getAuxBrowser() {
  if (auxBrowser && !auxBrowser.isDestroyed()) return auxBrowser;
  auxBrowser = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: true, sandbox: true, contextIsolation: true,
      nodeIntegration: false, images: false   // 只要 HTML，不加载图片省流量
    }
  });
  return auxBrowser;
}
async function browserFetchText(url, timeout = 35000) {
  const win = getAuxBrowser();
  const loadP = win.loadURL(url, { userAgent: UA_X() });
  await Promise.race([loadP.catch(() => {}), new Promise(r => setTimeout(r, timeout))]);
  const deadline = Date.now() + Math.max(5000, timeout);
  while (Date.now() < deadline) {
    const info = await win.webContents.executeJavaScript(
      '({t: document.title, len: document.documentElement ? document.documentElement.outerHTML.length : 0})'
    ).catch(() => null);
    // Cloudflare 挑战页标题是 "Just a moment..."，放行后变成站点标题且内容足够长
    if (info && info.len > 3000 && !/just a moment|请稍候|attention required/i.test(info.t || '')) {
      // 站点自身故障页（如 CF Error 526/52x）也要当作失败，让兜底链继续走下一个源
      if (/error code \d{3}|invalid ssl|bad gateway|service unavailable/i.test(info.t || '')) {
        throw new Error('站点故障页: ' + info.t);
      }
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
      logLine('[scrape] browser-fetch 命中: ' + url.slice(0, 90));
      return html;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error('浏览器加载超时或仍被拦截: ' + url.slice(0, 90));
}

ipcMain.handle('privacy:clearCovers', async () => {
  let count = 0;
  // 中央缓存
  try {
    const files = await fsp.readdir(coversDir());
    for (const f of files) { await fsp.rm(path.join(coversDir(), f), { force: true }); count++; }
  } catch {}
  // 视频文件夹里的刮削资产（cover.* / fanart-*，保留 metadata.json）
  const db = loadDb();
  for (const it of db.items) {
    if (!it.dir || !fs.existsSync(it.dir)) continue;
    try {
      for (const f of await fsp.readdir(it.dir)) {
        if (isEmbyAssetFile(f) || /^(cover\.(jpe?g|png|webp)|fanart-.*\.(jpe?g|png|webp))$/i.test(f)) {
          await fsp.rm(path.join(it.dir, f), { force: true });
          count++;
        }
      }
    } catch {}
    it.cover = '';
    it.previews = [];
  }
  saveDb(db);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed', { cleared: true });
  return count;
});

ipcMain.handle('library:clearAll', () => {
  saveDb({ items: [] });
  return true;
});

// ---------- 启动密码锁 ----------
// 密码只在主进程校验（sha256(salt::password)），渲染层拿不到哈希原文
const hashPassword = (salt, pw) =>
  crypto.createHash('sha256').update(salt + '::' + String(pw || ''), 'utf8').digest('hex');

ipcMain.handle('lock:setPassword', (e, pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(salt, pw);
  const s = loadSettings();
  s.lock = { enabled: true, salt, hash };
  writeJson(settingsFile(), s);
  return { salt, hash };
});

ipcMain.handle('lock:clear', () => {
  const s = loadSettings();
  s.lock = { enabled: false, salt: '', hash: '' };
  writeJson(settingsFile(), s);
  return true;
});

ipcMain.handle('lock:verify', (e, pw) => {
  const s = loadSettings();
  if (!s.lock || !s.lock.enabled || !s.lock.hash) return true;
  try {
    const h = Buffer.from(hashPassword(s.lock.salt, pw));
    const ref = Buffer.from(s.lock.hash);
    return h.length === ref.length && crypto.timingSafeEqual(h, ref);
  } catch { return false; }
});

// 设置保存后需要重启生效的场景（如开启密码锁）
ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

// 移除某目录下的全部库记录（文件不动）
ipcMain.handle('library:removeByPrefix', (e, prefix) => {
  const db = loadDb();
  const p = String(prefix || '').replace(/[\\/]+$/, '').toLowerCase();
  const before = db.items.length;
  db.items = db.items.filter(i => {
    const v = String(i.path || '').toLowerCase();
    return !(v.startsWith(p + '\\') || v.startsWith(p + '/'));
  });
  saveDb(db);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed', { removed: before - db.items.length });
  return { removed: before - db.items.length };
});

ipcMain.handle('player:open', async (e, filePath, playerPath) => {
  if (playerPath && fs.existsSync(playerPath)) {
    const child = spawn(playerPath, [filePath], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, via: playerPath };
  }
  const r = await shell.openPath(filePath);
  return { ok: !r, via: 'default', error: r };
});

ipcMain.handle('shell:open', (e, p) => { shell.openPath(p); return true; });

// 资源管理器中打开并选中文件（右键菜单「打开文件位置」）
ipcMain.handle('shell:showItem', (e, p) => { shell.showItemInFolder(p); return true; });

// 侧栏运行状态：汇总本应用所有进程的 CPU 占用与内存（渲染层 2s 轮询）
ipcMain.handle('sys:usage', () => {
  let cpu = 0, memKB = 0;
  for (const m of app.getAppMetrics()) {
    cpu += m.cpu ? m.cpu.percentCPUUsage : 0;
    memKB += m.memory ? m.memory.workingSetSize : 0;
  }
  return { cpu: Math.max(0, cpu), memMB: Math.round(memKB / 1024) };
});

ipcMain.handle('scrape:search', async (e, { code }) => {
  const settings = loadSettings();
  const cands = await scraper.searchCandidates(code, settings.scrape);
  return cands;
});

ipcMain.handle('scrape:apply', async (e, { item, candidate }) => {
  const updated = await applyCandidate(item, candidate);
  updateAndPush(updated);
  return updated;
});

// 详情页主动刷新演员别名（老条目刮削时还没有此功能，打开详情时 best-effort 补一次）
ipcMain.handle('scrape:alias', async (e, item) => {
  try {
    const alias = await scraper.fetchActressAliases(item.detailUrl, null, loadSettings().scrape);
    if (alias) {
      item.actressAlias = { ...(item.actressAlias || {}), ...alias };
      updateAndPush(item);
      return item;
    }
  } catch {}
  return null;
});

// 为库里已刮削的影片批量补写 Emby 兼容文件（movie.nfo / poster.* / backdropN.*）
ipcMain.handle('scrape:embyExport', async () => {
  const db = loadDb();
  let ok = 0, fail = 0, skip = 0;
  for (const it of db.items) {
    const dir = it.dir && fs.existsSync(it.dir) ? it.dir
      : (it.path && fs.existsSync(it.path) ? path.dirname(it.path) : null);
    // 只处理归档过刮削结果的条目（有 metadata.json），避免写出空 NFO
    if (!dir || !fs.existsSync(path.join(dir, ASSET_META))) { skip++; continue; }
    if (await writeEmbyAssets(it, dir)) ok++; else fail++;
  }
  logLine('[emby] 批量补写完成: ok=' + ok + ' fail=' + fail + ' skip=' + skip);
  return { ok, fail, skip, total: db.items.length };
});

// ---------- 用户手动添加图片 ----------
ipcMain.handle('dialog:pickImages', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择要添加的图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

// 读取本地图片为 dataURL（渲染层无文件权限，裁切要在渲染层 canvas 做）
ipcMain.handle('image:dataUrl', async (e, p) => {
  const buf = await fsp.readFile(p);
  const ext = (path.extname(p) || '.jpg').toLowerCase();
  const mime = { '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/jpeg';
  return `data:${mime};base64,` + buf.toString('base64');
});

// 保存用户裁切后的图片（dataURL）：
//  - 给了 itemPath → 存到该视频的资产文件夹（fanart-userNN.jpg，避免与刮削图重名）
//  - 否则退回旧的中央缓存目录（user01/user02...）
ipcMain.handle('image:saveUser', async (e, { itemPath, base, dataUrl }) => {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('无效的图片数据');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if (itemPath) {
    const dir = await assetDirForPath(itemPath);
    let n = 1;
    while (fs.existsSync(path.join(dir, `fanart-user${String(n).padStart(2, '0')}.${ext}`))) n++;
    const fileName = `fanart-user${String(n).padStart(2, '0')}.${ext}`;
    await fsp.writeFile(path.join(dir, fileName), Buffer.from(m[2], 'base64'));
    // 手动加图后同步 Emby 背景图（开启兼容输出时）
    const it = findItemByPath(itemPath);
    if (it && (loadSettings().scrape || {}).embyCompat) await writeEmbyAssets(it, dir);
    return fileUrl(path.join(dir, fileName));
  }
  const dir = coversDir();
  await fsp.mkdir(dir, { recursive: true });
  let n = 1;
  while (fs.existsSync(path.join(dir, `${base}-user${String(n).padStart(2, '0')}.${ext}`))) n++;
  const fileName = `${base}-user${String(n).padStart(2, '0')}.${ext}`;
  await fsp.writeFile(path.join(dir, fileName), Buffer.from(m[2], 'base64'));
  return 'cover://' + fileName;
});

// 保存用户自定义封面（dataURL）：
//  - 给了 itemPath → 存到视频资产文件夹 cover.jpg（覆盖旧的用户封面）
//  - 否则存中央缓存（带时间戳，避免缓存）
ipcMain.handle('image:saveCover', async (e, { itemPath, base, dataUrl }) => {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('无效的图片数据');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if (itemPath) {
    const dir = await assetDirForPath(itemPath);
    const fileName = `cover.${ext}`;
    // 清掉其它扩展名的旧封面，避免同目录多份
    try {
      const old = (await fsp.readdir(dir)).filter(f => /^cover\.(jpe?g|png|webp)$/i.test(f) && f !== fileName);
      for (const f of old) await fsp.unlink(path.join(dir, f)).catch(() => {});
    } catch {}
    await fsp.writeFile(path.join(dir, fileName), Buffer.from(m[2], 'base64'));
    // 换封面后同步 Emby 主图（开启兼容输出时）
    const it = findItemByPath(itemPath);
    if (it && (loadSettings().scrape || {}).embyCompat) await writeEmbyAssets(it, dir);
    return fileUrl(path.join(dir, fileName));
  }
  const dir = coversDir();
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${base}-mycover-${Date.now()}.${ext}`;
  await fsp.writeFile(path.join(dir, fileName), Buffer.from(m[2], 'base64'));
  try {
    const prefix = `${base}-mycover-`;
    for (const f of await fsp.readdir(dir)) {
      if (f.startsWith(prefix) && f !== fileName) await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch {}
  return 'cover://' + fileName;
});

// ---------- 启动 ----------
app.whenReady().then(async () => {
  logLine('[data] 程序数据目录: ' + dataDir());
  ensureDirs();
  // 启动诊断：合成后端决定拖动是否跟手，日志里留一份便于排查
  // 注意：必须在窗口加载完成后查询，过早查询 GPU 进程尚未初始化完，会误报 disabled_software
  setTimeout(async () => {
    try {
      const g = app.getGPUFeatureStatus();
      logLine('[gpu] 合成=' + (g.gpu_compositing || '?') + ' 光栅化=' + (g.rasterization || '?') +
        ' 视频解码=' + (g.video_decode || '?') + ' | ' + (NO_GPU ? '软件渲染(NAVI_NO_GPU)' : '硬件加速'));
      if (!NO_GPU) {
        const r = await mainWindow.webContents.executeJavaScript(`
          (() => { const c = document.createElement('canvas');
            const gl = c.getContext('webgl'); if (!gl) return 'no-webgl';
            const e = gl.getExtension('WEBGL_debug_renderer_info');
            return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()
        `).catch(() => 'n/a');
        logLine('[gpu] 渲染器: ' + r);
      }
    } catch (e) { logLine('[gpu] 状态查询失败: ' + e.message); }
  }, 2500);
  registerCoverProtocol();
  registerWallpaperProtocol();
  // 刮削请求走 Electron 会话（受代理设置控制）
  scraper.setFetchImpl(net.fetch);
  scraper.setBrowserFetch(browserFetchText);   // 挑战页/403 时用隐藏浏览器兜底
  await applyProxyConfig(loadSettings().network);
  await repairLooseVideos();   // 旧版归档规则遗留的散落视频先归位，再开监测
  await restoreSidecars();     // 库里缺资料的条目，用同目录 metadata.json 补全（刮削失败的兜底）
  createWindow();
  // 目录监测：新文件落入已登记目录时自动入库并刮削
  startWatchers();
});

app.on('window-all-closed', () => {
  stopWatchers();
  if (auxBrowser && !auxBrowser.isDestroyed()) auxBrowser.destroy();
  app.quit();
});
