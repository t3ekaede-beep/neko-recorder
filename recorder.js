// 進語音房收音。每個人的聲音分開寫成一條音軌。
import fs from 'node:fs';
import path from 'node:path';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { TrackWriter, SAMPLE_RATE } from './audio.js';

export class Recorder {
  constructor({ channel, workDir, onUnexpectedEnd }) {
    this.channel = channel;
    this.guild = channel.guild;
    this.dir = path.join(workDir, `${Date.now()}-${channel.id}`);
    this.onUnexpectedEnd = onUnexpectedEnd;
    this.tracks = new Map(); // userId -> TrackWriter
    this.active = new Map(); // userId -> { opus, decoder }
    this.participants = new Set(); // 曾在房內的人（含沒說話的）
    this.stopped = false;
    this.startTimeMs = 0;
  }

  async start() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      this.connection.destroy();
      throw new Error('連不上語音房（可能是權限不足，或語音加密握手失敗）');
    }

    this.startTimeMs = Date.now();
    for (const [id, member] of this.channel.members) {
      if (!member.user.bot) this.participants.add(id);
    }

    this.connection.receiver.speaking.on('start', (userId) => this.#subscribe(userId));

    // 斷線：5 秒內沒恢復就視為錄音意外結束，照常把已錄到的內容送去處理。
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopped) this.onUnexpectedEnd?.('bot 與語音房斷線（房間被刪除或 bot 被移出）');
      }
    });
    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (!this.stopped) this.onUnexpectedEnd?.('語音連線已中斷');
    });
  }

  #subscribe(userId) {
    if (this.stopped || this.active.has(userId)) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return;
    this.participants.add(userId);

    let track = this.tracks.get(userId);
    if (!track) {
      track = new TrackWriter(path.join(this.dir, `${userId}.pcm`), this.startTimeMs);
      this.tracks.set(userId, track);
    }

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: 1, frameSize: SAMPLE_RATE / 50 });
    const entry = { opus, decoder };
    this.active.set(userId, entry);

    const finish = () => {
      if (this.active.get(userId) !== entry) return;
      this.active.delete(userId);
      track.endSegment();
    };

    opus.on('error', (e) => console.warn(`[收音] ${userId} 串流錯誤：${e.message}`));
    decoder.on('error', (e) => console.warn(`[收音] ${userId} 解碼錯誤：${e.message}`));
    decoder.on('data', (chunk) => track.write(chunk, Date.now()));
    decoder.once('end', finish);
    decoder.once('close', finish);
    opus.pipe(decoder);
  }

  addParticipant(userId) {
    if (!this.stopped) this.participants.add(userId);
  }

  elapsedMs() {
    return this.startTimeMs ? Date.now() - this.startTimeMs : 0;
  }

  // 停止收音並關閉所有音軌，回傳音軌資料夾與每人的音軌。
  async stop() {
    if (this.stopped) return this.result;
    this.stopped = true;

    for (const { opus, decoder } of this.active.values()) {
      opus.unpipe(decoder);
      opus.destroy();
      decoder.end();
    }
    await new Promise((r) => setTimeout(r, 500)); // 讓解碼器把最後的資料寫完
    this.active.clear();

    try {
      this.connection.destroy();
    } catch { /* 已經中斷 */ }

    await Promise.all([...this.tracks.values()].map((t) => t.close()));
    this.result = {
      dir: this.dir,
      startTimeMs: this.startTimeMs,
      endTimeMs: Date.now(),
      tracks: this.tracks,
      participants: [...this.participants],
    };
    return this.result;
  }
}
