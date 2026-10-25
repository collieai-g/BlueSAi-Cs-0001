# WhatsApp 的實際收發路線

版本：0.3.0-preview.1。日常操作使用 [接駁教學](CONNECTION_GUIDE.md)。本文件供安裝人員核對服務。

```text
客人 WhatsApp → 已連結的 Evolution instance
  → Bearer 認證 POST /webhooks/evolution → SQLite 去重及對話
  → 同一 Engine：批准知識／模型或人工／期限及接手檢查
  → 待確認草稿 → 管理員批准 → 發送開關及 24 小時窗口
  → Evolution sendText → accepted
  → MESSAGES_UPDATE 回執 → delivered／read／failed
```

`npm start` 同時提供 `/workbench.html` 和 `/console`，共用同一 Store、Engine 及背景 worker。3101 預覽仍然隔離，手機登入成功不會在預覽啟動收發。

## 伺服器準備

使用 Node 24.22+（24.x）、一個程序、倉庫外持久資料目錄及已建立的 Evolution instance。Evolution 必須獨立運行；只設定網址不會安裝它。公開服務需要可信 HTTPS 反向代理及受保護管理入口。

在伺服器私人環境或秘密管理入口設定：

| 設定 | 用途 |
| --- | --- |
| `EVOLUTION_URL`、`EVOLUTION_INSTANCE`、`EVOLUTION_API_KEY` | 固定的服務及 instance 身份；金鑰不回傳瀏覽器、不入 SQLite |
| `PUBLIC_BASE_URL` | 客服服務的 HTTPS origin，無路徑及 query；生成 `/webhooks/evolution` |
| `WEBHOOK_SECRET` | 至少 32 字元，收件端的 Bearer secret |
| `COOKIE_SECURE=true` | 公開 HTTPS 管理及客人會話 cookie |
| `DELIVERY_ENABLED=false` | 初次設定保持關閉；指定測試號碼完成接收／草稿核對後再明確選擇開啟 |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | 選用背景模型；人工回覆不需要模型金鑰 |

本機開發只容許 loopback HTTP。`PUBLIC_BASE_URL=http://127.0.0.1:3100` 只適用於同機能存取該地址的 Evolution；遠端供應商不能存取你的 localhost。

## 工作台操作

1. 啟動服務，安全讀取資料目錄的 `admin-token` 登入 `/workbench.html`。
2. 「接駁 → 接駁 WhatsApp」依序完成準備、QR、連線及收件。服務網址和 instance 在真正執行器為唯讀；不從前端切換實際客戶渠道。
3. 「設定並核對收件網址」只使用伺服器指定的 callback，不接受任意前端網址。設定事件 `MESSAGES_UPSERT` 及 `MESSAGES_UPDATE`、`byEvents:false`、`base64:false`、Authorization Bearer，再以 `/webhook/find/{instance}` 讀回核對。錯誤結果不顯示已核對。
4. 商戶名稱、服務及人工聯絡方式由用戶實際填寫。保持 `review`；用另一個測試號碼來訊，驗證同一筆對話和草稿。接手後取消尚未提交回覆。
5. 用戶選擇測試發送後，由安裝人員在私人設定開啟 `DELIVERY_ENABLED=true` 並重啟。批准一次草稿或人工回覆；在收件手機和管理對話核對實際訊息。`accepted` 只表示供應商回傳 message ID。

模型可在工作台實際探測；環境已有金鑰時毋須把金鑰複製到瀏覽器。探測會使用該 API 額度。持續背景 AI 由服務執行器負責，不會自動喚起目前 Codex／DOT 對話。

## 更新、回執及失敗

增量 schema v3 新增回執 inbox、渠道觀察及 provider instance 對應；v4 新增受限客人網頁會話。升級前停止服務，備份並驗證私人資料副本。更新不更改已有商戶設定、批准、人工接手或發送開關。

渠道 URL／instance 身份在商戶資料庫持久記錄，憑證仍留在環境。重啟時若身份不同會拒絕啟動，避免把舊對話送到另一個帳號；有意換帳號需獨立資料目錄及經審閱的遷移，不刪鎖或直接覆寫身份。

回執按 instance、電話地址及 provider ID 配對，先到的 callback 持久保存，發送回應取得 ID 後對帳；重複或較舊回執不降級 delivered／read。群組、LID-only 及未知形狀不猜配。供應商錯誤、逾時或結果不明保留 `uncertain`，重啟亦不重發；人工先到 WhatsApp 核對。此版本沒有對供應商主動查詢未知 send 結果的對帳 API。

未對應的手機手動送出訊息會轉人工；供應商回聲早於 send HTTP 回應時亦採此保守處理。發送已在途時人工接手不能保證撤回。

這條路線已用模擬供應商完成收件、批准、發送、回執、重啟及身份保護測試。真實帳號、真實手機收件及公開 HTTPS 可達性仍須在實際環境驗收；本次介面教學更新沒有替用戶啟用帳戶或客戶自動發送。
