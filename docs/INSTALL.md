# 安裝客服卡片與真實渠道

版本：0.4.0-preview.1。先讀 [AGENT_UI_CONTRACT.md](AGENT_UI_CONTRACT.md)、[卡片設計](BLUEPRINT_PLUGIN_DESIGN.md) 及 [架構](ARCHITECTURE.md)。

## 安裝成果的界線

目標是工作室「AI → Agent 工作台」內的一個客服卡片項目。基本設定／訓練／接駁與客服對話留在同一卡片。**不能把客服整頁當成 Agent 安裝到宿主，也不能替換宿主總覽、工作、資料、導覽、全域 API 或資料表。**

根目錄 `agent.json` 是產品身份；`integrations/blueprint/agent.json` 是可登記的協作 manifest。完整卡片 renderer 與公司固定的受限 API 必須由實際宿主支援。單靠登記、卡片可見或 GitHub 已推送，不代表後台、手機連線或收發已啟動。

## 先核對同一個目標

沿用已確認的工作室網址、公司、部署來源、Site、儲存及安裝 operation_id。先做只讀 preflight，記錄實際宿主和客服完整 commit；沒有正式 Release 時明確使用固定 preview。套件、CAS journal、共享備份 coverage 與登記 client 操作見 [INSTALL_PACKAGE.md](INSTALL_PACKAGE.md)。

必要備份須涵蓋真正資料域、schema、checkpoint、可讀私人副本及還原驗證。宿主 D1 備份不涵蓋外部 SQLite／手機登入狀態。保留空白欄位、批准／撤銷、人工接手、歷史及未完成工作；不因安裝重設資料。

## 本機執行器

使用 Node.js 24.22+（24.x）。客服核心無第三方 npm 依賴；本機 WhatsApp 橋接的固定依賴在獨立子套件安裝，不更改系統 Node。

```sh
npm start
```

預設監聽 `127.0.0.1:3100`。開啟 `/` 或 `/workbench.html` 使用單一卡片；相容 `/console` 亦回到卡片。舊整頁診斷工具只能明確從 `/diagnostics/console` 使用，不能作為宿主 UI。`npm run workbench` 的 3101 卡片預覽沒有收發 worker。

私人設定可由環境或未追蹤的 `.env` 提供；已有環境變數優先，修改後重啟。服務生成的管理員 token 在資料目錄，請本機安全讀取，毋須貼到聊天。

| 變數 | 用途 |
| --- | --- |
| `HOST`／`PORT` | 預設 `127.0.0.1`／`3100` |
| `BLUEPRINT_DATA_DIR` | 倉庫外、此商戶獨享的持久 SQLite 及管理員資料目錄 |
| `ADMIN_TOKEN` | 可選、至少 32 字元；未填則生成私人 `admin-token` |
| `COOKIE_SECURE` | loopback HTTP 為 false；對外 HTTPS 必須 true |
| `EVOLUTION_URL`／`EVOLUTION_INSTANCE`／`EVOLUTION_API_KEY` | 固定渠道接口及 instance；可指向已啟動的本機相容橋接或既有 Evolution |
| `WEBHOOK_SECRET` | 至少 32 字元，收件端 Bearer 驗證 |
| `PUBLIC_BASE_URL` | 客服 origin，用來生成固定 callback；同機橋接可用 loopback HTTP |
| `DELIVERY_ENABLED` | 預設 false，普通渠道發送需明確授權後開啟 |
| `LOCAL_WHATSAPP_TEST` | 可信本機測試橋接模式；選定測試號碼及本人確認後才啟用程序內測試發送，重啟不沿用啟用狀態 |
| `OPENAI_API_KEY`／`OPENAI_MODEL` | 選用背景模型；手機連結及人工收發不需要模型金鑰 |
| `WEB_CHAT_ENABLED` | 可選網頁客人渠道，與 WhatsApp 驗收分開 |

## 真實 WhatsApp 的準備與驗收

1. 啟動真實接駁服務。已有 Evolution 時沿用指定 instance；本機橋接見 [WhatsApp 路線](WHATSAPP_RUNTIME.md) 及 `integrations/whatsapp-local/README.md`。只填網址不會安裝或啟動服務。
2. 卡片的「接駁 → 接駁 WhatsApp」取得真實 QR，由本人在手機「已連結裝置」掃碼，再核對實際 open 狀態。QR 不傳入模型、日誌或公開倉庫。
3. 在卡片私人設定選定本人同意的測試號碼。空 allowlist 的本機橋接只允許 QR／狀態，不轉送或發送其他客戶內容。核對 callback 的固定網址、認證與可達性。
4. 保持 review，填寫本人真實的必要商戶及人工接手資料，不用虛構欄位繞過發送門檻。以指定另一支測試 WhatsApp 號碼來訊，卡片讀回同一筆訊息；先驗證收件及草稿。
5. 用戶確認測試範圍後啟用測試發送，人工核對後回覆，在收件手機實際確認。記錄 instance、訊息對應及觀察狀態；未得到回執或收件證據時不寫成已送達。

同機橋接透過本機 callback 及對外 WhatsApp socket 工作，不需要公開 tunnel。遠端 Evolution 不能存取你電腦的 localhost；該路線需真正可達且受保護的 HTTPS callback。只開需要的指定收發途徑，避免同一帳號多個自動 bot 重複回覆。

缺少服務、手機掃碼、測試號碼、收件入口或發送條件時，畫面及交付列出具體缺項及下一步。離線規則或網頁扮演客人的成功不替代實際手機測試。[使用者接駁步驟](CONNECTION_GUIDE.md)

## 安裝到真正工作室

卡片前端只掛載自己的根節點及 `/api/agents/bluesai-cs-0001` 接口，由宿主 adapter 固定目前公司及 instance。使用者憑證不傳給瀏覽器；不代理宿主整個 `/api`，不共用／改寫宿主業務資料表。

| 實際能力 | 處理方式 |
| --- | --- |
| 宿主已有相容 renderer、API 及運行服務 | 重用原 Agent ID、CAS 更新、讀回；宿主來源不變時不重新部署 |
| 有 Agent 登記，但沒有三分頁 renderer／受限 API | 明確列為待開發；先補所缺合約，不用整頁或 iframe 替代 |
| 有 Sites D1／R2 資料 | 沿用實際儲存及身份；獨立客服命名空間需審閱遷移與備份 coverage，禁止新站 gateway 覆蓋原資料 |
| 只有靜態 Site／localhost 服務 | 尚不能作持續雲端客服；先取得可用執行及儲存方案。新增費用由用戶決定 |

完整通用 Sites D1 管理 API 與原生 renderer 尚未交付。Node HTTP／`node:sqlite` 不能原封不動放入 Workers；`127.0.0.1` 不是雲端後台。`blueprint-agent/1` 登記不會下載、執行 Node、喚起背景 Codex／DOT 或連結 WhatsApp。

## 更新及安全停止

升級前正常停止單一程序，備份完整私人資料與渠道登入狀態並驗證還原。schema v1–v4 的增量遷移保留原資料；不把較新資料庫交給舊程式開啟。

資料目錄的 `service.lock` 記錄擁有程序。異常退出後先核對 PID 已不存在且沒有其他 worker，才人工處理鎖檔；不能自動刪鎖繞過另一個程序。Cookie session 在記憶體內，重啟後重新登入；資料、對話、去重及工作狀態保留。

所有密鑰、登入檔、SQLite／WAL、日誌及備份在 Git 之外，Windows 私人資料目錄限制 ACL。正式對外部署另核對 HTTPS、存取／速率限制、監控及備份；不把本機成功寫成私人工作室已部署。

## 完成證據

分別提供固定客服／宿主來源、必要 PR／commit、真正 Site 版本或無需改動的原因、客服進程與持久儲存、同 ID 保存讀回、本人掃碼及測試手機收件結果。未完成能力列為 requires_setup／unsupported／not_verified／waiting_user，不把卡片可見概括成整條渠道已運行。
