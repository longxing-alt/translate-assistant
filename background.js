// 网页翻译助手 - 后台:翻译请求(多端点回退 + 超时控制)
// 端点链:gtx POST → single GET → 必应(国内可用) → MyMemory
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

function bingLang(to) {
  return to === "en" ? "en" : "zh-Hans";
}

// 识别翻译服务的错误/警告文本(如 MyMemory 超配额提示),避免污染页面
function isBadResult(tr, orig) {
  if (!tr || !tr.trim()) return true;
  const t = tr.trim();
  if (t.length > 30 && /MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE|HTTP \d{3}|EXCEPTION/i.test(t)) return true;
  if (t === orig && orig.length > 20) return true;
  if (orig.length > 10 && t.length > orig.length * 8) return true;
  return false;
}

// 尝试端点链翻译一个批次;全部失败返回 null
async function translateBatch(batch, to) {
  // 端点1:translate.googleapis.com POST
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

  // 端点2:translate.googleapis.com single GET
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

  // 端点3:MyMemory(并发,大陆直连可用,优先;结果需校验,超配额警告不算译文)
  try {
    const out = new Array(batch.length);
    await Promise.all(batch.map(async (t, idx) => {
      try {
        const r = await fetchWithTimeout(
          "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(t.slice(0, 450)) + "&langpair=auto|" + (to === "en" ? "en" : "zh-CN"),
          { timeout: 5000 }
        );
        if (r.ok) {
          const data = await r.json();
          const tr = (data && data.responseData && data.responseData.translatedText) || "";
          out[idx] = isBadResult(tr, t) ? "" : tr;
        }
      } catch (e) { /* 单条失败 */ }
    }));
    if (out.some((x) => x)) return out; // 有有效译文才返回,否则回退 Google
  } catch (e) { /* 回退 Google */ }

  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
            await new Promise((r) => setTimeout(r, 800));
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
