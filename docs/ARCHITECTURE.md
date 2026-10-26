# 客服卡片與執行器架構

版本：0.4.0-preview.1。權威介面及資料邊界見 [AGENT_UI_CONTRACT.md](AGENT_UI_CONTRACT.md)。

## 服務由左右協作形成

產品分工依 [客服專用 Harness](HARNESS_ENGINEERING.md)：本人決定目標及核對；左側目前 Codex／DOT 提供理解與可用工具；右側單一卡片及私人資料保留來訊、有效知識、草稿和處理結果；渠道後台獨立處理收發及持久控制。已確認 FAQ 先由確定規則處理；未命中時預設交本人，也可明確啟用原生 Codex CLI 或模型 API 後備。原生路線沿用本機 ChatGPT CLI 登入，不另要 API key；使用帳戶額度。手動交目前左側讀取及回存草稿的路線仍保留。

一般管理任務與所選客戶草稿使用不同的身份、快照及工具合約，不能混成通用任意資料存取。現有持久資料可重新讀取，但尚無通用工作 checkpoint、目前 Codex chat／run 關聯、自動喚醒該聊天或通用背景 DOT。新增 CLI 每次建立獨立受限工作，不是跨 AI resume；頁面未送出的文字也不具跨重啟持久性。

## 宿主中的一個 Agent

Blueprint Studio 提供外層工作空間、身份、導覽、主題及排版。客服是「AI → Agent 工作台」內的一個已登記項目；精簡入口展開為同一實例的工作區，主要檢視為收件匣／知識庫／管理。收件匣優先處理對話、草稿及人工回覆；商戶設定、全域回覆政策與渠道教學放在管理。內部 basic／training／connect ID 可保留作相容，不代表舊分頁規則繼續適用。

收件匣按卡片可用寬度選用雙欄加上下文抽屜或三欄；手機在列表及詳情間切換。這是自身根節點內的交互，不增加另一個工作室頁面。WhatsApp 自傳測試另列只讀，不進入客戶自動處理、DOT 草稿或待處理通知；沒有後台支援的 CRM、分派、SLA 及結案操作不由前端虛構。

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
  → FAQ 優先；未命中依明確政策選原生 CLI／API／人工
  → 卡片內待核對草稿／人工接手
  → 版本、來源、人工狀態、發送範圍及窗口檢查
  → provider 接受 → 可對應送達／已讀回執
```

`src/store.js` 負責資料及同步交易；`agent.js` 處理共用回覆格式、來源核對及選用模型 API；`codex-agent.js` 是獨立本機 CLI adapter；`engine.js` 管理接收、期限、人工控制和發送；`evolution.js` 適配供應商協定；`connections.js` 負責真實探測與接駁；`server.js` 提供認證及命名空間接口；`index.js` 管理生命週期。

## 原生生成與後台控制

原生 adapter 使用已核對的 CLI 執行檔，從 stdin 接收單一客戶有限資料及已批准知識；固定 JSON schema 只定義回覆、決策及來源，不授予操作權。每次工作 ephemeral、最多 25 秒，忽略使用者 config，關閉 shell、apps、MCP、plugins、hooks、多 agent、電腦／瀏覽器、圖片、網頁搜尋及 Skill discovery。遇到意外工具事件或無效結果時拒絕，不把程序原始輸出／私密日誌交前端。

CLI 自行沿用既有 ChatGPT 登入；客服不搬移 auth，也不把客服、渠道或模型 API 秘密加入工作資料。runtime 使用倉庫外 `BLUEPRINT_DATA_DIR/codex-jobs`，只放每次臨時 schema，完成清理；prompt 不落此目錄。工具關閉、有限輸入、固定目錄及後台驗證共同限制工作；read-only 字樣本身不代表可讀檔範圍已隔離。

`aiFallback=false`／`automaticAi=false` 是舊資料未有新欄位時的安全預設。fallback 只在 FAQ 優先已啟用、沒有命中且 adapter 可用時進入；退款／投訴、衝突及無依據安排轉人工。只有有批准來源的 `answer` 可按獨立 AI 自動發送授權排隊，`clarify` 仍為草稿。人工控制、對話及知識版本、來源有效性、24 小時窗口與渠道範圍都在後台重查，模型與 CLI 不直接發送。

`POST /api/agents/bluesai-cs-0001/connections/native-codex` 需本人 `{consent:true}`；CLI 版本、ChatGPT 登入及真正合成推理全部通過後才切換 adapter，政策不變。失敗轉人工，關閉 fallback 可恢復 FAQ-only／人工。核心及渠道仍需運行；這條本機路線沒有完成雲端部署。[安裝與復原](INSTALL.md#原生-codex-與選用-api)

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
