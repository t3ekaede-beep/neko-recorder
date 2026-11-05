// 純音訊處理：每人一軌的 PCM 寫入（含靜音補齊）、段落合併、WAV 轉換、ffmpeg 混音。
// 這個檔案不依賴 Discord，可單獨測試。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const SAMPLE_RATE = 16000; // 16kHz 單聲道，足夠語音辨識，檔案也小
const BYTES_PER_SAMPLE = 2; // s16le
const GAP_TOLERANCE = Math.round(SAMPLE_RATE * 0.2); // 0.2 秒內的延遲不補靜音
const ZERO_CHUNK = Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE); // 1 秒靜音

// 一個人一條音軌。說話時寫入聲音，沒說話的時間補靜音，讓所有人的音軌時間軸對齊。
export class TrackWriter {
  constructor(filePath, startTimeMs) {
    this.filePath = filePath;
    this.startTimeMs = startTimeMs;
    this.samples = 0;
    this.segments = []; // { start, end }，單位是 sample
    this.current = null;
    this.stream = fs.createWriteStream(filePath);
    this.closed = false;
  }

  write(chunk, nowMs) {
    if (this.closed || !chunk.length) return;
    const n = Math.floor(chunk.length / BYTES_PER_SAMPLE);
    const expectedEnd = Math.floor(((nowMs - this.startTimeMs) * SAMPLE_RATE) / 1000);
    const gap = expectedEnd - n - this.samples;
    if (gap > GAP_TOLERANCE) {
      this.endSegment();
      this.#writeSilence(gap);
    }
    if (!this.current) this.current = { start: this.samples, end: this.samples };
    this.stream.write(chunk.subarray(0, n * BYTES_PER_SAMPLE));
    this.samples += n;
    this.current.end = this.samples;
  }

  endSegment() {
    if (this.current && this.current.end > this.current.start) this.segments.push(this.current);
    this.current = null;
  }

  #writeSilence(count) {
    let left = count;
    while (left > 0) {
      const take = Math.min(left, SAMPLE_RATE);
      this.stream.write(ZERO_CHUNK.subarray(0, take * BYTES_PER_SAMPLE));
      left -= take;
    }
    this.samples += count;
  }

  close() {
    if (this.closed) return Promise.resolve();
    this.endSegment();
    this.closed = true;
    return new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }
}

// 把同一人相近的片段合併成一句話，太短的丟掉，太長的切開（轉文字 API 單檔有大小限制）。
export function mergeSegments(segments, {
  maxGapSec = 1.5,
  minLenSec = 0.4,
  maxLenSec = 600,
} = {}) {
  const maxGap = maxGapSec * SAMPLE_RATE;
  const minLen = minLenSec * SAMPLE_RATE;
  const maxLen = maxLenSec * SAMPLE_RATE;

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (last && seg.start - last.end <= maxGap && seg.end - last.start <= maxLen) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }

  const out = [];
  for (const seg of merged) {
    if (seg.end - seg.start < minLen) continue;
    for (let s = seg.start; s < seg.end; s += maxLen) {
      out.push({ start: s, end: Math.min(seg.end, s + maxLen) });
    }
  }
  return out;
}

export async function readPcmSlice(filePath, startSample, endSample) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const length = (endSample - startSample) * BYTES_PER_SAMPLE;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, startSample * BYTES_PER_SAMPLE);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk 大小
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 單聲道
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// 把所有人的音軌混成一個 Opus 音檔（約每小時 11MB）。
export function mixTracks(pcmFiles, outPath) {
  if (!pcmFiles.length) return Promise.reject(new Error('沒有任何音軌可以混音'));
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const f of pcmFiles) args.push('-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', f);
  if (pcmFiles.length > 1) {
    args.push(
      '-filter_complex',
      `amix=inputs=${pcmFiles.length}:duration=longest:normalize=0,alimiter=limit=0.95`,
    );
  }
  args.push('-c:a', 'libopus', '-b:a', '24k', outPath);

  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(outPath) : reject(new Error(`ffmpeg 失敗：${err}`))));
  });
}

export function formatTime(sample) {
  const total = Math.floor(sample / SAMPLE_RATE);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
