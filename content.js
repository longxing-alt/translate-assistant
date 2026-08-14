// 网页翻译助手 - 核心逻辑 v1.1(原创)
// 功能:全页沉浸式翻译(Ctrl+F / F2)、输入框三连空格翻译成英文、
//      iframe/shadow DOM 全覆盖、调试侧边栏(Alt+T 查看状态与错误)
(() => {
  "use strict";

  const TARGET = "zh-CN";
  const INPUT_TARGET = "en";
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "HEAD", "CODE", "PRE", "KBD", "SAMP", "IFRAME", "SVG", "VIDEO", "AUDIO", "CANVAS", "MATH", "RUBY", "RP", "RT", "FONT"]);
  const SKIP_SELECTORS = "wt-translated, [contenteditable=true], [role=dialog] [aria-modal=true], .ytp-caption-segment, #wt-panel";

  let pageEnabled = false;
  let sidebarVisible = false;
  const originals = new WeakMap();

  // ============ 状态与错误记录(调试侧边栏数据源) ============
  const stats = {
    enabled: false,
    toggles: 0,
    nodesTranslated: 0,
    requests: 0,
    failedBatches: 0,
    lastAction: "尚未操作",
    lastError: "",
    keys: [],
    logs: [],
  };
  function log(msg) {
    stats.logs.push(new Date().toLocaleTimeString() + " " + msg);
    if (stats.logs.length > 60) stats.logs.shift();
  }
  function recordKey(k) {
    stats.keys.push(k);
    if (stats.keys.length > 30) stats.keys.shift();
  }

  // ============ 翻译引擎(经 background,规避 CORS;含 429 退避) ============
  function translateTexts(texts, to) {
    stats.requests += 1;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage({ type: "wt-translate", texts, to }, (resp) => {
          const results = (resp && resp.results) || [];
          if (resp && resp.error) {
            stats.failedBatches += 1;
            stats.lastError = resp.error;
            log("翻译失败: " + resp.error);
          }
          done(results);
        });
      } catch (e) {
        stats.failedBatches += 1;
        stats.lastError = String(e);
        log("消息异常: " + e);
        done([]);
      }
      setTimeout(() => done([]), 60000);
    });
  }

  function isMostlyChinese(text) {
    const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const en = (text.match(/[A-Za-z]/g) || []).length;
    return cn > 0 && cn >= en;
  }
  function isSkippable(text) {
    return /^[\d\s.,:%+\-()\/\\:]+$/.test(text);
  }

  // ============ 文本节点收集(含 shadow DOM) ============
  function walkCollect(root, into, filterFn) {
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const t = (node.nodeValue || "").trim();
          if (!t) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.closest && p.closest(SKIP_SELECTORS)) return NodeFilter.FILTER_REJECT;
          if (filterFn && !filterFn(t)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) into.push(walker.currentNode);
    } catch (e) { /* noop */ }
  }

  function collectTranslateNodes(root) {
    const into = [];
    walkCollect(root, into, (t) => !isMostlyChinese(t) && !isSkippable(t));
    return into;
  }
  function collectRestoreNodes(root) {
    const into = [];
    walkCollect(root, into, null);
    return into;
  }
  function collectShadowNodes(into, translateMode) {
    try {
      for (const el of document.querySelectorAll("*")) {
        if (el.shadowRoot) {
          walkCollect(el.shadowRoot, into, translateMode ? (t) => !isMostlyChinese(t) && !isSkippable(t) : null);
        }
      }
    } catch (e) { /* noop */ }
  }

  // ============ 全页翻译 / 还原 ============
  async function translatePage() {
    const nodes = collectTranslateNodes(document);
    collectShadowNodes(nodes, true);
    if (!nodes.length) {
      stats.lastAction = "无可翻译文本";
      log("无可翻译文本");
      return;
    }
    stats.lastAction = "翻译中: " + nodes.length + " 个文本节点";
    log("开始翻译 " + nodes.length + " 节点");
    let done = 0;
    const CHUNK = 100; // 增量:每块独立应用,避免长时间无反馈
    for (let c = 0; c < nodes.length; c += CHUNK) {
      const chunk = nodes.slice(c, c + CHUNK);
      const texts = chunk.map((n) => n.nodeValue.trim());
      const results = await translateTexts(texts, TARGET);
      if (!pageEnabled) return; // 翻译期间被关闭,放弃应用(避免覆盖还原)
      chunk.forEach((node, i) => {
        const tr = results[i];
        if (!tr || !tr.trim()) return;
        if (!originals.has(node)) originals.set(node, node.nodeValue);
        node.nodeValue = tr;
        fadeNode(node);
        done += 1;
      });
      stats.nodesTranslated = done;
      stats.lastAction = "翻译中 " + done + "/" + nodes.length;
    }
    stats.lastAction = "翻译完成: " + done + "/" + nodes.length;
    log("翻译完成 " + done + "/" + nodes.length);
  }

  function restorePage() {
    const nodes = collectRestoreNodes(document);
    collectShadowNodes(nodes, false);
    let done = 0;
    nodes.forEach((node) => {
      if (originals.has(node)) {
        node.nodeValue = originals.get(node);
        originals.delete(node);
        done += 1;
      }
    });
    document.querySelectorAll("[wt-translated]").forEach((el) => el.removeAttribute("wt-translated"));
    stats.lastAction = "已还原 " + done + " 节点";
    log("还原 " + done + " 节点");
  }

  // 状态同步:广播带目标状态,所有 frame 一致,避免反复 toggle 闪烁
  function applyState(enabled) {
    if (pageEnabled === enabled) return;
    pageEnabled = enabled;
    stats.enabled = enabled;
    stats.toggles += 1;
    if (pageEnabled) {
      translatePage();
      showPanel(); // 翻译时自动显示调试面板
    } else {
      restorePage();
    }
  }

  // ============ iframe 广播(postMessage 树递归,跨域通用) ============
  let lastMsgId = "";
  function relayToggle(enabled, id) {
    const payload = { type: "wt-toggle", id, enabled };
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(payload, "*"); } catch (e) { /* noop */ }
    }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(payload, "*"); } catch (e) { /* noop */ }
    }
  }
  function requestToggle() {
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    lastMsgId = id; // 防止广播回环(子帧转发回来的消息被再次处理)
    applyState(!pageEnabled);
    relayToggle(pageEnabled, id);
  }

  // ============ 调试侧边栏(Alt+T 开关) ============
  function renderPanel() {
    return `<div style="font-weight:600;font-size:13px;margin-bottom:6px">翻译助手状态</div>
<div>状态:${stats.enabled ? '🟢 已开启' : '⚪ 关闭'} | 触发:${stats.toggles} 次</div>
<div>翻译节点:${stats.nodesTranslated} | 请求:${stats.requests} | 失败批:${stats.failedBatches}</div>
<div>上次操作:${stats.lastAction}</div>
${stats.lastError ? `<div style="color:#ff9090;margin-top:4px">最近错误:${stats.lastError}</div>` : ""}
${stats.keys.length ? `<div style="margin-top:6px;color:#ccc">按键记录:${stats.keys.slice(-12).join(" ")}</div>` : ""}
<div style="margin-top:8px;border-top:1px solid #555;padding-top:6px;color:#bbb">日志(最近 12 条)</div>
${stats.logs.slice(-12).map((l) => `<div style="color:#999;font-size:11px">${l}</div>`).join("")}
<div style="margin-top:8px;color:#777;font-size:11px">Ctrl+F / F2 翻译 · Alt+T 关闭此面板</div>`;
  }
  function showPanel() {
    let panel = document.getElementById("wt-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "wt-panel";
      panel.style.cssText =
        "position:fixed;top:12px;right:12px;width:340px;max-height:75vh;overflow:auto;background:rgba(28,28,34,.96);color:#eee;z-index:2147483647;border-radius:12px;padding:14px 16px;font:12px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;box-shadow:0 6px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08)";
      document.documentElement.appendChild(panel);
    }
    panel.innerHTML = renderPanel() + '<div id="wt-panel-close" style="position:absolute;top:8px;right:12px;cursor:pointer;color:#999;font-size:14px">✕</div>';
    const closeBtn = panel.querySelector("#wt-panel-close");
    if (closeBtn) closeBtn.onclick = () => { sidebarVisible = false; panel.remove(); };
  }
  function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
    if (sidebarVisible) {
      showPanel();
      const t = setInterval(() => {
        if (!sidebarVisible) { clearInterval(t); return; }
        const p = document.getElementById("wt-panel");
        if (p) p.innerHTML = renderPanel();
      }, 1000);
    } else {
      const p = document.getElementById("wt-panel");
      if (p) p.remove();
    }
  }

  // ============ 监听注册 ============
  function registerHotkeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        const isCtrlF = e.key === "f" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        const isF2 = e.key === "F2" && !e.ctrlKey && !e.metaKey && !e.altKey;
        const isAltT = e.key === "t" && e.altKey && !e.ctrlKey && !e.metaKey;
        if (isCtrlF || isF2) {
          e.preventDefault();
          e.stopPropagation();
          recordKey("F2/CtrlF");
          requestToggle();
        } else if (isAltT) {
          e.preventDefault();
          e.stopPropagation();
          toggleSidebar();
        }
      },
      true
    );
  }

  function registerTripleSpace() {
    let spaceCount = 0;
    let firstSpaceAt = 0;
    let lastTriggerAt = 0;
    let pendingCompose = false;
    // 中文输入法合成结束:若合成前已累计 2 次空格,合成确认后的第 1 次空格即触发
    document.addEventListener("compositionend", () => {
      pendingCompose = true;
      setTimeout(() => { pendingCompose = false; }, 800);
    });
    document.addEventListener(
      "keydown",
      (e) => {
        const isSpace = e.key === " " || e.code === "Space" || e.keyCode === 229;
        if (!isSpace) {
          spaceCount = 0;
          return;
        }
        const el = e.target;
        if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable))) {
          spaceCount = 0;
          return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const now = Date.now();
        if (spaceCount === 0 || now - firstSpaceAt > 900) {
          spaceCount = 1;
          firstSpaceAt = now;
          recordKey("sp1");
          return;
        }
        spaceCount += 1;
        recordKey("sp" + spaceCount);
        if (spaceCount < 3) return;
        // 三连空格达成(合成中的空格也参与计数;触发要求非合成状态)
        if (e.isComposing || e.key === "Process") {
          spaceCount = 0;
          return;
        }
        if (now - lastTriggerAt < 2500) {
          spaceCount = 0;
          return;
        }
        spaceCount = 0;
        lastTriggerAt = now;
        e.preventDefault();
        el.classList.add("wt-translating");
        stats.lastAction = "输入框三连空格触发";
        log("三连空格触发");

        let text = "";
        if (el.isContentEditable) text = (el.innerText || "").trim();
        else text = (el.value || "").trim();
        if (!text) {
          stats.lastAction = "输入框为空,忽略";
          return;
        }
        translateTexts([text], INPUT_TARGET).then(([tr]) => {
          el.classList.remove("wt-translating");
          if (!tr) {
            stats.lastAction = "输入框翻译失败";
            log("输入框翻译失败: " + stats.lastError);
            return;
          }
          if (el.isContentEditable) {
            el.innerText = tr;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            el.value = tr;
            try { el.setSelectionRange(tr.length, tr.length); } catch (e2) { /* noop */ }
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          stats.lastAction = "输入框已翻译为英文";
          log("输入框翻译完成");
        });
      },
      true
    );
  }

  function registerRuntime() {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "wt-sidebar") toggleSidebar();
      });
    } catch (e) { /* noop */ }
  }

  function registerMessage() {
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (m && m.type === "wt-toggle") {
        if (m.id === lastMsgId) return;
        lastMsgId = m.id;
        applyState(!!m.enabled);
        relayToggle(!!m.enabled, m.id);
      }
    });
  }

  // ============ 动态内容 ============
  let mo = null;
  function ensureObserver() {
    if (mo) return;
    mo = new MutationObserver(() => {
      if (!pageEnabled) return;
      const nodes = collectTranslateNodes(document);
      collectShadowNodes(nodes, true);
      const pending = nodes.filter((n) => !originals.has(n));
      if (!pending.length) return;
      const texts = pending.map((n) => n.nodeValue.trim());
      translateTexts(texts, TARGET).then((results) => {
        if (!pageEnabled) return;
        pending.forEach((node, i) => {
          const tr = results[i];
          if (!tr || !tr.trim()) return;
          if (!originals.has(node)) originals.set(node, node.nodeValue);
          node.nodeValue = tr;
          stats.nodesTranslated += 1;
        });
      });
    });
    mo.observe(document, { childList: true, subtree: true, characterData: true });
    setInterval(() => {
      if (!pageEnabled) return;
      try {
        for (const el of document.querySelectorAll("*")) {
          if (el.shadowRoot && !el.shadowRoot.__wtSeen) {
            el.shadowRoot.__wtSeen = true;
            const nodes = [];
            walkCollect(el.shadowRoot, nodes, (t) => !isMostlyChinese(t) && !isSkippable(t));
            const pending = nodes.filter((n) => !originals.has(n));
            if (!pending.length) continue;
            const texts = pending.map((n) => n.nodeValue.trim());
            translateTexts(texts, TARGET).then((results) => {
              pending.forEach((node, i) => {
                const tr = results[i];
                if (!tr || !tr.trim()) return;
                if (!originals.has(node)) originals.set(node, node.nodeValue);
                node.nodeValue = tr;
                stats.nodesTranslated += 1;
              });
            });
          }
        }
      } catch (e) { /* noop */ }
    }, 1500);
  }

  // ============ 翻译渐变效果 ============
  function injectStyle() {
    try {
      if (document.getElementById("wt-style")) return;
      const st = document.createElement("style");
      st.id = "wt-style";
      st.textContent =
        ".wt-fade-in{animation:wtFadeIn .5s ease}.wt-translating{opacity:.6;transition:opacity .25s ease}" +
        "@keyframes wtFadeIn{from{opacity:.2}to{opacity:1}}";
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { /* noop */ }
  }
  function fadeNode(node) {
    try {
      const p = node.parentElement;
      if (!p) return;
      p.classList.remove("wt-fade-in");
      void p.offsetWidth;
      p.classList.add("wt-fade-in");
    } catch (e) { /* noop */ }
  }

  // ============ 启动(延迟:兼容 doc.write 替换 document 的 iframe) ============
  function init() {
    injectStyle();
    registerHotkeys();
    registerTripleSpace();
    registerMessage();
    registerRuntime();
    ensureObserver();
    log("插件已加载");
  }
  let booted = false;
  function boot() {
    if (booted) return true;
    try {
      if (document.documentElement && document.readyState !== "loading") {
        booted = true;
        init();
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }
  if (!boot()) {
    document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
    const t = setInterval(() => { if (boot()) clearInterval(t); }, 120);
    setTimeout(() => clearInterval(t), 15000);
  }
})();
