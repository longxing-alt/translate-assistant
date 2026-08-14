# 1) background.js:MyMemory 结果校验 + 全空回退 Google
b = open('background.js', encoding='utf-8').read()
old = '''function bingLang(to) {
  return to === "en" ? "en" : "zh-Hans";
}'''
new = '''function bingLang(to) {
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
}'''
assert old in b, 'helper anchor not found'
b = b.replace(old, new, 1)

old2 = '''  // 端点3:MyMemory(并发,大陆直连可用,优先)
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
          out[idx] = (data && data.responseData && data.responseData.translatedText) || "";
        }
      } catch (e) { /* 单条失败 */ }
    }));
    return out;
  } catch (e) { /* 全部失败 */ }

  return null;'''
new2 = '''  // 端点3:MyMemory(并发,大陆直连可用,优先;结果需校验,超配额警告不算译文)
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

  return null;'''
assert old2 in b, 'mymem block not found'
b = b.replace(old2, new2, 1)
open('background.js', 'w', encoding='utf-8', newline='').write(b)
print('background.js result validation added')

# 2) content.js:应用前校验(双保险)
d = open('content.js', encoding='utf-8').read()
old3 = '''  function isSkippable(text) {
    return /^[\d\s.,:%+\-()\/\\:]+$/.test(text);
  }'''
new3 = '''  function isSkippable(text) {
    return /^[\d\s.,:%+\-()\/\\:]+$/.test(text);
  }
  function isBadResult(tr, orig) {
    if (!tr || !tr.trim()) return true;
    const t = tr.trim();
    if (t.length > 30 && /MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE|HTTP \d{3}|EXCEPTION/i.test(t)) return true;
    if (t === orig && orig.length > 20) return true;
    if (orig.length > 10 && t.length > orig.length * 8) return true;
    return false;
  }'''
assert old3 in d, 'isSkippable not found'
d = d.replace(old3, new3, 1)

# 应用处加校验:translatePage 分块
old4 = '''      chunk.forEach((node, i) => {
        const tr = results[i];
        if (!tr || !tr.trim()) return;
        if (!originals.has(node)) originals.set(node, node.nodeValue);
        node.nodeValue = tr;
        fadeNode(node);
        done += 1;
      });'''
new4 = '''      chunk.forEach((node, i) => {
        const tr = results[i];
        if (!tr || !tr.trim() || isBadResult(tr, node.nodeValue)) return;
        if (!originals.has(node)) originals.set(node, node.nodeValue);
        node.nodeValue = tr;
        fadeNode(node);
        done += 1;
      });'''
assert old4 in d, 'translate apply not found'
d = d.replace(old4, new4, 1)

# 输入框翻译校验
old5 = '''        translateTexts([text], INPUT_TARGET).then(([tr]) => {
          el.classList.remove("wt-translating");
          if (!tr) {'''
new5 = '''        translateTexts([text], INPUT_TARGET).then(([tr]) => {
          el.classList.remove("wt-translating");
          if (!tr || isBadResult(tr, text)) {'''
assert old5 in d, 'input apply not found'
d = d.replace(old5, new5, 1)
open('content.js', 'w', encoding='utf-8', newline='').write(d)
print('content.js validation added')
