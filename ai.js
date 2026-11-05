// 轉文字（Groq 的 Whisper，免費方案）與摘要（Claude）。
import { config } from './config.js';
import { withRetry, httpError } from './http.js';

// Groq 免費方案每分鐘 20 次、每小時 7200 秒音檔；超過會回 429，這裡最多重試 5 次並遵守 retry-after。
export function transcribe(wavBuffer) {
  return withRetry(async () => {
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'segment.wav');
    form.append('model', config.transcribeModel);
    form.append('language', config.transcribeLanguage);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', '以下是繁體中文的語音對話，使用台灣用語。');

    const res = await fetch(config.transcribeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqKey}` },
      body: form,
    });
    if (!res.ok) throw await httpError(res, '轉文字');
    const data = await res.json();
    return (data.text || '').trim();
  }, '轉文字', 5);
}

const TEMPLATES = {
  面試: `請依照以下標題整理（標題一字不改，用「## 」開頭；條列用「- 」開頭）：
## 摘要
## 應徵者自述重點
## 重點問答
## 觀察到的優勢
## 需要留意的地方
## 待確認事項
注意：不要給出錄取或不錄取的結論，最終決定由人事管理判斷。`,
  會議: `請依照以下標題整理（標題一字不改，用「## 」開頭；條列用「- 」開頭）：
## 摘要
## 討論議題
## 決議
## 待辦事項
## 尚未決定的事項
待辦事項格式：「- 事項（負責人／期限）」，逐字稿沒提到的負責人或期限寫「未指定」。`,
};

export function summarize({ type, title, position, participants, transcript }) {
  const system = `你是 Discord 社群「貓居」人事管理的紀錄助理。
根據逐字稿整理紀錄，使用繁體中文，語氣克制、專業、直接。
規則：
- 只根據逐字稿內容整理，不要推測或補充逐字稿沒有的資訊。
- 逐字稿由語音辨識產生，可能有錯字或聽錯；意思不明確的地方標註「（逐字稿不清楚）」。
- 某個標題下沒有內容時寫「- 無」。
- 不要輸出標題以外的開場白或結語。`;

  const meta = [
    `類型：${type}`,
    `標題：${title}`,
    position ? `應徵職位：${position}` : null,
    `參與者：${participants.join('、') || '（無）'}`,
  ].filter(Boolean).join('\n');

  // 超長逐字稿保留頭尾，避免超出模型上限
  const MAX = 300_000;
  const body = transcript.length > MAX
    ? `${transcript.slice(0, MAX / 2)}\n\n（中間過長，已省略）\n\n${transcript.slice(-MAX / 2)}`
    : transcript;

  return withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 4000,
        system,
        messages: [{
          role: 'user',
          content: `${meta}\n\n${TEMPLATES[type]}\n\n<逐字稿>\n${body || '（沒有辨識到任何語音）'}\n</逐字稿>`,
        }],
      }),
    });
    if (!res.ok) throw await httpError(res, '摘要');
    const data = await res.json();
    return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  }, '摘要');
}
