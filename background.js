// 网页翻译助手 - 后台:翻译请求 + 状态同步
// 端点链:Google POST → MyMemory(Google 不可达时自动跳过,避免干等)
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    try { chrome.tabs.sendMessage(tab.id, { type: "wt-sidebar" }); } catch (e) { /* noop */ }
  }
});

function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 4000);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(t));
}

// 识别错误/警告文本
function isBadResult(tr, orig) {
  if (!tr || !tr.trim()) return true;
  const t = tr.trim();
  if (t.length > 30 && /MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE|HTTP \d{3}|EXCEPTION|INVALID SOURCE/i.test(t)) return true;
  if (t === orig && orig.length > 20) return true;
  if (orig.length > 10 && t.length > orig.length * 8) return true;
  return false;
}

const TRAD_CHARS = "體們說這門時國學書東來見對後會問點電號車長頭語裡開當發還進過媽覺鐘遠張萬兩邊親銀錢員與華風雙應樣讓幾從種際麗愛現產義習燈寫讀講話聽請謝護轉輕鬆處灣臺灣";
const CANT_CHARS = "乜嘢嘅咁喺唔佢係啲冇哋嚟畀攞搵睇講傾食飲瞓返咗啦嘞";
function hasTraditional(t) { for (const c of TRAD_CHARS) if (t.includes(c)) return true; return false; }
function hasCantonese(t) { for (const c of CANT_CHARS) if (t.includes(c)) return true; return false; }
function detectSrcLang(t) {
  if (hasCantonese(t)) return "zh-HK";
  if (hasTraditional(t)) return "zh-TW";
  if (/[\u3040-\u30ff]/.test(t)) return "ja"; // 假名优先(日文常混汉字)
  if (/[\uac00-\ud7af]/.test(t)) return "ko";
  if (/[\u4e00-\u9fff]/.test(t)) return "zh-CN";
  if (/[A-Za-z]{4,}/.test(t)) return "en"; // 拉丁文本默认英文
  return null;
}

// Google 健康状态:失败后跳过(避免无梯子时每批干等 8 秒)
let googleDown = false;
let quotaExhausted = false;
const GOOGLE_COOLDOWN = 30000; // 标记 down 后 30s 内跳过,之后重试一次

async function translateBatch(batch, to) {
  // 端点1:Google POST(仅当未标记 down)
  if (!googleDown) {
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
      googleDown = true; // 失败(含超时/网络不可达)→ 跳过后续 Google
      setTimeout(() => { googleDown = false; }, GOOGLE_COOLDOWN);
    } catch (e) {
      googleDown = true;
      setTimeout(() => { googleDown = false; }, GOOGLE_COOLDOWN);
    }
  }

  // 端点2:MyMemory(并发 3,兜底)
  try {
    const out = new Array(batch.length);
    let idx = 0;
    let okCount = 0;
    async function worker() {
      while (idx < batch.length) {
        const i = idx++;
        const src = detectSrcLang(batch[i]);
        if (!src) continue; // 无法检测源语言
        try {
          const r = await fetchWithTimeout(
            "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(batch[i].slice(0, 450)) + "&langpair=" + src + "|" + (to === "en" ? "en" : "zh-CN"),
            { timeout: 4000 }
          );
          if (r.ok) {
            const data = await r.json();
            const tr = (data && data.responseData && data.responseData.translatedText) || "";
            if (/MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE/i.test(tr)) {
              quotaExhausted = true;
              continue;
            }
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
  if (msg && msg.type === "wt-sync-state" && sender.tab) {
    chrome.webNavigation.getAllFrames({ tabId: sender.tab.id }, (frames) => {
      (frames || []).forEach((f) => {
        try {
          chrome.tabs.sendMessage(sender.tab.id, { type: "wt-state", enabled: !!msg.enabled }, { frameId: f.frameId });
        } catch (e) { /* noop */ }
      });
    });
  }
  if (msg && msg.type === "wt-translate") {
    (async () => {
      const texts = msg.texts || [];
      const to = msg.to || "zh-CN";
      const out = new Array(texts.length);
      const BATCH = 25;
      const queue = [];
      for (let i = 0; i < texts.length; i += BATCH) queue.push(i);
      let idx = 0;
      let anyFail = false;
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
            await new Promise((r) => setTimeout(r, 400));
            if (attempt === 1) anyFail = true;
          }
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      const reason = quotaExhausted ? "MyMemory 免费配额已用尽,请开启梯子或稍后再试" : anyFail ? "部分翻译端点不可用" : "";
      sendResponse({ results: out, error: reason });
    })();
    return true;
  }
});
