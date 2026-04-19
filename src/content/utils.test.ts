/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { isAlreadyTargetLanguage, shouldSkipContent, getContentId, hasSuspiciousLineMismatch, isWrongLanguage, rebuildParagraphs, splitParagraphsByDom, extractAnchoredBlocks } from './utils';

// ========== isAlreadyTargetLanguage ==========

describe('isAlreadyTargetLanguage', () => {
  // 中文
  it('zh-CN: 纯中文 → true', () => {
    expect(isAlreadyTargetLanguage('今天天气很好，适合出去走走', 'zh-CN')).toBe(true);
  });
  it('zh-CN: 纯英文 → false', () => {
    expect(isAlreadyTargetLanguage('Mars is going to be amazing', 'zh-CN')).toBe(false);
  });
  it('zh-CN: 中英混合（中文占多数）→ true', () => {
    // 需要中文占比 > 40%
    expect(isAlreadyTargetLanguage('今天去了商店买了新东西回家', 'zh-CN')).toBe(true);
  });
  it('zh-CN: 中英混合（中文占少数）→ false', () => {
    expect(isAlreadyTargetLanguage('Today I went to Apple Store', 'zh-CN')).toBe(false);
  });
  it('zh-CN: 含日文假名 → false（区分日文）', () => {
    expect(isAlreadyTargetLanguage('これは日本語のテストです', 'zh-CN')).toBe(false);
  });
  it('zh-TW: 繁体中文 → true', () => {
    expect(isAlreadyTargetLanguage('今天天氣很好，適合出去走走', 'zh-TW')).toBe(true);
  });
  it('zh-CN: 空字符串 → true', () => {
    expect(isAlreadyTargetLanguage('', 'zh-CN')).toBe(true);
  });
  it('zh-CN: 纯空白 → true', () => {
    expect(isAlreadyTargetLanguage('   \n  ', 'zh-CN')).toBe(true);
  });
  it('zh-CN: CJK 恰好在 40% 边界附近', () => {
    // 10 chars total, 4 CJK = 40% → should be true (> 0.4 is false, exactly 0.4 is false)
    // Actually > 0.4, so 4/10 = 0.4 is false; 5/10 = 0.5 is true
    expect(isAlreadyTargetLanguage('你好世界AB CDEF', 'zh-CN')).toBe(false); // 4 CJK out of ~10
    expect(isAlreadyTargetLanguage('你好世界啊ABCDE', 'zh-CN')).toBe(true);  // 5 CJK out of 10
  });

  // 日文
  it('ja: 含假名 → true', () => {
    expect(isAlreadyTargetLanguage('これはテストです', 'ja')).toBe(true);
  });
  it('ja: 纯中文无假名 → false', () => {
    expect(isAlreadyTargetLanguage('今天天气很好', 'ja')).toBe(false);
  });

  // 韩文
  it('ko: 韩文 → true', () => {
    expect(isAlreadyTargetLanguage('안녕하세요 세계', 'ko')).toBe(true);
  });
  it('ko: 英文 → false', () => {
    expect(isAlreadyTargetLanguage('Hello World', 'ko')).toBe(false);
  });

  // 英文
  it('en: 纯英文 → true', () => {
    expect(isAlreadyTargetLanguage('Mars is going to be amazing', 'en')).toBe(true);
  });
  it('en: 含中文 → false', () => {
    expect(isAlreadyTargetLanguage('Hello 世界', 'en')).toBe(false);
  });
  it('en: 含日文 → false', () => {
    expect(isAlreadyTargetLanguage('Hello これ', 'en')).toBe(false);
  });

  // 未知语言
  it('unknown lang → false', () => {
    expect(isAlreadyTargetLanguage('Hello World', 'ar')).toBe(false);
  });
});

// ========== shouldSkipContent ==========

describe('shouldSkipContent', () => {
  it('纯 URL → skip', () => {
    expect(shouldSkipContent('https://t.co/example1')).toBe(true);
  });
  it('URL + 短文本 → skip', () => {
    expect(shouldSkipContent('abc https://t.co/example1')).toBe(true);
  });
  it('URL + 正常文本 → 不 skip', () => {
    expect(shouldSkipContent('Check this out https://t.co/example1')).toBe(false);
  });
  it('纯 emoji → skip', () => {
    expect(shouldSkipContent('🔥🔥🔥')).toBe(true);
  });
  it('纯标点符号 → skip', () => {
    expect(shouldSkipContent('!!!!!???')).toBe(true);
  });
  it('正常英文 → 不 skip', () => {
    expect(shouldSkipContent('This is a normal tweet')).toBe(false);
  });
  it('正常中文 → 不 skip', () => {
    expect(shouldSkipContent('今天天气很好')).toBe(false);
  });
  it('空字符串 → skip', () => {
    expect(shouldSkipContent('')).toBe(true);
  });
  it('不足 6 字符（去 URL 后）→ skip', () => {
    expect(shouldSkipContent('Hi')).toBe(true);
  });
});

// ========== getContentId ==========

describe('getContentId', () => {
  function makeEl(html: string, id = '', tag = 'article', attrs = ''): Element {
    const doc = new DOMParser().parseFromString(
      `<${tag}${id ? ` id="${id}"` : ''}${attrs ? ' ' + attrs : ''}>${html}</${tag}>`,
      'text/html'
    );
    return doc.querySelector(tag)!;
  }

  it('X.com: /user/status/<id>', () => {
    const el = makeEl('<a href="/elonmusk/status/1234567890">2h</a>');
    expect(getContentId(el)).toBe('1234567890');
  });

  it('X.com: 多个链接时取第一个 /status/ 链接', () => {
    const el = makeEl('<a href="https://t.co/xxx">link</a><a href="/user/status/9999">time</a>');
    expect(getContentId(el)).toBe('9999');
  });

  it('Mastodon: /statuses/<numeric id>', () => {
    const el = makeEl('<a href="https://mastodon.social/@alice/statuses/112345678">link</a>');
    expect(getContentId(el)).toBe('112345678');
  });

  it('Reddit: /r/<sub>/comments/<post_id>', () => {
    const el = makeEl('<a href="/r/programming/comments/abc123xyz/some_title/">permalink</a>');
    expect(getContentId(el)).toBe('abc123xyz');
  });

  it('Hacker News: /item?id=<id>', () => {
    const el = makeEl('<a href="https://news.ycombinator.com/item?id=38765432">link</a>');
    expect(getContentId(el)).toBe('38765432');
  });

  it('YouTube: ?v=<11-char id>', () => {
    const el = makeEl('<a href="https://youtube.com/watch?v=dQw4w9WgXcQ">video</a>');
    expect(getContentId(el)).toBe('dQw4w9WgXcQ');
  });

  it('Bluesky: /profile/<handle>/post/<id>', () => {
    const el = makeEl('<a href="/profile/alice.bsky.social/post/3kabc123def">post</a>');
    expect(getContentId(el)).toBe('3kabc123def');
  });

  it('data-post-id 属性回退（Medium / Substack 风格）', () => {
    const el = makeEl('<span>Article content</span>', '', 'article', 'data-post-id="abc-xyz-789"');
    expect(getContentId(el)).toBe('abc-xyz-789');
  });

  it('data-comment-id 属性回退', () => {
    const el = makeEl('<span>comment body</span>', '', 'div', 'data-comment-id="c-42"');
    expect(getContentId(el)).toBe('c-42');
  });

  it('完全无可识别标识时回退到 element.id', () => {
    const el = makeEl('<span>hello</span>', 'my-item-42');
    expect(getContentId(el)).toBe('my-item-42');
  });

  it('无标识 → null', () => {
    const el = makeEl('<span>hello</span>');
    expect(getContentId(el)).toBeNull();
  });

  it('URL 模式优先于 data 属性回退', () => {
    const el = makeEl(
      '<a href="/user/status/777">t</a>',
      '', 'article', 'data-post-id="should-not-be-used"'
    );
    expect(getContentId(el)).toBe('777');
  });

  it('Grok 摘要卡：用 data-dualang-grok 属性 + 第一子 div 标题作为 ID', () => {
    const el = makeEl(
      '<div>Nvidia CEO Huang Challenges U.S. Chip Bans</div><div>Last updated</div><div>body...</div><div>This story is a summary...</div>',
      '', 'div', 'data-dualang-grok="true"'
    );
    expect(getContentId(el)).toBe('grok:Nvidia CEO Huang Challenges U.S. Chip Bans');
  });

  it('没有 data-dualang-grok 标记时不走 Grok 策略', () => {
    const el = makeEl('<div>Not a Grok card</div>');
    expect(getContentId(el)).toBeNull();
  });
});

describe('hasSuspiciousLineMismatch', () => {
  // 为避免"短推文误伤"，门槛是 original.length >= 150；
  // 以下测试里的 longOrig/longTrans 都足够长来通过门槛
  const longBlock = (s: string) => s.repeat(10); // 约 150+ 字符

  it('短推文（< 150 字符）永远不报警', () => {
    expect(hasSuspiciousLineMismatch('Hello world', '你好世界')).toBe(false);
    expect(hasSuspiciousLineMismatch('Hi', '')).toBe(false);
    // 即使是多段短推文合并到单段，也在门槛以下 → 不报警（避免误伤短推文常规行为）
    expect(hasSuspiciousLineMismatch('Para one.\n\nPara two.', '段一 段二')).toBe(false);
  });

  it('长原文 + 适当比例的多行译文 → 正常', () => {
    const orig = longBlock('Some content line. ');
    // 译文与原文比例合理（> 14%），不应被判为可疑
    const trans = '这是翻译后的内容\n换行之后继续\n最后一行的内容在这里并且足够长';
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(false);
  });

  it('长原文 + 译文字符数坍缩到 15% 以下 → 可疑', () => {
    const orig = longBlock('This is a long English sentence. '); // ~330 字符
    const trans = '太短';  // 2 字符 << 330 * 0.15
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(true);
  });

  it('长原文 6 段 + 译文 1 段 → 可疑（段落合并）', () => {
    const orig = [
      'First paragraph with enough content here.',
      'Second paragraph also has meaningful length.',
      'Third paragraph contributes to the density.',
      'Fourth paragraph is also substantial.',
      'Fifth paragraph keeps going.',
      'Sixth paragraph wraps it up.',
    ].join('\n\n');
    const trans = '第一段第二段第三段第四段第五段第六段都合并到了一行';
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(true);
  });

  it('长原文 6 行（非段落）+ 译文 1 行 → 可疑（行数坍缩）', () => {
    const orig = [
      'Line A with enough content.',
      'Line B with enough content.',
      'Line C with enough content.',
      'Line D with enough content.',
      'Line E with enough content.',
      'Line F with enough content.',
    ].join('\n'); // 无空行分段
    const trans = '全部合并到了一行里';
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(true);
  });

  it('空译文 → 不报警（由其它路径处理）', () => {
    expect(hasSuspiciousLineMismatch(longBlock('Content. '), '')).toBe(false);
  });

  it('长原文 4 行 + 3 行译文 → 正常（差异在容忍范围内）', () => {
    const orig = [
      'Line one has content.',
      'Line two has content.',
      'Line three has content.',
      'Line four has content.',
    ].join('\n');
    const trans = '第一行\n第二行\n第三行';
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(false);
  });

  it('URL 占绝大多数时，短译文不应被判为可疑', () => {
    // 原文 >150 字符（门槛）但 URL 占大半，真正可翻译的文本很短
    const orig = 'Check this out: https://very.long.example.com/path/that/spans/many/characters/and/more/stuff/abc/xyz/123/456/789/extra/padding/foo/bar #breaking #ai #news @someone @another by @me';
    expect(orig.length).toBeGreaterThan(150);
    const trans = '看看这个';  // 可翻译部分 ≈ "Check this out: by" ≈ 20 字, 4 字译文合理
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(false);
  });

  it('URL 在原文但仍有大量可翻译文本时，短译文会被判为可疑', () => {
    const orig = longBlock('This is a substantial English sentence. ') + ' https://short.link/x';
    // 可翻译部分 ~400 字符，译文 15 字符 → 15*7=105 < 400 → 触发
    const trans = '这是一小段译文';
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(true);
  });

  it('@mention / #hashtag 同 URL 一样被剔除', () => {
    const orig = '@alice @bob @charlie #ai #tech #news #breaking hello world today is a beautiful day friends everyone';
    // 去掉 @ / # 后剩大约 "    hello world today is a beautiful day friends everyone" (60 chars)
    // 若 orig.length 原始值 > 150 但可翻译部分 < 150 → 短推文门槛，不检查
    const trans = '大家好';
    expect(hasSuspiciousLineMismatch(orig, trans)).toBe(false);
  });
});

describe('isWrongLanguage', () => {
  it('目标 zh-CN 但输出英文 → true（捕捉 Greg 截图场景）', () => {
    // "codex is becoming a security agencyic IDE" ≈ 41 字符，无 CJK
    expect(isWrongLanguage('codex is becoming a security agencyic IDE', 'zh-CN')).toBe(true);
  });

  it('目标 zh-CN 输出正常中文 → false', () => {
    expect(isWrongLanguage('这是一段正常的中文翻译输出', 'zh-CN')).toBe(false);
  });

  it('中英混排但中文占多数 → false（专有名词合法）', () => {
    expect(isWrongLanguage('这是 iPhone 的新功能介绍，使用 AI 模型来增强体验的详细说明', 'zh-CN')).toBe(false);
  });

  it('短译文（< 8 字符）不判', () => {
    expect(isWrongLanguage('ok', 'zh-CN')).toBe(false);
    expect(isWrongLanguage('yes sure', 'zh-CN')).toBe(false);
  });

  it('小垃圾字符串 "这条翻译" → 反而算中文（纯 CJK）', () => {
    // 注：isWrongLanguage 只管"输出是不是目标语言"，不查"内容有没有意义"
    // 实际的 "这条翻译" 垃圾靠 hasSuspiciousLineMismatch 和 prompt 修正捕获
    expect(isWrongLanguage('这条翻译', 'zh-CN')).toBe(false);
  });

  it('目标为英文时不做此检查（即使输出是中文也算正常）', () => {
    expect(isWrongLanguage('这是一段中文', 'en')).toBe(false);
  });

  it('目标日文，输出英文 → true', () => {
    expect(isWrongLanguage('this is an english sentence that should have been japanese', 'ja')).toBe(true);
  });

  it('URL 不影响判定（去掉后算纯文本）', () => {
    // 译文全英文，但含 URL。去掉 URL 后仍是全英文 → true
    expect(isWrongLanguage('check this out https://example.com it is cool', 'zh-CN')).toBe(true);
  });
});

describe('rebuildParagraphs', () => {
  it('目标 1 段 → 原样返回', () => {
    expect(rebuildParagraphs('单段译文', 1)).toEqual(['单段译文']);
  });

  it('已含 \\n\\n → 直接按原分段拆出', () => {
    expect(rebuildParagraphs('段一\n\n段二\n\n段三', 3)).toEqual(['段一', '段二', '段三']);
  });

  it('一大段 6 句 → 按句拆成 3 段（每段 2 句）', () => {
    const oneWall = '第一句子。第二句子。第三句子。第四句子。第五句子。第六句子。';
    const paras = rebuildParagraphs(oneWall, 3);
    expect(paras.length).toBe(3);
    expect(paras[0]).toBe('第一句子。第二句子。');
    expect(paras[1]).toBe('第三句子。第四句子。');
    expect(paras[2]).toBe('第五句子。第六句子。');
  });

  it('句数不足时返回原文不变（不敢强拆）', () => {
    expect(rebuildParagraphs('只有一句话没有句号', 3)).toEqual(['只有一句话没有句号']);
    expect(rebuildParagraphs('一句话。两句话。', 5)).toEqual(['一句话。两句话。']);
  });

  it('中英文句末标点混排', () => {
    const text = 'Hello world. Nice to meet you! How are you?这是中文。还有一句。最后一句。';
    const paras = rebuildParagraphs(text, 3);
    expect(paras.length).toBe(3);
    // 6 句平均 2 句/段
    expect(paras[0].endsWith('you!')).toBe(true);
  });
});

// ========== splitParagraphsByDom ==========

describe('splitParagraphsByDom', () => {
  function el(html: string): Element {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
  }

  it('单段纯文本：一个 fragment', () => {
    const parts = splitParagraphsByDom(el('Hello world'));
    expect(parts.length).toBe(1);
    expect(parts[0].textContent).toBe('Hello world');
  });

  it('文本节点里 \\n\\n 拆成两段', () => {
    // innerHTML 里 \n\n 会保留在 text node 里
    const node = document.createElement('div');
    node.appendChild(document.createTextNode('First paragraph.\n\nSecond paragraph.'));
    const parts = splitParagraphsByDom(node);
    expect(parts.length).toBe(2);
    expect(parts[0].textContent).toBe('First paragraph.');
    expect(parts[1].textContent).toBe('Second paragraph.');
  });

  it('保留链接 HTML', () => {
    const node = document.createElement('div');
    node.appendChild(document.createTextNode('Click '));
    const a = document.createElement('a');
    a.href = '/foo';
    a.textContent = '#tag';
    node.appendChild(a);
    node.appendChild(document.createTextNode(' now.\n\nSecond.'));
    const parts = splitParagraphsByDom(node);
    expect(parts.length).toBe(2);
    const frag0 = document.createElement('div');
    frag0.appendChild(parts[0]);
    expect(frag0.querySelector('a')?.getAttribute('href')).toBe('/foo');
    expect(frag0.textContent).toBe('Click #tag now.');
    expect(parts[1].textContent).toBe('Second.');
  });

  it('连续 <br><br> 视为段落分隔', () => {
    const parts = splitParagraphsByDom(el('A<br><br>B'));
    expect(parts.length).toBe(2);
    expect(parts[0].textContent).toBe('A');
    expect(parts[1].textContent).toBe('B');
  });

  it('单个 <br> 保留为行内换行，不分段', () => {
    const parts = splitParagraphsByDom(el('Line 1<br>Line 2'));
    expect(parts.length).toBe(1);
    // 单 BR 被转换为 \n（视觉等价，pre-wrap 下渲染相同）
    expect(parts[0].textContent).toMatch(/Line 1[\n\r]+Line 2/);
  });

  it('X.com 实际结构：整段推文包在一个 span 里用 \\n\\n 分段', () => {
    // 这是 X.com 主列表的真实 DOM 形态 —— 顶层是 <span>，3 段文本用 \n\n 分隔藏在 span 的 text node 里
    const node = document.createElement('div');
    const span = document.createElement('span');
    span.appendChild(document.createTextNode('para one\n\npara two\n\npara three'));
    node.appendChild(span);
    const parts = splitParagraphsByDom(node);
    expect(parts.length).toBe(3);
    expect(parts[0].textContent).toBe('para one');
    expect(parts[1].textContent).toBe('para two');
    expect(parts[2].textContent).toBe('para three');
    // 克隆的 fragment 保留了 <span> 壳
    const holder = document.createElement('div');
    holder.appendChild(parts[0]);
    expect(holder.querySelector('span')).not.toBeNull();
  });

  it('纯空白段落被过滤', () => {
    const node = document.createElement('div');
    node.appendChild(document.createTextNode('Content.\n\n   \n\nMore.'));
    const parts = splitParagraphsByDom(node);
    expect(parts.length).toBe(2);
    expect(parts[0].textContent).toBe('Content.');
    expect(parts[1].textContent).toBe('More.');
  });

  it('3 段实测：含 emoji img 和 @mention', () => {
    const node = document.createElement('div');
    node.appendChild(document.createTextNode('First '));
    const img = document.createElement('img');
    img.alt = '🔥';
    node.appendChild(img);
    node.appendChild(document.createTextNode('\n\nSecond.\n\nThird '));
    const mention = document.createElement('a');
    mention.textContent = '@user';
    node.appendChild(mention);
    const parts = splitParagraphsByDom(node);
    expect(parts.length).toBe(3);
    const holder = document.createElement('div');
    holder.appendChild(parts[0]);
    expect(holder.querySelector('img')?.alt).toBe('🔥');
    expect(parts[1].textContent).toBe('Second.');
    const holder2 = document.createElement('div');
    holder2.appendChild(parts[2]);
    expect(holder2.textContent).toBe('Third @user');
  });
});

// ========== extractAnchoredBlocks ==========

describe('extractAnchoredBlocks', () => {
  it('返回带 el 引用的 text blocks', () => {
    document.body.innerHTML = `
      <article>
        <p>Hello world</p>
        <p>Second para</p>
      </article>`;
    const root = document.querySelector('article')!;
    const blocks = extractAnchoredBlocks(root);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text).toBe('Hello world');
    expect(blocks[0].el.tagName).toBe('P');
    expect(blocks[1].text).toBe('Second para');
  });

  it('img 独立成 img-alt block，alt 文本进 text 字段', () => {
    document.body.innerHTML = `
      <article>
        <p>Before image</p>
        <figure><img alt="Chart showing revenue growth"></figure>
        <p>After image</p>
      </article>`;
    const root = document.querySelector('article')!;
    const blocks = extractAnchoredBlocks(root);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].kind).toBe('img-alt');
    expect(blocks[1].text).toBe('Chart showing revenue growth');
    expect(blocks[1].el.tagName).toBe('FIGURE');
  });

  it('无 alt 的图片不产生 block（避免空串）', () => {
    document.body.innerHTML = `
      <article>
        <p>Only text</p>
        <figure><img src="x.jpg"></figure>
      </article>`;
    const blocks = extractAnchoredBlocks(document.querySelector('article')!);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
  });

  it('视频/音频节点跳过（当前版本不翻译）', () => {
    document.body.innerHTML = `
      <article>
        <p>Intro</p>
        <video src="v.mp4"></video>
      </article>`;
    const blocks = extractAnchoredBlocks(document.querySelector('article')!);
    expect(blocks).toHaveLength(1);
  });
});
