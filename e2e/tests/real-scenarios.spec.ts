import { test, expect } from './fixtures';

const realPage = 'http://localhost:9999/e2e/fixtures/x-real.html';

// 统一的 API mock。每次请求把内容长度记下来，翻译文本用序号区分。
function installApi(context: any) {
  const requests: Array<{ texts: string[]; seq: number; sizeChars: number }> = [];
  let seq = 0;
  context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
    seq++;
    const postData = JSON.parse(route.request().postData() || '{}');
    const content: string = postData.messages?.[1]?.content || '';
    const hasDelimiter = /===\s*\d+\s*===|推文 \d+:/.test(content);
    const tweetBlocks = hasDelimiter
      ? content.split(/===\s*\d+\s*===|推文 \d+:/g).slice(1).map(s => s.trim())
      : [content.trim()];
    const count = tweetBlocks.length || 1;
    requests.push({ texts: tweetBlocks, seq, sizeChars: content.length });
    const results = Array.from({ length: count }, (_, i) => ({
      index: i,
      translated: `译文#${seq}-${i}`,
    }));
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
    });
  });
  return requests;
}

async function savePopup(popupPage: any) {
  await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
  await popupPage.locator('#apiKey').fill('sk-test-real');
  await popupPage.locator('#model').fill('moonshot-v1-8k');
  await popupPage.locator('#reasoningEffort').selectOption('medium');
  await popupPage.locator('#maxTokens').fill('4096');
  await popupPage.locator('#enableStreaming').evaluate((el: HTMLInputElement) => el.checked = false);
  await popupPage.locator('#saveBtn').click();
  await expect(popupPage.locator('#status')).toHaveText('设置已保存');
}

test.describe('Realistic X.com DOM scenarios', () => {
  test.beforeEach(async ({ popupPage }) => { await savePopup(popupPage); });

  test('Show more via innerHTML replace 应重新翻译', async ({ context }) => {
    const requests = installApi(context);
    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    await expect(page.locator('#tweet-1002 .dualang-translation')).toBeVisible({ timeout: 5000 });
    const before = requests.length;

    await page.evaluate(() => (window as any).xSim.expandShowMore('1002', 'replace'));

    // 展开后任一新请求应包含展开后文本特征
    await expect.poll(
      () => requests.slice(before).some(r => r.texts.some(t => t.includes('postmortem'))),
      { timeout: 5000 }
    ).toBe(true);
  });

  test('Show more via wrapper swap 应重新翻译', async ({ context }) => {
    const requests = installApi(context);
    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    await expect(page.locator('#tweet-1003 .dualang-translation')).toBeVisible({ timeout: 5000 });
    const before = requests.length;

    // wrapper 模式：tweetText 父节点被整块替换，tweetText 是全新 DOM 节点
    await page.evaluate(() => (window as any).xSim.expandShowMore('1003', 'wrapper'));

    await expect.poll(
      () => requests.slice(before).some(r => r.texts.some(t => t.includes('needle-in-a-haystack'))),
      { timeout: 5000 }
    ).toBe(true);
  });

  test('纯中文推文被跳过，不发 API', async ({ context }) => {
    const requests = installApi(context);
    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 2000 });
    // 触发视口内所有推文
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    // 所有 API 请求文本中都不应包含 tweet-1004 的原文特征
    const allTexts = requests.flatMap(r => r.texts).join(' ');
    expect(allTexts).not.toContain('诡异的重试循环');
  });

  test('含 mentions/hashtags/链接的推文提取出可翻译的纯文本', async ({ context }) => {
    const requests = installApi(context);
    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 2000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('#tweet-1007 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // tweet-1007 的文本应包含 @ivan / #rustlang / 实质内容
    const found = requests.find(r => r.texts.some(t => t.includes('rustlang') && t.includes('async runtime')));
    expect(found).toBeTruthy();
  });

  test('引用推文：外层和内层分别被识别为独立 article，各自翻译', async ({ context }) => {
    const requests = installApi(context);
    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 2000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // 内层和外层各自应有翻译块（每个 article 独立翻译）
    await expect(page.locator('#quoted-991 .dualang-translation')).toBeVisible({ timeout: 5000 });
    // 外层 #tweet-1005 子树下应包含 2 个翻译块：外层自己 + 嵌套的引用推文
    await expect(page.locator('#tweet-1005 .dualang-translation')).toHaveCount(2, { timeout: 5000 });
    // 内层翻译块只被渲染了一次（而非被外层 article 的 renderTranslation 重复插入）
    await expect(page.locator('#quoted-991 .dualang-translation')).toHaveCount(1);
  });

  test('虚拟 DOM 回收：article 被重绑到不同推文，不把旧翻译渲染到新推文', async ({ context }) => {
    // 慢响应 API — 在响应到达前触发 recycle
    const seenBodies: string[] = [];
    let seq = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      seq++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      seenBodies.push(content);
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      // 延迟 800ms，留出 recycle 窗口
      await new Promise(r => setTimeout(r, 800));
      const results = Array.from({ length: count }, (_, i) => ({
        index: i, translated: `慢译文#${seq}-${i}`,
      }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { const t = m.text(); if (t.includes('[Dualang')) logs.push(t); });
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    // 等第一批请求发出（API mock 会记录到 seenBodies）
    await expect.poll(() => seenBodies.length, { timeout: 5000 }).toBeGreaterThan(0);

    // 在 800ms 慢响应到达前，把 tweet-1001 的 article DOM 节点重绑到"不同推文"
    await page.evaluate(() => {
      (window as any).xSim.recycleArticle('1001', {
        id: '9999', user: 'newbie', displayName: 'Newbie',
        textHtml: 'Completely different tweet content now occupying this recycled DOM node.',
        lang: 'en',
      });
    });

    // 等原响应到达 + recycle 后的新请求也完成
    await expect.poll(() => seenBodies.length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1500);

    // 关键：原 tweet-1001 的 BatchItem 带着 tweetId=1001；响应到达时
    // article 的当前 getContentId 已变为 9999，renderAndCacheResult 的回收检测应触发 dom.recycle.drop
    const hasRecycleDrop = logs.some(l => l.includes('dom.recycle.drop'));
    expect(hasRecycleDrop).toBe(true);
  });

  test('行数严重不对等触发一次质量重试，之后接受结果', async ({ context, popupPage }) => {
    await savePopup(popupPage);

    // API mock：第一次返回 1 行坍缩译文（会被写入缓存），第二次必须绕过缓存并返回正常多行译文
    let call = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      call++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const translated = call === 1
        ? '行数被坍缩的单行译文'                           // 明显不够
        : '第一行\n第二行\n第三行\n第四行\n第五行';          // 合理
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    // 构造一个多行原文的推文，手动塞到 fixture 里
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { const t = m.text(); if (t.includes('[Dualang')) logs.push(t); });
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    // 插一条足够长的多段推文（超过 150 字符门槛）→ 触发质量检查
    await page.evaluate(() => {
      (window as any).xSim.appendTweet({
        id: '777', user: 'liner', displayName: 'MultiLiner',
        textHtml:
          'Line one of many with substantive content worth translating.\n\n'
          + 'Line two follows up with deeper elaboration and specifics.\n\n'
          + 'Line three here continues the thought with more detail.\n\n'
          + 'Line four next brings another angle to the discussion.\n\n'
          + 'Line five too adds yet more substance to the post.\n\n'
          + 'Line six and more rounds out the complete argument.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-777')?.scrollIntoView());

    // 关键：日志里应有 translation.quality.retry（这是核心断言）
    await expect.poll(() => logs.some(l => l.includes('translation.quality.retry')), { timeout: 8000 }).toBe(true);
    // 两次 API 调用都应发生（第一次被判定可疑后重试；skipCache 绕过刚写入的坏翻译）
    await expect.poll(() => call, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
    // 最终翻译内容应是第二次的正常多行结果，不是第一次的坍缩版本
    await expect(page.locator('#tweet-777 .dualang-translation')).toContainText('第五行', { timeout: 3000 });
  });

  test('统计 tab：成功请求后展示模型行、tokens、成功率；错误进入日志', async ({ context, popupPage }) => {
    await savePopup(popupPage);

    // 1 次成功 + 1 次失败
    let call = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      call++;
      if (call === 1) {
        const count = ((JSON.parse(route.request().postData() || '{}').messages?.[1]?.content || '').match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
        const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `译${i}` }));
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ results }) } }],
            usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
          }),
        });
      } else {
        // 不可重试错误（401）→ 记失败 + 写错误日志
        await route.fulfill({
          status: 401, contentType: 'application/json',
          body: JSON.stringify({ error: { type: 'invalid_api_key', message: 'bad key to log' } }),
        });
      }
    });

    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });
    // 等第一次成功
    await page.waitForSelector('article .dualang-translation', { timeout: 5000 });
    // 触发第二次（401）：追加一条新内容，hash miss 导致再次请求
    await page.evaluate(() => {
      (window as any).xSim.appendTweet({
        id: '7777', user: 'u', displayName: 'U',
        textHtml: 'Another fresh English tweet that needs a translation call.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-7777')?.scrollIntoView());
    await page.waitForTimeout(1500);

    // popup 切到"统计" tab，拉最新数据
    await popupPage.bringToFront();
    await popupPage.locator('.tab-button[data-tab="stats"]').click();
    await popupPage.locator('#refreshStatsBtn').click();

    // tokens 总数应反映 usage.total_tokens=200
    await expect(popupPage.locator('#statTotalTokens')).not.toHaveText('–', { timeout: 3000 });
    // 至少一行模型卡
    await expect(popupPage.locator('.model-row').first()).toBeVisible();
    // 错误日志里应包含 401 返回的 message 片段
    const errText = await popupPage.locator('#errorLogList').innerText();
    expect(errText).toMatch(/bad key to log|invalid_api_key|API Key/);
  });

  test('选择浏览器本地翻译预设 → 保存后 API/模型字段被禁用，providerType 持久化', async ({ popupPage }) => {
    await popupPage.locator('#preset').selectOption('browser-native');
    // API Key / baseUrl / model 等 HTTP 相关字段应被置灰
    await expect(popupPage.locator('#apiKey')).toBeDisabled();
    await expect(popupPage.locator('#baseUrl')).toBeDisabled();
    await expect(popupPage.locator('#model')).toBeDisabled();
    await expect(popupPage.locator('#maxTokens')).toBeDisabled();

    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    // 刷新 popup，字段仍是 browser-native
    await popupPage.reload();
    await expect(popupPage.locator('#preset')).toHaveValue('browser-native');
    await expect(popupPage.locator('#apiKey')).toBeDisabled();
  });

  test('质量重试用严格 prompt，API 收到 strictMode=true', async ({ context, popupPage }) => {
    await savePopup(popupPage);

    // 记录每次请求的 system prompt，用于验证第二次请求用的是严格版
    const prompts: string[] = [];
    let call = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      call++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const sysPrompt: string = postData.messages?.[0]?.content || '';
      prompts.push(sysPrompt);
      const count = (postData.messages?.[1]?.content?.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      // 第一次返回过短译文（触发质量检查）；第二次返回合理译文
      const translated = call === 1
        ? '短译'  // 20字原文 → 2字译文，触发
        : '完整翻译后的较长译文保留原文的多个段落含有 URL 例如 example.com 不被翻译';
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    // 插一条 >150 可翻译字符的推文，不含大量 URL（确保进入质量检查）
    await page.evaluate(() => {
      (window as any).xSim.appendTweet({
        id: '9091', user: 'strict', displayName: 'Strict',
        textHtml:
          'First paragraph with enough substance to count.\n\n'
          + 'Second paragraph continues the thought with more detail.\n\n'
          + 'Third paragraph provides additional context for translation.\n\n'
          + 'Fourth paragraph wraps it up nicely.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-9091')?.scrollIntoView());

    // 等到至少一次质量重试发生（即出现包含严格前缀的 prompt）
    await expect.poll(
      () => prompts.some((p) => p.includes('严格模式必须遵守')),
      { timeout: 6000 },
    ).toBe(true);

    // 第一次请求是常规 prompt（不含严格前缀）
    expect(prompts[0]).not.toContain('严格模式必须遵守');
    // 必有一条请求带严格前缀，且包含核心规则
    const strict = prompts.find((p) => p.includes('严格模式必须遵守'))!;
    expect(strict).toContain('严禁省略、合并、总结');
  });

  test('两次连续质量不佳时显示 fail 图标而非 success', async ({ context, popupPage }) => {
    await savePopup(popupPage);
    // API 两次都返回坍缩译文 — 重试后仍可疑 → 显示 fail
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const count = (postData.messages?.[1]?.content?.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: '永远只有一行' }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.evaluate(() => {
      (window as any).xSim.appendTweet({
        id: '888', user: 'liner2', displayName: 'MultiLiner2',
        textHtml:
          'Paragraph one with content to meet the length threshold.\n\n'
          + 'Paragraph two also substantial enough to matter here.\n\n'
          + 'Paragraph three continues the pattern for completeness.\n\n'
          + 'Paragraph four wraps up the six-paragraph structure.\n\n'
          + 'Paragraph five is there for robustness.\n\n'
          + 'Paragraph six finalizes the test input.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-888')?.scrollIntoView());

    // 既不是 success 也没挂翻译块 fail 图标（取决于渲染顺序，断言 fail 图标可见）
    await expect(page.locator('#tweet-888 .dualang-status--fail')).toBeVisible({ timeout: 8000 });
    // fail 图标的 title 应提示段落差异
    const failTitle = await page.locator('#tweet-888 .dualang-status--fail').getAttribute('title');
    expect(failTitle).toMatch(/段落|差异|强制重新翻译/);
  });

  test('同一 contentId 但内容被编辑（长度不变）时缓存应失效并重翻', async ({ context, popupPage }) => {
    await savePopup(popupPage);
    let call = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      call++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const text: string = postData.messages?.[1]?.content || '';
      const count = (text.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      // 第一次翻译旧文本，第二次翻译编辑后的文本 — 翻译里带明显标识
      const marker = text.includes('grapes') ? '葡萄译文' : '苹果译文';
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: marker }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { const t = m.text(); if (t.includes('[Dualang')) logs.push(t); });
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    // 1) 先加一条原始文本：我爱苹果（15 chars，但要超过 150 字符门槛才方便 — 用充分长度）
    await page.evaluate(() => {
      (window as any).xSim.appendTweet({
        id: '333', user: 'editu', displayName: 'Editor',
        textHtml: 'I really enjoy eating sweet red apples from the local orchard every morning.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-333')?.scrollIntoView());
    await expect(page.locator('#tweet-333 .dualang-translation')).toContainText('苹果译文', { timeout: 5000 });

    // 2) 模拟"同 contentId，编辑后的内容"重入 DOM：同长度字符串，只换"apples"→"grapes"
    await page.evaluate(() => {
      (window as any).xSim.removeTweet('333');
      (window as any).xSim.appendTweet({
        id: '333', user: 'editu', displayName: 'Editor',
        textHtml: 'I really enjoy eating sweet red grapes from the local orchard every morning.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-333')?.scrollIntoView());

    // 关键：cache.invalidate.stale 应以 reason:'edit'（长度未变）触发
    await expect.poll(
      () => logs.some(l => l.includes('cache.invalidate.stale') && l.includes('edit')),
      { timeout: 5000 }
    ).toBe(true);
    await expect.poll(() => call, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    // 最终译文来自第二次请求
    await expect(page.locator('#tweet-333 .dualang-translation')).toContainText('葡萄译文', { timeout: 3000 });
  });

  test('同一 contentId 再次出现时，若当前文本显著更长（从列表跳转到详情页）则缓存失效并重翻', async ({ context, popupPage }) => {
    await savePopup(popupPage);
    let call = 0;
    const translations = ['短译文'];  // 第一次：给短文本的短译文；第二次：给长文本的长译文
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      call++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const count = (postData.messages?.[1]?.content?.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const t = call === 1 ? '短译文' : '段一\n\n段二\n\n段三\n\n段四\n\n段五';
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: t }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { const t = m.text(); if (t.includes('[Dualang')) logs.push(t); });
    await page.goto(realPage);
    await page.setViewportSize({ width: 800, height: 900 });

    // 先插入一条短文本推文（模拟时间线上的截断版本），翻译完成入缓存
    await page.evaluate(() => {
      (window as any).xSim.appendTweet({
        id: '555', user: 'truncu', displayName: 'Trunc',
        textHtml: 'Short preview text.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-555')?.scrollIntoView());
    await expect(page.locator('#tweet-555 .dualang-translation')).toContainText('短译文', { timeout: 5000 });

    // 模拟 SPA 导航到详情页：移除旧 cell，换上一个同 tweetId 但含完整长文本的 cell
    await page.evaluate(() => {
      (window as any).xSim.removeTweet('555');
      (window as any).xSim.appendTweet({
        id: '555', user: 'truncu', displayName: 'Trunc',
        // 远比 "Short preview text." 长的多段落全文
        textHtml: 'Full paragraph one with much more detail.\n\nFull paragraph two also much longer.\n\nFull paragraph three here.\n\nFull paragraph four.\n\nFull paragraph five.\n\nFull paragraph six.',
        lang: 'en', hasShowMore: false,
      });
    });
    await page.evaluate(() => document.getElementById('cell-555')?.scrollIntoView());

    // 关键：日志里应有 cache.invalidate.stale（长度差检测命中）
    await expect.poll(() => logs.some(l => l.includes('cache.invalidate.stale')), { timeout: 5000 }).toBe(true);
    // 应该触发了第二次 API 调用（拿到长译文）
    await expect.poll(() => call, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    // 最终渲染的应是长译文，不是旧的"短译文"
    await expect(page.locator('#tweet-555 .dualang-translation')).toContainText('段五', { timeout: 3000 });
  });
});
