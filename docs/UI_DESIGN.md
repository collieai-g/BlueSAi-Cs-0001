# 客服 Agent 卡片介面

版本：0.4.0-preview.1，2026-10-25。此文件取代早期把整套客服管理後台當成 Agent 入口的呈現方式。

## 固定介面邊界

正式入口為「AI → Agent 工作台 → BlueSAI 客服」。客服只是一個已登記的 Agent 卡片項目，入口與配置是同一實例的狀態。整體限制見 [AGENT_UI_CONTRACT.md](AGENT_UI_CONTRACT.md)。

卡片不渲染工作室的側欄、頂列、公司切換或「總覽／工作／AI／資料」主導覽，也不提供能替換宿主這些頁面的安裝包。宿主負責外層導覽、身份、主題及排版；客服只管理自己的根節點及資料。

三個分頁固定在同一張配置卡片內：基本設定、訓練、接駁。客戶來訊、核對、人工接手及回覆留在卡片自己的內容區，不要求使用者離開 Agent 進入另一套客服總覽網站。

## 操作與真實狀態

- 「接駁 WhatsApp」為本次主要流程：檢查服務、取得真正 QR、本人手機掃碼、核對收件及指定號碼試覆。
- WhatsApp 手機狀態與 AI 模型狀態分開顯示；沒有模型金鑰不代表手機不能連結或人工回覆不能測試。
- 卡片就緒、服務設定齊全、手機 open、來訊已保存、provider accepted、手機送達是不同觀察結果。
- 不能用離線答案或網頁扮演客人的成功畫面宣稱 WhatsApp 已測試。
- 缺少能力時，畫面說明缺少什麼、目前能做什麼，以及下一個可執行步驟；不使用一個籠統的「已連接」覆蓋所有狀態。

## 表單與閱讀

空白商戶欄位保持空白。訓練原文預設待確認；批准、撤銷及失效維持後台控制。切換分頁、查看對話及背景狀態更新保留未儲存輸入。按鍵寫出實際操作結果。

本機卡片的來源是 `design/customer-agent-card-design.html`，由 `tools/build-workbench.py` 產生 `public/workbench.*`；不可只改產出檔案。HTTP client 放 `public/workbench-api.js`，只呼叫 `/api/agents/bluesai-cs-0001`。

卡片尺寸、24px 宿主方格、窄畫布閱讀模式、320px 與 200% zoom 驗收依 [BLUEPRINT_PLUGIN_DESIGN.md](BLUEPRINT_PLUGIN_DESIGN.md)。未完成的宿主拖移／縮放整合不得寫成可用。

## 共用資產及舊介面

共用 Blueprint 資產固定於 `UI_SOURCE.json` 記錄的 commit，MIT 聲明及雜湊保留。不能直接修改 `public/vendor/` 來影響整個宿主；卡片樣式只作用於客服根節點。

早期 `public/index.html`／`public/app.js` 的整頁工具保留作獨立診斷，僅在 `/diagnostics/console` 明確使用。它不是正式 Agent UI，不能搬進工作室或替換宿主的任何主列。歷史截圖及驗證記錄只證明當時版本，不能代證本版卡片或真實手機測試。
