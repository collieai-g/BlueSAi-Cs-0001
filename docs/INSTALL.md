# 安裝與連接

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
    "events": ["MESSAGES_UPSERT"]
  }
}
```

3. 僅開啟這個客服回覆途徑，關閉同一 instance 其他自動 bot，避免重複回答。
4. Evolution 的 `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES` 設為 false；按需要明確設定 telemetry。憑證不傳給模型。
5. 先保持本服務 `DELIVERY_ENABLED=false`，用測試帳號來訊，確認接收、草稿、重複事件與人工接手。重啟之前／超過五分鐘／缺時間的來訊會列入人工待辦。
6. 在「教客服」填商戶名稱、服務；在「設定」填人工聯絡方式。完成驗收後才明確設 `DELIVERY_ENABLED=true`。先用「先讓我確認」，再考慮「自動回覆已知問題」。

本接收端的驗證是 Bearer secret 配合 instance 比對，**不是 body HMAC 簽章**。外層需 HTTPS、限制來源／速率。若使用 Meta，供應商 webhook 的簽章驗證應在 Evolution 前的受控入口或經驗證的修正實作完成；此服務不冒充 Meta 原始入口。

事件只在寫入 SQLite 成功後回覆 200。舊訊息、非文字訊息留待人工；群組、廣播、LID-only 等不支援地址會忽略，不應將它們接入本版正式服務。標準電話與 LID 別名需要在後續版本實作完整映射。

## 真實發送與失敗處理

- 超過客戶最後來訊 24 小時，本版不發一般訊息；不支援範本，需在其他獲授權工具處理。依 [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)核對最新要求。
- 自動模式只發送有有效來源的 `answer`。追問、退款／例外及模型故障保留草稿或轉人工。離線規則不會自動發到真實渠道。
- 人工模式可直接回覆，但仍受真實發送開關和 24 小時窗口限制。
- `accepted` 只表示取得 provider message ID，未證明送達。本版未接入完整 `MESSAGES_UPDATE` 對帳。
- `uncertain` 表示發送逾時、錯誤或回應不明。**不會自動重試**；人工先在 WhatsApp 核對，避免重複訊息。重啟時原本 `sending` 的工作也轉為 `uncertain`。
- 接手取消尚未發出的草稿／佇列；已送往供應商的在途訊息可能仍然發出。介面會顯示發送中或未確認狀態。
- 人工待辦只顯示在「對話」，目前沒有推送通知。安排操作員查看，不能把已入列當成已通知外部人員。

## 儲存、備份、重啟

資料目錄有 SQLite、WAL 檔、管理員 token 和 `service.lock`。同一資料目錄只允許一個程序，不可在共享磁碟上啟動多 worker。

正常停止後備份整個資料目錄並加密保存。還原前停止服務，再還原資料和權限。若異常停止，先確認 `service.lock` 所記錄的 PID 已不存在且沒有其他服務在用資料庫，再手動刪除該鎖檔，然後啟動。不要自動刪除鎖以繞過另一個工作程序。

Cookie session 在記憶體內，重啟後要重新登入；商戶資料、對話、去重記錄和工作狀態保留。管理員可在介面刪除對話；本版沒有自動保留期排程。去重 ID／操作稽核不含訊息正文，但仍須列入資料保留政策；備份另行管理。

## 部署邊界

可先在本機開發，或在一台有持久磁碟的伺服器運行。正式公開網絡前需 HTTPS 反向代理、存取與速率限制、備份還原演練、日誌監控、渠道測試及資料告知。公開服務設定 `COOKIE_SECURE=true`，反向代理保留正確 Host；不要把管理介面直接裸露在互聯網。

這個倉庫已寫入程式碼不代表正式服務已部署，也不代表已開通任何付費資源或帳戶。
