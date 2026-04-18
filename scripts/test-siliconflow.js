// 测试 SiliconFlow GLM-4-9B-0414 API 连通性
// 使用方法：
//   1. 从 https://cloud.siliconflow.cn/ 注册并获取 API Key
//   2. 将下面的 API_KEY 替换为你的真实 Key
//   3. 在项目根目录运行：node scripts/test-siliconflow.js

const API_KEY = 'sk-xxxx'; // <-- 替换为你的 SiliconFlow API Key

async function test() {
  if (API_KEY === 'sk-xxxx' || !API_KEY.startsWith('sk-')) {
    console.error('请先将脚本中的 API_KEY 替换为你的真实 SiliconFlow API Key');
    process.exit(1);
  }

  const url = 'https://api.siliconflow.cn/v1/chat/completions';
  const body = {
    model: 'THUDM/GLM-4-9B-0414',
    messages: [
      { role: 'system', content: '你是一个翻译助手，只输出翻译结果。' },
      { role: 'user', content: 'Hello world' }
    ],
    temperature: 0.3,
    max_tokens: 64
  };

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const latency = Date.now() - start;

    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ 请求失败 HTTP ${res.status}`);
      console.error(text);
      process.exit(1);
    }

    const data = await res.json();
    const translated = data.choices?.[0]?.message?.content?.trim();
    console.log(`✅ 测试成功 (${latency}ms)`);
    console.log('模型返回:', translated);
  } catch (err) {
    console.error('❌ 网络请求异常:', err.message);
    process.exit(1);
  }
}

test();
