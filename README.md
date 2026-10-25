# BlueSAI-客服

**BlueSAi-Cs-#0001 · 0.4.0-preview.1 · MIT**

客服是 **Blueprint Studio → AI → Agent 工作台中的一個卡片項目**。入口與配置是同一項目的兩種狀態；基本設定、訓練、接駁及客服對話都在卡片自己的內容區處理。

**宿主的「總覽、工作、資料」保持由工作室管理。客服安裝不得替換這些內容、導覽、路由或資料表。** 固定邊界見 [Agent 介面及資料合約](docs/AGENT_UI_CONTRACT.md)。

## 卡片內容

- **基本設定**：商戶實際資料、回覆方式、客服來訊、待確認草稿及人工接手。未知資料保持空白。
- **訓練**：教客服、核對及批准記憶；未確認或過期內容不供客服採用。
- **接駁**：真實 WhatsApp 的連結裝置、收件與試覆流程；模型及網頁渠道分開設定。

卡片以「即時對話」處理新訊息、人工回覆及 DOT 草稿。知識庫優先模式不用另外設定模型 API key：唯一吻合的已確認問答可直接回覆，其餘立即提示本人／DOT 處理。接收範圍、允許回覆最近來訊客戶及已確認答案自動回覆分開確認。[完整運作邏輯與通知界線](docs/LIVE_INBOX.md)

## 本機啟動

客服核心需要 **Node.js 24.22+（24.x）**，沒有第三方 npm 依賴。

```sh
npm start
```

開啟 [http://127.0.0.1:3100/](http://127.0.0.1:3100/)，只顯示客服卡片；`/workbench.html` 是同一卡片入口。`/console` 也回到卡片。管理員密碼保存在倉庫外 `BLUEPRINT_DATA_DIR/admin-token`，預設資料目錄為 `~/.blueprint-service`；在本機安全讀取，毋須貼到聊天。

`npm run workbench` 保留 3101 隔離卡片預覽，沒有收發 worker。舊整頁管理工具只保留在獨立服務的 `/diagnostics/console` 供明確診斷，**不作為 Agent 的介面或安裝成果**。

本機卡片與真正工作室安裝是兩個驗收項目。此 Node 服務為一商戶、一程序及一份私人 SQLite，不可共用給不同商戶。

## 真正 WhatsApp 測試

目標是 **本人手機掃碼 → 指定測試號碼來訊 → 卡片核對／人工回覆 → 測試手機實際收到**。離線規則、網頁扮演客人、模擬 provider 和教學閱讀進度都不能代替這項驗收。

接駁方式及必要服務見 [WhatsApp 執行路線](docs/WHATSAPP_RUNTIME.md)；卡片操作見 [接駁教學](docs/CONNECTION_GUIDE.md)。沒有運行中的真實接駁服務時，會列出缺項，不提供示意 QR 當作已連接。只完成手機連結時不宣稱已能收件或送達。

初次發送維持關閉。先設定本人指定的測試收件號碼／allowlist，再依當次授權開啟測試發送；不把整個手機通訊錄當成測試對象。結果不明不盲目重發。

## 安裝到既有工作室

把 [INSTALL_AI.txt](INSTALL_AI.txt) 交給目前安裝 AI。先核對已指定的工作室、公司、來源及同一安裝工作，再做只讀 preflight；受支援時重用原 Agent ID、有效備份及設定，不新增另一套工作室。

套件內 `integrations/blueprint/agent.json` 是可登記的協作 manifest，根目錄 `agent.json` 是產品身份。完整三分頁 renderer 與公司固定的受限 API 仍須由真正宿主支援；單靠登記 manifest 不會產生這些能力。[安裝套件](docs/INSTALL_PACKAGE.md) · [完整安裝指引](docs/INSTALL.md)

**完整通用 Sites D1／R2 客服管理適配尚未交付。** 缺少 renderer、接口或持續執行器時，應明確說明「目前不能運行」的原因及下一步；不能用客服整頁、iframe 或覆蓋宿主主列避開限制。本版沒有宣稱私人測試工作室已修改或已安裝。

## 驗證

```sh
npm test
npm run check
```

模擬測試證明程式在指定條件下的行為；真實手機、收件及送達須保留當次證據。來源固定 commit、GitHub 推送、宿主部署、卡片可見和 WhatsApp 真實收發分別回報。[架構](docs/ARCHITECTURE.md) · [卡片尺寸與原生整合](docs/BLUEPRINT_PLUGIN_DESIGN.md) · [開發次序](docs/DEVELOPMENT_PLAN.md)

密鑰、手機登入狀態、SQLite、日誌、備份及私人部署身份均留在 Git 之外。Blueprint 共用視覺資產與 MIT 聲明保留於 [UI_SOURCE.json](UI_SOURCE.json) 及 `public/vendor/`。
