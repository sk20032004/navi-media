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

module.exports = { scanFolder, parseCode, VIDEO_EXT };
