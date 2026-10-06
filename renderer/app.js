/* global api */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let state = {
  items: [],
  trash: [],        // 软件回收站：[{ item, trashedAt }]
  settings: { theme: 'light', language: 'zh', playerPath: '', categories: [], dirs: [], scrape: { autoScrape: true, baseUrl: 'https://www.javbus.com' } },
  filter: 'home',
  search: '',
  currentItem: null,
  page: 1,          // 卡片墙当前页
  pageSize: 0,      // 每页数量（按窗口自适应计算）
  heroIndex: 0      // 轮播墙当前项
};

// ---------- 多语言（中 / 英） ----------
// 覆盖主界面框架（顶栏/侧栏/分页/右键菜单/设置导航/锁屏/通用页）；
// 设置页深层说明文字暂为中文，可按需扩充词条。
const I18N = {
  zh: {
    appTitle: '我的影音库', searchPh: '搜索片名 / 番号 / 演员 / 分类 / 标签...',
    home: '首页', allVideos: '全部视频', myFavorites: '我的收藏', scrapeFailed: '刮削失败',
    trash: '回收站', categories: '分类', addCategory: '添加分类', catPh: '分类名称，回车确认',
    scanAll: '⟳ 扫描全部目录', preparing: '准备中...', prevPage: '‹ 上一页', nextPage: '下一页 ›',
    ctxPlay: '播放', ctxScrape: '刮削信息', ctxEdit: '编辑信息', ctxFav: '加入收藏', ctxUnfav: '取消收藏',
    ctxReveal: '打开文件位置',
    mem: '内存',
    ctxDelete: '删除影片（移到回收站）', ovHint: '右键更多', settingsTitle: '设置', save: '保存',
    secGeneral: '通用', secTheme: '主题', secHero: '轮播', secScrape: '刮削', secNetwork: '网络',
    secPrivacy: '隐私', secAbout: '关于',
    lockTitle: '我的影音库已锁定', lockSub: '请输入启动密码继续使用', lockPh: '启动密码', unlock: '解 锁',
    langLabel: '界面语言', langDesc: '切换界面显示语言（中文 / English），改动后点击左下角「保存」生效。',
    gPlayer: '外部播放器', gPlayerDesc: '留空则使用系统默认播放器打开视频。可指定 mpv / PotPlayer 等主程序路径。',
    gPlayerPh: '例如 D:\\mpv\\mpv.exe', gBrowse: '浏览', gClear: '清空',
    gDataDir: '数据目录', gDataDirDesc: '库记录、设置与封面缓存均存放在此目录，零侵入，不修改你的视频文件。', gOpen: '打开'
  },
  en: {
    appTitle: 'My Media Library', searchPh: 'Search title / code / actor / category / tag...',
    home: 'Home', allVideos: 'All Videos', myFavorites: 'Favorites', scrapeFailed: 'Failed',
    trash: 'Trash', categories: 'Categories', addCategory: 'Add Category', catPh: 'Category name, Enter to confirm',
    scanAll: '⟳ Scan All Folders', preparing: 'Preparing...', prevPage: '‹ Prev', nextPage: 'Next ›',
    ctxPlay: 'Play', ctxScrape: 'Scrape Info', ctxEdit: 'Edit Info', ctxFav: 'Add to Favorites', ctxUnfav: 'Remove Favorite',
    ctxReveal: 'Show in Folder',
    mem: 'Memory',
    ctxDelete: 'Delete (move to trash)', ovHint: 'Right-click for more', settingsTitle: 'Settings', save: 'Save',
    secGeneral: 'General', secTheme: 'Theme', secHero: 'Carousel', secScrape: 'Scraper', secNetwork: 'Network',
    secPrivacy: 'Privacy', secAbout: 'About',
    lockTitle: 'Library Locked', lockSub: 'Enter your password to continue', lockPh: 'Password', unlock: 'Unlock',
    langLabel: 'Language', langDesc: 'Switch the interface language (中文 / English). Click "Save" to apply permanently.',
    gPlayer: 'External Player', gPlayerDesc: 'Leave empty to use the system default player, or set a path like mpv / PotPlayer.',
    gPlayerPh: 'e.g. D:\\mpv\\mpv.exe', gBrowse: 'Browse', gClear: 'Clear',
    gDataDir: 'Data Directory', gDataDirDesc: 'Library records, settings and cover cache are stored here. Non-destructive to your video files.', gOpen: 'Open'
  }
};
function t(key) {
  const lang = state.settings.language === 'en' ? 'en' : 'zh';
  return (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
}
// 应用语言到界面：静态标记（data-i18n / data-i18n-ph）+ 动态渲染区
function applyLanguage(lang) {
  state.settings.language = (lang === 'en') ? 'en' : 'zh';
  document.documentElement.lang = state.settings.language === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  renderSettingsNav();
  if (!$('#settingsModal').classList.contains('hidden')) renderSettingsSection();
  renderGrid();
  renderHero();
}

// ---------- 初始化 ----------
(async function init() {
  const lib = await api.loadLibrary();
  state.items = lib.items || [];
  state.trash = lib.trash || [];
  state.settings = lib.settings;
  document.body.dataset.acrylic = '0';   // 默认按回退处理，主进程确认后置 1
  applyTheme(state.settings.theme || 'light');
  applyAccent(state.settings.accent);
  applyLanguage(state.settings.language || 'zh');
  initLockScreen();
  bindEvents();
  renderAll();
  // 窗口尺寸变化（含最大化 / 还原）→ 重算每行几个、每页多少个，并回到第一页
  let _rz = null;
  window.addEventListener('resize', () => {
    clearTimeout(_rz);
    _rz = setTimeout(() => {
      const size = computePageSize();
      state.pageSize = size;
      state.page = 1;
      renderGrid();
    }, 180);
  });
  console.log('RENDERER_READY items=' + state.items.length);
  // 侧栏运行状态轮询（CPU/内存）
  refreshUsage();
  setInterval(refreshUsage, 2000);
})();

api.onUpdateItem((item) => {
  // 刮削归档时视频被移入新文件夹：主进程已清掉旧路径记录，渲染层同步移除旧卡片，避免残留重复
  if (item.movedFrom) {
    const oi = state.items.findIndex(i => i.path === item.movedFrom);
    if (oi >= 0) state.items.splice(oi, 1);
  }
  const idx = state.items.findIndex(i => i.path === item.path);
  if (idx >= 0) state.items[idx] = item; else state.items.push(item);
  renderGrid();
  renderCounts();
  renderHero();
  renderCategories();
});

api.onScrapeProgress((p) => renderProgress(p));

// 主进程发现新文件（目录监测/清缓存）→ 重新拉取库
api.onLibraryChanged(async () => {
  try {
    const lib = await api.loadLibrary();
    state.items = lib.items || [];
    state.trash = lib.trash || [];
    state.settings = lib.settings || state.settings;
    renderAll();
  } catch {}
});

// ---------- 主题 ----------
function applyTheme(t) {
  document.body.dataset.theme = t;
  applyWallpaper();
  applyGlassTint(t, state.settings.glassTint);
}

// 自定义壁纸：仅浅白/暗黑可用；毛玻璃由系统合成器模糊背后内容
// （系统级 acrylic 不可用时回退内置壁纸）
function applyWallpaper(wpMap) {
  const t = document.body.dataset.theme;
  const wp = (wpMap || state.settings.wallpaper || {})[t];
  const layer = $('#wallpaper');
  if ((t === 'light' || t === 'dark') && wp) {
    document.body.dataset.wallpaper = 'custom';
    layer.style.backgroundImage = `url("${wp}")`;
  } else if (t === 'glass' && document.body.dataset.acrylic !== '1') {
    // 回退：无法启用系统级毛玻璃时，用内置渐变壁纸保证毛玻璃观感
    document.body.dataset.wallpaper = 'none';
    layer.style.backgroundImage = '';
  } else {
    document.body.dataset.wallpaper = 'none';
    layer.style.backgroundImage = '';
  }
}

// 毛玻璃模式：系统级 acrylic 开关 + 背景色调浓度（0=通透 90=厚重）
function applyGlassTint(theme, tint) {
  api.setGlassTint({ enabled: theme === 'glass', tint: theme === 'glass' ? Number(tint ?? 35) : 0 });
}

// ---------- 主色（强调色） ----------
// 预设色板：都选了足够深的色值，配白字保持可读性；默认浅绿
const ACCENT_PRESETS = [
  { name: '浅绿（默认）', value: '#2fb37a' },
  { name: '蓝色', value: '#2f81f7' },
  { name: '青色', value: '#0ea5b7' },
  { name: '橙色', value: '#ef8b1f' },
  { name: '红色', value: '#e5484d' },
  { name: '紫色', value: '#8b5cf6' },
  { name: '粉色', value: '#e0569b' },
  { name: '金色', value: '#c39312' }
];
const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;

// 写 body 内联样式：优先级高于各主题规则里的 --accent，全站（按钮/选中项/进度条）一起变
function applyAccent(color) {
  const c = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : DEFAULT_ACCENT;
  document.body.style.setProperty('--accent', c);
}

// 主进程告知系统级毛玻璃是否启用成功（失败回退内置壁纸）
api.onAcrylic((ok) => {
  document.body.dataset.acrylic = ok ? '1' : '0';
  applyWallpaper();
});

// ---------- 启动密码锁 ----------
// 开启后：覆盖整个界面的锁定层，背后主界面用 backdrop-filter 模糊；密码在主进程校验
function initLockScreen() {
  const lk = state.settings.lock;
  if (!lk || !lk.enabled || !lk.hash) return;
  const ov = $('#lockScreen');
  const inp = $('#lockPass');
  const err = $('#lockErr');
  ov.classList.remove('hidden');
  document.body.classList.add('locked');
  setTimeout(() => { try { inp.focus(); } catch {} }, 250);
  const tryUnlock = async () => {
    const ok = await api.verifyLock(inp.value);
    if (ok) {
      ov.classList.add('hidden');
      document.body.classList.remove('locked');
      toast('欢迎回来 👋');
    } else {
      err.textContent = '密码不正确，请重试';
      ov.classList.remove('shake'); void ov.offsetWidth; ov.classList.add('shake');
      inp.select();
    }
  };
  $('#lockBtn').onclick = tryUnlock;
  inp.onkeydown = (e) => { if (e.key === 'Enter') tryUnlock(); };
}

// ---------- 窗口 ----------
$('#winMin').onclick = () => api.minimize();
$('#winMax').onclick = () => api.maximize();
$('#winClose').onclick = () => api.close();

// ---------- 事件 ----------
// ---------- 封面预览（完整显示 + 滚轮缩放，顶层定义供 bindEvents/openDetail 共用） ----------
const lightbox = { el: null, img: null, scale: 1 };
function openCoverPreview(src) {
  if (!src) return;
  lightbox.el = lightbox.el || $('#coverLightbox');
  lightbox.img = lightbox.img || $('#lbImg');
  lightbox.scale = 1;
  lightbox.img.style.transform = 'scale(1)';
  lightbox.img.src = src;
  lightbox.el.classList.remove('hidden');
}
function closeCoverPreview() {
  if (!lightbox.el) return;
  lightbox.el.classList.add('hidden');
  lightbox.img.removeAttribute('src');
}

// ---------- 截图画廊（卡片左键弹出：大图 + 缩略图条 + 左右切换） ----------
const shots = { it: null, list: [], idx: 0 };
function openShots(it) {
  shots.it = it;
  shots.list = (it.previews && it.previews.length) ? [...it.previews] : (it.cover ? [it.cover] : []);
  shots.idx = 0;
  $('#shotsTitle').textContent = displayTitle(it);
  const more = shots.list.length > 1;
  $('#shotsPrev').classList.toggle('hidden', !more);
  $('#shotsNext').classList.toggle('hidden', !more);
  $('#shotsThumbs').innerHTML = '';
  if (more) {
    shots.list.forEach((src, i) => {
      const im = document.createElement('img');
      im.src = src; im.loading = 'lazy'; im.alt = '';
      im.onclick = () => shotsGo(i);
      $('#shotsThumbs').appendChild(im);
    });
  }
  $('#shotsEmpty').classList.toggle('hidden', !!shots.list.length);
  $('#shotsImg').classList.toggle('empty', !shots.list.length);
  $('#shotsImg').removeAttribute('src');
  shotsApply();
  showModal('shotModal');
}
function shotsApply() {
  const img = $('#shotsImg');
  const src = shots.list[shots.idx];
  if (src) { img.src = src; } else { img.removeAttribute('src'); }
  $('#shotsCount').textContent = shots.list.length ? `${shots.idx + 1} / ${shots.list.length}` : '';
  const kids = [...$('#shotsThumbs').children];
  kids.forEach((el, i) => el.classList.toggle('on', i === shots.idx));
  const on = $('#shotsThumbs img.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function shotsGo(i) {
  if (!shots.list.length) return;
  shots.idx = (i + shots.list.length) % shots.list.length;
  shotsApply();
}

function bindEvents() {  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); resetPage(); renderHero(); renderGrid(); });
  $$('.side-item[data-filter]').forEach(el => {
    el.onclick = () => {
      $$('.side-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      state.filter = el.dataset.filter;
      resetPage();
      renderHero();
      renderGrid();
    };
  });
  // 扫描全部已登记目录
  $('#btnScanAll').onclick = async () => {
    const dirs = state.settings.dirs || [];
    if (!dirs.length) { toast('还没有刮削目录，去「设置 → 刮削」添加'); return; }
    toast('正在扫描 ' + dirs.length + ' 个目录...');
    const r = await api.scanAllDirs();
    const lib = await api.loadLibrary();
    state.items = lib.items;
    state.settings = lib.settings;
    renderAll();
    toast(`扫描完成：新增 ${r.added} 个${r.failed.length ? `，${r.failed.length} 个目录无法访问` : ''}`);
  };
  // 轮播切换
  $('#heroPrev').onclick = (e) => { e.stopPropagation(); heroGo(hero.idx - 1); };
  $('#heroNext').onclick = (e) => { e.stopPropagation(); heroGo(hero.idx + 1); };
  // 分页
  $('#pgPrev').onclick = () => { if (state.page > 1) { state.page--; renderGrid(); scrollGridTop(); } };
  $('#pgNext').onclick = () => { state.page++; renderGrid(); scrollGridTop(); };
  // 添加分类：Electron 不支持 prompt()，用侧栏内联输入行
  $('#btnAddCategory').onclick = () => {
    const wrap = $('#addCatInput'), inp = $('#newCatName');
    wrap.classList.remove('hidden');
    inp.value = '';
    inp.focus();
  };
  $('#newCatName').addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { $('#addCatInput').classList.add('hidden'); return; }
    if (e.key !== 'Enter') return;
    const name = $('#newCatName').value.trim();
    if (!name) return;
    if (!state.settings.categories) state.settings.categories = [];
    if (!state.settings.categories.includes(name)) {
      state.settings.categories.push(name);
      await api.saveSettings(state.settings);
    }
    $('#addCatInput').classList.add('hidden');
    renderCategories();
    toast('已添加分类：' + name);
  });
  $('#newCatName').addEventListener('blur', () => {
    // 延时隐藏，避免按住回车触发 blur 时闪没
    setTimeout(() => { if (!$('#newCatName').value.trim()) $('#addCatInput').classList.add('hidden'); }, 200);
  });
  $$('.modal-close').forEach(b => b.onclick = () => hideModal(b.dataset.close));
  $$('.modal').forEach(m => m.addEventListener('mousedown', (e) => {
    if (e.target === m) m.classList.add('hidden');
  }));

  // 详情
  $('#btnSaveItem').onclick = saveDetail;
  $('#btnPlay').onclick = () => {
    const it = state.currentItem;
    if (it) api.openPlayer(it.path, state.settings.playerPath);
  };
  $('#btnOpenDir').onclick = () => {
    const it = state.currentItem;
    if (it) api.openInShell(it.path.replace(/[\\/][^\\/]+$/, ''));
  };
  $('#btnScrape').onclick = () => openScrapeModal(state.currentItem);
  $('#btnDeleteItem').onclick = () => askDelete(state.currentItem);
  $('#btnDelOk').onclick = doDelete;
  $('#btnTrashData').onclick = () => trashPurge('data');
  $('#btnTrashFiles').onclick = () => trashPurge('files');
  $('#btnDirDelOk').onclick = doRemoveDir;

  // 刮削弹窗
  $('#btnScrapeSearch').onclick = doScrapeSearch;
  $('#scrapeCode').addEventListener('keydown', e => { if (e.key === 'Enter') doScrapeSearch(); });

  // 封面预览（完整显示 + 滚轮缩放 0.5x~5x；函数定义在顶层，openDetail 也要用）
  const lb = $('#coverLightbox'), lbImg = $('#lbImg');
  lb.addEventListener('click', e => { if (e.target !== lbImg) closeCoverPreview(); });
  $('#lbClose').onclick = closeCoverPreview;
  lb.addEventListener('wheel', e => {
    e.preventDefault();
    lightbox.scale = Math.min(5, Math.max(0.5, lightbox.scale + (e.deltaY < 0 ? 0.2 : -0.2)));
    lbImg.style.transform = `scale(${lightbox.scale})`;
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !lb.classList.contains('hidden')) closeCoverPreview();
  });
  $('#dCover').onclick = () => openCoverPreview($('#dCover').getAttribute('src'));

  // 截图画廊：左右切换 / 大图点击放大 / 键盘 ←→ 与 Esc（Esc 在大图预览打开时只关预览）
  $('#shotsPrev').onclick = () => shotsGo(shots.idx - 1);
  $('#shotsNext').onclick = () => shotsGo(shots.idx + 1);
  $('#shotsImg').onclick = () => { const src = shots.list[shots.idx]; if (src) openCoverPreview(src); };
  window.addEventListener('keydown', e => {
    const m = $('#shotModal');
    if (!m || m.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') shotsGo(shots.idx - 1);
    else if (e.key === 'ArrowRight') shotsGo(shots.idx + 1);
    else if (e.key === 'Escape' && lb.classList.contains('hidden')) hideModal('shotModal');
  });
  // 详情页收藏切换
  $('#dFav').onclick = () => toggleFavorite(state.currentItem);

  // 分类标签编辑器 + 用户添加图片（裁切）
  bindTagEditor();
  bindCropTools();

  // 设置
  $('#btnSettings').onclick = openSettings;
  $('#btnSaveSettings').onclick = saveSettingsDraft;

  // 拖拽导入文件夹
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.path) {
      const st = await new Promise(r => {
        // 简单判断：以文件分隔符结尾或无扩展名视作目录
        r(/\\[^\\]+\.[a-z0-9]+$/i.test(f.path) ? { isDir: false } : { isDir: true });
      });
      if (st.isDir) doScan(f.path);
      else doScan(f.path.replace(/[\\/][^\\/]+$/, ''));
    }
  });
}

// ---------- 导入 ----------
async function addFolder() {
  const dir = await api.selectFolder();
  if (dir) doScan(dir);
}
async function doScan(dir) {
  toast('正在扫描：' + dir);
  const r = await api.scanFolder(dir);
  const lib = await api.loadLibrary();
  state.items = lib.items;
  renderAll();
  toast(`已扫描，新增 ${r.added} 个视频（共 ${r.total} 个）${state.settings.scrape.autoScrape ? '，后台自动刮削中...' : ''}`);
}

// ---------- 渲染 ----------
function renderAll() { renderCategories(); renderCounts(); renderHero(); renderGrid(); }

// 过滤/搜索条件变化时回到第一页
function resetPage() { state.page = 1; }

function renderCounts() {
  $('#countAll').textContent = state.items.length;
  $('#countFav').textContent = state.items.filter(i => i.favorite).length;
  $('#countFailed').textContent = state.items.filter(i => i.status === 'failed').length;
  $('#countTrash').textContent = (state.trash || []).length;
}

function renderCategories() {
  const list = $('#categoryList');
  list.innerHTML = '';
  for (const c of state.settings.categories || []) {
    const n = state.items.filter(i => i.category === c).length;
    const div = document.createElement('div');
    div.className = 'side-item' + (state.filter === 'cat:' + c ? ' active' : '');
    div.innerHTML = `<span>🏷</span> <span class="cat-name">${escapeHtml(c)}</span><em>${n}</em>`;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'cat-x'; x.textContent = '×'; x.title = '删除该分类';
    x.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`删除分类「${c}」？\n（仅删除分类本身，视频及其标签不受影响）`)) return;
      state.settings.categories = state.settings.categories.filter(v => v !== c);
      api.saveSettings(state.settings);
      if (state.filter === 'cat:' + c) {
        state.filter = 'home';
        $$('.side-item[data-filter]').forEach(el => el.classList.toggle('active', el.dataset.filter === 'home'));
        renderGrid();
      }
      renderCategories();
    };
    div.appendChild(x);
    div.onclick = () => {
      $$('.side-item').forEach(el => el.classList.remove('active'));
      div.classList.add('active');
      state.filter = 'cat:' + c;
      resetPage();
      renderHero();
      renderGrid();
    };
    list.appendChild(div);
  }
}

// 搜索命中：返回该条目命中的字段描述数组（用于结果提示与卡片标注）
function matchItem(it, q) {
  const has = (s) => String(s == null ? '' : s).toLowerCase().includes(q);
  const hits = [];
  if (has(it.title) || has(it.name)) hits.push('标题');
  if (has(it.code)) hits.push('番号');
  const acts = (it.actresses || []).filter(has);
  if (acts.length) hits.push('演员：' + acts.join('、'));
  if (it.category && has(it.category)) hits.push('分类：' + it.category);
  const tags = (it.tags || []).filter(has);
  if (tags.length) hits.push('标签：' + tags.join('、'));
  const names = new Set((it.actresses || []).map(s => String(s).trim()));
  const alias = Object.values(it.actressAlias || {}).flatMap(a => [a && a.en, a && a.ja])
    .filter(Boolean).map(s => String(s).trim())
    .filter(s => !names.has(s))                 // 与中文名相同的别名不重复计入
    .filter(has);
  if (alias.length) hits.push('演员别名：' + [...new Set(alias)].join('、'));
  const meta = [['导演', it.director], ['制作商', it.studio], ['发行商', it.publisher], ['日期', it.date]];
  const metas = meta.filter(([, v]) => has(v)).map(([k]) => k);
  if (metas.length) hits.push(metas.join('、'));
  if (!hits.length && has(it.path)) hits.push('文件名');
  return hits;
}

function filteredItems() {
  // 回收站视图：渲染回收站快照（条目带 _trashedAt），不走搜索
  if (state.filter === 'trash') {
    state._hits = new Map();
    return (state.trash || []).map(t => Object.assign({}, t.item, { _trashedAt: t.trashedAt }));
  }
  let arr = state.items;
  if (state.filter === 'fav') arr = arr.filter(i => i.favorite);
  else if (state.filter === 'failed') arr = arr.filter(i => i.status === 'failed');
  else if (state.filter.startsWith('cat:')) {
    const c = state.filter.slice(4);
    arr = arr.filter(i => i.category === c);
  }
  state._hits = new Map();
  if (state.search) {
    const q = state.search;
    arr = arr.filter(i => {
      const h = matchItem(i, q);
      if (h.length) { state._hits.set(i.path, h); return true; }
      return false;
    });
  }
  return arr;
}

// ---------- 列表排序 ----------
// 「首页」的轮播下方固定随机推荐；其余列表视图按 设置→主题→全部视频排序：
//   random = 随机（默认）| newest = 文件时间从新到旧 | name = 番号/名称顺序
function librarySortMode() {
  const s = state.settings.librarySort;
  return (s === 'newest' || s === 'name') ? s : 'random';
}

function sortViewItems(arr) {
  if (state.filter === 'trash') return arr;           // 回收站保持入箱顺序
  const mode = state.filter === 'home' ? 'random' : librarySortMode();
  if (mode === 'name') {
    return [...arr].sort((a, b) => String(a.code || a.title || a.name || '')
      .localeCompare(String(b.code || b.title || b.name || ''), 'zh-Hans-CN', { numeric: true }));
  }
  if (mode === 'newest') {
    // 文件时间新→旧；没有 mtime 的退回发行日期，再退回文件名保持稳定
    return [...arr].sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0)
      || String(b.date || '').localeCompare(String(a.date || ''))
      || String(a.name || '').localeCompare(String(b.name || '')));
  }
  // 随机：稳定随机——同一批影片不因翻页/搜索重渲染而重排；集合或设置变化时才重新洗牌
  const sig = mode + ':' + arr.map(i => i.path).join('|');
  if (state._shuffleSig !== sig) {
    const pool = [...arr];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    state._shuffle = pool;
    state._shuffleSig = sig;
  }
  return state._shuffle || arr;
}

// ---------- 轮播展示墙（群晖 Video 风格） ----------
const hero = { timer: null, idx: 0, list: [], perView: 1 };

function heroItems(arr) {
  // 轮播逻辑来自设置：mode = random（随机）| favorite（收藏），count = 数量（1-20，默认 5）
  const cfg = state.settings.hero || {};
  const mode = cfg.mode === 'favorite' ? 'favorite' : 'random';
  const count = Math.max(1, Math.min(20, Number(cfg.count) || 5));
  let pool = arr.filter(i => i.cover);
  if (mode === 'favorite') pool = pool.filter(i => i.favorite);
  // 稳定随机：同一批影片不因搜索/翻页重渲染而重排；影片集合或配置变化时才重新洗牌
  const sig = mode + ':' + count + ':' + pool.map(i => i.path).join('|');
  if (hero._sig !== sig) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    hero._sel = pool.slice(0, count);
    hero._sig = sig;
  }
  return hero._sel || [];
}

// 0-5 评分 → 5 颗星（实心黄色 + 空心灰），rating 为 0 时全灰
function starHtml(r) {
  const full = Math.max(0, Math.min(5, Math.round(Number(r) || 0)));
  return '<span class="on">' + '★'.repeat(full) + '</span><span class="off">' + '★'.repeat(5 - full) + '</span>';
}

// 分钟数 → "1:49" 时长显示（Video Station 风格）
function fmtDuration(min) {
  const m = Number(min) || 0;
  if (m <= 0) return '';
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
}

function renderHero() {
  const wrap = $('#hero');
  const track = $('#heroTrack');
  const dots = $('#heroDots');
  if (!wrap) return;
  // 轮播横幅只在「首页」视图展示；其他视图（全部视频/收藏/分类…）只显示列表
  if (state.filter !== 'home') {
    wrap.classList.add('hidden');
    stopHeroTimer();
    return;
  }
  const list = heroItems(filteredItems());
  hero.list = list;
  if (!list.length) {
    wrap.classList.add('hidden');
    stopHeroTimer();
    return;
  }
  wrap.classList.remove('hidden');
  if (hero.idx >= list.length) hero.idx = 0;
  track.innerHTML = '';
  list.forEach((it, i) => {
    const slide = document.createElement('div');
    slide.className = 'hero-slide';
    // 背景用剧照（第一张预览图），没有则退化为海报；左侧竖版海报悬浮，右下角信息区
    const bg = (it.previews && it.previews[0]) || it.cover;
    const year = (it.date || '').slice(0, 4);
    const dur = it.duration ? fmtDuration(it.duration) : '';
    slide.innerHTML = `
      <img class="hero-bg" src="${escapeHtml(bg)}" alt="" draggable="false">
      <div class="hero-mask"></div>
      <img class="hero-poster" src="${escapeHtml(it.cover)}" alt="" draggable="false">
      <div class="hero-info">
        <div class="hero-title">${escapeHtml((it.title || it.name || '') + (year ? `（${year}）` : ''))}</div>
        <div class="hero-syn">${escapeHtml((it.synopsis || '').slice(0, 110))}</div>
        <div class="hero-stars">${starHtml(it.rating || 0)}</div>
        <div class="hero-meta">
          ${it.code ? `<span class="hero-tag code">${escapeHtml(it.code)}</span>` : ''}
          ${(it.actresses || []).slice(0, 3).map(a => `<span class="hero-tag">${escapeHtml(a)}</span>`).join('')}
          ${(it.tags || []).slice(0, 4).map(t => `<span class="hero-tag dim">${escapeHtml(t)}</span>`).join('')}
          <button class="btn primary hero-play" type="button">▶ 播放</button>
        </div>
      </div>
      <div class="hero-corner">
        ${year ? `<span class="hero-tag dim">${year}</span>` : ''}
        ${dur ? `<span class="hero-tag dim">${dur}</span>` : ''}
      </div>`;
    slide.onclick = (e) => {
      if (e.target.classList.contains('hero-play')) api.openPlayer(it.path, state.settings.playerPath);
      else openDetail(it);
    };
    track.appendChild(slide);
  });
  dots.innerHTML = '';
  list.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'hero-dot' + (i === hero.idx ? ' active' : '');
    d.onclick = (e) => { e.stopPropagation(); heroGo(i); };
    dots.appendChild(d);
  });
  heroApply();
  startHeroTimer();
  // 鼠标悬停暂停自动轮播，移开恢复（Video Station 行为）
  wrap.onmouseenter = stopHeroTimer;
  wrap.onmouseleave = () => startHeroTimer();
}

function heroApply() {
  const track = $('#heroTrack');
  if (track) track.style.transform = `translateX(${-hero.idx * 100}%)`;
  $$('#heroDots .hero-dot').forEach((d, i) => d.classList.toggle('active', i === hero.idx));
}

function heroGo(i) {
  if (!hero.list.length) return;
  hero.idx = (i + hero.list.length) % hero.list.length;
  heroApply();
  startHeroTimer();
}

function startHeroTimer() {
  stopHeroTimer();
  if (hero.list.length < 2) return;
  hero.timer = setInterval(() => heroGo(hero.idx + 1), 6000);
}
function stopHeroTimer() { if (hero.timer) { clearInterval(hero.timer); hero.timer = null; } }

// ---------- 分页 ----------
// 规则：一行 N 个（按窗口宽度算），行数按网格可视高度算——铺满当前窗口为准，
// 最少 2 行（窗口特别矮时不至于只剩一排）。多余的一律翻到下一页。
// 窗口放大 / 最大化 / 拉伸后，行数与列数都会重算，每页数量随之变化
// （卡片最小不小于 ~96px 宽，避免过窄）。
const GRID_ROWS_MIN = 2;  // 每页最少行数
const GRID_ROWS_MAX = 12; // 每页最多行数（防止极端比例窗口下单页过多）
const BASE_COLS = 6;      // 基准：一行 6 个
const CARD_BASE_W = 182;  // 基准窗口宽度下的卡片宽度（决定什么时候能多塞一列）
const CARD_MIN_W = 96;    // 卡片最小可读宽度（窗口很窄时允许少于 6 列）
const CARD_TITLE_H = 37;  // .card-title 高度（上下 padding 8+8 + 一行 12.5px 文本）

function gridCols() {
  const grid = $('#grid');
  if (!grid) return BASE_COLS;
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.gap) || 16;
  const padL = parseFloat(cs.paddingLeft) || 18;
  const padR = parseFloat(cs.paddingRight) || 18;
  const availW = Math.max(120, grid.clientWidth - padL - padR);
  const byBase = Math.floor((availW + gap) / (CARD_BASE_W + gap));  // 按基准卡片宽度能放几列
  const byMin = Math.floor((availW + gap) / (CARD_MIN_W + gap));    // 卡片最小宽度的上限
  return Math.max(1, Math.min(16, Math.min(byMin, Math.max(BASE_COLS, byBase))));
}

// 行数：按 #grid 的可视高度（flex 布局下已自动扣除轮播横幅、搜索提示条和分页条）动态计算。
// #grid 本身 overflow-y:auto，行数只会取得保守值（向下取整），正常不会出现半行溢出滚动。
function gridRows() {
  const grid = $('#grid');
  if (!grid) return GRID_ROWS_MIN;
  const cs = getComputedStyle(grid);
  const gapY = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 16;
  const padT = parseFloat(cs.paddingTop) || 18;
  const padB = parseFloat(cs.paddingBottom) || 18;
  const padL = parseFloat(cs.paddingLeft) || 18;
  const padR = parseFloat(cs.paddingRight) || 18;
  const availH = grid.clientHeight - padT - padB - 2; // 2px 安全余量
  if (!(availH > 0)) return GRID_ROWS_MIN;
  const cols = gridCols();
  const availW = Math.max(120, grid.clientWidth - padL - padR);
  const colW = Math.max(CARD_MIN_W, (availW - gapY * (cols - 1)) / cols);
  const cardH = colW / 1.5 + CARD_TITLE_H + 2;  // 3:2 封面 + 标题行 + 上下边框
  const rows = Math.floor((availH + gapY) / (cardH + gapY));
  return Math.max(GRID_ROWS_MIN, Math.min(GRID_ROWS_MAX, rows));
}

function computePageSize() {
  return gridCols() * gridRows();
}

// 把列数写进样式，保证每行正好 N 个且不横向溢出
function applyGridCols() {
  const grid = $('#grid');
  if (!grid) return;
  grid.style.gridTemplateColumns = `repeat(${gridCols()}, minmax(0, 1fr))`;
}

function renderPager(total) {
  const pager = $('#pager');
  const pages = Math.max(1, Math.ceil(total / Math.max(1, state.pageSize)));
  if (state.page > pages) state.page = pages;
  // 只要有内容就常驻显示（按钮位置固定在网格下方居中），按钮按是否还有上下页禁用
  if (!total) { pager.classList.add('hidden'); return; }
  pager.classList.remove('hidden');
  $('#pgInfo').textContent = state.settings.language === 'en'
    ? `Page ${state.page} / ${pages} · ${total} items · ${state.pageSize} per page`
    : `第 ${state.page} / ${pages} 页 · 共 ${total} 个 · 每页 ${state.pageSize} 个`;
  $('#pgPrev').disabled = state.page <= 1;
  $('#pgNext').disabled = state.page >= pages;
}

function scrollGridTop() {
  const grid = $('#grid');
  if (grid) grid.scrollTop = 0;
}

// 搜索结果提示条：命中数量 + 各类命中统计
function renderSearchInfo(arr) {
  const box = $('#searchInfo');
  if (!state.search) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  let nAct = 0, nCat = 0, nTag = 0;
  for (const it of arr) {
    const h = state._hits.get(it.path) || [];
    if (h.some(s => s.startsWith('演员'))) nAct++;
    if (h.some(s => s.startsWith('分类'))) nCat++;
    if (h.some(s => s.startsWith('标签'))) nTag++;
  }
  const chips = [['演员', nAct], ['分类', nCat], ['标签', nTag]]
    .filter(([, n]) => n).map(([k, n]) => `<span class="si-hit">${k} ${n}</span>`).join('');
  box.innerHTML = `搜索「<b>${escapeHtml(state.search)}</b>」命中 <b>${arr.length}</b> 个视频` +
    (chips ? `<span class="si-hits">${chips}</span>` : '');
  box.classList.remove('hidden');
}

function renderGrid() {
  const grid = $('#grid');
  const all = sortViewItems(filteredItems());
  renderSearchInfo(all);
  // 按当前窗口定好每行列数与行数（列看宽度、行看高度），铺满可视区；窗口变化时随之调整
  state.pageSize = computePageSize();
  applyGridCols();
  const pages = Math.max(1, Math.ceil(all.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  if (state.page < 1) state.page = 1;
  const arr = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  grid.innerHTML = '';
  if (!all.length) {
    $('#pager').classList.add('hidden');
    grid.innerHTML = state.filter === 'trash'
      ? `<div class="empty-tip">回收站是空的<br>删除影片后会先来到这里</div>`
      : state.search
      ? `<div class="empty-tip">没有匹配「${escapeHtml(state.search)}」的视频<br>可试试演员名、分类或标签</div>`
      : `<div class="empty-tip">还没有视频<br>在「设置 → 刮削」里添加影片目录，或把文件夹拖入窗口</div>`;
    return;
  }
  for (const it of arr) {
    const card = document.createElement('div');
    card.className = 'card';
    // 回收站视图：显示删除时间角标，点击弹出处理方式（删除数据 / 删除硬盘源文件）
    if (state.filter === 'trash') {
      const when = it._trashedAt ? new Date(it._trashedAt) : null;
      const whenTxt = when && !isNaN(when) ? `${when.getMonth() + 1}-${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '';
      card.innerHTML = `
        <div class="poster">
          ${it.cover ? `<img src="${escapeHtml(it.cover)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
                        <div class="fallback" style="display:none">${escapeHtml(displayTitle(it))}</div>`
                     : `<div class="fallback">${escapeHtml(displayTitle(it))}</div>`}
          <span class="badge trash-badge">🗑 ${whenTxt}</span>
        </div>
        <div class="card-title">${escapeHtml(displayTitle(it))}</div>`;
      card.title = '点击选择处理方式';
      card.onclick = () => openTrashModal(it);
      grid.appendChild(card);
      continue;
    }
    const badge = it.status === 'manual' ? '<span class="badge manual">已刮削</span>'
      : it.status === 'failed' ? '<span class="badge failed">刮削失败</span>' : '';
    card.innerHTML = `
      <div class="poster">
        ${it.cover ? `<img src="${escapeHtml(it.cover)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
                      <div class="fallback" style="display:none">${escapeHtml(displayTitle(it))}</div>`
                   : `<div class="fallback">${escapeHtml(displayTitle(it))}</div>`}
        ${badge}
        ${it.favorite ? '<span class="fav-mark" title="已收藏">♥</span>' : ''}
        <div class="overlay">
          <button class="ov-play" title="播放" data-act="play">▶</button>
          <span class="ov-hint">${t('ovHint')}</span>
        </div>
      </div>
      <div class="card-title">${escapeHtml(displayTitle(it))}</div>
      ${state.search ? `<div class="card-hit">${escapeHtml((state._hits.get(it.path) || []).join(' · '))}</div>` : ''}`;
    card.onclick = () => openShots(it);
    // 右键：刮削 / 编辑 / 收藏 / 删除 收到右键菜单里
    card.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openCardMenu(e, it); };
    const playBtn = card.querySelector('.overlay button');
    if (playBtn) playBtn.onclick = (e) => { e.stopPropagation(); api.openPlayer(it.path, state.settings.playerPath); };
    grid.appendChild(card);
  }
  renderPager(all.length);
}

// ---------- 卡片右键菜单（播放 / 刮削 / 编辑 / 收藏 / 删除） ----------
function closeCardMenu() {
  const m = $('#ctxMenu');
  if (m && !m.classList.contains('hidden')) { m.classList.add('hidden'); m.innerHTML = ''; }
}
function openCardMenu(ev, it) {
  const m = $('#ctxMenu');
  const isFav = !!it.favorite;
  const rows = [
    { act: 'play',   icon: '▶', label: t('ctxPlay') },
    { sep: true },
    { act: 'fav',    icon: isFav ? '♥' : '♡', label: isFav ? t('ctxUnfav') : t('ctxFav') },
    { act: 'edit',   icon: '✎', label: t('ctxEdit') },
    { act: 'scrape', icon: '🔍', label: t('ctxScrape') },
    { sep: true },
    { act: 'reveal', icon: '📁', label: t('ctxReveal') },
    { act: 'del',    icon: '🗑', label: t('ctxDelete'), danger: true }
  ];
  m.innerHTML = rows.map(r => r.sep
    ? '<div class="ctx-sep"></div>'
    : `<button class="ctx-item${r.danger ? ' danger' : ''}" data-act="${r.act}"><span class="ctx-ico">${r.icon}</span>${r.label}</button>`
  ).join('');
  m.classList.remove('hidden');
  // 贴光标定位，并保证不超出窗口
  const pad = 8;
  const box = m.getBoundingClientRect();
  m.style.left = Math.max(pad, Math.min(ev.clientX, window.innerWidth - box.width - pad)) + 'px';
  m.style.top = Math.max(pad, Math.min(ev.clientY, window.innerHeight - box.height - pad)) + 'px';
  m.querySelectorAll('.ctx-item').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      closeCardMenu();
      const act = b.dataset.act;
      if (act === 'play') api.openPlayer(it.path, state.settings.playerPath);
      else if (act === 'scrape') openScrapeModal(it);
      else if (act === 'fav') toggleFavorite(it);
      else if (act === 'reveal') api.showInFolder(it.path);
      else if (act === 'del') askDelete(it);
      else openDetail(it);   // 编辑信息走详情弹窗
    };
  });
}
// 点击别处 / 右键别处 / 滚轮 / Esc / 窗口失焦 → 收起菜单
window.addEventListener('click', closeCardMenu);
window.addEventListener('contextmenu', (e) => { if (!e.target.closest || !e.target.closest('.card')) closeCardMenu(); }, true);

// ---------- 侧栏运行状态：CPU / 内存占用（2s 轮询，percentCPUUsage 是相对上次调用的增量） ----------
async function refreshUsage() {
  try {
    const u = await api.sysUsage();
    $('#ssCpu').textContent = u.cpu.toFixed(1) + '%';
    $('#ssMem').textContent = u.memMB + ' MB';
  } catch {}
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCardMenu(); });
window.addEventListener('blur', closeCardMenu);
window.addEventListener('resize', closeCardMenu);
document.addEventListener('scroll', closeCardMenu, true);

// ---------- 删除影片（移到系统回收站，带警告） ----------
let pendingDelete = null;
function askDelete(it) {
  if (!it) return;
  pendingDelete = it;
  const dir = (it.path || '').replace(/[\\/][^\\/]+$/, '');
  const ownFolder = dir.split(/[\\/]/).pop().toLowerCase() === (it.code || it.name || '').replace(/\.[^.]+$/, '').toLowerCase();
  $('#delList').innerHTML = [
    `<div class="del-row"><span>影片</span><b>${escapeHtml(it.title || it.name || '')}</b></div>`,
    `<div class="del-row"><span>视频文件</span><code>${escapeHtml(it.path)}</code></div>`,
    `<div class="del-row"><span>将移入回收站</span><code>${escapeHtml(ownFolder ? dir : (it.dir || (dir + '\\' + (it.code || ''))))}</code></div>`
  ].join('');
  showModal('delModal');
}

async function doDelete() {
  const it = pendingDelete;
  if (!it) return;
  $('#btnDelOk').disabled = true;
  let r;
  try {
    r = await api.deleteMedia(it.path);
  } catch (e) {
    r = { ok: false, errors: [String(e.message || e)] };
  }
  $('#btnDelOk').disabled = false;
  hideModal('delModal');
  hideModal('detailModal');
  pendingDelete = null;
  if (r && r.ok) {
    state.items = state.items.filter(i => i.path !== it.path);
    // 进软件回收站：保留条目快照，主界面不再显示
    state.trash = state.trash || [];
    state.trash = state.trash.filter(t => t.item.path !== it.path);
    state.trash.unshift({ item: r.item || it, trashedAt: new Date().toISOString() });
    renderAll();
    toast('已移入软件回收站，可在左侧「🗑 回收站」中彻底删除或恢复');
  } else {
    toast('删除失败：' + ((r && r.errors && r.errors[0]) || '未知错误'));
  }
}

// ---------- 回收站处理（两种删除方式） ----------
let pendingTrash = null;

function openTrashModal(t) {
  pendingTrash = t;
  const when = t._trashedAt ? new Date(t._trashedAt).toLocaleString() : '';
  $('#trashInfo').innerHTML = [
    `<div class="del-row"><span>影片</span><b>${escapeHtml(t.title || t.name || '')}</b></div>`,
    `<div class="del-row"><span>视频文件</span><code>${escapeHtml(t.path)}</code></div>`,
    `<div class="del-row"><span>删除时间</span><code>${escapeHtml(when)}</code></div>`
  ].join('');
  showModal('trashModal');
}

async function trashPurge(mode) {
  const t = pendingTrash;
  if (!t) return;
  const btn = mode === 'files' ? $('#btnTrashFiles') : $('#btnTrashData');
  btn.disabled = true;
  let r;
  try {
    r = mode === 'files' ? await api.trashPurgeFiles(t.path) : await api.trashPurgeData(t.path);
  } catch (e) {
    r = { ok: false, errors: [String(e.message || e)] };
  }
  btn.disabled = false;
  hideModal('trashModal');
  pendingTrash = null;
  if (r && r.ok) {
    state.trash = (state.trash || []).filter(x => x.item.path !== t.path);
    renderGrid();
    renderCounts();
    toast(mode === 'files' ? '已删除硬盘源文件（含刮削数据），可在系统回收站找回' : '已删除数据记录（硬盘文件未动）');
  } else {
    toast('操作失败：' + ((r && r.errors && r.errors[0]) || '未知错误'));
  }
}

// ---------- 刮削进度（左下角） ----------
function renderProgress(p) {
  const box = $('#scrapeProgress');
  if (!box) return;
  if (!p || !p.running) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  $('#spText').textContent = `刮削中 ${p.done}/${p.total}${p.title ? ' · ' + p.title : ''}`;
  $('#spBar').style.width = pct + '%';
}

// ---------- 详情 / 编辑 ----------
// ---------- 收藏 ----------
async function toggleFavorite(it) {
  if (!it) return;
  it.favorite = !it.favorite;
  try { await api.saveItems([it]); } catch {}
  const idx = state.items.findIndex(i => i.path === it.path);
  if (idx >= 0) state.items[idx] = it;
  if (state.currentItem && state.currentItem.path === it.path) { state.currentItem = it; updateFavBtn(it); }
  renderGrid();
  renderCounts();
  renderHero();
  toast(it.favorite ? '已加入收藏 ❤' : '已取消收藏');
}

function updateFavBtn(it) {
  const b = $('#dFav');
  if (!b || !it) return;
  b.innerHTML = it.favorite ? '<span class="fi">♥</span>已收藏' : '<span class="fi">♡</span>加入收藏';
  b.classList.toggle('on', !!it.favorite);
  b.title = it.favorite ? '取消收藏' : '收藏';
}

function openDetail(it) {
  state.currentItem = it;
  updateFavBtn(it);
  $('#dTitle').textContent = displayTitle(it);
  $('#dPath').textContent = it.path;
  $('#fTitle').value = it.title || '';
  $('#fCode').value = it.code || '';
  $('#fDate').value = it.date || '';
  $('#fActresses').value = (it.actresses || []).join(', ');
  setEditTags(it.tags || []);
  $('#fTagInput').value = '';
  hideTagSuggest();
  // 分类下拉：选项来自主界面侧栏自定义的分类；条目已有但已不在列表中的分类也保留显示
  const selCat = $('#fCategory');
  const cats = [...(state.settings.categories || [])];
  if (it.category && !cats.includes(it.category)) cats.push(it.category);
  selCat.innerHTML = '<option value="">（未分类）</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  selCat.value = it.category || '';
  $('#fCover').value = (it.cover && !it.cover.startsWith('cover://')) ? it.cover : '';
  $('#fRating').value = it.rating || 0;
  const coverImg = $('#dCover');
  coverImg.src = it.cover || '';
  coverImg.onerror = () => { coverImg.removeAttribute('src'); };
  // 预览截图（点小图看大图）+ 简介
  const pvWrap = $('#dPreviews');
  pvWrap.innerHTML = '';
  for (const src of (it.previews || [])) {
    const im = document.createElement('img');
    im.src = src; im.loading = 'lazy'; im.alt = '';
    im.onclick = () => openCoverPreview(src);
    pvWrap.appendChild(im);
  }
  const syn = $('#dSynopsis');
  if (it.synopsis) { syn.textContent = it.synopsis; syn.style.display = ''; }
  else { syn.style.display = 'none'; }
  // 演员别名（英文名/日文名，括号显示）；老条目没有则后台补抓一次，回来后刷新
  renderAliasHint(it);
  if ((it.actresses || []).length && it.detailUrl && !it.actressAlias) {
    api.fetchAlias(it).then(updated => {
      if (!updated) return;
      const idx = state.items.findIndex(i => i.path === updated.path);
      if (idx >= 0) state.items[idx] = updated;
      if (state.currentItem && state.currentItem.path === updated.path) {
        state.currentItem = updated;
        renderAliasHint(updated);
      }
    });
  }
  showModal('detailModal');
}

// 演员别名提示：中文名（英文名 / 日文名），与中文名重复的别名不重复展示
function renderAliasHint(it) {
  const el = $('#dActressAlias');
  const al = it.actressAlias || {};
  const lines = (it.actresses || []).map(n => {
    const a = al[n];
    if (!a) return '';
    const extra = [...new Set([a.en, a.ja].map(s => (s || '').trim()).filter(s => s && s !== n))].join(' / ');
    return extra ? `${n}（${extra}）` : '';
  }).filter(Boolean);
  if (lines.length) { el.innerHTML = lines.map(escapeHtml).join('<br>'); el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); el.innerHTML = ''; }
}

async function saveDetail() {
  const it = { ...state.currentItem };
  it.title = $('#fTitle').value.trim();
  it.code = $('#fCode').value.trim().toUpperCase();
  it.date = $('#fDate').value.trim();
  it.actresses = $('#fActresses').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  it.tags = editTags.slice();
  // 分类：来自下拉（主界面侧栏维护）；空值则移除该字段
  const catVal = $('#fCategory').value;
  if (catVal) it.category = catVal; else delete it.category;
  // 记住本次用到的标签（立即在本会话可选，主进程也会合并去重持久化）
  state.settings.knownTags = [...new Set([...(state.settings.knownTags || []), ...editTags])];
  api.saveSettings(state.settings);
  const urlCover = $('#fCover').value.trim();
  if (urlCover) it.cover = urlCover;
  it.rating = Number($('#fRating').value) || 0;
  await api.saveItems([it]);
  state.currentItem = it;
  const idx = state.items.findIndex(i => i.path === it.path);
  if (idx >= 0) state.items[idx] = it;
  renderGrid();
  renderCounts();
  renderCategories();
  toast('已保存');
}

// ---------- 分类标签编辑器（chips + 历史分类下拉） ----------
let editTags = [];

function setEditTags(tags) {
  editTags = [...new Set((tags || []).map(s => String(s).trim()).filter(Boolean))];
  renderTagChips();
}

function renderTagChips() {
  const wrap = $('#tagChips');
  wrap.innerHTML = '';
  for (const t of editTags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const b = document.createElement('b');
    b.textContent = t;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'chip-x'; x.textContent = '×'; x.title = '删除该分类';
    x.onclick = () => { editTags = editTags.filter(v => v !== t); renderTagChips(); };
    chip.appendChild(b); chip.appendChild(x);
    wrap.appendChild(chip);
  }
  renderTagHistory();
}

function addTag(t) {
  t = String(t || '').trim().replace(/[,，]/g, '');
  if (!t || editTags.includes(t)) return;
  editTags.push(t);
  renderTagChips();
  state.settings.knownTags = [...new Set([...(state.settings.knownTags || []), t])];
}

function knownTagList() {
  return [...new Set([...(state.settings.knownTags || []), ...editTags])];
}

// 历史分类区：常驻平铺在输入框下方，点击即加入本视频；输入文字时实时过滤
function renderTagHistory(q) {
  const box = $('#tagHistory');
  if (!box) return;
  q = (q || '').trim().toLowerCase();
  let list = knownTagList().filter(t => !editTags.includes(t));
  if (q) list = list.filter(t => t.toLowerCase().includes(q));
  box.innerHTML = '';
  if (!list.length) { box.classList.add('hidden'); return; }
  const label = document.createElement('span');
  label.className = 'th-label';
  label.textContent = '历史标签：';
  box.appendChild(label);
  for (const t of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tag-hist'; b.textContent = t; b.title = '加入本视频';
    b.onclick = () => { addTag(t); $('#fTagInput').value = ''; };
    box.appendChild(b);
  }
  box.classList.remove('hidden');
}

function hideTagSuggest() { renderTagHistory(''); }

function bindTagEditor() {
  const input = $('#fTagInput');
  input.addEventListener('input', () => renderTagHistory(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTag(input.value);
      input.value = '';
      renderTagHistory('');
    } else if (e.key === 'Backspace' && !input.value && editTags.length) {
      editTags.pop();
      renderTagChips();
    }
  });
  $('#tagEditor').addEventListener('click', (e) => {
    if (e.target.id === 'tagEditor' || e.target.id === 'tagChips') input.focus();
  });
}

// ---------- 用户添加图片（选文件 → 裁切 3:2 → 存 covers 并加入图集） ----------
const AR_PREVIEW = 800 / 534;   // 预览截图比例（≈3:2）
const AR_COVER = 800 / 538;     // 封面比例（与 JavBus 横版封面一致）
const crop = {
  queue: [],            // 待处理的本地文件路径队列
  dataUrl: '',          // 当前图片的 dataURL
  natural: { w: 0, h: 0 },
  disp: { w: 0, h: 0 },
  box: { x: 0, y: 0, w: 0, h: 0 },
  mode: null,           // move | draw | resize
  start: null,
  target: 'preview',    // preview=加入图集 | cover=设为封面
  AR: AR_PREVIEW
};

function bindCropTools() {
  $('#btnAddImage').onclick = addImages;
  $('#btnSetCover').onclick = setCover;
  $('#btnCropOk').onclick = confirmCrop;
  $('#btnCropSkip').onclick = skipCrop;
  $('#cropModal').addEventListener('mousedown', (e) => {
    if (e.target === $('#cropModal')) crop.queue = [];   // 点空白关闭 = 放弃剩余队列
  });

  const stage = $('#cropStage');
  stage.addEventListener('mousedown', (e) => {
    if (e.target.id === 'cropHandle') crop.mode = 'resize';
    else if (e.target.closest('.crop-box')) crop.mode = 'move';
    else crop.mode = 'draw';
    crop.start = {
      mx: e.clientX, my: e.clientY,
      box: { ...crop.box },
      anchor: stagePoint(e)
    };
    e.preventDefault();
  });
  window.addEventListener('mousemove', onCropMove);
  window.addEventListener('mouseup', () => { crop.mode = null; });
}

async function addImages() {
  const files = await api.pickImages();
  if (!files || !files.length) return;
  crop.target = 'preview';
  crop.AR = AR_PREVIEW;
  crop.queue = files.slice();
  nextCrop();
}

// 更换封面：选一张本地图片，按封面比例裁切后存为条目封面
async function setCover() {
  if (!state.currentItem) return;
  const files = await api.pickImages();
  if (!files || !files.length) return;
  if (files.length > 1) toast('更换封面只使用第一张图片');
  crop.target = 'cover';
  crop.AR = AR_COVER;
  crop.queue = [files[0]];
  nextCrop();
}

async function nextCrop() {
  const f = crop.queue.shift();
  if (!f) return;
  let dataUrl = null;
  try { dataUrl = await api.imageDataUrl(f); } catch {}
  if (!dataUrl) { toast('无法读取图片：' + f.split(/[\\/]/).pop()); nextCrop(); return; }
  openCropModal(dataUrl);
}

function openCropModal(dataUrl) {
  crop.dataUrl = dataUrl;
  const img = $('#cropImg');
  img.onload = () => {
    crop.natural = { w: img.naturalWidth, h: img.naturalHeight };
    requestAnimationFrame(() => {
      const r = img.getBoundingClientRect();
      crop.disp = { w: r.width, h: r.height };
      let w = r.width, h = w / crop.AR;
      if (h > r.height) { h = r.height; w = h * crop.AR; }
      crop.box = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
      applyCropBox();
      const what = crop.target === 'cover' ? '封面' : '预览图';
      $('#cropHint').textContent = `原图 ${img.naturalWidth}×${img.naturalHeight} → ${what}输出宽 800（比例 ${crop.target === 'cover' ? '800:538' : '3:2'}）`;
    });
  };
  img.src = dataUrl;
  showModal('cropModal');
}

function applyCropBox() {
  const b = $('#cropBox');
  b.style.left = crop.box.x + 'px';
  b.style.top = crop.box.y + 'px';
  b.style.width = crop.box.w + 'px';
  b.style.height = crop.box.h + 'px';
}

function stagePoint(e) {
  const r = $('#cropStage').getBoundingClientRect();
  return {
    x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
    y: Math.min(Math.max(e.clientY - r.top, 0), r.height)
  };
}

function onCropMove(e) {
  if (!crop.mode || !crop.start) return;
  const d = crop.disp, AR = crop.AR, s = crop.start, b = crop.box;
  if (crop.mode === 'move') {
    b.x = Math.min(Math.max(s.box.x + (e.clientX - s.mx), 0), d.w - b.w);
    b.y = Math.min(Math.max(s.box.y + (e.clientY - s.my), 0), d.h - b.h);
  } else if (crop.mode === 'resize') {
    let w = Math.max(48, Math.min(e.clientX - s.mx + s.box.w, d.w - b.x));
    let h = w / AR;
    if (b.y + h > d.h) { h = d.h - b.y; w = h * AR; }
    b.w = w; b.h = h;
  } else if (crop.mode === 'draw') {
    const p = stagePoint(e), a = s.anchor;
    let w = Math.abs(p.x - a.x), h = Math.abs(p.y - a.y);
    if (h < w / AR) w = h * AR; else h = w / AR;
    w = Math.max(48, Math.min(w, d.w)); h = Math.min(h, d.h);
    if (b.y + h > d.h) { h = d.h - b.y; w = h * AR; }
    let x = p.x < a.x ? a.x - w : a.x;
    let y = p.y < a.y ? a.y - h : a.y;
    b.w = w; b.h = h;
    b.x = Math.min(Math.max(x, 0), d.w - w);
    b.y = Math.min(Math.max(y, 0), d.h - h);
  }
  applyCropBox();
}

async function confirmCrop() {
  const scale = crop.natural.w / crop.disp.w;   // 显示坐标 → 原图像素
  const b = crop.box;
  const sx = Math.round(b.x * scale), sy = Math.round(b.y * scale);
  const sw = Math.round(b.w * scale), sh = Math.round(b.h * scale);
  try {
    const out = await cropImage(crop.dataUrl, sx, sy, sw, sh);
    if (crop.target === 'cover') await attachCover(out);
    else await attachUserImage(out);
  } catch (e) { toast('裁切失败：' + (e.message || e)); }
  hideModal('cropModal');
  nextCrop();
}

async function skipCrop() {
  if (crop.target === 'cover') await attachCover(crop.dataUrl);
  else await attachUserImage(crop.dataUrl);
  hideModal('cropModal');
  nextCrop();
}

// 按裁切框从原图截取，输出宽 800 的 JPEG
function cropImage(dataUrl, sx, sy, sw, sh) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cw = 800, ch = Math.max(1, Math.round(800 * sh / sw));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

async function attachUserImage(dataUrl) {
  const it = state.currentItem;
  if (!it) return;
  const base = (it.code || it.name || 'pic').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  try {
    // 存到该视频所在的文件夹（与刮削资产同处）
    const cover = await api.saveUserImage({ itemPath: it.path, base, dataUrl });
    it.previews = [...(it.previews || []), cover];
    const idx = state.items.findIndex(i => i.path === it.path);
    if (idx >= 0) state.items[idx] = it;
    await api.saveItems([it]);
    appendPreviewImg(cover);
    toast('已添加图片');
  } catch (e) { toast('保存失败：' + (e.message || e)); }
}

// 保存自定义封面：写入 covers 目录，覆盖条目封面并刷新卡片
async function attachCover(dataUrl) {
  const it = state.currentItem;
  if (!it) return;
  const base = (it.code || it.name || 'pic').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  try {
    const cover = await api.saveCoverImage({ itemPath: it.path, base, dataUrl });
    it.cover = cover;
    const idx = state.items.findIndex(i => i.path === it.path);
    if (idx >= 0) state.items[idx] = it;
    await api.saveItems([it]);
    $('#fCover').value = '';          // 清掉远程地址，避免保存时把它盖回旧封面
    const img = $('#dCover');
    img.src = cover;
    renderGrid();
    toast('封面已更新');
  } catch (e) { toast('封面保存失败：' + (e.message || e)); }
}

function appendPreviewImg(src) {
  const im = document.createElement('img');
  im.src = src; im.alt = '';
  im.onclick = () => openCoverPreview(src);
  $('#dPreviews').appendChild(im);
}

// ---------- 刮削 ----------
function openScrapeModal(it) {
  hideModal('detailModal');
  state.currentItem = it;
  $('#scrapeCode').value = it.code || '';
  $('#scrapeResults').innerHTML = '<div class="scrape-empty">点击「搜索」获取候选结果</div>';
  showModal('scrapeModal');
  if (it.code) doScrapeSearch();
}

async function doScrapeSearch() {
  const code = $('#scrapeCode').value.trim();
  if (!code) return toast('请输入番号');
  const box = $('#scrapeResults');
  box.innerHTML = '<div class="scrape-empty">搜索中，请稍候...</div>';
  let cands;
  try {
    cands = await api.scrapeSearch({ code });
  } catch (e) {
    box.innerHTML = `<div class="scrape-empty">搜索失败：${escapeHtml(String(e.message || e))}<br>请检查网络或设置中的刮削源地址</div>`;
    return;
  }
  if (!cands.length) {
    box.innerHTML = '<div class="scrape-empty">没有找到结果，可尝试修改番号</div>';
    return;
  }
  box.innerHTML = '';
  for (const c of cands) {
    const div = document.createElement('div');
    div.className = 'scrape-item';
    div.innerHTML = `
      <img src="${escapeHtml(c.coverUrl || '')}" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="si-info">
        <div class="si-title">${escapeHtml(c.title || c.code)}</div>
        <div class="si-meta">${escapeHtml(c.code || '')} ${c.date ? '· ' + escapeHtml(c.date) : ''}
          ${(c.actresses || []).length ? '· ' + escapeHtml(c.actresses.join(', ')) : ''}</div>
      </div>
      <button class="btn primary">选择</button>`;
    div.querySelector('button').onclick = async () => {
      const updated = await api.scrapeApply({ item: state.currentItem, candidate: c });
      const idx = state.items.findIndex(i => i.path === updated.path);
      if (idx >= 0) state.items[idx] = updated;
      hideModal('scrapeModal');
      renderGrid(); renderCounts();
      toast('已应用刮削结果');
    };
    box.appendChild(div);
  }
}

// ---------- 设置（左大类 + 右二级面板） ----------
const SETTINGS_SECTIONS = [
  { id: 'general',  icon: '⚙',  nameKey: 'secGeneral' },
  { id: 'theme',    icon: '🎨', nameKey: 'secTheme' },
  { id: 'hero',     icon: '🖼', nameKey: 'secHero' },
  { id: 'scrape',   icon: '🔍', nameKey: 'secScrape' },
  { id: 'network',  icon: '🌐', nameKey: 'secNetwork' },
  { id: 'privacy',  icon: '🔒', nameKey: 'secPrivacy' },
  { id: 'about',    icon: 'ℹ',  nameKey: 'secAbout' }
];
let draftSettings = null;
let currentSection = 'general';
let dataDir = '';
let lockPending = null;   // 隐私页里正在输入的启动密码 { pass, confirm }，离开页面即作废

function openSettings() {
  draftSettings = JSON.parse(JSON.stringify(state.settings));
  if (!draftSettings.network) draftSettings.network = { proxyEnabled: false, proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7897' };
  if (!draftSettings.hero) draftSettings.hero = { mode: 'random', count: 5 };
  currentSection = 'general';
  renderSettingsNav();
  $('#saveHint').textContent = '';
  api.loadLibrary().then(lib => { dataDir = lib.dataDir; renderSettingsSection(); });
  showModal('settingsModal');
}

function renderSettingsNav() {
  const nav = $('#settingsNav');
  nav.innerHTML = '';
  for (const sec of SETTINGS_SECTIONS) {
    const div = document.createElement('div');
    div.className = 'nav-item' + (currentSection === sec.id ? ' active' : '');
    div.innerHTML = `<span>${sec.icon}</span> ${t(sec.nameKey)}`;
    div.onclick = () => { currentSection = sec.id; renderSettingsNav(); renderSettingsSection(); };
    nav.appendChild(div);
  }
}

const switchHtml = (id, checked) =>
  `<label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="slider"></span></label>`;

// ---------- 主题化下拉框 ----------
// 原生 <select> 的弹出列表是操作系统样式（白底 + 蓝色高亮），无法跟随主题，
// 这里用 div 自绘：面板色/边框/圆角走主题变量，悬停与选中态走主色。
// mountId: 占位容器 id；items: [{value,label}]；onChange(value) 选中回调
function themeSelect(mountId, items, value, onChange) {
  const mount = $('#' + mountId);
  if (!mount) return;
  const cur = items.find(i => i.value === value) || items[0];
  mount.classList.add('tselect');
  mount.innerHTML = `
    <button type="button" class="tselect-trigger" aria-haspopup="listbox">
      <span class="tselect-label">${escapeHtml(cur.label)}</span><span class="tselect-arrow">▾</span>
    </button>
    <div class="tselect-list hidden" role="listbox">
      ${items.map(i => `
        <div class="tselect-item ${i.value === value ? 'selected' : ''}" data-value="${escapeHtml(i.value)}" role="option">
          <span>${escapeHtml(i.label)}</span>${i.value === value ? '<span class="tselect-check">✓</span>' : ''}
        </div>`).join('')}
    </div>`;
  const trigger = mount.querySelector('.tselect-trigger');
  const list = mount.querySelector('.tselect-list');
  const close = () => { list.classList.add('hidden'); mount.classList.remove('open'); document.removeEventListener('click', onDoc, true); };
  const onDoc = (e) => { if (!mount.contains(e.target)) close(); };
  trigger.onclick = () => {
    const opening = list.classList.contains('hidden');
    // 先关掉其他打开的下拉
    document.querySelectorAll('.tselect-list').forEach(l => { l.classList.add('hidden'); l.parentElement.classList.remove('open'); });
    if (opening) {
      list.classList.remove('hidden');
      mount.classList.add('open');
      setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    } else close();
  };
  list.querySelectorAll('.tselect-item').forEach(it => {
    it.onclick = () => {
      const v = it.dataset.value;
      const item = items.find(i => i.value === v);
      mount.querySelector('.tselect-label').textContent = item.label;
      list.querySelectorAll('.tselect-item').forEach(x => {
        x.classList.toggle('selected', x === it);
        x.querySelector('.tselect-check')?.remove();
        if (x === it) x.insertAdjacentHTML('beforeend', '<span class="tselect-check">✓</span>');
      });
      close();
      onChange(v);
    };
  });
  mount._closeTSelect = close;
}

function renderSettingsSection() {
  const body = $('#settingsBody');
  const d = draftSettings;
  lockPending = null;   // 每次重渲染作废未保存的密码输入，防止串页

  if (currentSection === 'general') {
    body.innerHTML = `
      <h3>${t('secGeneral')}</h3>
      <p class="sec-desc">${state.settings.language === 'en' ? 'Playback and basic behavior. Click "Save" to apply.' : '播放与基础行为设置。改动后点击左下角「保存」生效。'}</p>
      <div class="setting-block">
        <div class="sb-label">${t('langLabel')}</div>
        <div id="sLang" style="width:220px"></div>
        <div class="sb-desc">${t('langDesc')}</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">${t('gPlayer')}</div>
        <div class="sb-desc">${t('gPlayerDesc')}</div>
        <div class="setting-inline">
          <input type="text" id="sPlayerPath" data-i18n-ph="gPlayerPh" placeholder="${t('gPlayerPh')}" value="${escapeHtml(d.playerPath || '')}">
          <button class="btn" id="btnBrowsePlayer">${t('gBrowse')}</button>
          <button class="btn" id="btnClearPlayer">${t('gClear')}</button>
        </div>
      </div>
      <div class="setting-block">
        <div class="sb-label">${t('gDataDir')}</div>
        <div class="sb-desc">${t('gDataDirDesc')}</div>
        <div class="setting-inline">
          <input type="text" value="${escapeHtml(dataDir)}" readonly>
          <button class="btn" id="btnOpenDataDir">${t('gOpen')}</button>
        </div>
      </div>`;
    themeSelect('sLang', [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' }
    ], d.language === 'en' ? 'en' : 'zh', (v) => {
      draftSettings.language = v;
      applyLanguage(v);   // 即时预览
      $('#saveHint').textContent = state.settings.language === 'en' ? 'Selected, remember to save' : '已选择，记得保存';
    });
    $('#btnBrowsePlayer').onclick = async () => {
      const p = await api.selectPlayer();
      if (p) { $('#sPlayerPath').value = p; draftSettings.playerPath = p; }
    };
    $('#btnClearPlayer').onclick = () => { $('#sPlayerPath').value = ''; draftSettings.playerPath = ''; };
    $('#sPlayerPath').oninput = (e) => { draftSettings.playerPath = e.target.value.trim(); };
    $('#btnOpenDataDir').onclick = () => api.openInShell(dataDir);
  }

  else if (currentSection === 'hero') {
    const h = d.hero || {};
    const mode = h.mode === 'favorite' ? 'favorite' : 'random';
    body.innerHTML = `
      <h3>${t('secHero')}</h3>
      <p class="sec-desc">主界面顶部轮播展示墙的选取逻辑。改动后点击左下角「保存」生效。</p>
      <div class="setting-block">
        <div class="sb-label">轮播逻辑</div>
        <div id="sHeroMode" style="width:340px"></div>
        <div class="sb-desc">「收藏」：把鼠标悬停在影片卡片上点 ♡ 按钮，或在详情页标题旁点 ♡。收藏模式下的展示条目会随你的收藏自动变化。</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">轮播影片数量</div>
        <div class="setting-inline">
          <input type="number" id="sHeroCount" min="1" max="20" step="1" value="${Math.max(1, Math.min(20, Number(h.count) || 5))}">
          <span class="sb-desc" style="margin:0">部（1-20，默认 5）</span>
        </div>
        <div class="sb-desc">收藏模式下若收藏数量少于该值，只展示已收藏的影片；若一部都没收藏，轮播区会隐藏。</div>
      </div>`;
    themeSelect('sHeroMode', [
      { value: 'random', label: '随机 — 从全部影片中随机选取' },
      { value: 'favorite', label: '我的收藏 — 只轮播点了「收藏」的影片' }
    ], mode, (v) => { draftSettings.hero.mode = v; });
    $('#sHeroCount').oninput = (e) => {
      const v = Math.max(1, Math.min(20, Number(e.target.value) || 5));
      draftSettings.hero.count = v;
    };
  }

  else if (currentSection === 'theme') {
    const th = d.theme || 'light';   // th：本页主题值（不要叫 t，会遮蔽全局翻译函数 t()）
    const wp = d.wallpaper || {};
    const wpImg = (url) => url
      ? `<img class="wp-preview" src="${escapeHtml(url)}">`
      : `<div class="wp-preview empty"></div>`;
    const card = (id, cls, name) => `
      <div class="theme-card ${th === id ? 'active' : ''}" data-theme-opt="${id}">
        <div class="theme-preview ${cls}"><div class="tp-bar"></div><div class="tp-side"></div><div class="tp-grid"><i></i><i></i><i></i></div></div>
        <div class="tc-name">${name}</div>
      </div>`;
    body.innerHTML = `
      <h3>${t('secTheme')}</h3>
      <p class="sec-desc">三种主题：浅白 / 暗黑（可自定义壁纸）、毛玻璃（系统级模糊，可看见并模糊背后内容）。点击卡片即时预览。</p>
      <div class="theme-cards">
        ${card('light', 'tp-light', '☀️ 浅白')}
        ${card('dark', 'tp-dark', '🌙 暗黑')}
        ${card('glass', 'tp-glass', '🧊 毛玻璃')}
      </div>
      <div class="setting-block" style="margin-top:16px">
        <div class="sb-label">主色</div>
        <div class="sb-desc">按钮、选中项、标签、进度条等强调色，默认浅绿。点击色块即时预览，点左下角「保存」永久生效。</div>
        <div class="accent-row" id="accentRow"></div>
      </div>
      <div class="setting-block" style="margin-top:16px">
        <div class="sb-label">全部视频排序</div>
        <div id="sLibSort" style="width:340px"></div>
        <div class="sb-desc">「全部视频」「收藏」「分类」等列表的排列方式；「首页」轮播下方固定为随机推荐，不受此项影响。改动后点「保存」生效。</div>
      </div>
      <div class="setting-block" style="margin-top:16px;display:${th === 'glass' ? '' : 'none'}">
        <div class="sb-label">背景色调浓度：<b id="tintVal">${d.glassTint ?? 35}</b>%（越大越暗、文字越清晰）</div>
        <input type="range" id="sGlassTint" min="0" max="90" step="5" value="${d.glassTint ?? 35}">
        <div class="sb-desc">毛玻璃由系统合成器模糊窗口背后的内容（Clash Verge 同款效果）；此滑块调节覆盖在其上的深色 tint 强度。</div>
      </div>
      <div style="display:${th === 'light' || th === 'dark' ? '' : 'none'}">
        <div class="setting-block" style="margin-top:14px">
          <div class="sb-label">浅白主题壁纸</div>
          ${wpImg(wp.light)}
          <button class="btn" id="btnPickWpLight">选择图片</button>
          <button class="btn" id="btnResetWpLight" ${wp.light ? '' : 'disabled'}>恢复默认</button>
        </div>
        <div class="setting-block">
          <div class="sb-label">暗黑主题壁纸</div>
          ${wpImg(wp.dark)}
          <button class="btn" id="btnPickWpDark">选择图片</button>
          <button class="btn" id="btnResetWpDark" ${wp.dark ? '' : 'disabled'}>恢复默认</button>
        </div>
      </div>
      ${th === 'glass' ? '<div class="setting-block"><div class="sb-desc">毛玻璃模式透视桌面，没有壁纸可换；若系统不支持会自动回退为内置渐变壁纸。</div></div>' : ''}`;

    body.querySelectorAll('.theme-card').forEach(el => {
      el.onclick = () => {
        draftSettings.theme = el.dataset.themeOpt;
        applyTheme(draftSettings.theme);
        applyWallpaper(draftSettings.wallpaper);
        renderSettingsSection();
        $('#saveHint').textContent = '已预览，记得保存';
      };
    });

    // 主色选择（点击即时预览，保存后持久化）
    const accentRow = $('#accentRow');
    if (accentRow) {
      const cur = String(d.accent || DEFAULT_ACCENT).toLowerCase();
      accentRow.innerHTML = ACCENT_PRESETS.map(p =>
        `<button class="accent-dot ${p.value.toLowerCase() === cur ? 'active' : ''}" data-accent="${p.value}" style="--c:${p.value}" title="${p.name}"></button>`
      ).join('');
      accentRow.querySelectorAll('.accent-dot').forEach(b => {
        b.onclick = () => {
          draftSettings.accent = b.dataset.accent;
          applyAccent(b.dataset.accent);
          accentRow.querySelectorAll('.accent-dot').forEach(x => x.classList.toggle('active', x === b));
          $('#saveHint').textContent = '已预览，记得保存';
        };
      });
    }

    // 全部视频排序
    const sortMount = $('#sLibSort');
    if (sortMount) {
      const sortItems = [
        { value: 'random', label: '随机 — 每次启动随机排列（默认）' },
        { value: 'newest', label: '最近优先 — 按文件时间从新到旧' },
        { value: 'name', label: '番号/名称 — 按字母数字顺序' }
      ];
      themeSelect('sLibSort', sortItems, librarySortMode(), (v) => {
        draftSettings.librarySort = v;
        $('#saveHint').textContent = '已选择，记得保存';
      });
    }

    // 毛玻璃：背景色调滑块（实时预览，直接改系统 tint）
    const tintSlider = $('#sGlassTint');
    if (tintSlider) {
      tintSlider.oninput = (e) => {
        const v = Number(e.target.value);
        draftSettings.glassTint = v;
        $('#tintVal').textContent = v;
        applyGlassTint('glass', v);
        $('#saveHint').textContent = '已预览，记得保存';
      };
    }

    // 壁纸选择（浅白/暗黑）
    const bindWp = (theme) => {
      const pick = $('#btnPickWp' + theme[0].toUpperCase() + theme.slice(1));
      const reset = $('#btnResetWp' + theme[0].toUpperCase() + theme.slice(1));
      if (pick) pick.onclick = async () => {
        const src = await api.selectImage();
        if (!src) return;
        const url = await api.setWallpaper({ theme, src });
        draftSettings.wallpaper[theme] = url;
        renderSettingsSection();
        if (document.body.dataset.theme === theme) {
          applyWallpaper(draftSettings.wallpaper);
          $('#saveHint').textContent = '已预览，记得保存';
        }
      };
      if (reset) reset.onclick = async () => {
        await api.resetWallpaper({ theme });
        draftSettings.wallpaper[theme] = '';
        renderSettingsSection();
        if (document.body.dataset.theme === theme) {
          applyWallpaper(draftSettings.wallpaper);
          $('#saveHint').textContent = '已恢复默认';
        }
      };
    };
    bindWp('light');
    bindWp('dark');
  }

  else if (currentSection === 'scrape') {
    const sc = d.scrape || {};
    body.innerHTML = `
      <h3>${t('secScrape')}</h3>
      <p class="sec-desc">元数据来源与自动刮削行为。刮削需要能访问外网，请在「网络」中配置代理。</p>
      <div class="setting-block">
        <div class="sb-label">刮削目录</div>
        <div class="sb-desc">影片所在文件夹，可添加多个。开启「监测」后，一旦有新文件进入目录会自动加入库并刮削。</div>
        <div class="dir-list" id="dirList"></div>
        <div class="setting-inline" style="margin-top:10px">
          <button class="btn" id="btnAddDir">＋ 添加目录</button>
          <button class="btn" id="btnScanDirs">⟳ 立即扫描全部</button>
          <span class="save-hint" id="dirHint"></span>
        </div>
      </div>
      <div class="setting-block">
        <div class="sb-label">刮削源</div>
        <div class="sb-desc">自动模式：FC2 番号（如 FC2-1423962 / FC2-PPV-1423962）自动走 FC2 专用链<br>（FC2 官方 → PPV Databank → FC2HUB 逐个兜底），其余番号走 JavBus。</div>
        <div id="sProvider" style="width:220px"></div>
      </div>
      <div class="setting-block">
        <div class="sb-label">源地址</div>
        <div class="sb-desc">站点被墙或更换域名时，可改为镜像地址。</div>
        <input type="text" id="sBaseUrl" value="${escapeHtml(sc.baseUrl || '')}" placeholder="https://www.javbus.com">
      </div>
      <div class="setting-block">
        <div class="setting-inline">
          <div style="flex:1">
            <div class="sb-label">导入后自动刮削</div>
            <div class="sb-desc">添加文件夹后自动按默认规则刮削一遍（取第一个结果），失败的可再手动刮削。</div>
          </div>
          ${switchHtml('sAutoScrape', !!sc.autoScrape)}
        </div>
      </div>
      <div class="setting-block">
        <div class="sb-label">请求超时（毫秒）</div>
        <div class="sb-desc">单次刮削请求的超时时间，网络差可适当调大。</div>
        <input type="number" id="sTimeout" value="${sc.timeout || 15000}" min="3000" max="60000" step="1000" style="width:140px">
      </div>
      <div class="setting-block">
        <div class="setting-inline">
          <div style="flex:1">
            <div class="sb-label">刮削结果归档到视频文件夹</div>
            <div class="sb-desc">开启后，封面/截图/元数据写入视频所在文件夹（cover.jpg、fanart-01.jpg…、metadata.json）；若该视频单独放在一个文件夹里，会自动新建同名文件夹并把视频移入。</div>
          </div>
          ${switchHtml('sArchive', sc.archiveToFolder !== false)}
        </div>
      </div>
      <div class="setting-block">
        <div class="setting-inline">
          <div style="flex:1">
            <div class="sb-label">Emby / Jellyfin 兼容输出</div>
            <div class="sb-desc">额外生成播放器能识别的本地元数据：<b>movie.nfo</b>（标题/番号/简介/演员/标签/评分/日期/片商/时长）+ <b>poster.jpg</b>（主图）+ <b>backdrop1.jpg…</b>（背景图，来自截图）。需先开启「归档到视频文件夹」；原文件与程序逻辑不受影响，图片优先用硬链接不额外占用空间。</div>
          </div>
          ${switchHtml('sEmby', !!sc.embyCompat)}
        </div>
        <div class="setting-inline" style="margin-top:10px">
          <button class="btn" id="btnEmbyExport">为已刮削影片补写</button>
          <span class="save-hint" id="embyHint">给库里已有刮削数据的影片补一份 Emby 元数据</span>
        </div>
        <div class="sb-note"><b>Emby 端建议</b>：库设置里把 NFO 读取器排到第一位，并关闭在线元数据抓取（或设为「仅本地」）——番号类影片在 TMDB 查不到，否则可能识别失败被自动改名。</div>
      </div>`;
    $('#sBaseUrl').oninput = (e) => { draftSettings.scrape.baseUrl = e.target.value.trim(); };
    themeSelect('sProvider', [
      { value: 'auto', label: '自动（推荐）' },
      { value: 'javbus', label: '仅 JavBus' },
      { value: 'fc2', label: '仅 FC2（官方/镜像）' }
    ], (!sc.provider || sc.provider === 'auto') ? 'auto' : sc.provider, (v) => { draftSettings.scrape.provider = v; });
    $('#sAutoScrape').onchange = (e) => { draftSettings.scrape.autoScrape = e.target.checked; };
    $('#sTimeout').oninput = (e) => { draftSettings.scrape.timeout = Number(e.target.value) || 15000; };
    $('#sArchive').onchange = (e) => { draftSettings.scrape.archiveToFolder = e.target.checked; };
    $('#sEmby').onchange = (e) => { draftSettings.scrape.embyCompat = e.target.checked; };
    $('#btnEmbyExport').onclick = async () => {
      $('#embyHint').textContent = '正在写入…';
      try {
        const r = await api.embyExport();
        $('#embyHint').textContent = `完成：写入 ${r.ok} 部` + (r.fail ? `，失败 ${r.fail} 部` : '') + (r.skip ? `，跳过 ${r.skip} 部（未刮削）` : '');
      } catch (err) {
        $('#embyHint').textContent = '失败：' + (err.message || err);
      }
    };
    renderDirList();
    $('#btnAddDir').onclick = async () => {
      const r = await api.addDirs();
      if (!r.added) return;
      draftSettings.dirs = r.dirs;
      state.settings.dirs = r.dirs;
      renderDirList();
      toast('已添加 ' + r.added + ' 个目录，正在扫描...');
      const s = await api.scanAllDirs();
      const lib = await api.loadLibrary();
      state.items = lib.items;
      renderAll();
      $('#dirHint').textContent = `新增 ${s.added} 个视频`;
    };
    $('#btnScanDirs').onclick = async () => {
      $('#dirHint').textContent = '扫描中...';
      const s = await api.scanAllDirs();
      const lib = await api.loadLibrary();
      state.items = lib.items;
      renderAll();
      $('#dirHint').textContent = `新增 ${s.added} 个` + (s.failed.length ? `，${s.failed.length} 个目录无法访问` : '');
    };
  }

  else if (currentSection === 'network') {
    const nw = d.network;
    body.innerHTML = `
      <h3>${t('secNetwork')}</h3>
      <p class="sec-desc">为刮削请求配置代理（支持 Clash Verge / Clash / v2rayN 等本地代理）。是否开启完全由你决定。</p>
      <div class="setting-block">
        <div class="setting-inline">
          <div style="flex:1">
            <div class="sb-label">启用代理</div>
            <div class="sb-desc">开启后，刮削的搜索、详情与封面下载均通过代理发出。</div>
          </div>
          ${switchHtml('sProxyEnabled', !!nw.proxyEnabled)}
        </div>
      </div>
      <div class="setting-block" id="proxyDetail" style="${nw.proxyEnabled ? '' : 'opacity:0.45;pointer-events:none'}">
        <div class="sb-label">代理模式</div>
        <div id="sProxyMode" style="width:220px"></div>
        <div class="sb-label" style="margin-top:12px">代理地址</div>
        <div class="sb-desc">格式 http://地址:端口。Clash Verge 默认混合端口为 7897。</div>
        <div class="setting-inline">
          <input type="text" id="sProxyUrl" value="${escapeHtml(nw.proxyUrl || '')}" placeholder="http://127.0.0.1:7897">
        </div>
        <div class="preset-btns">
          <button class="btn" data-preset="http://127.0.0.1:7897">Clash Verge (7897)</button>
          <button class="btn" data-preset="http://127.0.0.1:7890">Clash (7890)</button>
          <button class="btn" data-preset="http://127.0.0.1:10808">v2rayN (10808)</button>
          <button class="btn" data-preset="socks5://127.0.0.1:7897">SOCKS5 (7897)</button>
        </div>
      </div>
      <div class="setting-block">
        <div class="sb-label">测试连接</div>
        <div class="sb-desc">用当前填写（未保存亦可）的代理配置访问刮削源，检查是否连通。</div>
        <button class="btn primary" id="btnNetTest">测试连接</button>
        <div class="test-result" id="netTestResult"></div>
      </div>`;
    $('#sProxyEnabled').onchange = (e) => {
      draftSettings.network.proxyEnabled = e.target.checked;
      renderSettingsSection();
    };
    themeSelect('sProxyMode', [
      { value: 'manual', label: '手动指定地址' },
      { value: 'system', label: '跟随系统代理' }
    ], nw.proxyMode === 'system' ? 'system' : 'manual', (v) => { draftSettings.network.proxyMode = v; });
    $('#sProxyUrl').oninput = (e) => { draftSettings.network.proxyUrl = e.target.value.trim(); };
    body.querySelectorAll('[data-preset]').forEach(b => {
      b.onclick = () => { $('#sProxyUrl').value = b.dataset.preset; draftSettings.network.proxyUrl = b.dataset.preset; };
    });
    $('#btnNetTest').onclick = async () => {
      const el = $('#netTestResult');
      el.className = 'test-result';
      el.textContent = '测试中...';
      const target = (draftSettings.scrape && draftSettings.scrape.baseUrl) || 'https://www.javbus.com';
      const r = await api.netTest({
        url: target,
        proxy: { ...draftSettings.network }
      });
      if (r.ok) {
        el.className = 'test-result ok';
        el.textContent = `✅ 连接成功（HTTP ${r.status}，耗时 ${r.ms}ms）：${target}`;
      } else {
        el.className = 'test-result fail';
        el.textContent = `❌ 连接失败（${r.ms || '?'}ms）：${r.error || 'HTTP ' + r.status}。请确认代理软件已启动、端口正确，或代理已允许该站点。`;
      }
    };
  }

  else if (currentSection === 'privacy') {
    const lk = d.lock || (d.lock = { enabled: false, salt: '', hash: '' });
    lockPending = { pass: '', confirm: '' };   // 保存时读取；离开本页会自动清空
    body.innerHTML = `
      <h3>${t('secPrivacy')}</h3>
      <p class="sec-desc">本应用完全本地运行：库记录、设置、封面缓存都只保存在本机数据目录，不上传任何数据。</p>
      <div class="setting-block">
        <div class="setting-inline">
          <div style="flex:1">
            <div class="sb-label">🔒 启动密码锁</div>
            <div class="sb-desc">开启后每次打开软件都会先进入锁定界面（背景主界面模糊显示），输入正确密码才能使用。默认关闭。</div>
          </div>
          ${switchHtml('sLock', !!lk.enabled)}
        </div>
        <div id="lockSetup" style="display:${lk.enabled ? '' : 'none'};margin-top:14px">
          ${lk.enabled && lk.hash ? '<div class="sb-desc" style="color:var(--accent);margin-bottom:8px">🔐 密码锁已开启：下方留空直接保存 = 保持现有密码；输入新密码 = 更换密码。</div>' : ''}
          <div class="setting-inline">
            <input type="password" id="sLockPass" placeholder="${lk.enabled && lk.hash ? '输入新密码（留空保持不变）' : '设置启动密码（至少 4 位）'}" autocomplete="new-password">
          </div>
          <div class="setting-inline">
            <input type="password" id="sLockPass2" placeholder="再输入一次确认" autocomplete="new-password">
          </div>
          <div class="sb-desc">设置完成后点左下角「保存」，软件会自动重启并进入密码锁定状态。</div>
        </div>
      </div>
      <div class="setting-block">
        <div class="sb-label">🔑 忘记密码了？</div>
        <div class="sb-desc">别担心，密码锁只存在本机，就保存在数据目录的 <code>settings.json</code> 文件里（名为 <code>"lock"</code> 的字段），删掉它就能解除：<br>
        · <b>推荐做法</b>：用记事本打开 <code>settings.json</code>，找到整段 <code>"lock": { ... }</code> 并删除（如果上一行行尾有逗号，记得一起去掉，否则文件会失效），保存后重启软件即可<br>
        · <b>省事做法</b>：直接删除整个 <code>settings.json</code> —— 主题、刮削目录等设置会回到默认，但媒体库记录和视频文件完全不受影响<br>
        📂 数据目录位置：「通用 → 数据目录」，点旁边的「打开」按钮直达。</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">清除封面缓存</div>
        <div class="sb-desc">删除已下载的封面文件并清空条目封面字段，下次刮削会重新下载。</div>
        <button class="btn" id="btnClearCovers">清除</button>
      </div>
      <div class="setting-block">
        <div class="sb-label">清空媒体库</div>
        <div class="sb-desc">删除所有条目记录（不删除视频文件本身），不可恢复，请谨慎操作。</div>
        <button class="btn danger" id="btnClearLibrary">清空</button>
      </div>`;
    $('#sLock').onchange = (e) => {
      lk.enabled = e.target.checked;
      $('#lockSetup').style.display = lk.enabled ? '' : 'none';
    };
    $('#sLockPass').oninput = (e) => { if (lockPending) lockPending.pass = e.target.value; };
    $('#sLockPass2').oninput = (e) => { if (lockPending) lockPending.confirm = e.target.value; };
    $('#btnClearCovers').onclick = async () => {
      if (!confirm('确定清除所有封面缓存？')) return;
      const n = await api.clearCovers();
      state.items = (await api.loadLibrary()).items;
      renderGrid(); renderCounts();
      toast(`已清除 ${n} 个封面缓存`);
    };
    $('#btnClearLibrary').onclick = async () => {
      if (!confirm('确定清空媒体库所有记录？视频文件不会被删除，但记录不可恢复。')) return;
      await api.clearLibrary();
      state.items = [];
      hideModal('settingsModal');
      renderAll();
      toast('媒体库已清空');
    };
  }

  else if (currentSection === 'about') {
    const ua = navigator.userAgent.match(/Electron\/([\d.]+)/);
    const chip = (t) => `<span class="about-chip">${t}</span>`;
    body.innerHTML = `
      <h3>${t('secAbout')}</h3>
      <p class="sec-desc"></p>
      <div class="setting-block">
        <div class="sb-label">我的影音库 <span style="color:var(--text-dim);font-size:12px">v0.1.0</span></div>
        <div class="sb-desc">一款注重隐私的本地影片库管理工具：卡片墙浏览 · 首页轮播 · 交互式刮削 · 外部播放器调用 · 浅白/暗黑/毛玻璃三主题。</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">使用场景</div>
        <div class="sb-desc">· <b>硬盘 / NAS 影片整理</b>：把分散的文件夹导入媒体库，自动按番号刮削封面、演员、标签、剧情简介，归档为「视频 + 封面 + 截图 + 元数据」的标准文件夹<br>
        · <b>找片看片</b>：首页轮播随机推荐、按收藏/分类/标签筛选、全字段搜索（片名 / 番号 / 演员 / 分类 / 标签），一键调用 mpv、PotPlayer 等外部播放器播放<br>
        · <b>收藏与回顾</b>：收藏喜欢的影片，轮播可设为只展示收藏；删除走系统回收站，误删可恢复<br>
        · <b>隐私优先</b>：所有数据（库记录、设置、封面缓存）只存在本机数据目录，不联网上传，可在「隐私」中随时清除</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">技术实现</div>
        <div class="about-chips">${chip('Electron ' + (ua ? ua[1] : '33'))}${chip('原生 HTML / CSS / JS（无前端框架）')}${chip('Node.js 主进程 + IPC 白名单')}${chip('koffi FFI · Windows DWM 系统级毛玻璃')}${chip('fs.watch 目录实时监测')}${chip('系统回收站 API')}${chip('多源刮削引擎（JavBus + FC2 多级兜底链）')}</div>
        <div class="sb-desc">界面基于 Electron（Chromium 渲染 + Node.js 主进程），未使用前端框架，纯原生实现保证轻量与可维护性；主进程与渲染进程通过 preload 白名单通信，安全隔离。<br>
        毛玻璃主题通过 koffi FFI 直接调用 Windows DWM 的 SetWindowCompositionAttribute，实现系统级 Acrylic/Blur 背景模糊（由系统合成器负责，性能优于页面内 CSS 模糊）。<br>
        刮削引擎参考开源项目 JavBoss / mdcz 的思路自研：按番号自动路由到 JavBus（有码/无码）或 FC2 专用多级兜底链（FC2 官方 → PPV Databank → FC2PPVDB → JavDB → Javten），内置隐藏浏览器窗口穿越 Cloudflare 验证，支持代理；刮削结果交由用户确认后才写入。</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">设计思路</div>
        <div class="sb-desc">· <b>零侵入</b>：不改动你的视频文件本身（归档除外），所有数据写入独立数据目录，删除程序即可完全还原<br>
        · <b>人来确认</b>：自动刮削只做候选推荐，采用哪个结果始终由用户决定<br>
        · <b>界面即主题</b>：主题与主色由全局 CSS 变量驱动，右键菜单等每个控件都跟随主题变化</div>
      </div>
      <div class="setting-block">
        <div class="sb-label">使用提示</div>
        <div class="sb-desc">· 刮削失败时先到「网络」里测试连接、配置代理<br>
        · 「刮削失败」分类里的条目可逐个手动重刮<br>
        · 所有记录仅存本机，可在「隐私」中随时清除</div>
      </div>`;
  }
}

// 刮削目录列表（设置 → 刮削）
function renderDirList() {
  const box = $('#dirList');
  if (!box) return;
  const dirs = draftSettings.dirs || [];
  if (!dirs.length) {
    box.innerHTML = '<div class="dir-empty">还没有刮削目录，点下方「＋ 添加目录」选择影片所在文件夹</div>';
    return;
  }
  box.innerHTML = '';
  dirs.forEach(d => {
    const row = document.createElement('div');
    row.className = 'dir-row';
    const p = document.createElement('span');
    p.className = 'dir-path'; p.textContent = d.path; p.title = d.path;
    const watchWrap = document.createElement('label');
    watchWrap.className = 'dir-watch';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!d.watch;
    watchWrap.appendChild(cb);
    watchWrap.appendChild(document.createTextNode(' 监测'));
    cb.onchange = async () => {
      const list = await api.setDirWatch({ dirPath: d.path, watch: cb.checked });
      draftSettings.dirs = list; state.settings.dirs = list;
      toast(cb.checked ? '已开启监测：新文件会自动入库刮削' : '已关闭监测');
    };
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'btn dir-rm'; rm.textContent = '移除';
    rm.onclick = () => askRemoveDir(d);
    row.appendChild(p); row.appendChild(watchWrap); row.appendChild(rm);
    box.appendChild(row);
  });
}

let pendingDirRemove = null;
function askRemoveDir(d) {
  pendingDirRemove = d;
  $('#dirDelList').innerHTML = `<div class="del-row"><span>目录</span><code>${escapeHtml(d.path)}</code></div>`;
  $('#dirDelAlsoItems').checked = false;
  showModal('dirDelModal');
}

async function doRemoveDir() {
  const d = pendingDirRemove;
  if (!d) return;
  const alsoItems = $('#dirDelAlsoItems').checked;
  const list = await api.removeDir(d.path);
  draftSettings.dirs = list;
  state.settings.dirs = list;
  pendingDirRemove = null;
  hideModal('dirDelModal');
  if (alsoItems) {
    await api.removeByPrefix(d.path);
    const lib = await api.loadLibrary();
    state.items = lib.items;
  }
  renderDirList();
  renderAll();
  toast('已移除目录：' + d.path);
}

async function saveSettingsDraft() {
  // 启动密码锁：开启时校验密码输入并生成哈希（哈希由主进程落盘）
  let needRestart = false;
  if (draftSettings.lock && draftSettings.lock.enabled) {
    const typed = lockPending && (lockPending.pass || lockPending.confirm);
    if (typed) {
      if ((lockPending.pass || '').length < 4) {
        $('#saveHint').textContent = '密码至少 4 位';
        toast('启动密码至少需要 4 位');
        return;
      }
      if (lockPending.pass !== lockPending.confirm) {
        $('#saveHint').textContent = '两次输入的密码不一致';
        toast('两次输入的密码不一致，请检查');
        return;
      }
      const r = await api.setLockPassword(lockPending.pass);
      draftSettings.lock = { enabled: true, salt: r.salt, hash: r.hash };
    } else if (!draftSettings.lock.hash) {
      $('#saveHint').textContent = '请先设置启动密码';
      toast('请先输入要设置的启动密码');
      return;
    }
    needRestart = true;
  } else if (draftSettings.lock) {
    // 关闭密码锁：清掉盐和哈希（重启后不再锁定）
    draftSettings.lock = { enabled: false, salt: '', hash: '' };
  }

  await api.saveSettings(draftSettings);
  state.settings = draftSettings;
  applyTheme(state.settings.theme || 'light');
  applyAccent(state.settings.accent);
  hero._sig = null;          // 轮播配置可能变了，强制重新选取
  state._shuffleSig = null;  // 排序设置可能变了，强制重新洗牌
  renderHero();
  renderGrid();

  // 刚开启/更换了启动密码锁 → 重启进入锁定状态
  if (needRestart) {
    $('#saveHint').textContent = '已保存，正在重启…';
    toast('密码锁已开启，软件即将重启 🔒');
    await new Promise(r => setTimeout(r, 1200));
    api.restartApp();
    return;
  }
  $('#saveHint').textContent = '已保存 ✓';
  toast('设置已保存');
}

// ---------- 工具 ----------
function showModal(id) { $('#' + id).classList.remove('hidden'); }
function hideModal(id) { $('#' + id).classList.add('hidden'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 展示标题：番号在前、标题在后；标题里已经带番号（忽略分隔符/PPV字样）时不重复
function displayTitle(it) {
  const title = String(it?.title || it?.name || '').trim();
  const code = String(it?.code || '').trim();
  if (!code) return title;
  const norm = (s) => s.toLowerCase().replace(/ppv/g, '').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  if (!title || norm(title).includes(norm(code))) return title;
  return `${code} ${title}`;
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}
