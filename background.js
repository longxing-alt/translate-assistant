// 网页翻译助手 - 后台:翻译请求 + 翻译状态跨 frame 同步
// 端点链:Google POST → single GET → MyMemory(兜底)
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    try { chrome.tabs.sendMessage(tab.id, { type: "wt-sidebar" }); } catch (e) { /* noop */ }
  }
});

function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 5000);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(t));
}

// 识别翻译服务的错误/警告文本(如 MyMemory 超配额提示),避免污染页面
const TRAD_CHARS = "體們說這門時國學書東來見對後會問點電號車長頭語裡開當發還進過媽覺鐘遠張萬兩邊親銀錢員與華風雙應樣讓幾從種際麗愛現產義習燈寫讀講話聽請謝護轉輕鬆處灣臺灣";
const CANT_CHARS = "乜嘢嘅咁喺唔佢係啲冇哋嚟畀攞搵睇講傾食飲瞓返咗啦嘞";
function hasTraditional(t) { for (const c of TRAD_CHARS) if (t.includes(c)) return true; return false; }
function hasCantonese(t) { for (const c of CANT_CHARS) if (t.includes(c)) return true; return false; }
function detectSrcLang(t) {
  if (hasCantonese(t)) return "zh-HK";
  if (hasTraditional(t)) return "zh-TW";
  if (/[一-鿿]/.test(t)) return "zh-CN";
  if (/[぀-ヿ]/.test(t)) return "ja";
  if (/[가-힯]/.test(t)) return "ko";
  return null;
}

function isBadResult(tr, orig) {
  if (!tr || !tr.trim()) return true;
  const t = tr.trim();
  if (t.length > 30 && /MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE|HTTP \d{3}|EXCEPTION|INVALID SOURCE/i.test(t)) return true;
  if (t === orig && orig.length > 20) return true;
  if (orig.length > 10 && t.length > orig.length * 8) return true;
  return false;
}

async function translateBatch(batch, to) {
  // 端点1:Google POST
  try {
    const body = batch.map((t) => "q=" + encodeURIComponent(t)).join("&");
    const r = await fetchWithTimeout(
      "https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=auto&tl=" + to + "&format=html",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body }
    );
    if (r.ok) {
      const data = await r.json();
      return batch.map((_, j) => (data && data[j] && data[j][0]) || "");
    }
  } catch (e) { /* 下一端点 */ }

  // 端点2:Google single GET
  try {
    const joined = batch.join("\n");
    const r = await fetchWithTimeout(
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + to + "&dt=t&q=" + encodeURIComponent(joined)
    );
    if (r.ok) {
      const data = await r.json();
      const flat = (data[0] || []).map((s) => (s && s[0]) || "").join("");
      const parts = flat.split("\n");
      return batch.map((_, j) => parts[j] || "");
    }
  } catch (e) { /* 下一端点 */ }

  // 端点3:MyMemory(并发 3,兜底;429 快速失败)
  try {
    const out = new Array(batch.length);
    let idx = 0;
    let okCount = 0;
    async function worker() {
      while (idx < batch.length) {
        const i = idx++;
        try {
          const src = detectSrcLang(batch[i]);
          if (!src) continue; // 无法检测源语言,跳过(留给 Google)
          const r = await fetchWithTimeout(
            "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(batch[i].slice(0, 450)) + "&langpair=" + src + "|" + (to === "en" ? "en" : "zh-CN"),
            { timeout: 4000 }
          );
          if (r.ok) {
            const data = await r.json();
            const tr = (data && data.responseData && data.responseData.translatedText) || "";
            if (!isBadResult(tr, batch[i])) { out[i] = tr; okCount += 1; }
          }
        } catch (e) { /* 单条失败 */ }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (okCount > 0) return out;
  } catch (e) { /* 全部失败 */ }

  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 翻译状态同步:主文档状态变化时广播给 tab 所有 frame(iframe 重载后也能对齐)
  if (msg && msg.type === "wt-sync-state" && sender.tab) {
    chrome.webNavigation.getAllFrames({ tabId: sender.tab.id }, (frames) => {
      (frames || []).forEach((f) => {
        try {
          chrome.tabs.sendMessage(sender.tab.id, { type: "wt-state", enabled: !!msg.enabled }, { frameId: f.frameId });
        } catch (e) { /* noop */ }
      });
    });
  }
  // 翻译请求
  if (msg && msg.type === "wt-translate") {
    (async () => {
      const texts = msg.texts || [];
      const to = msg.to || "zh-CN";
      const out = new Array(texts.length);
      const BATCH = 25;
      const queue = [];
      for (let i = 0; i < texts.length; i += BATCH) queue.push(i);
      let idx = 0;
      async function worker() {
        while (idx < queue.length) {
          const start = queue[idx++];
          const batch = texts.slice(start, start + BATCH);
          for (let attempt = 0; attempt < 2; attempt++) {
            const results = await translateBatch(batch, to);
            if (results) {
              for (let j = 0; j < batch.length; j++) out[start + j] = results[j] || "";
              break;
            }
            await new Promise((r) => setTimeout(r, 600));
            if (attempt === 1) {
              sendResponse({ results: out, error: "所有翻译端点均失败" });
              return;
            }
          }
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      sendResponse({ results: out });
    })();
    return true;
  }
});
