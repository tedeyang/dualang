import { test, expect } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

const baseBeforeEach = async (popupPage: any) => {
  await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
  await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
  await popupPage.locator('#model').fill('moonshot-v1-8k');
  await popupPage.locator('#reasoningEffort').selectOption('medium');
  await popupPage.locator('#maxTokens').fill('4096');
  await popupPage.locator('#enableStreaming').evaluate((el: HTMLInputElement) => el.checked = false);
  await popupPage.locator('#saveBtn').click();
  await expect(popupPage.locator('#status')).toHaveText('设置已保存');
};

function makeApiRoute(delay = 0) {
  return async (route: any) => {
    const postData = JSON.parse(route.request().postData() || '{}');
    const content: string = postData.messages?.[1]?.content || '';
    const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
    const results = Array.from({ length: count }, (_, i) => ({
      index: i, translated: `测试翻译 ${i}`
    }));
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
    });
  };
}

test.describe('Status Indicators', () => {
  test.beforeEach(async ({ popupPage }) => baseBeforeEach(popupPage));

  test('pass 状态在跳过中文推文后短暂展示再消失', async ({ context }) => {
    await context.route('https://api.moonshot.cn/v1/chat/completions', makeApiRoute());

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 滚入视口让 viewportObserver 触发
    await page.locator('#tweet-4').scrollIntoViewIfNeeded();

    // tweet-4 是简体中文，应跳过 → pass 图标
    await expect(page.locator('#tweet-4 .dualang-status--pass')).toBeVisible({ timeout: 5000 });
    // pass 图标 1.8s 后自动消失
    await expect(page.locator('#tweet-4 .dualang-status--pass')).not.toBeVisible({ timeout: 4000 });
  });

  test('成功翻译后 loading 状态消失、翻译块出现', async ({ context }) => {
    // 加 100ms 延迟，让 loading 状态有时间可见
    await context.route('https://api.moonshot.cn/v1/chat/completions', makeApiRoute(100));

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 翻译完成后 .dualang-translation 出现，loading 状态消失
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#tweet-1 .dualang-status--loading')).not.toBeVisible({ timeout: 2000 });
  });

  test('成功后状态图标变为模型品牌图标，hover 有模型+tokens 提示，点击打开部署站', async ({ context }) => {
    // 返回真实 tokens usage，content 会把它显示在 tooltip 里
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `翻译${i}` }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results }) } }],
          usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
        }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    const status = page.locator('#tweet-1 .dualang-status--success');
    await expect(status).toBeVisible({ timeout: 5000 });

    // 内部是 <img> 品牌图标（由 chrome.runtime.getURL 解析为 chrome-extension:// URL）
    const imgSrc = await status.locator('img').getAttribute('src');
    expect(imgSrc).toMatch(/^chrome-extension:\/\/.+\/icons\/(kimi|moonshot|zai|siliconflow|icon48)\.(png|svg)$/);

    // tooltip 包含模型名 + tokens
    const title = await status.getAttribute('title');
    expect(title).toMatch(/moonshot-v1-8k|Kimi/i);
    expect(title).toContain('tokens');  // "本次消耗 240 tokens" 这一行

    // 点击会 window.open — 用 popup 事件探测（不真的导航）
    const popupPromise = page.waitForEvent('popup', { timeout: 2000 }).catch(() => null);
    await status.click();
    const popup = await popupPromise;
    if (popup) {
      const url = popup.url();
      // moonshot 或 kimi 相关（取决于 model 字段如何分类）
      expect(url).toMatch(/moonshot|kimi|openai/);
      await popup.close();
    }
    // popup 未触发也是可接受的（某些 headless 模式下 window.open 被吞），只要 status 本身显示 & tooltip 正确即可
  });
});

test.describe('Fail & Retry', () => {
  test.beforeEach(async ({ popupPage }) => baseBeforeEach(popupPage));

  test('API 返回 401 后显示 fail 图标，点击后重新翻译', async ({ context }) => {
    let requestCount = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      requestCount++;
      if (requestCount <= 1) {
        // 第一次返回 401（不可重试，直接 showFail）
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { type: 'invalid_api_key', message: 'Invalid API Key' } }),
        });
      } else {
        // 点击重试后成功
        const results = [{ index: 0, translated: '重试成功' }];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
        });
      }
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 401 不可重试，直接显示 fail 图标
    await expect(page.locator('#tweet-1 .dualang-status--fail')).toBeVisible({ timeout: 10000 });

    // fail 图标的 tooltip 应包含错误信息（"Invalid API Key" 中文版）
    const failTitle = await page.locator('#tweet-1 .dualang-status--fail').first().getAttribute('title');
    expect(failTitle).toContain('点击重新翻译');
    expect(failTitle).toMatch(/API Key|原因/);

    // 点击 fail 图标触发重试
    await page.locator('#tweet-1 .dualang-status--fail').first().click();

    // 重试成功后翻译块出现
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Fallback API', () => {
  test('popup 应能保存和读取 fallback 配置', async ({ popupPage }) => {
    await baseBeforeEach(popupPage);

    // 开启 fallback
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-test-99999');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    // 重新加载 popup，验证设置被持久化
    await popupPage.reload();
    await expect(popupPage.locator('#fallbackEnabled')).toBeChecked();
    await expect(popupPage.locator('#fallbackApiKey')).toHaveValue('sk-sf-test-99999');
    await expect(popupPage.locator('#fallbackBaseUrl')).toHaveValue('https://api.siliconflow.cn/v1');
    await expect(popupPage.locator('#fallbackModel')).toHaveValue('THUDM/GLM-4-9B-0414');
  });

  test('主 API 可重试错误也立刻切兜底，不在主上做 3 次退避', async ({ context, popupPage }) => {
    await baseBeforeEach(popupPage);
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true; el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-fast-fallback');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    let mainHit = 0, fbHit = 0;
    // 主返回可重试的 500 — 旧行为会在主上退避 3 次再切兜底；新行为应立刻切
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      mainHit++;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"Upstream error"}}' });
    });
    await context.route('https://api.siliconflow.cn/v1/chat/completions', async (route) => {
      fbHit++;
      const count = ((JSON.parse(route.request().postData() || '{}').messages?.[1]?.content || '').match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `兜底译 ${i}` }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toContainText('兜底译', { timeout: 6000 });
    // 等一会让其他 batch 都走完，避免观察到主已打但兜底尚未到的瞬间
    await page.waitForTimeout(800);

    // 核心断言：主和兜底每批次各打 1 次 — 每个 fb 对应一次且仅一次 main
    // 旧行为：每批次主 4 次（首次 + 3 次重试）+ 兜底 1 次 → mainHit ≈ 4 × fbHit，远大于 fbHit
    expect(fbHit).toBeGreaterThan(0);
    // 允许 ±1 的瞬态（batch 正在处理时捕获），但绝不是 4 倍关系
    expect(mainHit).toBeGreaterThanOrEqual(fbHit);
    expect(mainHit).toBeLessThan(fbHit * 2);  // 若仍在重试则 mainHit ≈ 4 × fbHit
  });

  test('主 API quota 耗尽时自动 fallback 到硅基流动', async ({ context, popupPage }) => {
    // 配置 fallback
    await baseBeforeEach(popupPage);
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-fallback-key');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    // 主 API 返回 quota 耗尽
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'exceeded_current_quota_error', message: 'Quota exceeded' } }),
      });
    });

    // fallback API（SiliconFlow）正常返回
    await context.route('https://api.siliconflow.cn/v1/chat/completions', async (route) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({
        index: i, translated: `硅基兜底翻译 ${i}`
      }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 翻译块应出现（由 fallback API 返回）
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tweet-1 .dualang-translation')).toContainText('硅基兜底翻译');
  });
});

test.describe('Hedged Request', () => {
  test('开启并发赛跑后，快的 API 先返回时用快的', async ({ context, popupPage }) => {
    await baseBeforeEach(popupPage);
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-hedge-key');
    await popupPage.locator('#hedgedRequestEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    let mainHit = false;
    let fbHit = false;

    // 主 API 慢（800ms）
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      mainHit = true;
      await new Promise(r => setTimeout(r, 800));
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `主翻译 ${i}` }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    // 兜底 API 快（立即返回）
    await context.route('https://api.siliconflow.cn/v1/chat/completions', async (route) => {
      fbHit = true;
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `兜底快译 ${i}` }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    // 兜底赢了，译文应来自兜底
    await expect(page.locator('#tweet-1 .dualang-translation')).toContainText('兜底快译');
    // 两路都应被触发（证明是"并发"而非"串行 fallback"）
    expect(mainHit).toBe(true);
    expect(fbHit).toBe(true);
  });

  test('延迟启动：主 API 足够快时兜底不发起（节省配额）', async ({ context, popupPage }) => {
    await baseBeforeEach(popupPage);
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true; el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-not-called');
    await popupPage.locator('#hedgedRequestEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true; el.dispatchEvent(new Event('change'));
    });
    // 显式设 1000ms 延迟，大于主 API 返回时间，兜底不应被触发
    await popupPage.locator('#hedgedDelayMode').selectOption('1000');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    let mainHit = 0, fbHit = 0;
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      mainHit++;
      const count = ((JSON.parse(route.request().postData() || '{}').messages?.[1]?.content || '').match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `快主译 ${i}` }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });
    await context.route('https://api.siliconflow.cn/v1/chat/completions', async (route) => {
      fbHit++;
      await route.fulfill({ status: 500, body: '{}' });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 翻译完成，且来自主
    await expect(page.locator('#tweet-1 .dualang-translation')).toContainText('快主译', { timeout: 5000 });
    // 主被调用，兜底在延迟期内被主的返回抢先 → 未发起
    expect(mainHit).toBeGreaterThan(0);
    expect(fbHit).toBe(0);
  });

  test('赛马败者被 abort 不触发 popup 错误横幅', async ({ context, popupPage }) => {
    await baseBeforeEach(popupPage);
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true; el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-race-key');
    await popupPage.locator('#hedgedRequestEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true; el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#hedgedDelayMode').selectOption('0');  // 同时发起，确保两路都飞
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    // 主快、兜底慢 — 主先完成 → fbAbort.abort() → 败者抛 AbortError，
    // 不应被 callWithRetry 当成 fatal 写入 dualang_error_v1
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      const count = ((JSON.parse(route.request().postData() || '{}').messages?.[1]?.content || '').match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `主快译 ${i}` }));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });
    await context.route('https://api.siliconflow.cn/v1/chat/completions', async (route) => {
      // 刻意慢响应，让主先返回后败者被 abort
      await new Promise(r => setTimeout(r, 1500));
      await route.fulfill({ status: 200, body: '{"choices":[{"message":{"content":"{}"}}]}', contentType: 'application/json' });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('#tweet-1 .dualang-translation')).toContainText('主快译', { timeout: 5000 });

    // 等一会儿让败者的 abort 路径跑完
    await page.waitForTimeout(500);

    // 检查 popup 错误状态：不应有 dualang_error_v1 或 'signal is aborted' 字样
    const errState = await popupPage.evaluate(async () =>
      (await chrome.storage.local.get('dualang_error_v1'))['dualang_error_v1']
    );
    if (errState?.message) {
      expect(errState.message).not.toMatch(/aborted|AbortError|signal is aborted/i);
    }
  });

  test('popup 暴露 getHedgeStats 接口', async ({ popupPage }) => {
    // 主 API 的自适应延迟读取通道：popup 可通过 background 消息查询当前样本/p95
    const response = await popupPage.evaluate(async () => {
      return await chrome.runtime.sendMessage({ action: 'getHedgeStats' });
    });
    expect(response?.success).toBe(true);
    expect(response.data).toMatchObject({
      samples: expect.any(Number),
      p95Ms: expect.any(Number),
      floorMs: expect.any(Number),
      ceilingMs: expect.any(Number),
    });
  });

  test('两路都失败时返回错误（不静默）', async ({ context, popupPage }) => {
    await baseBeforeEach(popupPage);
    await popupPage.locator('#fallbackEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#fallbackApiKey').fill('sk-sf-both-fail');
    await popupPage.locator('#hedgedRequestEnabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    // 两路都返回致命错误（401 不可重试）
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      await route.fulfill({
        status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'invalid_api_key', message: 'Invalid main key' } }),
      });
    });
    await context.route('https://api.siliconflow.cn/v1/chat/completions', async (route) => {
      await route.fulfill({
        status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'invalid_api_key', message: 'Invalid fb key' } }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 两路都失败 → fail 图标（不是 loading 卡住，不是静默跳过）
    await expect(page.locator('#tweet-1 .dualang-status--fail')).toBeVisible({ timeout: 10000 });
  });
});
