const fsp = require('fs').promises;
const path = require('path');

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.wmv', '.mov', '.rmvb', '.rm', '.ts', '.m2ts',
  '.webm', '.flv', '.iso', '.mpg', '.mpeg', '.m4v', '.vob', '.3gp'
]);

const CODE_BLACKLIST = new Set([
  'H264', 'H265', 'HEVC', 'X264', 'X265', 'AV1', 'AAC', 'MP4', 'MKV', 'AVC',
  '10BIT', '8BIT', 'UHD', 'HDR', 'DV', 'WEB', 'WEBDL', 'REMUX', 'HYBRID',
  'CHS', 'CHT', 'BIG5', 'GB', 'SD', 'HD', 'CD', 'DVD', 'BDMV', 'DIY', 'FHD'
]);

/**
 * 从文件名解析番号
 * 支持: ABC-123 / ABC123 / FC2-PPV-1234567 等
 */
function parseCode(name) {
  const base = String(name).replace(/\.[^.]+$/, '');
  let m = base.match(/(?:fc2|fc2ppv)[-_ ]*(?:ppv[-_ ]*)?(\d{5,8})/i);
  if (m) return 'FC2-PPV-' + m[1];

  m = base.match(/(^|[^A-Za-z0-9])([A-Za-z]{2,6})-?(\d{2,5})(?!\d*[pP])/);
  if (m) {
    const letters = m[2].toUpperCase();
    const digits = m[3];
    if (!CODE_BLACKLIST.has(letters) && digits.length >= 2) {
      return letters + '-' + digits;
    }
  }
  return '';
}

/** 递归扫描目录下的视频文件（跳过 . 开头目录，深度限制 8） */
async function scanFolder(dir, depth = 0) {
  if (depth > 8) return [];
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await scanFolder(full, depth + 1)));
    } else if (VIDEO_EXT.has(path.extname(ent.name).toLowerCase())) {
      let st = null;
      try { st = await fsp.stat(full); } catch { continue; }
      out.push({
        path: full,
        name: ent.name,
        size: st.size,
        mtime: st.mtimeMs
      });
    }
  }
  return out;
}

const ASSET_META = 'metadata.json';
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tbn']);

/**
 * 反向读取刮削资产：视频所在目录（或它的同名子目录）里的 metadata.json。
 *
 * 用途：重新扫描目录、库索引丢失、换电脑/换盘后重建库时，把已经刮好的
 * 标题 / 演员 / 标签 / 简介 / 封面 / 截图原样读回来，避免重新刮削一遍。
 * 只返回目录内真实存在的文件，不写任何东西，绝对路径不落盘。
 *
 * @returns {{meta:object, dir:string, coverName:string, previews:string[]}|null}
 */
async function readSidecarMeta(videoPath) {
  const parent = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const videoBase = path.basename(videoPath).toLowerCase();

  for (const dir of [parent, path.join(parent, stem)]) {
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, ASSET_META), 'utf-8'));
    } catch {
      continue;   // 读不到 / 不是合法 JSON，继续找下一处
    }
    if (!meta || typeof meta !== 'object') continue;

    let files = [];
    try { files = await fsp.readdir(dir); } catch {}
    const isImg = (f) => IMG_EXT.has(path.extname(f).toLowerCase());
    const vids = files.filter(f => VIDEO_EXT.has(path.extname(f).toLowerCase()));

    // 归属判定：metadata 只认「属于当前这个视频」的那份，避免同目录多视频时张冠李戴
    //  - 记了 videoFile 且能在目录里找到 → 必须就是当前视频
    //  - 记了 videoFile 但找不到（改过名）→ 仅当目录里只有当前这一个视频时才认
    //  - 没记 videoFile → 目录里只有一个视频时才认
    const vf = String(meta.videoFile || '').toLowerCase();
    if (vf) {
      if (vids.length) {
        const has = vids.some(f => f.toLowerCase() === vf);
        if (has) {
          if (vf !== videoBase) continue;
        } else if (vids.length !== 1 || vids[0].toLowerCase() !== videoBase) {
          continue;
        }
      }
      // 目录里没有视频（视频还在外面的同名子目录场景）→ 接受
    } else if (vids.length > 1 || (vids.length === 1 && vids[0].toLowerCase() !== videoBase)) {
      continue;
    }

    const metaCover = String(meta.cover || '');
    const coverName = (metaCover && isImg(metaCover) && files.includes(metaCover))
      ? metaCover
      : files.find(f => /^cover[-_A-Za-z0-9]*\./.test(f) && isImg(f)) || '';
    // 截图：刮削的 fanart-01… 排在前，用户手动加的 fanart-user* 排在后
    const previews = files
      .filter(f => /^fanart(-user\d+|-\d+)?\./i.test(f) && isImg(f))
      .map(f => ({ f, user: /-user/i.test(f) ? 1 : 0, n: parseInt((/(\d+)/.exec(f) || [0, 0])[1], 10) }))
      .sort((a, b) => (a.user - b.user) || (a.n - b.n))
      .map(o => o.f);

    return { meta, dir, coverName, previews };
  }
  return null;
}

module.exports = { scanFolder, parseCode, readSidecarMeta, VIDEO_EXT };
