# 安裝與連接

0.3.0-preview.1 新增 [版本化安裝套件與 preflight](INSTALL_PACKAGE.md)、[按鍵接駁教學](CONNECTION_GUIDE.md) 及 [共用 WhatsApp 執行器](WHATSAPP_RUNTIME.md)。先做只讀 preflight，再按相容性決定備份及變更；尚未支援的 Sites renderer／API 不會被當成已安裝。

## 安裝到既有藍圖工作室（含 GitHub 及 Site）

從 [README 的可複製指示](../README.md#貼給-codexdot安裝到藍圖工作室)開始，或把 [INSTALL_AI.txt](../INSTALL_AI.txt) 的全文交給目前的 Codex／DOT。這個入口適用於「把客服加入已有工作室」，會處理所需的程式整合、GitHub 提交與原 Site 更新。它不會因為找到舊工作室就另建一個工作室。

**目前是預覽套件：原生協作 manifest／登記 client 已用固定合約 fixture 驗證；完整 Sites 管理 renderer／API 仍未實作及驗收。** 下文是安裝 AI 要落實的工作；文件發佈不代表已安裝到任何使用者的 Site。

### 使用者只需提供

- **目標工作室**：沿用目前對話已核實的目標；無法唯一辨認時，提供工作室網址。AI 再從現有設定、Sites 與 GitHub 工具核對其程式來源，不要求使用者重複填已有資料。
- **必要的登入或授權**：在平台或本機安全入口完成。Codex／DOT 協作不要求另一個模型 API 金鑰；工作室與客服後台之間仍須有受限制的服務身份。
- **缺少的運行環境**：只有現有資源不能承載客服時，才說明缺少哪種主機或儲存及可選路線；新增收費先取得授權。

### 安裝 AI 的執行順序

1. **確認同一個目標。** 核對工作室網址、公司／工作空間、實際 GitHub 來源及分支、Site ID、部署模式、資料位置和現有權限。公開藍圖倉庫是參考來源，不一定是使用者正在運行的來源；Site 的來源倉庫也未必等於 GitHub 倉庫。已有私人安裝記錄就接續，不重建服務或資料庫。
2. **只讀 preflight、固定來源再備份。** 讀取雙方的 `AGENTS.md`、README、安裝及架構文件。核實客服 Releases；若沒有正式發行版，明確使用本協作預覽的已核對完整 commit，不能稱為最新正式版。記錄宿主與客服的來源 commit，保留修改、MIT 聲明及可恢復的資料備份；不要因加入客服而順便升級整個工作室。
3. **補齊宿主相容層。** 依目標版本的 `docs/AGENT_CONTRACT.md`、`templates/agent/agent.json`、`docs/INTEGRATION_GUIDE.md` 及 `contracts/integration-v1` 實作。先核對正式部署回報的能力，不能只看公開原始碼。本倉庫的 `agent.json` 是產品身份，不能原封不動提交為宿主 manifest。把相容 manifest／adapter 作為獨立、可審核的通用程式保存，保留 `BlueSAi-Cs-#0001` 顯示身份；宿主識別欄位依其格式規則映射，記錄映射而不猜欄位。
4. **加入原生客服入口。** 以宿主真正支援的登記及版本檢查加入「AI → Agent 工作台 → 客服 AI」卡片；相容接口已存在時，優先用登記及設定完成。需要原始碼改動時才修改目標工作室來源。配置內容保持「基本設定／訓練／接駁」同一卡片，沿用宿主外層導覽；本機頁面的側欄與頂列不再嵌入。卡片移動、縮放與最小／最大尺寸按 [原生卡片規格](BLUEPRINT_PLUGIN_DESIGN.md)實作及驗收，沒有支援時列作待補功能。
5. **部署及連接客服後台。** 本版客服使用 Node.js 24.22+（24.x）、單程序 SQLite，服務及私人持久資料與工作室分開。實作明確的插件 API 命名空間、宿主身份／公司範圍及服務憑證；不要把宿主整個 `/api` 轉送到客服，或把管理員 token 放入前端。資料同步須按實際支援的 Integration Contract 實作受限 client，包含來源版本、撤銷、冪等及斷線恢復；不共用或直接改寫宿主資料庫。
6. **更新需要改動的倉庫與 Site。** 測試後提交並合併已授權的程式變更，記錄 GitHub commit。Sites 使用現行官方技能及原有 `.openai/hosting.json`，保留精確 Site ID、網址、儲存綁定和存取權限；推送實際 Site 來源、保存匹配的版本，再部署同一個 Site。兩套來源不相同時，分別核對 GitHub commit、Site source commit 和發佈版本。已有接口可以直接登記，而且 Site 來源沒有變更時，回報「已登記，無需重新部署」，不製造空提交或多餘網站。
7. **在真正工作室驗收。** 執行客服 `npm test`、`npm run check` 及宿主要求的檢查。登入目標 Site，驗證卡片、三個分頁、保存與重新讀回、已批准記憶及未儲存輸入；用明確標示且不含真實客戶的任務完成 Codex／DOT 讀取與草稿回存。原生送出須由使用者本人完成時，列為待驗證，不代按或宣稱成功。另驗證 320px、瀏覽器 200% 縮放、卡片尺寸邊界，以及重啟客服後資料仍在。
8. **留下可接續記錄。** 在程式倉庫外私人保存來源及部署版本、安裝狀態、備份位置、啟停方式及下一步。重跑指示先核對已安裝版本與既有 Agent／integration ID，更新原項目，不重複加卡片、註冊或重設資料；發生結果不明先讀回，不盲目重做寫入。

### Site 與後台的適配界線

目前參考的 Agent 合約採用 `adapter: "connected_client"` 及 `ui.layout: "standard"` 共用控制項，不接受任意 HTML、JavaScript 或 iframe。若目標版本的控制項不足以呈現客服三個分頁，須在宿主原生元件實作所需擴充；單靠登記 manifest 不會產生這個配置介面。

本版客服每個實例只服務一個商戶。多公司工作室應把該實例及受限服務身份固定到指定公司，不共用客服 SQLite；尚未實作及驗證的多租戶隔離不能當成已有能力。

| 實際環境 | 安裝時要做 |
| --- | --- |
| 原生藍圖後台 | 核對宿主實際能力；按固定合約實作客服 adapter／client，再登記及讀寫驗收。 |
| Sites 入口＋原生藍圖後台 | 保留入口身份與原生資料位置；核對需要的 Agent／integration 路由是否真正支援。後台合約相容且入口無改動時，可只部署受影響的後台。 |
| 已有資料的 Sites D1／R2 後台 | 沿用現有儲存，先備份及核對更新路線，再補齊相同合約；不能直接套用新站 gateway 取代原後台。 |
| 只有靜態 Site 或未有可達的客服後台 | 先補齊經授權的運行及持久儲存方案，再做完整安裝驗收。只有卡片或本機連結時，明確標示只完成介面。 |

Sites 的伺服器程式運行於 Workers；現有 Node HTTP／`node:sqlite` 常駐服務及本機 SQLite 檔案不能原封不動當成 Sites 後台。優先保留獨立 Node 客服服務，使用經授權的 HTTPS 連接及伺服器身份橋接；如果選擇平台移植，須另實作並驗證全部資料及身份行為。`127.0.0.1:3101` 不是雲端後台地址；現有工作台亦不允許 iframe 嵌入，網站工具只在頂層註冊，不能用 iframe 載入整頁代替原生整合。

`blueprint-agent/1` 的登記／連接與外部資料 Integration Contract 是不同能力；前者不會下載並執行本倉庫的 Node 程式，也不會自動啟動 DOT 或 WhatsApp。接駁頁提供手機掃碼及網頁連結四步教學；真實 WhatsApp 掃碼、模型供應商金鑰及自動對客發送仍按使用者選擇另行設定；安裝階段保持草稿與發送關閉。AI 協作不另要模型金鑰，不代表服務之間可以省略身份驗證。

### 完成後要交付的結果

| 項目 | 可核對的證據 |
| --- | --- |
| 程式來源 | 所用客服 commit、宿主變更 PR／commit；不用改程式時說明原因。 |
| Site | 原有實際網址、發佈版本與成功部署結果；未改 Site 時核對已登記卡片可見。 |
| 客服服務 | 真正運行位置、健康檢查、持久資料位置及啟停方式。 |
| 設定及記憶 | 保存後重新讀回，重啟後同一資料仍在；空白公司欄位不被虛構內容填滿。 |
| Codex／DOT | 實際讀取與保存的同一任務 ID；原生確認送出是否完成，分開列出。 |
| 未完成部分 | 準確指出缺少的能力或使用者操作，不把 GitHub 推送、卡片可見或 Site 發佈當成完整驗收。 |

宿主相容性參考於 2026-10-25 核對的 [Blueprint Studio commit 1157aa4](https://github.com/collieai-g/Blueprint-Studio-Open-Source/tree/1157aa49538b402e7a54996068e845c44abecb8f)：[Agent 合約](https://github.com/collieai-g/Blueprint-Studio-Open-Source/blob/1157aa49538b402e7a54996068e845c44abecb8f/docs/AGENT_CONTRACT.md)、[外部整合指引](https://github.com/collieai-g/Blueprint-Studio-Open-Source/blob/1157aa49538b402e7a54996068e845c44abecb8f/docs/INTEGRATION_GUIDE.md)、[Sites 原生接駁](https://github.com/collieai-g/Blueprint-Studio-Open-Source/blob/1157aa49538b402e7a54996068e845c44abecb8f/docs/SITES_NATIVE_GATEWAY.md)。這是文件參考，安裝時仍須以使用者實際部署版本與能力為準。

## 插件本機實測入口

本項目定位為藍圖工作室內置客服 AI 插件。目前可執行 `npm run workbench` 在 `127.0.0.1:3101` 試用；完整步驟見 [LOCAL_WORKBENCH.md](LOCAL_WORKBENCH.md)。這不會安裝到測試工作室。宿主註冊、原生卡片移動／縮放與尺寸規則需按 [插件設計規格](BLUEPRINT_PLUGIN_DESIGN.md) 另外整合。

下列安裝與發送說明適用於保留的 3100 客服服務；3101 工作台沒有對客發送 worker 或 webhook。

## 本機／開發

Node.js 24.22+（24.x）、一個本機程序即可。`npm start` 啟動，`Ctrl+C` 停止。預設只監聽 `127.0.0.1:3100`。沒有第三方依賴，毋須 `npm install`。

本項目名稱為 **BlueSAI-客服**，Agent 編號為 `BlueSAi-Cs-#0001`。為了保留既有設定與對話，改名後仍使用原本的 `.blueprint-service` 資料目錄及 `BLUEPRINT_DATA_DIR` 環境變數，毋須搬移資料。

若要設定選項，將 `.env.example` 複製成 `.env`；程式在啟動時讀取，已有環境變數優先。修改後須重啟。

| 變數 | 說明 |
| --- | --- |
| `HOST` / `PORT` | 預設 `127.0.0.1` / `3100` |
| `BLUEPRINT_DATA_DIR` | 預設 `~/.blueprint-service`；必須在倉庫之外 |
| `ADMIN_TOKEN` | 可選，至少 32 字元；未填會在資料目錄產生 `admin-token` |
| `COOKIE_SECURE` | 本機 HTTP 為 false；HTTPS 部署必須 true |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 兩項都有值才呼叫 OpenAI；模型須支援 Responses 與 Structured Outputs |
| `EVOLUTION_URL` / `EVOLUTION_INSTANCE` / `EVOLUTION_API_KEY` | Evolution 服務位址、instance 名稱及該 instance 憑證 |
| `WEBHOOK_SECRET` | 至少 32 個隨機字元，用於接收端 Bearer 驗證 |
| `PUBLIC_BASE_URL` | 客服 HTTPS origin，用來設定及核對 `/webhooks/evolution`；loopback HTTP 只限同機開發 |
| `WEB_CHAT_ENABLED` | 預設 false；明確開啟受限 `/chat` 客人入口，不會開啟 WhatsApp 發送 |
| `DELIVERY_ENABLED` | 預設 false；明確設 true 才容許真實發送 |

以密碼管理器或伺服器秘密管理功能填寫密鑰，不要在聊天、Git、截圖或日誌公開。`.env`、SQLite 和日誌已被 Git 忽略；正式部署仍須核對檔案權限，Windows 上亦要限制資料目錄 ACL。

## 啟用 AI

在伺服器設定 `OPENAI_API_KEY` 和可用的 `OPENAI_MODEL`。未預設付費模型，避免把帳戶未有權限的型號當成可用。啟動後畫面會由「離線示範」變成「AI 已設定」，這僅代表配置齊全，首次試聊才能驗證帳戶、模型及網絡。

呼叫使用 `POST https://api.openai.com/v1/responses`、`store:false` 及 `text.format` JSON schema。參考 [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。`store:false` 不等於供應商完全不保留任何記錄，資料處理須配合實際帳戶設定。

試聊亦會使用 API 額度；本次程式開發測試沒有使用真實 key。離線模式只按價錢／時間／退款類別套用已確認文字，不理解任意指令，不能當成 AI 效果測試。

## 連接 Evolution API

先獨立部署並固定 Evolution 的版本／image digest，完成其渠道登入。建議先用測試帳號，第一版只處理單對單文字及標準電話 JID。正式使用優先評估官方 Meta Cloud API；供應商認證及 Evolution 適配仍須實測。

1. 在本服務設定 Evolution URL、instance、instance API key 和獨立 webhook secret。URL 使用 HTTPS；只容許 localhost 開發連接使用 HTTP。
2. 為該 instance 設定 `POST /webhook/set/{instanceName}`。以下是結構示例，請用你的安全設定工具填入值，不要把真實 token 留在 shell 歷史：

```json
{
  "webhook": {
    "enabled": true,
    "url": "https://YOUR-SERVICE/webhooks/evolution",
    "headers": { "Authorization": "Bearer YOUR_RANDOM_WEBHOOK_SECRET" },
    "byEvents": false,
    "base64": false,
    "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE"]
  }
}
```

3. 僅開啟這個客服回覆途徑，關閉同一 instance 其他自動 bot，避免重複回答。
4. Evolution 的 `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES` 設為 false；按需要明確設定 telemetry。憑證不傳給模型。
5. 先保持本服務 `DELIVERY_ENABLED=false`，用測試帳號來訊，確認接收、草稿、重複事件與人工接手。重啟之前／超過五分鐘／缺時間的來訊會列入人工待辦。
6. 在「AI → 教客服」填商戶名稱、服務；在左下角「設定」填人工聯絡方式。完成驗收後才明確設 `DELIVERY_ENABLED=true`。先用「先讓我確認」，再考慮「自動回覆已知問題」。

本接收端的驗證是 Bearer secret 配合 instance 比對，**不是 body HMAC 簽章**。外層需 HTTPS、限制來源／速率。若使用 Meta，供應商 webhook 的簽章驗證應在 Evolution 前的受控入口或經驗證的修正實作完成；此服務不冒充 Meta 原始入口。

事件只在寫入 SQLite 成功後回覆 200。舊訊息、非文字訊息留待人工；群組、廣播、LID-only 等不支援地址會忽略，不應將它們接入本版正式服務。標準電話與 LID 別名需要在後續版本實作完整映射。

## 真實發送與失敗處理

- 超過客戶最後來訊 24 小時，本版不發一般訊息；不支援範本，需在其他獲授權工具處理。依 [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)核對最新要求。
- 自動模式只發送有有效來源的 `answer`。追問、退款／例外及模型故障保留草稿或轉人工。離線規則不會自動發到真實渠道。
- 人工模式可直接回覆，但仍受真實發送開關和 24 小時窗口限制。
- `accepted` 只表示取得 provider message ID。此版新增持久 `MESSAGES_UPDATE` inbox，按 instance／電話／provider ID 配對，收到相應回執才標 delivered／read；不主動查詢未知 send 結果，不能假稱完整供應商對帳。
- `uncertain` 表示發送逾時、錯誤或回應不明。**不會自動重試**；人工先在 WhatsApp 核對，避免重複訊息。重啟時原本 `sending` 的工作也轉為 `uncertain`。
- 接手取消尚未發出的草稿／佇列；已送往供應商的在途訊息可能仍然發出。介面會顯示發送中或未確認狀態。
- 人工待辦顯示在「總覽」及「工作 → 客戶對話」，目前沒有推送通知。安排操作員查看，不能把已入列當成已通知外部人員。

## 儲存、備份、重啟

可靠交接版本啟動時會執行第一版增量遷移，新增期限與本地交接工作表並保存遷移版本；既有資料不重建、歷史對話不倒填期限。實際升級前先正常停止程序及備份，先用副本驗證還原；較新版本資料庫不能由此版本開啟。詳見 [可靠交接流程](RELIABLE_HANDOFF.md)。

Codex／DOT 協作版另有 v2 增量遷移，只新增任務快照、狀態與草稿表，保留 v1 交接工作及商戶資料。按鍵沿用目前宿主對話，無須額外模型 API 金鑰；原生瀏覽器功能、選定任務網站工具及複製備援見 [協作流程](CODEX_DOT_HANDOFF.md)。本機工作台升級會令記憶體 session 及選用的供應商接駁失效，需重新登入；既有管理員 token 及資料保留。

資料目錄有 SQLite、WAL 檔、管理員 token 和 `service.lock`。同一資料目錄只允許一個程序，不可在共享磁碟上啟動多 worker。

正常停止後備份整個資料目錄並加密保存。還原前停止服務，再還原資料和權限。若異常停止，先確認 `service.lock` 所記錄的 PID 已不存在且沒有其他服務在用資料庫，再手動刪除該鎖檔，然後啟動。不要自動刪除鎖以繞過另一個工作程序。

Cookie session 在記憶體內，重啟後要重新登入；商戶資料、對話、去重記錄和工作狀態保留。管理員可在介面刪除對話；本版沒有自動保留期排程。去重 ID／操作稽核不含訊息正文，但仍須列入資料保留政策；備份另行管理。

## 部署邊界

可先在本機開發，或在一台有持久磁碟的伺服器運行。正式公開網絡前需 HTTPS 反向代理、存取與速率限制、備份還原演練、日誌監控、渠道測試及資料告知。公開服務設定 `COOKIE_SECURE=true`，反向代理保留正確 Host；不要把管理介面直接裸露在互聯網。

這個倉庫已寫入程式碼不代表正式服務已部署，也不代表已開通任何付費資源或帳戶。

## 本版接駁教學與共用服務

執行 `npm start` 後，開啟 `/workbench.html` 配置及閱讀逐步教學，開啟 `/console` 處理同一份對話。原有 3101 `npm run workbench` 保留隔離資料；不要把其手機 QR 測試當成客服執行器已啟動。詳細設定、遷移 v3／v4、渠道身份保護及收發驗收見 [WHATSAPP_RUNTIME.md](WHATSAPP_RUNTIME.md)。
