// 网页翻译助手 - 后台:翻译请求(无 CORS 限制,含 429 限流退避)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "wt-translate") {
    (async () => {
      const texts = msg.texts || [];
      const to = msg.to || "zh-CN";
      const out = new Array(texts.length);
      const BATCH = 25; // 小批次降低限流概率
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const body = batch.map((t) => "q=" + encodeURIComponent(t)).join("&");
            const resp = await fetch(
              "https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=auto&tl=" + to + "&format=html",
              {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body,
              }
            );
            if (resp.status === 429) {
              await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
              continue;
            }
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            for (let j = 0; j < batch.length; j++) out[i + j] = (data && data[j] && data[j][0]) || "";
            ok = true;
          } catch (e) {
            if (attempt === 2) {
              sendResponse({ results: out, error: String(e) });
              return;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      sendResponse({ results: out });
    })();
    return true; // 异步响应
  }
});
