# X 光速翻译

**刷 X 时，译文应该像空气一样不被察觉。**

专为 **X.com / Twitter** 打造的沉浸式翻译插件（项目代号 Dualang）。它不做弹窗面板，而是让译文直接长在时间线上——滚动到视野内的推文自动译好，点击「译」按钮毫秒出结果，展开 Show more、刷新页面、切换网络，体验都丝般顺滑。

**为什么快？** 视窗检测 + 本地双层缓存 + 请求去重，大部分翻译零网络等待。**为什么稳？** 主 API 与兜底 API 并发赛马，谁先到用谁，主线路卡顿自动无缝切换。**为什么准？** 智能难词预筛 + 段落级词典融合 + 逐行双语对照，专业术语不再望文生义。

支持 SiliconFlow（GLM-4-9B / Qwen 免费模型）、Moonshot Kimi、阿里通义千问等多家 provider，API Key 仅保存在本地浏览器，隐私零妥协。

## 功能特性

- 🎯 **专为 X.com 深度优化**：自动识别推文正文，一键翻译，完美融入暗黑/亮色主题
- ⚡ **视窗即译**：基于 `IntersectionObserver`，滚动到视野内的推文自动触发翻译，减少无效调用
- 🔘 **点击秒回**：手动模式下每条推文右下角出现「译」按钮，点击即译，本地缓存零等待
- 🏇 **多模型赛马**：主 API 与兜底 API 并发请求，先到先用；主线路故障时自动无缝切换
- 🎨 **四种展示模式**：`append`（保留原文）/ `translation-only` / `inline`（段落对照）/ `bilingual`（整体对照）
- 📖 **智能字典融合**：本地 Zipf+音节+词长预筛难词，翻译时自动注入术语释义，段落级精准融合
- ✨ **逐行双语对照**：长推按原文行结构逐行拼接译文，阅读节奏不被打乱
- 🔄 **流式输出**：支持 SSE 实时返回翻译结果，长文也能边译边看
- 💾 **双层缓存**：内存 LRU + `chrome.storage.local` 持久缓存，配合请求去重显著降低 API 费用
- 🌐 **多语言支持**：简中、繁中、英、日、韩、法、德、西、俄等语言互译
- 🔒 **隐私优先**：API Key 与设置仅存储在本地浏览器，不经过任何第三方服务器

## 安装步骤

1. 打开 Chrome 浏览器，进入 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目所在的 `dualang` 文件夹
5. 安装成功后，点击浏览器右上角的「X 光速翻译」图标，配置你的 Kimi Code API Key

## 使用方法

1. **获取 API Key**：前往 [SiliconFlow](https://cloud.siliconflow.cn/) 注册并创建免费 API Key（格式如 `sk-...`）
2. **配置插件**：点击 Chrome 工具栏的「X 光速翻译」图标，填入 API Key（默认 API 地址 `https://api.siliconflow.cn/v1`、模型 `THUDM/GLM-4-9B-0414`）
3. **翻译推文**：
   - 自动模式：开启「自动翻译推文」，视口内的推文自动翻译
   - 手动模式：关闭自动翻译后，每条推文右下角出现「译」按钮，点击即译

## 设置说明

| 设置项 | 说明 |
|--------|------|
| **API 地址 (Entrypoint)** | 默认 `https://api.siliconflow.cn/v1` |
| **API Key** | 你的 SiliconFlow 或 Moonshot API Key，格式如 `sk-...` |
| **模型 (Model)** | 默认 `THUDM/GLM-4-9B-0414` |
| **推理强度 (Reasoning Effort)** | `low` / `medium` / `high` |
| **最大输出 Token** | 限制单次翻译最大输出长度，默认 `4096` |
| **启用流式输出** | 开启后使用 SSE 流式接收翻译结果（缓存对此模式不生效） |
| **目标语言** | 翻译输出的语言 |
| **自动翻译推文** | 页面滚动加载新推文时自动翻译 |
| **展示模式** | `append`（译文下方保留原文）/ `translation-only` / `inline`（段落对照）/ `bilingual`（整体对照）|

## 项目结构

```
dualang/
├── manifest.json       # Chrome 扩展清单
├── background.js       # Service Worker，处理 Kimi API 请求与缓存
├── content.js          # 内容脚本，注入 X.com 页面
├── styles.css          # 注入样式
├── popup.html          # 扩展弹窗页面
├── popup.js            # 弹窗逻辑
├── popup.css           # 弹窗样式
├── icons/              # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── e2e/                # Playwright E2E 测试
│   ├── fixtures/
│   ├── tests/
│   ├── playwright.config.ts
│   └── package.json
├── test-manual.html    # 手动测试页
└── README.md
```

## 技术说明

- 采用 **Chrome Extension Manifest V3** 构建
- 内容脚本通过 `MutationObserver` 监听动态加载的推文
- 翻译请求通过 `background.js` 代理至用户配置的 LLM API（SiliconFlow / Moonshot / 通义千问等），避免 X.com 的 CORS 限制
- 使用 `chrome.storage.sync` 同步用户设置
- 本地双层缓存（内存 LRU + `chrome.storage.local`）与请求去重，显著降低 API 调用费用
- 视口检测（`IntersectionObserver`）避免快速滚动时的无效翻译
- 支持 **流式输出 (SSE)** 解析，实时返回翻译结果
- 支持 **赛马模式**（主 API + 兜底 API 并发竞争，先到先用）

## 运行 E2E 测试

项目使用 [Playwright](https://playwright.dev/) 进行端到端测试，覆盖扩展加载、设置保存、内容脚本注入、翻译流程、缓存命中和自动翻译等场景。

```bash
cd e2e
npm install
npx playwright test          # 无界面静默运行（headless）
npx playwright test --ui     # Playwright UI 模式
```

测试说明：
- Playwright 会自动加载本地扩展并启动 mock HTTP 服务（`localhost:9999`）
- 测试在无界面模式下静默运行，不会弹出浏览器窗口
- `manifest.json` 中已包含 `http://localhost:9999/*`，专供 E2E 测试使用

## 注意事项

- 本插件适用于 `x.com`、`twitter.com` 及本地测试环境
- 请妥善保管你的 API Key，不要分享给他人
- 自动翻译功能会消耗 API 调用额度，请根据需求开启

## 参考资料 · References

- **SiliconFlow 定价**（GLM-4-9B / Qwen3-8B / Qwen2.5-7B 等免费模型）
  https://siliconflow.cn/pricing
- **Moonshot Kimi 开放平台**（API 认证、速率限制、错误码）
  https://platform.moonshot.cn/
- **阿里通义千问 Qwen**
  https://chat.qwen.ai/
- **智谱 z.ai（GLM 系列）**
  https://z.ai/

## License

Apache-2.0
