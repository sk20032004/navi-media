/**
 * 刮削器：可插拔 provider 架构
 * 内置 javbus HTML 解析 provider（best-effort，站点改版可能需要调整正则）。
 * searchCandidates(code, scrapeConfig) => [{ code, title, coverUrl, date, actresses, detailUrl, provider }]
 * downloadImage(url, dir, name) => 本地文件名
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// DMM/JavBus 的 "NOW PRINTING" 占位图（站方没有真预览图时返回的同一张灰图），按内容哈希识别
const PLACEHOLDER_SHAS = new Set([
  'efea457c7fc0fae1eb0ec93f4f719189e38b0679cac47c11b829740d9b5675d8', // 2732 字节变体
  '47b17ea7d673b39ec9136b54e4ae257e95552d03e8c164b2c1770a1c49723560'  // 2918 字节变体
]);
function isPlaceholderImage(buf) {
  if (!buf || buf.length < 1024) return true;             // 过小 = 无效
  if (PLACEHOLDER_SHAS.has(crypto.createHash('sha256').update(buf).digest('hex'))) return true;
  return false;
}

// fetch 实现：默认 Node 全局 fetch；主进程可注入 net.fetch（走 Electron 会话代理）
let doFetch = (...args) => fetch(...args);
function setFetchImpl(fn) { doFetch = fn; }
// 浏览器兜底：主进程注入的隐藏窗口抓取（Cloudflare 挑战页用），可为空
let browserFetchText = null;
function setBrowserFetch(fn) { browserFetchText = fn; }

const CF_MARK = /just a moment|challenge-platform|cf-browser-verification|cf_chl_opt|请稍候/i;

async function fetchText(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await doFetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cookie': 'existmag=all'
      },
      signal: ctrl.signal,
      redirect: 'follow'
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    // 排障用：NAVI_DUMP_HTML=<目录> 时把最近一次响应原文落盘，便于核对站点改版后的选择器
    if (process.env.NAVI_DUMP_HTML) {
      try {
        const fsx = require('fs'), pathx = require('path');
        const dirx = process.env.NAVI_DUMP_HTML;
        fsx.mkdirSync(dirx, { recursive: true });
        const name = 'dump-' + Date.now() + '.html';
        fsx.writeFileSync(pathx.join(dirx, name), '<!-- ' + url + ' -->\n' + text);
      } catch {}
    }
    return text;
  } finally {
    clearTimeout(t);
  }
}

/**
 * fetchText 的智能版：响应是 Cloudflare 挑战页 / 403 / 5xx 时，
 * 若主进程注入了 browserFetchText（隐藏窗口），用它重试一次。
 */
async function fetchTextSmart(url, timeout = 15000) {
  try {
    const text = await fetchText(url, timeout);
    if (CF_MARK.test(text.slice(0, 5000))) throw new Error('CF challenge page');
    return text;
  } catch (e) {
    const st = e.status || 0;
    const retriable = st === 403 || st === 429 || st === 503 || st === 526 || /CF challenge/.test(String(e.message || e));
    if (retriable && browserFetchText) return await browserFetchText(url, timeout);
    throw e;
  }
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ---------- javbus provider ----------

/** 解析搜索结果列表页 */
function parseJavbusSearch(html, baseUrl) {
  const results = [];
  // 每个 <a class="movie-box" href="DETAIL"> ... <img src="..." title="...">
  const re = /<a[^>]*class="movie-box"[^>]*href="([^"]+)"([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[2];
    const img = block.match(/<img[^>]*src="([^"]+)"/);
    const title = block.match(/title="([^"]+)"/);
    // 无码区等版面的链接可能是相对路径，统一转绝对
    let detailUrl = m[1];
    try { detailUrl = new URL(m[1], baseUrl || 'https://www.javbus.com').href; } catch {}
    results.push({
      detailUrl,
      coverUrl: img ? new URL(img[1], baseUrl || 'https://www.javbus.com').href : '',
      title: title ? stripTags(title[1]) : '',
      provider: 'javbus'
    });
  }
  return results;
}

/** 解析详情页 */
function parseJavbusDetail(html, detailUrl) {
  const out = { provider: 'javbus', detailUrl };
  const title = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  if (title) out.title = stripTags(title[1]);

  const cover = html.match(/<a[^>]*class="bigImage"[^>]*href="([^"]+)"/);
  if (cover) out.coverUrl = new URL(cover[1], detailUrl).href;

  const code = html.match(/识别码[:：]?<\/span>\s*<span[^>]*>([^<]+)</);
  if (code) out.code = code[1].trim();

  const date = html.match(/发行时间[:：]?<\/span>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (date) out.date = date[1];

  const actresses = new Set();
  const starRe = /\/star\/[^"]+">([^<]+)<\/a>/g;
  let sm;
  while ((sm = starRe.exec(html)) !== null) {
    const n = stripTags(sm[1]);
    if (n) actresses.add(n);
  }
  out.actresses = [...actresses];

  // 元数据（col-md-3 info 块）：导演/制作商/发行商/长度/类别
  const metaSeg = (html.match(/<div class="col-md-3 info"[^>]*>[\s\S]*?<h4[^>]*id="star-hide"/) || [''])[0]
    || (html.match(/<div class="col-md-3 info"[^>]*>[\s\S]*?star-show/) || [''])[0];
  const metaPick = (label) => {
    const m = metaSeg.match(new RegExp('(?:' + label + ')[:：]<\\/span>\\s*(?:<a[^>]*>)?([^<]+)'));
    return m ? stripTags(m[1]) : '';
  };
  out.director = metaPick('導演|导演');
  out.studio = metaPick('製作商|制作商');
  out.publisher = metaPick('發行商|发行商');
  const durM = metaSeg.match(/長度[:：]<\/span>\s*([0-9]+)/) || metaSeg.match(/长度[:：]<\/span>\s*([0-9]+)/);
  if (durM) out.duration = Number(durM[1]);
  const genres = [];
  let gm;
  const genreRe = /\/genre\/[^"]*"[^>]*>([^<]+)<\/a>/g;
  while ((gm = genreRe.exec(metaSeg)) !== null) {
    const t = stripTags(gm[1]);
    if (t) genres.push(t);
  }
  if (genres.length) out.tags = genres;

  // 预览截图：sample-box 链接指向大图，内部 <img> 是缩略图（站点改版可能需调整）。
  // 大图在站方缺图时会返回 "NOW PRINTING" 占位图，故同时记录缩略图作为备用源。
  const previews = [];
  let pm;
  const pvRe = /<a[^>]*class="sample-box"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/g;
  while ((pm = pvRe.exec(html)) !== null) {
    try {
      previews.push({
        url: new URL(pm[1], detailUrl).href,
        thumb: pm[2] ? new URL(pm[2], detailUrl).href : ''
      });
    } catch {}
  }
  if (previews.length) out.previews = previews;

  // 简介：优先取页面上的剧情简介（部分版本为 col-md-12 info 纯文本块）；
  // JavBus 大多数页面没有正文简介 → 用元数据合成一份详情式简介
  let prose = '';
  const blocks = html.match(/<div class="col-md-12 info"[^>]*>[\s\S]*?<\/div>/g) || [];
  for (const blk of blocks) {
    if (/<(label|img)\b|<a[\s>]/.test(blk)) continue;
    if (/識別碼|识别码|發行|发行|長度|长度|類別|类别|製作|制作/.test(blk)) continue;
    const txt = stripTags(blk);
    if (txt && txt.length >= 15) { prose = txt; break; }
  }
  const meta = [];
  if (out.director) meta.push('导演：' + out.director);
  if (out.studio) meta.push('制作商：' + out.studio);
  if (out.publisher) meta.push('发行商：' + out.publisher);
  if (out.duration) meta.push('时长：' + out.duration + ' 分钟');
  if (genres.length) meta.push('类别：' + genres.join(' / '));
  out.synopsis = prose || meta.join('\n');
  return out;
}

async function javbusSearch(code, cfg) {
  const base = (cfg && cfg.baseUrl) || 'https://www.javbus.com';
  const timeout = (cfg && cfg.timeout) || 15000;
  // 先搜有码区；无结果再搜无码区（HEYZO/加勒比 等无码番号不在有码索引里）
  let list = [];
  try {
    const html = await fetchText(`${base}/search/${encodeURIComponent(code)}&type=1&parent=ce`, timeout);
    list = parseJavbusSearch(html, base);
  } catch {}
  if (!list.length) {
    const html = await fetchText(`${base}/uncensored/search/${encodeURIComponent(code)}&type=1&parent=uncensored`, timeout);
    list = parseJavbusSearch(html, base);
  }
  // 补全详情
  const top = list.slice(0, 8);
  const detail = await Promise.allSettled(
    top.map(it => fetchText(it.detailUrl, timeout).then(h => parseJavbusDetail(h, it.detailUrl)))
  );
  return detail.map((d, i) => {
    const cand = d.status === 'fulfilled'
      ? { ...top[i], ...d.value }
      : top[i];
    cand.code = cand.code || code;
    if (!cand.title) cand.title = code;
    return cand;
  });
}

// ---------- FC2 系列（参考 ShotHeadman/mdcz 的实现） ----------
// FC2 与普通 JAV 番号不同：站点的商品 ID 就是一串数字（如 1423962），
// mdcz 的做法是「数字归一化 + 站点专属解析」，并准备多个 FC2 数据源互相兜底：
//   ① FC2 官方 adult.contents.fc2.com/article/<数字>/  —— 信息最全（卖家/标签/剧照）
//   ② ppvdatabank.com/article/<数字>/                —— 官方站镜像库，含卖家/时长/剧照
//   ③ javten.com（FC2HUB）search?kw=<数字>            —— 有 JSON-LD，含演员/评分
// 输出统一为 FC2-<数字> 形态的番号。

/** FC2 番号识别：FC2-1423962 / FC2-PPV-1423962 / FC2PPV1423962 都算 */
function isFc2Code(code) {
  return /^fc2([-_ ]?ppv)?[-_ ]*\d{5,8}$/i.test(String(code || '').trim());
}

/** FC2 数字归一化（mdcz: normalizeFc2Number）：去掉 FC2/PPV/连字符，只留数字 */
function normalizeFc2Number(code) {
  const m = String(code || '').toUpperCase()
    .replace(/FC2PPV/g, '')
    .replace(/FC2-PPV/g, '')
    .replace(/FC2[-_ ]?/g, '')
    .match(/\d{5,8}/);
  return m ? m[0] : '';
}

/** 取 marsection 起始处起 len 长度的 HTML 片段（无 cheerio，用轻量定位替代） */
function sliceAfter(html, marker, len = 4000) {
  const i = html.indexOf(marker);
  return i < 0 ? '' : html.slice(i, i + len);
}

/** 从 "00:12:34" / "12:34" 形式的时长文本解析分钟数 */
function clockToMinutes(text) {
  const m = String(text || '').match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const total = (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) / 60;
  return Math.max(1, Math.round(total));
}

/** 从 "2024/05/06" / "2024-05-06" 解析日期为 YYYY-MM-DD */
function parseAnyDate(text) {
  const m = String(text || '').match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 收集片段内所有 <a href="URL">文本</a>（含可选内层 img thumb） */
function collectAnchors(fragment) {
  const out = [];
  const re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(fragment)) !== null) {
    const img = m[2].match(/<img[^>]*src="([^"]+)"/);
    out.push({ href: m[1], text: stripTags(m[2]), thumb: img ? img[1] : '' });
  }
  return out;
}

const abs = (base, url) => {
  try { return url ? new URL(url, base).href : ''; } catch { return ''; }
};

/** ① FC2 官方详情页解析 */
function parseFc2OfficialDetail(html, detailUrl) {
  if (/お探しの商品が見つかりません|We couldn't find any products that match your search/.test(html)) return null;
  const out = { provider: 'fc2', detailUrl };

  // 标题：div[data-section="userInfo"]（新版为 div.items_article_headerInfo）里的 h3。
  // 需剔除两类干扰元素：① 促销角标 span.items_article_saleTag（"50%OFF!"）
  // ② 站方塞进标题的内联样式水印 span（mdcz 同样做法）
  const userInfo = sliceAfter(html, 'data-section="userInfo"', 8000);
  const h3 = userInfo.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  if (h3) {
    out.title = stripTags(
      h3[1]
        .replace(/<span[^>]*class="[^"]*items_article_saleTag[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '')
        .replace(/<span[^>]*style=[^>]*>[\s\S]*?<\/span>/gi, '')
    );
  }
  if (!out.title) {
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
    // og:title 前缀带番号（"FC2-PPV-4987080 标题…"），去掉番号前缀
    out.title = ogTitle ? stripTags(ogTitle[1]).replace(/^FC2[-_ ]?(?:PPV[-_ ]?)?\d{5,8}\s*/i, '') : '';
  }
  if (!out.title) return null;

  // 卖家（FC2 没有制作商，卖家即工作室）：li.items_article_writer > a[href*='/users/']
  const seller = userInfo.match(/<a[^>]*href="[^"]*\/users\/[^"]*"[^>]*>([^<]+)<\/a>/);
  if (seller) out.studio = stripTags(seller[1]);

  // 封面：优先 og:image（原图），退回主图区缩略图（补全 https: 协议相对地址）
  const ogImg = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  const mainThumb = sliceAfter(html, 'items_article_MainitemThumb', 2500);
  const thumbImg = mainThumb.match(/<img[^>]*src="([^"]+)"/);
  out.coverUrl = abs(detailUrl, (ogImg && ogImg[1]) || (thumbImg && thumbImg[1]) || '');

  // 时长：主图区的 p.items_article_info（"40:32"，老版为 "再生時間：00:40:32"）
  const durText = mainThumb.match(/class="items_article_info"[^>]*>([\s\S]*?)</);
  if (durText) out.duration = clockToMinutes(stripTags(durText[1]));

  // 剧照：ul.items_article_SampleImagesArea 里每项 a[href] 是 w1280 大图，内层 img 是 w480 缩略图
  const samples = collectAnchors(sliceAfter(html, 'items_article_SampleImagesArea', 20000))
    .filter(a => /\.(jpe?g|png|webp)(\?|$)/i.test(a.href))
    .map(a => ({ url: abs(detailUrl, a.href), thumb: abs(detailUrl, a.thumb) }));
  if (samples.length) out.previews = samples;

  // 标签：新版为 a[data-article-tag][data-tag="人妻"]；老版为 p.card-text a[href*='/tag/']
  const tags = [];
  const pushTag = (t) => { const v = stripTags(t); if (v && v !== '無修正' && !tags.includes(v)) tags.push(v); };
  for (const a of html.match(/<a[^>]*data-article-tag[^>]*>[\s\S]*?<\/a>/g) || []) {
    const dt = a.match(/data-tag="([^"]*)"/);
    pushTag(dt ? dt[1] : a.replace(/^<a[^>]*>/, ''));
  }
  if (!tags.length) {
    for (const m of html.matchAll(/<a[^>]*href="[^"]*\/tag\/[^"]*"[^>]*>([^<]+)<\/a>/g)) pushTag(m[1]);
  }
  if (tags.length) out.tags = tags;

  // 发售日：新版在 div.items_article_softDevice 的 <p>标签 : YYYY/MM/DD</p>（标签随语言变化，
  // 中文站为「上架时间」，故按「短标签 + 冒号 + 日期」的结构匹配，避免误取页面里的促销活动日期）；
  // 老版为 div.items_article_Releasedate
  const dateP = html.match(/<p>[^<]{0,24}[:：]\s*(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})\s*<\/p>/);
  out.date = dateP ? parseAnyDate(dateP[1]) : parseAnyDate(sliceAfter(html, 'items_article_Releasedate', 600));
  if (!out.date) out.date = '';

  const desc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/);
  const descText = desc ? stripTags(desc[1]) : '';
  // 站方 meta 描述常只填番号（如 "FC2-PPV-4987080"），这种就没必要当简介
  if (descText && descText.length > 12 && !/^FC2[-_ ]?(?:PPV[-_ ]?)?\d{5,8}$/i.test(descText)) out.synopsis = descText;

  out.actresses = [];
  return out;
}

/** ② ppvdatabank（FC2 番号镜像库）详情页解析 */
function parsePpvDatabankDetail(html, detailUrl) {
  if (/404 File Not Found|お探しのページは見つかりませんでした/.test(html)) return null;
  const out = { provider: 'fc2-ppvdatabank', detailUrl };

  const titleA = html.match(/class="article_title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
  const metaTitle = html.match(/<meta[^>]*name="title"[^>]*content="([^"]*)"/);
  out.title = titleA ? stripTags(titleA[1]) : (metaTitle ? stripTags(metaTitle[1]) : '');
  if (!out.title) return null;

  const thumb = html.match(/class="thumb"[^>]*>\s*<img[^>]*src="([^"]+)"/);
  if (thumb) out.coverUrl = abs(detailUrl, thumb[1]);

  // ul.meta 里的 <li>标签 : 值</li>
  const metaBlock = sliceAfter(html, '<ul class="meta">', 3000);
  const metaOf = (labels) => {
    for (const li of metaBlock.match(/<li>[\s\S]*?<\/li>/g) || []) {
      for (const label of labels) {
        if (new RegExp('^\\s*' + label).test(stripTags(li))) return stripTags(li).replace(/^[^:：]*[:：]\s*/, '');
      }
    }
    return '';
  };
  out.date = parseAnyDate(metaOf(['発売日', '販売日', '発売']));
  const dur = metaOf(['再生時間', '収録時間']);
  if (dur) out.duration = clockToMinutes(dur);
  const sellerLi = (metaBlock.match(/<li>\s*販売者[\s\S]*?<\/li>/) || [''])[0];
  const sellerA = sellerLi.match(/<a[^>]*>([^<]+)<\/a>/);
  const seller = sellerA ? stripTags(sellerA[1]) : metaOf(['販売者']);
  if (seller) out.studio = seller;

  const samples = collectAnchors(sliceAfter(html, 'sample_image_area', 20000))
    .filter(a => /\.(jpe?g|png|webp)(\?|$)/i.test(a.href))
    .map(a => ({ url: abs(detailUrl, a.href), thumb: abs(detailUrl, a.thumb) }));
  if (samples.length) out.previews = samples;

  const exp = html.match(/class="explanation"[^>]*>([\s\S]*?)<\/div>/);
  if (exp) {
    const txt = stripTags(exp[1]);
    if (txt && txt !== out.title) out.synopsis = txt;
  }
  out.actresses = [];
  return out;
}

/** ③ javten（FC2HUB）详情页解析（有 JSON-LD，字段更规范） */
function parseJavtenDetail(html, detailUrl) {
  const out = { provider: 'fc2-javten', detailUrl };
  let ld = null;
  const scripts = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const s of scripts) {
    const body = s.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/, '');
    try {
      const parsed = JSON.parse(body);
      const list = (parsed && parsed['@graph']) ? parsed['@graph'] : (Array.isArray(parsed) ? parsed : [parsed]);
      for (const rec of list) {
        const t = rec && rec['@type'];
        if (t === 'Movie' || (Array.isArray(t) && t.includes('Movie'))) { ld = rec; break; }
      }
    } catch {}
    if (ld) break;
  }

  const h1 = html.match(/<h1[^>]*class="[^"]*fc2-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  out.title = h1 ? stripTags(h1[1]) : (ld && ld.name ? stripTags(ld.name) : '');
  if (!out.title) return null;

  const ogImg = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  const cover = (ld && (Array.isArray(ld.image) ? ld.image[0] : ld.image)) || (ogImg ? ogImg[1] : '');
  if (cover) out.coverUrl = String(cover).replace(/^http:\/\//i, 'https://');

  if (ld && Array.isArray(ld.actor)) {
    out.actresses = ld.actor.map(a => (typeof a === 'string' ? a : (a && a.name) || '')).filter(Boolean);
  } else out.actresses = [];

  const badges = [];
  const bRe = /<a[^>]*class="[^"]*badge[^"]*"[^>]*>([^<]+)<\/a>/g;
  let bm;
  while ((bm = bRe.exec(html)) !== null) {
    const t = stripTags(bm[1]);
    if (t && !badges.includes(t)) badges.push(t);
  }
  if (badges.length) out.tags = badges;

  if (ld && ld.datePublished) out.date = parseAnyDate(ld.datePublished);
  if (!out.date) { const d = html.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/); if (d) out.date = parseAnyDate(d[0]); }

  if (ld && typeof ld.duration === 'string') {
    const dm = ld.duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (dm) {
      const mins = Number(dm[1] || 0) * 60 + Number(dm[2] || 0) + Number(dm[3] || 0) / 60;
      if (mins > 0) out.duration = Math.max(1, Math.round(mins));
    }
  }
  if (!out.duration) {
    const dText = html.match(/再生時間[^0-9]{0,10}((?:\d{1,2}:)?\d{1,2}:\d{2})/);
    if (dText) out.duration = clockToMinutes(dText[1]);
  }

  const sellerBlock = html.match(/売り手情報[\s\S]{0,600}?class="col-8"[^>]*>([\s\S]*?)<\/div>/);
  if (sellerBlock) {
    const s = stripTags(sellerBlock[1].replace(/<span[^>]*class="[^"]*badge[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ''));
    if (s) out.studio = s;
  }

  const gallery = [];
  const gRe = /<a[^>]*data-fancybox="gallery"[^>]*href="([^"]+)"/g;
  let gm;
  while ((gm = gRe.exec(html)) !== null) {
    gallery.push({ url: String(gm[1]).replace(/^http:\/\//i, 'https://'), thumb: '' });
  }
  if (gallery.length) out.previews = gallery;

  const desc = html.match(/<div[^>]*class="[^"]*col des[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (desc) {
    const t = stripTags(desc[1].replace(/<br\s*\/?>/gi, '\n'));
    if (t) out.synopsis = t.slice(0, 2000);
  }
  if (ld && ld.description && !out.synopsis) out.synopsis = stripTags(ld.description);
  return out;
}

/** ③ fc2ppvdb.com 镜像库：官方下架的商品大多仍可查到（og:meta + JSON-LD + 链接规律兜底解析） */
function parseFc2PpvDbDetail(html, detailUrl) {
  const out = { provider: 'fc2-ppvdb', detailUrl };
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

  // 标题：og:title（常带「 | FC2 PPV DB」之类站名后缀）→ h1
  let title = pick(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
  if (!title) { const h = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/); title = h ? stripTags(h[1]) : ''; }
  out.title = stripTags(title).replace(/\s*[|｜-]\s*FC2\s*PPV\s*DB\s*$/i, '');
  // 站点故障页（CF Error 52x 等）也会带 og:title，不能当作有效条目
  if (!out.title || /error code \d{3}|invalid ssl|bad gateway|service unavailable|just a moment/i.test(out.title)) return null;
  const ogImg = pick(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  if (ogImg) out.coverUrl = ogImg.replace(/^http:\/\//i, 'https://');
  let ld = null;
  const scripts = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const s of scripts) {
    const body = s.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/, '');
    try {
      const parsed = JSON.parse(body);
      const list = (parsed && parsed['@graph']) ? parsed['@graph'] : (Array.isArray(parsed) ? parsed : [parsed]);
      for (const rec of list) {
        const t = rec && rec['@type'];
        if (t === 'Movie' || t === 'VideoObject' || (Array.isArray(t) && (t.includes('Movie') || t.includes('VideoObject')))) { ld = rec; break; }
      }
    } catch {}
    if (ld) break;
  }
  if (ld && Array.isArray(ld.actor)) {
    out.actresses = ld.actor.map(a => (typeof a === 'string' ? a : (a && a.name) || '')).filter(Boolean);
  }
  if (!out.actresses || !out.actresses.length) {
    const actresses = [];
    const aRe = /<a[^>]*href="[^"]*\/actresses\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let am;
    while ((am = aRe.exec(html)) !== null) {
      const t = stripTags(am[1]);
      if (t && !actresses.includes(t)) actresses.push(t);
    }
    if (actresses.length) out.actresses = actresses;
  }
  if (!out.actresses) out.actresses = [];

  // 标签：/tags/ 链接
  const tags = [];
  const tRe = /<a[^>]*href="[^"]*\/tags\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let tm;
  while ((tm = tRe.exec(html)) !== null) {
    const t = stripTags(tm[1]);
    if (t && !tags.includes(t)) tags.push(t);
  }
  if (tags.length) out.tags = tags;

  // 日期：JSON-LD → 「販売日」行 → 页面首个日期
  if (ld && ld.datePublished) out.date = parseAnyDate(ld.datePublished);
  if (!out.date) {
    const dm = html.match(/販売日[^0-9]{0,30}(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (dm) out.date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
  }
  if (!out.date) { const d = html.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); if (d) out.date = parseAnyDate(d[0]); }

  // 时长：JSON-LD ISO8601 → "HH:MM:SS" 文本
  if (ld && typeof ld.duration === 'string') {
    const dm = ld.duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (dm) {
      const mins = Number(dm[1] || 0) * 60 + Number(dm[2] || 0) + Number(dm[3] || 0) / 60;
      if (mins > 0) out.duration = Math.max(1, Math.round(mins));
    }
  }
  if (!out.duration) {
    const dText = html.match(/(?:再生時間|収録時間|時間)[^0-9]{0,10}((?:\d{1,2}:)?\d{1,2}:\d{2})/);
    if (dText) out.duration = clockToMinutes(dText[1]);
  }

  if (ld && ld.description) out.synopsis = stripTags(ld.description).slice(0, 2000);
  return out;
}

async function fc2PpvDbSearch(code, cfg) {
  const digits = normalizeFc2Number(code);
  if (!digits) return [];
  const timeout = (cfg && cfg.timeout) || 15000;
  const url = `https://fc2ppvdb.com/articles/${digits}`;
  const html = await fetchTextSmart(url, timeout);
  const cand = parseFc2PpvDbDetail(html, url);
  if (!cand) return [];
  cand.code = fc2DisplayCode(code);
  if (!cand.synopsis) cand.synopsis = synthesizeFc2Synopsis(cand);
  return [cand];
}

// ---------- JavDB（FC2 下架商品的兜底源，也覆盖普通番号） ----------

/** 解析 javdb 详情页：og:meta + movie-panel-info 标签行 */
function parseJavdbDetail(html, detailUrl) {
  const out = { provider: 'javdb', detailUrl };
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

  let title = pick(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
  if (!title) { const h = html.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/); title = h ? stripTags(h[1]) : ''; }
  out.title = stripTags(title);
  if (!out.title) return null;

  const ogImg = pick(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  if (ogImg) out.coverUrl = ogImg.replace(/^http:\/\//i, 'https://');

  // movie-panel-info：每行一个 panel-block，label + value
  const panel = html.match(/<div[^>]*class="[^"]*movie-panel-info[^"]*"[^>]*>([\s\S]*?)<\/section>/);
  const rows = {};
  if (panel) {
    const rowRe = /class="panel-block[^"]*"[^>]*>([\s\S]*?)<\/(?:panel-block|div|nav)>/g;
    let rm;
    while ((rm = rowRe.exec(panel[1])) !== null) {
      const blk = rm[1];
      const lab = blk.match(/panel-label[^>]*>([^<]+)</);
      if (!lab) continue;
      const key = stripTags(lab[1]);
      const valHtml = blk.replace(/<strong[^>]*panel-label[\s\S]*?<\/strong>/i, '');
      rows[key] = { html: valHtml, text: stripTags(valHtml) };
    }
  }
  const row = (names) => { for (const n of names) { for (const k of Object.keys(rows)) { if (k.includes(n)) return rows[k]; } } return null; };

  const idRow = row(['識別碼', '识别码', 'ID']);
  if (idRow && idRow.text) out.code = idRow.text.trim();
  const dateRow = row(['發行日期', '发行日期', '日期']);
  if (dateRow && dateRow.text) out.date = parseAnyDate(dateRow.text);
  const durRow = row(['時長', '时长']);
  if (durRow && durRow.text) {
    const dm = durRow.text.match(/(\d+)\s*分鐘?|\b(\d+)\s*minutes?\b/i);
    if (dm) out.duration = Number(dm[1] || dm[2]);
    else { const t = durRow.text.match(/(\d{1,2}:\d{2}:\d{2})/); if (t) out.duration = clockToMinutes(t[1]); }
  }
  const dirRow = row(['導演', '导演']);
  if (dirRow && dirRow.text) out.director = dirRow.text;
  const studioRow = row(['製作', '制作']);
  if (studioRow && studioRow.text) out.studio = studioRow.text;
  const pubRow = row(['發行商', '发行商', 'publisher']);
  if (pubRow && pubRow.text) out.publisher = pubRow.text;

  // 演员 / 类别：块内链接文本
  const actressRow = row(['演員', '演员']);
  if (actressRow) {
    const names = [];
    const aRe = /<a[^>]*>([\s\S]*?)<\/a>/g;
    let am;
    while ((am = aRe.exec(actressRow.html)) !== null) {
      const t = stripTags(am[1]);
      if (t && !names.includes(t)) names.push(t);
    }
    if (names.length) out.actresses = names;
  }
  if (!out.actresses) out.actresses = [];
  const genreRow = row(['類別', '类别']);
  if (genreRow) {
    const tags = [];
    const gRe = /<a[^>]*>([\s\S]*?)<\/a>/g;
    let gm;
    while ((gm = gRe.exec(genreRow.html)) !== null) {
      const t = stripTags(gm[1]);
      if (t && !tags.includes(t)) tags.push(t);
    }
    if (tags.length) out.tags = tags;
  }

  // 预览截图：/detail 页面顶部 #preview-video 里的缩略图（w320/w240），能换成大图就换
  const previews = [];
  const pvRe = /<img[^>]*class="[^"]*video-cover[^"]*"[^>]*src="([^"]+)"|<div[^>]*id="preview-video"[\s\S]*?<\/div>/g;
  const thumbBlock = (html.match(/<div[^>]*id="preview-video"[\s\S]{0,20000}?<\/div>/) || [''])[0];
  const tbRe = /<img[^>]*src="([^"]+)"/g;
  let tbm;
  while ((tbm = tbRe.exec(thumbBlock)) !== null) {
    const url = tbm[1].replace(/^http:\/\//i, 'https://').replace(/\/(?:w\d+|thumbs)\//, '/thumbs/w/big/');
    previews.push({ url, thumb: tbm[1].replace(/^http:\/\//i, 'https://') });
  }
  if (previews.length) out.previews = previews.slice(0, 10);

  return out;
}

async function javdbSearch(code, cfg) {
  const timeout = (cfg && cfg.timeout) || 15000;
  const base = 'https://javdb.com';
  const norm = String(code).toUpperCase().replace(/[-_ ]/g, '');
  const norm2 = norm.replace(/PPV/g, '');   // javdb 展示 FC2 番号时常省略 PPV（FC2-1423962）
  const html = await fetchTextSmart(`${base}/search?q=${encodeURIComponent(code)}&f=all`, timeout);
  // 结果链接：<a href="/v/<hash>" class="box" ...>…<strong>CODE</strong>…（href 与 class 顺序不固定）
  const boxes = [];
  const re = /<a\b([^>]*class="box"[^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hm = m[1].match(/href="([^"]+)"/);
    if (!hm || !hm[1].includes('/v/')) continue;
    const strongs = Array.from(m[2].matchAll(/<strong>([^<]+)<\/strong>/g)).map(x => stripTags(x[1]).toUpperCase().replace(/[-_ ]/g, ''));
    if (strongs.some(n => n === norm || n === norm2 || n.includes(norm2))) boxes.push({ href: hm[1], attrs: m[1], block: m[2] });
  }
  if (!boxes.length) return [];
  // 详情页信息最全；但 javdb 未登录时详情会 302 到登录页 → 解析失败退回搜索结果块
  let cand = null;
  try {
    const detailUrl = `${base}${boxes[0].href}`;
    const detail = await fetchTextSmart(detailUrl, timeout);
    cand = parseJavdbDetail(detail, detailUrl);
  } catch {}
  if (!cand) cand = javdbCandFromBox(boxes[0], base);
  if (!cand) return [];
  cand.code = cand.code || code;
  if (!cand.synopsis) cand.synopsis = synthesizeFc2Synopsis(cand);
  return [cand];
}

/** 从 javdb 搜索结果块拼 candidate（详情页需要登录时的兜底） */
function javdbCandFromBox(box, base) {
  const t = box.attrs.match(/title="([^"]+)"/);
  const title = t ? stripTags(t[1]) : '';
  if (!title) return null;
  const out = { provider: 'javdb', detailUrl: base + box.href, title };
  const img = box.block.match(/<img[^>]*src="([^"]+)"/);
  if (img) out.coverUrl = img[1].replace(/^http:\/\//i, 'https://');
  const codeM = box.block.match(/<strong>([^<]+)<\/strong>/);
  if (codeM) out.code = stripTags(codeM[1]);
  const meta = box.block.match(/<div class="meta">\s*([\d-]{8,10})/);
  if (meta) out.date = parseAnyDate(meta[1]);
  out.actresses = [];
  return out;
}

/** FC2 展示用番号：保留用户命名习惯（原番号含 PPV 就输出 FC2-PPV-xxx，否则 FC2-xxx） */
function fc2DisplayCode(code) {
  const digits = normalizeFc2Number(code);
  return (/ppv/i.test(String(code)) ? 'FC2-PPV-' : 'FC2-') + digits;
}

/** 缺简介时用元数据合成一份（与 JavBus provider 的做法一致） */
function synthesizeFc2Synopsis(cand) {
  const meta = [];
  if (cand.studio) meta.push('卖家：' + cand.studio);
  if (cand.date) meta.push('发售日期：' + cand.date);
  if (cand.duration) meta.push('时长：' + cand.duration + ' 分钟');
  if (cand.tags && cand.tags.length) meta.push('标签：' + cand.tags.join(' / '));
  meta.push('来源：FC2 个人拍摄（无码）');
  return meta.join('\n');
}

async function fc2OfficialSearch(code, cfg) {
  const digits = normalizeFc2Number(code);
  if (!digits) return [];
  const timeout = (cfg && cfg.timeout) || 15000;
  const url = `https://adult.contents.fc2.com/article/${digits}/`;
  const html = await fetchText(url, timeout);
  const cand = parseFc2OfficialDetail(html, url);
  if (!cand) return [];
  cand.code = fc2DisplayCode(code);
  if (!cand.synopsis) cand.synopsis = synthesizeFc2Synopsis(cand);
  return [cand];
}

async function ppvDatabankSearch(code, cfg) {
  const digits = normalizeFc2Number(code);
  if (!digits) return [];
  const timeout = (cfg && cfg.timeout) || 15000;
  const url = `https://ppvdatabank.com/article/${digits}/`;
  const html = await fetchTextSmart(url, timeout);
  const cand = parsePpvDatabankDetail(html, url);
  if (!cand) return [];
  cand.code = fc2DisplayCode(code);
  if (!cand.synopsis) cand.synopsis = synthesizeFc2Synopsis(cand);
  return [cand];
}

async function fc2JavtenSearch(code, cfg) {
  const digits = normalizeFc2Number(code);
  if (!digits) return [];
  const timeout = (cfg && cfg.timeout) || 15000;
  const base = 'https://javten.com';
  const html = await fetchTextSmart(`${base}/search?kw=${encodeURIComponent(digits)}`, timeout);
  if (/Access denied/i.test(html)) throw new Error('FC2HUB 拒绝访问');

  // 详情链接：优先 canonical / og:url，其次搜索结果里的 /video/ 链接
  const metas = [html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/), html.match(/<meta[^>]*property="og:url"[^>]*content="([^"]+)"/)];
  let detail = '';
  for (const m of metas) {
    if (m && m[1].includes('/video/') && m[1].includes(digits)) { detail = m[1]; break; }
  }
  if (!detail) {
    const links = Array.from(html.matchAll(/href="([^"]*\/video\/[^"]+)"/g)).map(x => x[1]);
    const hit = links.find(u => u.includes(digits));
    if (hit) detail = hit;
  }
  if (!detail) return [];

  const dHtml = await fetchTextSmart(detail, timeout);
  const cand = parseJavtenDetail(dHtml, detail);
  if (!cand) return [];
  cand.code = fc2DisplayCode(code);
  if (!cand.synopsis) cand.synopsis = synthesizeFc2Synopsis(cand);
  return [cand];
}

/** FC2 专用链：官方 → ppvdatabank → fc2ppvdb → javdb → javten，逐个兜底 */
async function fc2Search(code, cfg) {
  const chain = [fc2OfficialSearch, ppvDatabankSearch, fc2PpvDbSearch, javdbSearch, fc2JavtenSearch];
  const errors = [];
  for (const fn of chain) {
    try {
      const list = await fn(code, cfg);
      if (list && list.length) {
        // FC2 没有「制作商/发行商」之分，卖家即工作室（mdcz 同样把 publisher 设为 studio）
        for (const c of list) if (c.studio && !c.publisher) c.publisher = c.studio;
        return list;
      }
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  if (errors.length) throw new Error('FC2 数据源均不可用：' + errors.join(' / '));
  return [];
}

// ---------- 注册表 ----------
const PROVIDERS = {
  javbus: javbusSearch,
  fc2: fc2Search
};

async function searchCandidates(code, cfg) {
  const provider = (cfg && cfg.provider) || 'auto';
  // FC2 番号：JavBus 等常规站点没有条目，自动走 FC2 专用链（官方站→镜像库→FC2HUB）
  if (provider === 'auto' || provider === 'fc2') {
    if (isFc2Code(code)) return await fc2Search(code, cfg);
    if (provider === 'fc2') throw new Error('该番号不是 FC2 番号：' + code);
  }
  // provider 为 auto 且非 FC2 番号 → 落到默认的 JavBus 链；显式的未知源仍报错
  const fn = PROVIDERS[provider] || (provider === 'auto' ? PROVIDERS.javbus : null);
  if (!fn) throw new Error('未知的刮削源: ' + provider);
  return await fn(code, cfg);
}

async function downloadImage(url, dir, name) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await doFetch(url, { headers: { 'User-Agent': UA, Referer: url }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error('封面文件过小');
    const extMatch = new URL(url).pathname.match(/\.(jpe?g|png|webp)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
    const fileName = name + '.' + ext;
    const fs = require('fs');
    const fsp = fs.promises;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(require('path').join(dir, fileName), buf);
    return fileName;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 下载预览截图：优先大图；若大图是站方 "NOW PRINTING" 占位图则换缩略图；
 * 两者都是占位图/下载失败 → 返回 null（调用方跳过该图）。
 * @param pv {string|{url, thumb}} 兼容旧格式纯 URL 字符串
 * @returns {Promise<string|null>} 本地文件名
 */
async function downloadPreview(pv, dir, name) {
  const entry = typeof pv === 'string' ? { url: pv, thumb: '' } : (pv || {});
  const tryDl = async (url) => {
    if (!url) return null;
    try {
      const fileName = await downloadImage(url, dir, name);
      const buf = await fsp.readFile(path.join(dir, fileName));
      if (isPlaceholderImage(buf)) {           // 占位图：不留着骗人，直接删
        await fsp.rm(path.join(dir, fileName), { force: true });
        return null;
      }
      return fileName;
    } catch { return null; }
  };
  return (await tryDl(entry.url)) || (await tryDl(entry.thumb));
}

/** 解析页面里的演员 star 链接 → { starId: 名字 }（同一 star id 在各语言版页面通用） */
function parseStarMap(html) {
  const map = {};
  const re = /\/star\/([A-Za-z0-9]+)\/?[^"]*"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = stripTags(m[2]);
    if (n && !map[m[1]]) map[m[1]] = n;
  }
  return map;
}

/**
 * 演员别名（英文/日文名）：JavBus 各语言版详情页 /en/<code> /ja/<code> 的 star id 与中文页一致，
 * 按 id 对齐即得每个演员的罗马字名与日文名。best-effort：任一语言页失败/被反爬拦截则跳过该语言。
 * 返回 { 中文名: { en, ja } } 或 null。
 */
async function fetchActressAliases(detailUrl, zhStarMap, cfg) {
  if (!detailUrl) return null;
  const timeout = (cfg && cfg.timeout) || 12000;
  try {
    const u = new URL(detailUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    const zhJob = (zhStarMap && Object.keys(zhStarMap).length)
      ? Promise.resolve(zhStarMap)
      : fetchText(detailUrl, timeout).then(parseStarMap);
    const enJob = fetchText(`${u.origin}/en/${encodeURIComponent(seg)}`, timeout).then(parseStarMap).catch(() => ({}));
    const jaJob = fetchText(`${u.origin}/ja/${encodeURIComponent(seg)}`, timeout).then(parseStarMap).catch(() => ({}));
    const [zh, en, ja] = await Promise.all([zhJob, enJob, jaJob]);
    const out = {};
    for (const [id, name] of Object.entries(zh)) {
      const e = (en[id] || '').trim();
      const j = (ja[id] || '').trim();
      if (e || j) out[name] = { en: e, ja: j };
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

module.exports = {
  searchCandidates, downloadImage, downloadPreview, isPlaceholderImage, setFetchImpl, setBrowserFetch,
  parseJavbusSearch, parseJavbusDetail, parseStarMap, fetchActressAliases,
  // FC2 系列
  isFc2Code, normalizeFc2Number, fc2Search, fc2DisplayCode,
  parseFc2OfficialDetail, parsePpvDatabankDetail, parseJavtenDetail, parseJavdbDetail
};
