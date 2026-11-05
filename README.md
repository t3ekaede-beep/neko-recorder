# 貓居錄音機器人 v1.0

在語音房錄音，自動產生逐字稿與 Claude 摘要，寫進 Notion「貓居錄音紀錄」資料庫。

## 指令
‧ `/錄音開始 類型 標題 [應徵職位]`：在你所在的語音房開始錄音
‧ `/錄音結束`：停止錄音，整理完成後私訊 Notion 連結
‧ 只有人事管理身分組（1356160142529400873）能使用

## 自動行為
‧ 開始前先在語音房文字區公告錄音；中途有人進房會再提醒一次
‧ 房間沒人 60 秒後自動結束；超過 180 分鐘自動結束
‧ bot 被移出、房間被刪除：立刻結束並整理已錄到的內容
‧ 每 6 小時檢查一次，清除超過 30 天的音檔（只清音檔，逐字稿和摘要保留）

## 部署步驟（手機可完成）

### 1. Discord Developer Portal
1. 開 https://discord.com/developers/applications （手機瀏覽器建議切「電腦版網站」）
2. New Application → 取名（例如「貓居錄音喵」）
3. 左側 Bot → Reset Token → 複製 Token（只貼到 Railway，不要貼在任何聊天室）
4. 同頁的 Privileged Gateway Intents 三個都不用開
5. 邀請 bot：把網址中的 `應用程式ID` 換成 General Information 頁的 Application ID
   `https://discord.com/oauth2/authorize?client_id=應用程式ID&scope=bot+applications.commands&permissions=1051648`
   權限只有：檢視頻道、發送訊息、連接（不給 Administrator）

### 2. 動態語音權限
‧ 在 TempVoice 動態語音所在的分類，給 bot 身分組「允許」：檢視頻道、連接、發送訊息
‧ 這樣房主鎖房或隱藏房間時，bot 仍然進得去

### 3. Notion
1. 開 https://www.notion.so/profile/integrations → New integration → 類型 Internal → 複製 Secret
2. 打開「貓居錄音紀錄」資料庫 → 右上 ⋯ → Connections → 加入剛建立的 integration
3. 資料庫欄位名稱不要改，bot 依名稱寫入

### 4. API 金鑰
‧ Groq（轉文字，免費方案）：https://console.groq.com 註冊後到 API Keys 建立金鑰，額度以 Limits 頁面為準
‧ Anthropic：https://console.anthropic.com 建立金鑰，並設定每月消費上限

### 5. GitHub
1. 建立新的 **Private** repository
2. Add file → Upload files，把這個資料夾所有檔案上傳（含 `.gitignore`、`.dockerignore`）
3. 不要上傳 `.env`

### 6. Railway
1. https://railway.com → New Project → Deploy from GitHub repo → 選剛才的 repo
2. 會自動用 Dockerfile 建置
3. Variables → Raw Editor，依 `.env.example` 填入真正的值
4. Settings → Region 建議選新加坡（離台灣近）
5. Deployments → View Logs，看到「指令已註冊」就是上線成功

## 上線前測試清單
‧ 在一般動態語音測 3 分鐘會議，確認 Notion 有逐字稿、摘要、音檔
‧ 房主鎖房後再測一次
‧ 兩個人同時講話，確認逐字稿分得出是誰
‧ 確認逐字稿是繁體中文
‧ 測試清除：暫時把 `AUDIO_RETENTION_DAYS` 設成 0，重新部署後音檔欄位應被清空，測完改回 30

## 已知限制
‧ Discord 官方沒有正式支援收音功能，Discord 改版可能讓錄音失效
‧ Railway 重新部署或重啟時，進行中的錄音會遺失；錄音期間不要改設定
‧ Notion 頁面歷史可能留有已清除音檔的舊版本，不等於立即徹底刪除
‧ 逐字稿由語音辨識產生，會有錯字；摘要不會下錄取結論
‧ 免費的 Whisper 可能輸出簡體字，摘要由 Claude 負責，會用繁體；如果逐字稿常出現簡體，回報給我再調整
‧ Groq 免費方案限額：每分鐘 20 次、每小時 7200 秒音檔；超過時 bot 會自動等待重試，長會議整理會比較慢
‧ 逐字稿的音檔會送到 Groq 處理，Groq 說明預設不保留，但可能暫存最長 30 天；要更嚴格可在 Groq 的 Data Controls 開啟 Zero Data Retention

## 版本紀錄
‧ v1.0（2026-11-05）：初版
‧ v1.1（2026-11-05）：轉文字從 OpenAI 改為 Groq 免費方案，環境變數 OPENAI_API_KEY 改為 GROQ_API_KEY
