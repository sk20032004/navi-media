const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 窗口
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  // 文件
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectPlayer: () => ipcRenderer.invoke('dialog:selectPlayer'),
  scanFolder: (p) => ipcRenderer.invoke('scan:folder', p),
  openInShell: (p) => ipcRenderer.invoke('shell:open', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  sysUsage: () => ipcRenderer.invoke('sys:usage'),
  embyExport: () => ipcRenderer.invoke('scrape:embyExport'),
  // 库
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveItems: (items) => ipcRenderer.invoke('library:saveItems', items),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  onLibraryChanged: (cb) => ipcRenderer.on('library:changed', (e, info) => cb(info)),
  // 刮削目录管理 + 监测
  listDirs: () => ipcRenderer.invoke('dirs:list'),
  addDirs: () => ipcRenderer.invoke('dirs:add'),
  removeDir: (p) => ipcRenderer.invoke('dirs:remove', p),
  setDirWatch: (payload) => ipcRenderer.invoke('dirs:setWatch', payload),
  scanAllDirs: () => ipcRenderer.invoke('dirs:scanAll'),
  removeByPrefix: (p) => ipcRenderer.invoke('library:removeByPrefix', p),
  onScrapeProgress: (cb) => ipcRenderer.on('scrape:progress', (e, p) => cb(p)),
  // 删除影片（整个影片文件夹移到系统回收站）
  deleteMedia: (videoPath) => ipcRenderer.invoke('media:delete', videoPath),
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashPurgeData: (videoPath) => ipcRenderer.invoke('trash:purgeData', videoPath),
  trashPurgeFiles: (videoPath) => ipcRenderer.invoke('trash:purgeFiles', videoPath),
  // 毛玻璃（系统级 acrylic）实时开关/色调
  setGlassTint: (p) => ipcRenderer.invoke('glass:setTint', p),
  onAcrylic: (cb) => ipcRenderer.on('glass:acrylic', (e, ok) => cb(ok)),
  // 播放
  openPlayer: (filePath, playerPath) => ipcRenderer.invoke('player:open', filePath, playerPath),
  // 刮削
  scrapeSearch: (payload) => ipcRenderer.invoke('scrape:search', payload),
  scrapeApply: (payload) => ipcRenderer.invoke('scrape:apply', payload),
  fetchAlias: (item) => ipcRenderer.invoke('scrape:alias', item),
  // 用户图片（添加到详情图集，支持裁切）
  pickImages: () => ipcRenderer.invoke('dialog:pickImages'),
  imageDataUrl: (p) => ipcRenderer.invoke('image:dataUrl', p),
  saveUserImage: (payload) => ipcRenderer.invoke('image:saveUser', payload),
  // 用户自定义封面（选图 → 按封面比例裁切 → 保存）
  saveCoverImage: (payload) => ipcRenderer.invoke('image:saveCover', payload),
  // 网络 / 隐私
  netTest: (payload) => ipcRenderer.invoke('net:test', payload),
  clearCovers: () => ipcRenderer.invoke('privacy:clearCovers'),
  clearLibrary: () => ipcRenderer.invoke('library:clearAll'),
  // 启动密码锁（校验在主进程，渲染层不接触哈希）
  setLockPassword: (pw) => ipcRenderer.invoke('lock:setPassword', pw),
  verifyLock: (pw) => ipcRenderer.invoke('lock:verify', pw),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  // 壁纸
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  setWallpaper: (payload) => ipcRenderer.invoke('wallpaper:set', payload),
  resetWallpaper: (payload) => ipcRenderer.invoke('wallpaper:reset', payload),
  // 推送
  onUpdateItem: (cb) => ipcRenderer.on('item:update', (e, item) => cb(item))
});
