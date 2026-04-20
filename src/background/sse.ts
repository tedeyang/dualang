/**
 * OpenAI 兼容 SSE 流解析器。
 *
 * 协议：每行 `data: <json>` 或 `data: [DONE]`；JSON 里 choices[0].delta.content 是增量。
 * 两点关键正确性：
 *   1. TextDecoder 的 `stream: true` 让多字节 UTF-8 字符跨 chunk 不被截断；
 *      循环结束后必须 `decoder.decode()`（无参）flush 内部残留字节，否则最后
 *      一个 CJK 字符可能变成 U+FFFD。
 *   2. 按 '\n' split 后用 `lines.pop()` 暂存"最后半行"到下一轮，否则 SSE line
 *      在 chunk 边界被切断会当噪声丢弃。
 */
export async function* iterateSseDeltas(response: Response): AsyncGenerator<string, void, void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  function extractDelta(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return null;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content;
      return typeof delta === 'string' ? delta : null;
    } catch {
      return null;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        const delta = extractDelta(line);
        if (delta) yield delta;
      }
    }
    // flush 内部字节缓冲；尾部残留行也处理
    buffer += decoder.decode();
    if (buffer) {
      const delta = extractDelta(buffer);
      if (delta) yield delta;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
