# BlueSAI-客服

**BlueSAi-Cs-#0001 · 0.3.0-preview.1 · MIT**

為 Blueprint Studio 設計的客服 Agent。基本設定、訓練及接駁保留在同一張設定卡片；未知的商戶資料保持空白，記憶經確認後才供客服採用。

「接駁」現在提供兩個清楚的按鍵：

- **接駁 WhatsApp**：準備手機及服務 → 取得二維碼及手機掃碼 → 核對收件設定 → 試收試覆。包含 iPhone／Android 操作、重新取得二維碼及實際連線檢查。
- **接駁網頁**：準備網頁客服 → 取得聊天網址 → 加入原有網站 → 客人提問及工作台核對回覆。

沒有接駁服務時，可以先請目前 Codex／DOT 整理安裝步驟草稿。閱讀完教學不會把服務改成「已連接」，亦不會開啟對客發送。詳見 [接駁教學](docs/CONNECTION_GUIDE.md)。

## 啟動

需要 **Node.js 24.22+（24.x）**，沒有第三方 npm 依賴。

```sh
npm start
```

- 客服配置、訓練與接駁教學：[http://127.0.0.1:3100/workbench.html](http://127.0.0.1:3100/workbench.html)
- 客戶對話、人工接手及批准發送：[http://127.0.0.1:3100/console](http://127.0.0.1:3100/console)
- 管理員密碼保存在倉庫外 `BLUEPRINT_DATA_DIR/admin-token`；預設資料目錄為 `~/.blueprint-service`。請在本機安全讀取，毋須貼到聊天。

這兩個管理入口使用同一個商戶、資料庫及客服執行器。收件、草稿、人工接手和發送不再是分開的設定展示。單商戶、單程序；不可把同一資料目錄共用給不同商戶。

只想試用獨立介面，可以執行 `npm run workbench`，開啟 [3101 隔離預覽](http://127.0.0.1:3101)。它保留自己的資料，沒有對客收發 worker，不會更新私人工作室。

## 能力及設定

| 模式 | 交付內容 | 還需要甚麼 |
| --- | --- | --- |
| collaboration | 按需準備任務、有效資料快照及待核對草稿 | 目前客戶端工具；原生送出由本人完成 |
| web-chat | `/chat` 客人會話、同一核心、人工批准後收件 | 明確開啟 `WEB_CHAT_ENABLED`；公開使用需要 HTTPS 及持續服務 |
| whatsapp | Evolution QR／連線、認證 webhook、批准發送、送達及已讀回執 | 已建立的 Evolution instance、手機掃碼、接收網址及測試號碼 |
| 持續 AI | Node 背景執行器、已批准知識、獨立人工接手期限 | 選用模型 API 及運行主機；目前 Codex 對話不會自動持續執行 |

WhatsApp 預設 `DELIVERY_ENABLED=false`。配置齊全、手機已連結、渠道接受及客人收到各自顯示；發送結果不明時不盲目重試。網頁客人只會看到自己的已提交訊息，不會取得管理工具、未批准草稿或其他客人的資料。

[完整安裝設定](docs/INSTALL.md) · [WhatsApp 收發路線](docs/WHATSAPP_RUNTIME.md) · [可靠人工交接](docs/RELIABLE_HANDOFF.md) · [Codex／DOT 協作](docs/CODEX_DOT_HANDOFF.md)

## 安裝到既有藍圖工作室

把下列指示交給目前的安裝 AI；沿用已指定的工作室、公司及 Site，不需要重建網站。

```text
請按 BlueSAi-Cs-0001 的 INSTALL_AI.txt 及 docs/INSTALL_PACKAGE.md，
先做只讀 preflight，沿用已知工作室、公司、來源及安裝 operation_id。
來源：https://github.com/collieai-g/BlueSAi-Cs-0001
固定經核對的完整 commit 與產物雜湊；先說明所選模式及缺少能力。
使用套件內相容 manifest，重用有效備份及既有 Agent，不重複登記。
在接駁頁提供 WhatsApp／網頁逐步教學，按實際結果驗收。
未支援的宿主 renderer／API，先列出缺項及相容層開發範圍。
保留原有資料、登入及空白選填欄位；金鑰在安全入口設定。
只更新受影響來源，GitHub 發佈與真正 Site 部署分別提供證據。
```

套件包含可登記的 `bluesai-cs-0001` 原生協作 manifest、capability profile、只讀 preflight、共用安裝 journal、備份 coverage 檢查、登記 client、固定來源產物及 Windows／Linux CI。見 [安裝套件及接續方式](docs/INSTALL_PACKAGE.md)。根目錄 `agent.json` 仍是產品身份，不是宿主 manifest。

**完整 Sites D1／R2 管理 API 及原生三分頁 renderer 尚未在此公開套件實作。** `integrations/blueprint/sites/` 提供需求合約及阻擋檢查；不把私人安裝成果、Node／SQLite 或完整 iframe 當作可直接匯入的 Sites 後台。現有宿主未支援時，preflight 會列明缺項。這個 preview 沒有宣稱已部署到任何私人工作室。

## 驗證及維護

```sh
npm test
npm run check
```

測試涵蓋知識批准及失效、不可變任務、人工接手、持久期限、發送去重及不明結果、webhook 認證、送達回執、客人會話隔離、重啟、安裝 CAS、備份 coverage 及版本產物。真實 WhatsApp 帳戶與私人 Site 驗收另依當次設定完成，不能由模擬測試代證。

[本版驗證記錄](docs/CONNECTION_VERIFICATION.md) · [架構](docs/ARCHITECTURE.md) · [插件及卡片規格](docs/BLUEPRINT_PLUGIN_DESIGN.md) · [開發計劃](docs/DEVELOPMENT_PLAN.md) · [貢獻指引](CONTRIBUTING.md)

密鑰、SQLite、日誌、備份及私人部署身份均留在 Git 之外。共用 Blueprint 視覺資產的來源、固定版本及 MIT 聲明保留於 [UI_SOURCE.json](UI_SOURCE.json) 與 `public/vendor/`。
