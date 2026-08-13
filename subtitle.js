// 网页翻译助手 - 视频字幕翻译(YouTube 双语字幕)
// 英文等外语字幕 → 双语显示(原文 + 中文),中文视频保持原样
(() => {
  "use strict";

  const cache = new Map(); // 字幕文本 → 译文

  async function translateOne(text) {
    if (cache.has(text)) return cache.get(text);
    if (/[\u4e00-\u9fff]/.test(text) && (text.match(/[\u4e00-\u9fff]/g) || []).length >= (text.match(/[A-Za-z]/g) || []).length) {
      cache.set(text, null);
      return null;
    }
    try {
      const results = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        try {
          chrome.runtime.sendMessage({ type: "wt-translate", texts: [text], to: "zh-CN" }, (resp) => {
            done((resp && resp.results) || []);
          });
        } catch (e) { done([]); }
        setTimeout(() => done([]), 30000);
      });
      const tr = results[0] || null;
      cache.set(text, tr);
      return tr;
    } catch (e) {
      return null;
    }
  }

  function processSegments() {
    document.querySelectorAll(".ytp-caption-segment").forEach((el) => {
      if (el.__wtProcessed) return;
      el.__wtProcessed = true;
      const text = (el.textContent || "").trim();
      if (!text) return;
      translateOne(text).then((tr) => {
        if (!tr || tr === text) return;
        // 若已有中文行则不重复
        if (el.querySelector(".wt-zh")) return;
        const zh = document.createElement("span");
        zh.className = "wt-zh";
        zh.textContent = tr;
        zh.style.display = "block";
        el.appendChild(zh);
      });
    });
  }

  const obs = new MutationObserver(() => processSegments());
  function start() {
    // 无条件启动:发现字幕元素才工作(YouTube 等视频站通用)
    processSegments();
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
