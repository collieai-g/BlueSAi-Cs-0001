# 客服卡片與執行器架構

版本：0.4.0-preview.1。權威介面及資料邊界見 [AGENT_UI_CONTRACT.md](AGENT_UI_CONTRACT.md)。

## 宿主中的一個 Agent

Blueprint Studio 提供外層工作空間、身份、導覽、主題及排版。客服是「AI → Agent 工作台」內的一個已登記項目；入口和配置為同一項目的狀態，配置只含基本設定／訓練／接駁三個分頁。自己的對話、草稿及人工回覆亦在卡片內容區處理。

客服不載入另一套總覽、工作或資料網站，不覆寫宿主的這些內容、全域路由、CSS 或資料表。只有自己的 Agent 登記／設定及經宿主管理的卡片排版可以更新。讀取公司資料需要另外明確授權的受限整合，不能由卡片擴成全域寫入權限。

## 程式與資料流

```text
宿主 Agent 工作台
  └─ 一個客服卡片根節點
       └─ /api/agents/bluesai-cs-0001（目前公司與 instance 的受限 adapter）
            └─ 獨立客服 Engine + 私人 SQLite

指定測試 WhatsApp 手機
  ↔ 真實連結裝置服務／Evolution instance
  → 認證 webhook → 去重、指定對話、持久工作及期限
  → 已批准知識 + 模型／人工處理
  → 卡片內待核對草稿／人工接手
  → 版本、來源、人工狀態、發送範圍及窗口檢查
  → provider 接受 → 可對應送達／已讀回執
```

`src/store.js` 負責資料及同步交易；`agent.js` 處理模型協定；`engine.js` 管理接收、期限、人工控制和發送；`evolution.js` 適配供應商協定；`connections.js` 負責真實探測與接駁；`server.js` 提供認證及命名空間接口；`index.js` 管理生命週期。

`design/customer-agent-card-design.html` 經 `tools/build-workbench.py` 產生 `public/workbench.*`。本機 `/`、`/workbench.html` 及相容 `/console` 入口均呈現卡片。舊 `public/index.html`／`public/app.js` 整頁工具只在 `/diagnostics/console` 作獨立診斷，不屬於正式 Agent UI 或宿主安裝流程。

卡片前端只使用 `/api/agents/bluesai-cs-0001`。客服獨立服務內部的 `/api/workbench` 及舊相容 API 不授權宿主代理整個 `/api`，亦不代表多租戶身份隔離已完成。3101 預覽仍為自己的資料目錄，沒有收發 worker；實際手機測試使用真正執行器。

## 儲存與不可跨越的控制

每個部署只服務一個商戶、一個渠道身份、一個程序及一份倉庫外 SQLite。宿主資料庫不直接共用；若日後實作 Sites D1 適配，須有專屬命名空間、公司身份、版本及備份 coverage，不能改寫宿主原有表或套用新站資料庫覆蓋。

- 商戶未知欄位保持空白。已批准、仍有效的知識才進模型；對話不會自動變成政策。
- 新來訊及人工接手增加對話版本。資料 revision 或來源有效性改變後，舊生成結果、草稿及未提交訊息不能沿用。
- 人工狀態持久保存；只有明確交回才恢復 AI。超時監察獨立於模型等待。
- 未完成動作不得由模型聲稱已退款、預約、通知或改單。模型沒有這些執行工具。
- 發送前重查人工狀態、來源、版本、發送開關、測試範圍及窗口。在途訊息不能保證撤回；不明結果不自動重發。

schema v1 保存 response_windows／handoff_tasks，v2 保存不可變 Codex／DOT 任務，v3 保存 provider instance、回執 inbox 及觀察，v4 保存受限網頁會話，v5 新增 FAQ 對照及知識庫優先政策。遷移前正常停止、備份及驗證還原；不重建商戶資料或默默啟用發送。

## 真實渠道與驗收範圍

本機連結裝置橋接與客服可同機 loopback 運行，不需要把本機管理頁公開。第三方 Baileys 路線不是 Meta Cloud API；登入資料只在私人渠道目錄。原有指定號碼測試模式預設空名單；本人另可明確選擇所有新私人文字收件。接收權限與只回覆實際最近來訊客戶的發送授權分開，不能由開收件變成任意號碼廣播。詳見 [即時對話邏輯](LIVE_INBOX.md)。

Evolution 可作為獨立供應商；遠端服務須核對真正 callback 的 HTTPS 可達性與身份。兩種方式都不把手機 open 當作客服已收件。實際設定見 [WHATSAPP_RUNTIME.md](WHATSAPP_RUNTIME.md)。

`accepted` 只表示取得 provider ID。回執按 instance、電話及 ID 配對，先到 callback 持久保存，重複／較舊結果不降級 delivered／read。群組、廣播、無法可靠映射的 LID、媒體及未知形狀不猜配。未對應的手機發訊息保守轉人工；發送回聲早於 HTTP 回應也可能如此處理。

網頁客人入口是獨立可選渠道，只公開自己的已提交內容，瀏覽器 ACK 才標送達。離線規則和模擬 provider 用於程式測試，不能替代真實 WhatsApp 手機驗收。

## 宿主能力不足時

原生協作 manifest、只讀 preflight、安裝 journal、備份 coverage 及 CAS 登記 client 見 [INSTALL_PACKAGE.md](INSTALL_PACKAGE.md)。它們不自動部署後台，也不會啟動目前 Codex 對話成為持續 AI。

完整通用 Sites renderer／D1 管理 API、宿主 manifest 原地升級與私人工作室現場驗收仍待完成。缺項必須阻擋相應安裝並說明下一步，不以搬入整頁客服或覆蓋宿主主列補位。歷史測試與舊截圖只屬當時版本的證據。
