# 本機 Agent 工作台

> 歷史說明：下文保留早期 3101 隔離預覽的操作及驗證背景，並非 2026-10-26 的現行導覽規格。現行入口展開為同一卡片的「收件匣／知識庫／管理」；WhatsApp 與模型狀態分開。啟動與真實渠道以 [README](../README.md)、[INSTALL](INSTALL.md) 及 [UI_DESIGN](UI_DESIGN.md) 為準。

這是**藍圖工作室內置客服 AI 插件的獨立本機實測版**。原生設計與固定卡片尺寸範圍見 [插件設計規格](BLUEPRINT_PLUGIN_DESIGN.md)。本機版已完成卡片介面；宿主註冊、拖移／縮放及尺寸限制仍待整合。

這份本機版本延續已核對的卡片設計：**AI → Agent 工作台 → 客服 AI → 配置客服**。它不會向測試工作室或 GitHub 寫入任何設定。卡片以紅燈「未連接」／綠燈「已連接」顯示最近驗證結果；AI 模型及 WhatsApp 均已連接才顯示綠燈。

## 啟動

Windows 執行 `tools/start-local-workbench.ps1`，或在 Node.js 24.22+ 執行 `npm run workbench`。開啟 <http://127.0.0.1:3101>。預設資料位置是使用者目錄的 `.bluesai-local-workbench`，與原有 3100 服務分開；首次產生的管理員密碼在該目錄 `admin-token`，只在本機登入使用。

設定 `BLUESAI_WORKBENCH_PORT`、`BLUESAI_WORKBENCH_DATA` 可指定獨立測試埠及資料目錄。資料目錄不可放在程式碼內，也不可同時給兩個程序使用。Windows 啟動腳本為新建資料目錄設定目前使用者專用的存取權限。

## 可以真正實測的內容

「基本設定／訓練／接駁」共用一張設定卡片，返回按鈕、分頁、內容及操作結果都在卡片內。移除重複的「配置客服」標題、Agent 介紹及基本設定開場提示；欄位標籤保留，訓練和接駁內容以分隔線整理。切換分頁保留尚未儲存的輸入。

1. **基本設定**：保存商戶名稱、行業、服務、自訂回覆指令及語氣。下拉選單提供按行業、簡短直接、親切自然、正式專業、先了解需要及逐步說明；按「加入指令」才加入文字，不覆寫既有指令或預填商戶政策。人工安排輸入欄已移除，保存設定時保留原有值。
2. **訓練**：以對話教客服，生成待確認記憶。沒有接駁模型時原文保存，明確標示離線；接駁後模型會參考最近 12 則訓練對話整理一條記憶或追問。確認、修改、重新確認及刪除均保存至 SQLite，重啟後仍在。
3. **接駁**：首先提供「交給 Codex／DOT 處理」：準備任務、檢查內容，再按鍵呼叫目前 AI 對話，毋須額外金鑰。內置瀏覽器接受原生交接請求後仍由使用者確認送出；不支援時可複製任務。網站工具或貼回結果只保存待核對草稿，詳見 [協作流程](CODEX_DOT_HANDOFF.md)。另可展開選用的 OpenAI 設定，填入金鑰與模型名稱，使用一次實際結構化回覆驗證。Evolution 填入既有服務網址、instance 名稱及金鑰後，向服務取得二維碼；檢查連線使用服務回傳狀態。

依使用者要求，介面的「試聊」分頁已移除。此次只是介面調整，後端回覆、記憶及對外發送規則保持原有行為。

## 接駁及資料邊界

- 本機服務只綁定 `127.0.0.1`，需管理員登入及同源寫入驗證。
- 這版接駁金鑰只存在服務程序記憶體，不寫入磁碟、瀏覽器儲存或模型上下文；重啟後重新填寫。不要把真實金鑰貼到聊天。
- AI 測試、模型訓練及試聊會使用使用者的 API 額度；沒有金鑰時不呼叫付費模型。開發驗證只用模擬供應商。
- Codex／DOT 按鍵沿用目前宿主帳戶與使用限制；不需要 OpenAI API 金鑰。卡片的 AI／WhatsApp 連線燈代表已驗證的後台連線，不將「宿主支援按鍵」誤寫成自動客服已上線。
- 支援 OpenAI Responses 與結構化輸出的模型；使用者填寫自己帳戶可用的模型，沒有預選付費型號。
- WhatsApp 掃碼適用於已建立的 Evolution WhatsApp Baileys instance；這版不自動安裝 Evolution、不建立 instance，不提供 Meta Cloud API 的註冊流程。
- 掃碼會建立真實 WhatsApp 已連結裝置。清除本機接駁只移除本程序的憑證；移除 WhatsApp 裝置需在手機的「已連結裝置」處理。
- 本機配置服務不啟動發送 worker、不接收 webhook、不提供真實發送開關。**裝置連線成功不等於客服已在 WhatsApp 上線。**正式收發需另外驗證可達的 webhook 網址、測試帳號、人工接手及發送設定。
- 訓練是建立可審閱的商戶記憶，並非更改模型權重。刪除記憶會停止回覆採用；原訓練對話仍保留在本機訓練記錄。避免在共用訓練填入個別客戶私資料。
- 模型可能整理錯誤，因此記憶一律先待確認；來源 ID 檢查不等於完整的語意正確保證。

## 設計與程式

`design/customer-agent-card-design.html` 是沒有網絡存取的互動設計稿。`python tools/build-workbench.py` 產生 `public/workbench.html`、`workbench.css`、`workbench.js`；`workbench-api.js` 只在本機頁面注入真正 HTTP 操作。設計稿本身不讀寫工作室。

本機入口 `src/workbench.js` 與原有 `src/index.js` 分開。原有客服介面及 3100 程序可繼續使用；新增記憶表及 profile 行業欄位兼容舊資料。

## 參考及驗證

AI 接口參照 [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)。Evolution 路由及回傳結構參照固定版本的 [instance router](https://github.com/evolution-foundation/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/src/api/routes/instance.router.ts) 與 [instance controller](https://github.com/evolution-foundation/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/src/api/controllers/instance.controller.ts)。

執行 `npm test` 與 `npm run check`。測試覆蓋待確認知識隔離、修改後撤回批准、跨重啟持久化、對話不進發送佇列、認證與同源限制、模型連線成功／失敗、金鑰不回傳、WhatsApp QR／狀態回應及 HTTPS／redirect 限制。

## 0.3 按鍵接駁教學

同一張卡片的「接駁」新增「接駁 WhatsApp」「接駁網頁」四步教學。3101 仍為隔離預覽；真正執行器的同款配置入口在 `npm start` 的 `/workbench.html`，與 `/console` 共用設定及對話。詳見 [CONNECTION_GUIDE.md](CONNECTION_GUIDE.md)。
