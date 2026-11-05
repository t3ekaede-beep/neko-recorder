// 讀取並檢查環境變數。缺必要值就直接停止，不套用預設值。
const required = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'RECORDER_ROLE_ID',
  'NOTION_TOKEN',
  'NOTION_DATABASE_ID',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`缺少必要環境變數：${missing.join(', ')}`);
  process.exit(1);
}

const num = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`環境變數 ${key} 必須是非負數字，目前是：${v}`);
    process.exit(1);
  }
  return n;
};

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  recorderRoleId: process.env.RECORDER_ROLE_ID,
  notifyChannelId: process.env.NOTIFY_CHANNEL_ID || '',

  notionToken: process.env.NOTION_TOKEN,
  notionDatabaseId: process.env.NOTION_DATABASE_ID.replace(/-/g, ''),
  notionVersion: process.env.NOTION_VERSION || '2022-06-28',

  openaiKey: process.env.OPENAI_API_KEY,
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || 'zh',

  anthropicKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',

  retentionDays: num('AUDIO_RETENTION_DAYS', 30),
  maxRecordingMinutes: num('MAX_RECORDING_MINUTES', 180),
  workDir: process.env.WORK_DIR || '/tmp/neko-recordings',
};
