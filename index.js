// 貓居錄音機器人：/錄音開始、/錄音結束 → 逐字稿 + Claude 摘要 → Notion
import fs from 'node:fs';
import {
  Client,
  GatewayIntentBits,
  Events,
  ApplicationCommandOptionType,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from './config.js';
import { Recorder } from './recorder.js';
import { mergeSegments, readPcmSlice, pcmToWav, mixTracks, formatTime } from './audio.js';
import { transcribe, summarize } from './ai.js';
import { uploadFile, createRecordPage, purgeExpiredAudio } from './notion.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map(); // guildId -> session
const NO_PING = { parse: [] };
const EMPTY_ROOM_STOP_MS = 60_000;

const COMMANDS = [
  {
    name: '錄音開始',
    description: '在你所在的語音房開始錄音（限人事管理）',
    dm_permission: false,
    options: [
      {
        name: '類型',
        description: '面試或會議',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [{ name: '面試', value: '面試' }, { name: '會議', value: '會議' }],
      },
      {
        name: '標題',
        description: '例如：客服管理面試－某某、十一月管理會議',
        type: ApplicationCommandOptionType.String,
        required: true,
        max_length: 100,
      },
      {
        name: '應徵職位',
        description: '面試時填寫，例如：客服管理',
        type: ApplicationCommandOptionType.String,
        required: false,
        max_length: 50,
      },
    ],
  },
  { name: '錄音結束', description: '停止錄音並整理成 Notion 紀錄（限人事管理）', dm_permission: false },
];

// ---------- 工具 ----------

async function displayName(guild, userId) {
  try {
    const m = await guild.members.fetch(userId);
    return m.displayName;
  } catch {
    return `未知成員(${userId})`;
  }
}

async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

async function notify(session, text) {
  const targets = new Set([session.starterId, session.stopperId].filter(Boolean));
  for (const id of targets) {
    try {
      const user = await client.users.fetch(id);
      await user.send(text);
    } catch (e) {
      console.warn(`[通知] 無法私訊 ${id}：${e.message}`);
    }
  }
  if (config.notifyChannelId) {
    try {
      const ch = await client.channels.fetch(config.notifyChannelId);
      await ch.send({ content: text, allowedMentions: NO_PING });
    } catch (e) {
      console.warn(`[通知] 無法發到通知頻道：${e.message}`);
    }
  }
}

async function sayInRoom(session, content) {
  try {
    await session.channel.send({ content, allowedMentions: NO_PING });
  } catch (e) {
    console.warn(`[語音房文字] 發送失敗：${e.message}`);
  }
}

function hasRole(member) {
  return member.roles.cache.has(config.recorderRoleId);
}

// ---------- 開始 ----------

async function handleStart(interaction) {
  const { member, guild } = interaction;
  const type = interaction.options.getString('類型', true);
  const title = interaction.options.getString('標題', true).trim();
  const position = interaction.options.getString('應徵職位')?.trim() || '';

  if (sessions.has(guild.id)) {
    const s = sessions.get(guild.id);
    return interaction.reply({ content: `已經有一場錄音在 <#${s.channel.id}> 進行中，請先用 /錄音結束。`, flags: MessageFlags.Ephemeral });
  }
  const channel = member.voice.channel;
  if (!channel) {
    return interaction.reply({ content: '請先進入要錄音的語音房，再使用這個指令。', flags: MessageFlags.Ephemeral });
  }
  if (channel.type !== ChannelType.GuildVoice) {
    return interaction.reply({ content: '只支援一般語音房，不支援舞台頻道。', flags: MessageFlags.Ephemeral });
  }

  const perms = channel.permissionsFor(guild.members.me);
  const need = [
    ['檢視頻道', PermissionFlagsBits.ViewChannel],
    ['連接', PermissionFlagsBits.Connect],
    ['發送訊息', PermissionFlagsBits.SendMessages],
  ];
  const lacking = need.filter(([, bit]) => !perms?.has(bit)).map(([n]) => n);
  if (lacking.length) {
    return interaction.reply({
      content: `bot 在這個語音房缺少權限：${lacking.join('、')}。\n如果是動態語音被鎖房，請確認 bot 身分組在動態語音分類上有允許這些權限。`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) {
    return interaction.reply({ content: '語音房人數已滿，bot 進不去。請先放寬人數上限。', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = {
    guildId: guild.id,
    channel,
    type,
    title,
    position,
    starterId: member.id,
    starterName: member.displayName,
    stopperId: null,
    finalizing: false,
    timers: [],
  };
  sessions.set(guild.id, session); // 先佔位，避免兩人同時開始

  // 先公告、再開始錄音：讓房內的人在錄音前就知道
  await sayInRoom(session, [
    '₊˚ʚ 錄音通知 ɞ˚₊',
    '> 這個語音房現在開始錄音囉 ♡',
    `> ➜ 類型：${type}`,
    `> ➜ 發起人：<@${member.id}>`,
    '> ➜ 用途：貓居人事內部紀錄，會整理成逐字稿和摘要',
    `> ➜ 音檔約 ${config.retentionDays} 天後清除，逐字稿和摘要會保留在人事紀錄中`,
    '-# 不同意被錄音的話，請直接告訴發起人，或先離開語音房 ✿',
  ].join('\n'));

  session.recorder = new Recorder({
    channel,
    workDir: config.workDir,
    onUnexpectedEnd: (reason) => finalize(session, reason),
  });

  try {
    await session.recorder.start();
  } catch (e) {
    sessions.delete(guild.id);
    await sayInRoom(session, '> 錄音沒有成功啟動，這次不會留下任何紀錄 ♡');
    return interaction.editReply(`錄音啟動失敗：${e.message}`);
  }

  const maxMs = config.maxRecordingMinutes * 60_000;
  if (maxMs > 0) {
    session.timers.push(setTimeout(() => finalize(session, `已達錄音上限 ${config.maxRecordingMinutes} 分鐘，自動結束`), maxMs));
  }

  console.log(`[開始] ${guild.name} #${channel.name} ${type}「${title}」by ${member.displayName}`);
  return interaction.editReply(`已在 <#${channel.id}> 開始錄音。結束時請用 /錄音結束，完成後會私訊你 Notion 連結。`);
}

// ---------- 結束 ----------

async function handleStop(interaction) {
  const session = sessions.get(interaction.guild.id);
  if (!session) {
    return interaction.reply({ content: '目前沒有進行中的錄音。', flags: MessageFlags.Ephemeral });
  }
  session.stopperId = interaction.user.id;
  await interaction.reply({ content: '已停止錄音，正在整理逐字稿和摘要，完成後會私訊 Notion 連結給你。', flags: MessageFlags.Ephemeral });
  finalize(session, '手動結束');
}

async function finalize(session, reason) {
  if (session.finalizing) return;
  session.finalizing = true;
  session.timers.forEach(clearTimeout);
  if (session.emptyTimer) clearTimeout(session.emptyTimer);
  sessions.delete(session.guildId);

  console.log(`[結束] 「${session.title}」原因：${reason}`);
  const result = await session.recorder.stop();
  await sayInRoom(session, '₊˚ʚ 錄音已結束 ɞ˚₊\n> 謝謝大家的配合 ♡');
  if (reason !== '手動結束') await notify(session, `「${session.title}」錄音已結束（${reason}），正在整理中。`);

  try {
    const guild = session.channel.guild;
    const names = new Map();
    for (const id of new Set([...result.participants, ...result.tracks.keys()])) {
      names.set(id, await displayName(guild, id));
    }

    // 1. 每人每段話轉文字
    const jobs = [];
    for (const [userId, track] of result.tracks) {
      for (const seg of mergeSegments(track.segments)) jobs.push({ userId, track, seg });
    }
    jobs.sort((a, b) => a.seg.start - b.seg.start);
    const texts = await pool(jobs, 3, async ({ track, seg }) => {
      try {
        const pcm = await readPcmSlice(track.filePath, seg.start, seg.end);
        return await transcribe(pcmToWav(pcm));
      } catch (e) {
        console.warn(`[轉文字] 片段失敗：${e.message}`);
        return '（這段轉文字失敗）';
      }
    });

    // 2. 依時間排列，同一人連續說話合併成一行
    const lines = [];
    let last = null;
    jobs.forEach((job, i) => {
      const text = texts[i];
      if (!text) return;
      if (last && last.userId === job.userId) {
        last.text += ` ${text}`;
      } else {
        last = { userId: job.userId, start: job.seg.start, text };
        lines.push(last);
      }
    });
    const transcriptLines = lines.map((l) => `[${formatTime(l.start)}] ${names.get(l.userId)}：${l.text}`);

    // 3. 混音並上傳音檔（失敗不影響逐字稿和摘要）
    let audioUploadId = null;
    let audioNote = '';
    if (result.tracks.size) {
      try {
        const audioPath = `${result.dir}/recording.ogg`;
        await mixTracks([...result.tracks.values()].map((t) => t.filePath), audioPath);
        audioUploadId = await uploadFile(audioPath);
      } catch (e) {
        console.error('[音檔]', e);
        audioNote = `⚠ 音檔處理或上傳失敗，這筆紀錄沒有音檔。原因：${e.message.slice(0, 300)}`;
      }
    } else {
      audioNote = '這次沒有錄到任何聲音。';
    }

    // 4. Claude 摘要
    const participantNames = result.participants.map((id) => names.get(id));
    let summary;
    try {
      summary = await summarize({
        type: session.type,
        title: session.title,
        position: session.position,
        participants: participantNames,
        transcript: transcriptLines.join('\n'),
      });
    } catch (e) {
      console.error('[摘要]', e);
      summary = `## 摘要\n- 摘要產生失敗，請直接看逐字稿。原因：${e.message.slice(0, 300)}`;
    }

    // 5. 寫入 Notion
    const url = await createRecordPage({
      type: session.type,
      title: session.title,
      position: session.position,
      recorderName: session.starterName,
      participantNames,
      startMs: result.startTimeMs,
      endMs: result.endTimeMs,
      audioUploadId,
      audioNote,
      summary,
      transcriptLines,
    });

    await fs.promises.rm(result.dir, { recursive: true, force: true });
    await notify(session, `「${session.title}」紀錄已完成 ♡\n${url}`);
    console.log(`[完成] ${url}`);
  } catch (e) {
    console.error('[處理失敗]', e);
    await notify(session, `「${session.title}」整理失敗：${e.message.slice(0, 500)}\n錄音檔暫存在主機上，主機重啟前請聯絡技術人員處理。`);
  }
}

// ---------- 事件 ----------

client.once(Events.ClientReady, async (c) => {
  console.log(`已登入：${c.user.tag}`);
  const guild = await c.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.error(`找不到伺服器 ${config.guildId}，請確認 bot 已加入貓居且 GUILD_ID 正確。`);
    return;
  }
  await guild.commands.set(COMMANDS);
  console.log('指令已註冊：/錄音開始、/錄音結束');

  const purge = () => purgeExpiredAudio()
    .then((n) => n && console.log(`[清除音檔] 已清除 ${n} 筆到期音檔`))
    .catch((e) => console.error('[清除音檔] 失敗：', e.message));
  purge();
  setInterval(purge, 6 * 3600_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild() || interaction.guildId !== config.guildId) {
    return interaction.reply({ content: '這個指令只能在貓居使用。', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (!hasRole(interaction.member)) {
    return interaction.reply({ content: '只有人事管理可以使用錄音功能。', flags: MessageFlags.Ephemeral });
  }
  try {
    if (interaction.commandName === '錄音開始') await handleStart(interaction);
    else if (interaction.commandName === '錄音結束') await handleStop(interaction);
  } catch (e) {
    console.error('[指令錯誤]', e);
    const msg = { content: `發生錯誤：${e.message.slice(0, 300)}`, flags: MessageFlags.Ephemeral };
    (interaction.deferred || interaction.replied ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {});
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const session = sessions.get(newState.guild.id);
  if (!session || session.finalizing || oldState.channelId === newState.channelId) return;
  const roomId = session.channel.id;

  // bot 自己被移到別的房間：立刻結束，避免錄到其他房間
  if (newState.id === client.user.id) {
    if (newState.channelId && newState.channelId !== roomId) finalize(session, 'bot 被移到其他語音房');
    return;
  }
  if (newState.member?.user.bot) return;

  if (newState.channelId === roomId) {
    session.recorder?.addParticipant(newState.id);
    if (session.emptyTimer) {
      clearTimeout(session.emptyTimer);
      session.emptyTimer = null;
    }
    sayInRoom(session, `-# <@${newState.id}> 提醒一下～這個語音房正在錄音喔 ♡ 不同意的話請告訴 <@${session.starterId}> ✿`);
  } else if (oldState.channelId === roomId) {
    const humans = session.channel.members.filter((m) => !m.user.bot).size;
    if (humans === 0 && !session.emptyTimer) {
      session.emptyTimer = setTimeout(() => finalize(session, '語音房已經沒有人'), EMPTY_ROOM_STOP_MS);
    }
  }
});

process.on('unhandledRejection', (e) => console.error('[未處理的錯誤]', e));
process.on('SIGTERM', () => {
  if (sessions.size) console.warn('主機正在重啟，進行中的錄音會遺失。');
  process.exit(0);
});

client.login(config.discordToken);
