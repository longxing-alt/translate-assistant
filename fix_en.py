for f in ['content.js', 'background.js']:
    d = open(f, encoding='utf-8').read()
    old = '''    if (/[\\u4e00-\\u9fff]/.test(t)) return "zh-CN";
    return null;'''
    new = '''    if (/[\\u4e00-\\u9fff]/.test(t)) return "zh-CN";
    if (/[A-Za-z]{4,}/.test(t)) return "en"; // 拉丁文本默认英文(MyMemory 需要具体源语言)
    return null;'''
    assert old in d, f + ' pattern missing'
    d = d.replace(old, new, 1)
    open(f, 'w', encoding='utf-8', newline='').write(d)
    print(f, 'en fallback added')
