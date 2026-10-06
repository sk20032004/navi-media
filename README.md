# 我的影音库 (NaviMedia)

一个 **纯本地运行** 的 Emby 风格影音库，基于 Electron 构建。卡片墙浏览、交互式刮削、内置密码锁与毛玻璃效果——所有数据都留在你自己的电脑上。

![icon](build/icon.png)

## 特性

- **卡片墙 + 轮播横幅**：封面按 3:2 统一展示，支持搜索、排序、收藏与分页，上万条目依然流畅
- **交互式刮削**：输入番号自动抓取标题、简介、演员、标签、评分与截图；FC2 与无码番号走专用兜底链，支持配置代理
- **自动归档**：刮削结果写入视频同名文件夹（`cover.jpg` / `fanart-01.jpg…` / `metadata.json`），散落视频自动归位
- **Emby / Jellyfin 兼容输出**（可选）：一键生成 `movie.nfo` + `poster.jpg` + `backdrop1.jpg…`，刮削数据可直接被 Emby、Jellyfin 等播放器读取，图片优先用硬链接不占额外空间
- **截图画廊**：左键点卡片直接浏览刮削到的剧照，支持键盘翻页与全屏缩放
- **目录监测**：把影片文件夹加入「刮削目录」并开启监测后，新文件自动入库并刮削
- **右键快捷操作**：播放 / 收藏 / 编辑信息 / 刮削信息 / 打开文件位置 / 删除（进系统回收站，可反悔）
- **三套主题**：浅白 / 暗黑 / 毛玻璃（Win32 BlurBehind），8 种主题色可选，中英文界面切换
- **隐私保护**：可选启动密码锁；删除文件先进回收站；程序不联网上传任何数据（刮削请求除外）
- **效果演示**：
- <img width="1356" height="856" alt="demo1" src="https://github.com/user-attachments/assets/60e07c6b-add6-48a3-acb8-13b716290f4d" />
<img width="972" height="675" alt="setting" src="https://github.com/user-attachments/assets/ef74584e-958c-46fc-b2f1-fcb69cda5e9e" />

## 下载安装

到 [Releases](../../releases) 页面下载：

| 文件 | 说明 |
|---|---|
| `NaviMedia-Setup-x.y.z.exe` | 安装版，双击安装，可选安装目录，自动创建桌面/开始菜单快捷方式 |
| `NaviMedia-Portable-x.y.z.exe` | 便携版，单文件直接运行，无需安装 |

- 仅支持 **Windows x64**（Win10 及以上）
- 数据默认保存在 `%APPDATA%\navi-media\data`；若检测到旧版数据目录 `E:\JavManger`（含已有库文件）会自动沿用，也可用环境变量 `NAVI_DATA_DIR` 指定任意目录（如 U 盘）

## 从源码运行

```bash
npm install
npm start          # 正常启动
npm run start:safe # GPU 不可用时软件渲染兜底
```

## 打包

```bash
npm run dist            # 同时构建安装版 + 便携版
npm run dist:installer  # 仅 NSIS 安装包
npm run dist:portable   # 仅便携版
```

产物输出到 `dist/`。

## 技术栈

Electron 33 · 原生 JavaScript / CSS（无前端框架）· koffi（FFI 调用 Win32 实现毛玻璃）

## 免责声明

本程序仅提供本地媒体文件的管理与展示功能，刮削源为公开网站，请仅用于管理你拥有合法权利的影音内容。

## License

[MIT](LICENSE)
