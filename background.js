// 网页翻译助手 - 后台:翻译请求(无 CORS 限制)+ 广播翻译指令到所有 frame
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[wt] msg:", msg && msg.type, "from:", sender && sender.tab && sender.tab.id);
  // 翻译请求
  if (msg && msg.type === "wt-translate") {
    (async () => {
      const texts = msg.texts || [];
      const to = msg.to || "zh-CN";
      const out = new Array(texts.length);
      const BATCH = 60;
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const q = encodeURIComponent(batch.join("\n"));
        try {
          const resp = await fetch(
            "https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=auto&tl=" + to + "&format=html",
            {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
              body: batch.map((t) => "q=" + encodeURIComponent(t)).join("&"),
            }
          );
          const data = await resp.json();
          for (let j = 0; j < batch.length; j++) out[i + j] = (data && data[j] && data[j][0]) || "";
        } catch (e) { /* 该批保持原文 */ }
      }
      sendResponse({ results: out });
    })();
    return true; // 异步响应
  }
  // 翻译指令广播:发送到 tab 的所有 frame
  if (msg && msg.type === "wt-toggle" && sender.tab) {
    chrome.webNavigation.getAllFrames({ tabId: sender.tab.id }, (frames) => {
      (frames || []).forEach((f) => {
        try {
          chrome.tabs.sendMessage(sender.tab.id, { type: "wt-toggle" }, { frameId: f.frameId });
        } catch (e) { /* noop */ }
      });
    });
  }
});
