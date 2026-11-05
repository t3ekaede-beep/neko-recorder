// Notion：上傳音檔、建立紀錄頁、到期清除音檔。
// 資料庫欄位名稱必須和 PROP 完全一致（README 有建立方式）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { withRetry, httpError } from './http.js';

export const PROP = {
  title: '標題',
  type: '類型', // select：面試／會議
  date: '日期', // date
  recorder: '錄音者', // rich_text
  participants: '參與者', // rich_text
  position: '應徵職位', // rich_text
  audio: '音檔', // files
  audioExpiry: '音檔刪除日', // date
};

const API = 'https://api.notion.com/v1';
const SINGLE_PART_LIMIT = 20 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const TEXT_LIMIT = 2000;

function headers(json = true) {
  const h = { Authorization: `Bearer ${config.notionToken}`, 'Notion-Version': config.notionVersion };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function call(method, url, body) {
  return withRetry(async () => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await httpError(res, `Notion ${method} ${url}`);
    return res.json();
  }, 'Notion');
}

function sendPart(uploadId, buf, filename, contentType, partNumber) {
  return withRetry(async () => {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: contentType }), filename);
    if (partNumber) form.append('part_number', String(partNumber));
    const res = await fetch(`${API}/file_uploads/${uploadId}/send`, {
      method: 'POST',
      headers: headers(false),
      body: form,
    });
    if (!res.ok) throw await httpError(res, 'Notion 上傳');
    return res.json();
  }, 'Notion 上傳');
}

// 小於 20MB 一次上傳，超過就分段（每段 10MB）。
export async function uploadFile(filePath, contentType = 'audio/ogg') {
  const filename = path.basename(filePath);
  const { size } = await fs.promises.stat(filePath);

  if (size <= SINGLE_PART_LIMIT) {
    const up = await call('POST', '/file_uploads', { mode: 'single_part', filename, content_type: contentType });
    await sendPart(up.id, await fs.promises.readFile(filePath), filename, contentType);
    return up.id;
  }

  const parts = Math.ceil(size / PART_SIZE);
  const up = await call('POST', '/file_uploads', {
    mode: 'multi_part', filename, content_type: contentType, number_of_parts: parts,
  });
  const fh = await fs.promises.open(filePath, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const len = Math.min(PART_SIZE, size - i * PART_SIZE);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, i * PART_SIZE);
      await sendPart(up.id, buf, filename, contentType, i + 1);
    }
  } finally {
    await fh.close();
  }
  await call('POST', `/file_uploads/${up.id}/complete`);
  return up.id;
}

function richText(text) {
  const out = [];
  const chars = [...text]; // 依字元切，避免切壞中文或 emoji
  for (let i = 0; i < chars.length && out.length < 100; i += TEXT_LIMIT) {
    out.push({ type: 'text', text: { content: chars.slice(i, i + TEXT_LIMIT).join('') } });
  }
  return out.length ? out : [{ type: 'text', text: { content: '' } }];
}

const block = (type, text) => ({ object: 'block', type, [type]: { rich_text: richText(text) } });

// 把 Claude 的摘要（## 標題、- 條列）轉成 Notion 區塊
export function summaryToBlocks(md) {
  const blocks = [];
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('### ')) blocks.push(block('heading_3', line.slice(4)));
    else if (line.startsWith('## ')) blocks.push(block('heading_2', line.slice(3)));
    else if (line.startsWith('# ')) blocks.push(block('heading_2', line.slice(2)));
    else if (/^\s*[-*] /.test(line)) blocks.push(block('bulleted_list_item', line.replace(/^\s*[-*] /, '')));
    else blocks.push(block('paragraph', line));
  }
  return blocks;
}

async function appendAll(parentId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await call('PATCH', `/blocks/${parentId}/children`, { children: blocks.slice(i, i + 100) });
    await new Promise((r) => setTimeout(r, 350)); // Notion 限速約每秒 3 次
  }
}

export function taipeiISO(ms) {
  return new Date(ms + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}
const taipeiDate = (ms) => taipeiISO(ms).slice(0, 10);

export async function createRecordPage({
  type, title, position, recorderName, participantNames,
  startMs, endMs, audioUploadId, audioNote, summary, transcriptLines,
}) {
  const props = {
    [PROP.title]: { title: richText(title) },
    [PROP.type]: { select: { name: type } },
    [PROP.date]: { date: { start: taipeiISO(startMs), end: taipeiISO(endMs) } },
    [PROP.recorder]: { rich_text: richText(recorderName) },
    [PROP.participants]: { rich_text: richText(participantNames.join('、')) },
  };
  if (position) props[PROP.position] = { rich_text: richText(position) };
  if (audioUploadId) {
    props[PROP.audio] = {
      files: [{ type: 'file_upload', file_upload: { id: audioUploadId }, name: `${taipeiDate(startMs)}-${title}.ogg` }],
    };
    props[PROP.audioExpiry] = { date: { start: taipeiDate(Date.now() + config.retentionDays * 86400_000) } };
  }

  const head = [];
  if (audioNote) head.push({ object: 'block', type: 'callout', callout: { rich_text: richText(audioNote) } });
  head.push(...summaryToBlocks(summary));
  head.push({ object: 'block', type: 'divider', divider: {} });
  head.push({ object: 'block', type: 'toggle', toggle: { rich_text: richText('逐字稿（點開展開）') } });

  const page = await call('POST', '/pages', {
    parent: { database_id: config.notionDatabaseId },
    properties: props,
    children: head.slice(0, 100),
  });
  if (head.length > 100) await appendAll(page.id, head.slice(100));

  // 找到剛建立的「逐字稿」折疊區塊，把逐字稿放進去
  let toggleId = null;
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const list = await call('GET', `/blocks/${page.id}/children${q}`);
    const t = list.results.find((b) => b.type === 'toggle');
    if (t) toggleId = t.id;
    cursor = list.has_more ? list.next_cursor : undefined;
  } while (!toggleId && cursor);

  const lines = transcriptLines.length ? transcriptLines : ['（沒有辨識到任何語音）'];
  await appendAll(toggleId ?? page.id, lines.map((l) => block('paragraph', l)));
  return page.url;
}

// 清除已到期的音檔：只清「音檔」欄位，逐字稿和摘要保留。
export async function purgeExpiredAudio() {
  const today = taipeiDate(Date.now());
  let count = 0;
  // 清掉的頁面會從篩選結果消失，所以每輪都從頭查，直到查不到為止（最多 20 輪防呆）
  for (let round = 0; round < 20; round++) {
    const res = await call('POST', `/databases/${config.notionDatabaseId}/query`, {
      filter: {
        and: [
          { property: PROP.audioExpiry, date: { on_or_before: today } },
          { property: PROP.audio, files: { is_not_empty: true } },
        ],
      },
      page_size: 50,
    });
    if (!res.results.length) break;
    for (const page of res.results) {
      await call('PATCH', `/pages/${page.id}`, { properties: { [PROP.audio]: { files: [] } } });
      count++;
    }
  }
  return count;
}
