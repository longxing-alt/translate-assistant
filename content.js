// 网页翻译助手 - 核心逻辑(原创)
// 功能:全页沉浸式翻译(Ctrl+F / F2)、输入框三连空格翻译成英文
// iframe/shadow DOM 全覆盖;无后台界面、无登录
(() => {
  "use strict";

  const TARGET = "zh-CN"; // 全页翻译目标语言
  const INPUT_TARGET = "en"; // 输入框翻译目标语言
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "HEAD", "CODE", "PRE", "KBD", "SAMP", "IFRAME", "SVG", "VIDEO", "AUDIO", "CANVAS", "MATH", "RUBY", "RP", "RT", "FONT"]);
  const SKIP_SELECTORS = "wt-translated, [contenteditable=true], [role=dialog] [aria-modal=true], .ytp-caption-segment";

  let pageEnabled = false;
  const originals = new WeakMap(); // 原文备份

  // ============ 翻译引擎(经 background 请求,规避 CORS) ============
  function translateTexts(texts, to) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage({ type: "wt-translate", texts, to }, (resp) => {
          done((resp && resp.results) || []);
        });
      } catch (e) { done([]); }
      setTimeout(() => done([]), 30000);
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
          walkCollect(
            el.shadowRoot,
            into,
            translateMode ? (t) => !isMostlyChinese(t) && !isSkippable(t) : null
          );
        }
      }
    } catch (e) { /* noop */ }
  }

  // ============ 全页翻译 / 还原 ============
  async function translatePage() {
    const nodes = collectTranslateNodes(document);
    collectShadowNodes(nodes, true);
    if (!nodes.length) return;
    const texts = nodes.map((n) => n.nodeValue.trim());
    const results = await translateTexts(texts, TARGET);
    nodes.forEach((node, i) => {
      const tr = results[i];
      if (!tr || !tr.trim()) return;
      if (!originals.has(node)) originals.set(node, node.nodeValue);
      node.nodeValue = tr;
    });
  }

  function restorePage() {
    const nodes = collectRestoreNodes(document);
    collectShadowNodes(nodes, false);
    nodes.forEach((node) => {
      if (originals.has(node)) {
        node.nodeValue = originals.get(node);
        originals.delete(node);
      }
    });
    document.querySelectorAll("[wt-translated]").forEach((el) => el.removeAttribute("wt-translated"));
  }

  function togglePage() {
    pageEnabled = !pageEnabled;
    if (pageEnabled) translatePage();
    else restorePage();
  }

  // ============ iframe 广播(postMessage 树递归,跨域通用) ============
  let lastMsgId = "";

  function relayToggle(id) {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage({ type: "wt-toggle", id }, "*"); } catch (e) { /* noop */ }
    }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: "wt-toggle", id }, "*"); } catch (e) { /* noop */ }
    }
  }

  function requestToggle() {
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    togglePage();
    relayToggle(id);
  }

  // ============ 监听注册 ============
  function registerHotkeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        const isCtrlF = e.key === "f" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        const isF2 = e.key === "F2" && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (isCtrlF || isF2) {
          e.preventDefault();
          e.stopPropagation();
          requestToggle();
        }
      },
      true
    );
  }

  function registerTripleSpace() {
    let spaceCount = 0;
    let firstSpaceAt = 0;
    let lastTriggerAt = 0;
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
        if (spaceCount === 0 || now - firstSpaceAt > 600) {
          spaceCount = 1;
          firstSpaceAt = now;
          return;
        }
        spaceCount += 1;
        if (spaceCount < 3) return;
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

        let text = "";
        if (el.isContentEditable) text = (el.innerText || "").trim();
        else text = (el.value || "").trim();
        if (!text) return;

        translateTexts([text], INPUT_TARGET).then(([tr]) => {
          if (!tr) return;
          if (el.isContentEditable) {
            el.innerText = tr;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            el.value = tr;
            try { el.setSelectionRange(tr.length, tr.length); } catch (e2) { /* noop */ }
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
      },
      true
    );
  }

  function registerMessage() {
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (m && m.type === "wt-toggle") {
        if (m.id === lastMsgId) return;
        lastMsgId = m.id;
        togglePage();
        relayToggle(m.id);
      }
    });
  }

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
        pending.forEach((node, i) => {
          const tr = results[i];
          if (!tr || !tr.trim()) return;
          if (!originals.has(node)) originals.set(node, node.nodeValue);
          node.nodeValue = tr;
        });
      });
    });
    mo.observe(document, { childList: true, subtree: true, characterData: true });
    // 轮询:动态创建的 shadow root 内容
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
              });
            });
          }
        }
      } catch (e) { /* noop */ }
    }, 1500);
  }

  // ============ 启动(延迟:兼容 doc.write 替换 document 的 iframe) ============
  function init() {
    registerHotkeys();
    registerTripleSpace();
    registerMessage();
    ensureObserver();
  }

  function boot() {
    try {
      if (document.documentElement && document.readyState !== "loading") {
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
