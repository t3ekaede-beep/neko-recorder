// 離線測試音訊邏輯（不需要 Discord）：node test-audio.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { TrackWriter, mergeSegments, readPcmSlice, pcmToWav, mixTracks, formatTime, SAMPLE_RATE } from './audio.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-test-'));
const FRAME = SAMPLE_RATE / 50; // 20ms

function tone(freq, n, offset) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * (offset + i)) / SAMPLE_RATE)), i * 2);
  return b;
}

// 模擬說話：從 startSec 開始講 durSec 秒，每 20ms 到一包（加一點網路抖動）
function speak(track, t0, startSec, durSec, freq) {
  const frames = Math.round((durSec * 1000) / 20);
  for (let f = 0; f < frames; f++) {
    const jitter = (f % 7) * 3; // 0~18ms 抖動
    const arrival = t0 + startSec * 1000 + (f + 1) * 20 + jitter;
    track.write(tone(freq, FRAME, f * FRAME), arrival);
  }
  track.endSegment();
}

const t0 = 1_000_000;
const a = new TrackWriter(path.join(dir, 'a.pcm'), t0);
const b = new TrackWriter(path.join(dir, 'b.pcm'), t0);
speak(a, t0, 0, 3, 440); // A：0~3 秒
speak(b, t0, 3.5, 2, 660); // B：3.5~5.5 秒
speak(a, t0, 4.0, 0.2, 440); // A：插話 0.2 秒（太短，應被丟掉…但和前段相隔 1 秒，會被合併）
speak(a, t0, 10, 4, 440); // A：10~14 秒
await a.close();
await b.close();

// 1. 時間軸對齊：A 的第二段應從約 10 秒開始，誤差 0.2 秒內
assert.equal(a.segments.length, 3, `A 應有 3 段，實際 ${a.segments.length}`);
const s3 = a.segments[2].start / SAMPLE_RATE;
assert.ok(Math.abs(s3 - 10) < 0.2, `A 第三段起點應約 10 秒，實際 ${s3}`);
const bStart = b.segments[0].start / SAMPLE_RATE;
assert.ok(Math.abs(bStart - 3.5) < 0.2, `B 起點應約 3.5 秒，實際 ${bStart}`);

// 2. 檔案長度 = 寫入 sample 數
assert.equal(fs.statSync(a.filePath).size, a.samples * 2);

// 3. 合併：A 的 0~3 秒和 4.0~4.2 秒相隔 1 秒，應合併；10 秒那段獨立
const merged = mergeSegments(a.segments);
assert.equal(merged.length, 2, `合併後應剩 2 段，實際 ${merged.length}`);
assert.ok(merged[0].end / SAMPLE_RATE > 4.1);

// 4. 太短的單獨片段會被丟掉；太長的會被切開
assert.equal(mergeSegments([{ start: 0, end: SAMPLE_RATE * 0.2 }]).length, 0);
assert.equal(mergeSegments([{ start: 0, end: SAMPLE_RATE * 1500 }]).length, 3);

// 5. WAV 轉換能被 ffprobe 讀出正確長度
const pcm = await readPcmSlice(a.filePath, merged[1].start, merged[1].end);
const wavPath = path.join(dir, 'seg.wav');
fs.writeFileSync(wavPath, pcmToWav(pcm));
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const wavDur = probe(wavPath);
assert.ok(Math.abs(wavDur - 4) < 0.1, `片段應約 4 秒，實際 ${wavDur}`);

// 6. 混音輸出長度 = 最長音軌（約 14 秒）
const out = path.join(dir, 'mix.ogg');
await mixTracks([a.filePath, b.filePath], out);
const mixDur = probe(out);
assert.ok(Math.abs(mixDur - 14) < 0.3, `混音應約 14 秒，實際 ${mixDur}`);

// 7. 單一音軌也能輸出
await mixTracks([b.filePath], path.join(dir, 'single.ogg'));

assert.equal(formatTime(SAMPLE_RATE * 65), '01:05');
assert.equal(formatTime(SAMPLE_RATE * 3725), '1:02:05');

fs.rmSync(dir, { recursive: true, force: true });
console.log('全部通過 ✓');
