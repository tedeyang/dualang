# X 光速翻译

**刷 X 时，译文应该像空气一样不被察觉。**

专为 **X.com / Twitter** 打造的沉浸式翻译插件（项目代号 Dualang）。视窗里的推文进到眼里就已经译好；点 Show more、手动「译」、重试这些用户动作一律秒回，绝不排队；主 API 抽风时，兜底已经在路上跑了半程，谁先到用谁。

支持 Moonshot Kimi · SiliconFlow（GLM / Qwen 免费）· Chrome & Edge 浏览器内置 Translator API（离线、免 Key），一次配置，随 X 的抽风自动切换。

## 功能特性

- 🎯 **专为 X.com 优化**：自动识别推文内容，提供一键翻译
- 🌐 **多语言支持**：支持简中、繁中、英、日、韩、法、德、西、俄等语言
- ⚡ **自动翻译**：可选自动翻译所有新加载的推文，支持视口检测减少无效调用
- 🎨 **沉浸式 UI**：翻译结果优雅嵌入推文下方，完美融入 X.com 暗黑风格
- 📖 **双语对照**：段落级原文+译文对照，鼠标悬停高亮原文
- 🔒 **隐私安全**：API Key 仅存储在本地浏览器，不经过任何第三方服务器

## 安装步骤

1. 打开 Chrome 浏览器，进入 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目所在的 `dualang` 文件夹
5. 安装成功后，点击浏览器右上角的「X 光速翻译」图标，配置你的 Kimi Code API Key

## 使用方法

1. **获取 API Key**：前往 [Moonshot 开放平台](https://platform.moonshot.cn/) 注册并创建 API Key（格式如 `sk-...`）
2. **配置插件**：点击 Chrome 工具栏的「X 光速翻译」图标，填写 API 地址（默认 `https://api.moonshot.cn/v1`）、API Key、模型（如 `moonshot-v1-8k`）等参数
3. **翻译推文**：
   - 手动模式：在 X.com 浏览时，点击推文正文右下角的「翻译」按钮
   - 自动模式：开启「自动翻译推文」，新加载的推文将自动翻译

## 设置说明

| 设置项 | 说明 |
|--------|------|
| **API 地址 (Entrypoint)** | 默认 `https://api.moonshot.cn/v1` |
| **API Key** | 你的 Moonshot API Key，格式如 `sk-...` |
| **模型 (Model)** | 默认 `moonshot-v1-8k`，可按需填写其他模型 |
| **推理强度 (Reasoning Effort)** | `low` / `medium` / `high` |
| **最大输出 Token** | 限制单次翻译最大输出长度，默认 `4096` |
| **启用流式输出** | 开启后使用 SSE 流式接收翻译结果（缓存对此模式不生效） |
| **目标语言** | 翻译输出的语言 |
| **自动翻译推文** | 页面滚动加载新推文时自动翻译 |
| **保留原文对照** | 开启后显示段落级双语对照；关闭后仅显示紧凑译文 |

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
- 翻译请求通过 `background.js` 代理至 **Moonshot Open API**，避免 X.com 的 CORS 限制
- 使用 `chrome.storage.sync` 同步用户设置
- 本地缓存（`chrome.storage.local`）与请求去重，显著降低 API 调用费用
- 视口检测（`IntersectionObserver`）避免快速滚动时的无效翻译
- 支持 **流式输出 (SSE)** 解析，实时返回翻译结果

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

翻译提供方的官方文档与定价页面：

- **SiliconFlow 定价**（Qwen3-8B / Qwen2.5-7B-Instruct / GLM-4-9B 等免费模型托管入口与限额）
  https://siliconflow.cn/pricing
- **Moonshot Kimi 开放平台**（API 认证、速率限制、错误码）
  https://platform.moonshot.cn/
- **阿里通义千问 Qwen 官方入口**（品牌主页，图标来源）
  https://chat.qwen.ai/
- **智谱 z.ai（GLM 系列）** 模型作者官网
  https://z.ai/

浏览器内置翻译 API（Chrome 和 Edge 共用同一 W3C 标准接口，`self.Translator.create()` / `translate()`）：

- **Chrome Translator API**（Chrome 138+ 通用可用，桌面端 / 约 22GB 空间）
  https://developer.chrome.com/docs/ai/translator-api
- **Microsoft Edge Translator API**（Edge Canary/Dev 143+，需开启 `edge://flags/#edge-translation-api`）
  https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api
- **W3C Translator API Explainer**（标准草案）
  https://github.com/webmachinelearning/translation-api
- **Chrome 客户端翻译总览**（语言检测 + 翻译组合使用）
  https://developer.chrome.com/docs/ai/translate-on-device

## License

MIT
