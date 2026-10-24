# BlueSAI-客服

**Agent 編號：`BlueSAi-Cs-#0001` · MIT 開源授權**

項目名稱為「BlueSAI-客服」，完整編號保留大小寫及 `#`。GitHub 倉庫名稱使用 `BlueSAi-Cs-0001`，身份資料記錄於 [agent.json](agent.json)。

**專門為 Blueprint Studio（藍圖工作室）設計的內置客服 AI 插件。** 商戶由「AI → Agent 工作台」的客服卡片進入，在同一張設定卡片內使用「基本設定／訓練／接駁」。介面沿用工作室原生設計，回覆簡短、清楚、專業；不知道的商戶資料保持空白。

新增獨立的 **[本機 Agent 工作台](docs/LOCAL_WORKBENCH.md)**：卡片入口 → 配置客服 → 基本設定／訓練／接駁。執行 `npm run workbench` 使用 3101 埠；資料與原有 3100 服務分開，不會寫入測試工作室。

插件的卡片移動、縮放及尺寸範圍見 **[原生插件與卡片設計規格](docs/BLUEPRINT_PLUGIN_DESIGN.md)**。使用者可在固定最小與最大尺寸之間調整，按工作室的 24px 方格移動。**目前交付本機實測版；宿主插件註冊、原生拖移／縮放及尺寸限制仍待整合，並未安裝到測試工作室。**

**目前版本：0.2.0。單商戶、單程序、文字訊息 MVP，未宣稱已在真實 WhatsApp／OpenAI 帳戶上驗證。**

**[可靠交接流程](docs/RELIABLE_HANDOFF.md)**已完成並合併：持久 30 秒期限、模型等待期間獨立轉人工、跨重啟恢復與遲到答案攔截。本地交接工作已保存不代表私人 WhatsApp 已收到通知；完整階段安排見 [開發計劃](docs/DEVELOPMENT_PLAN.md)。

整體設計以 **Codex 與 DOT 配合**。本版提供 **[按鍵呼叫 Codex／DOT 的協作預覽](docs/CODEX_DOT_HANDOFF.md)**：工作台準備任務、展示已確認資料快照，交給目前智能 Agent，再保存待核對草稿，毋須額外模型金鑰。原生交接最後由使用者確認送出；這一步仍待手動實測。網站工具讀取、草稿回存及複製備援已在本機驗證，全套 74 項測試通過；詳見 [驗證記錄](docs/CODEX_DOT_VERIFICATION.md)。自動背景事件與對客發送另行驗收。

## 已有功能

- 本機插件工作台：客服入口卡片、紅／綠連線狀態、同一卡片內三個分頁、行業及六種回覆模式、對話訓練與待確認記憶、模型及 WhatsApp 接駁介面。見 [本機版功能與邊界](docs/LOCAL_WORKBENCH.md)。

下列能力保留於原有 3100 客服服務，並非全部已接入 3101 插件工作台：

- 沿用 Blueprint Studio 的原版樣式、圖示及品牌圖形：**總覽／工作／AI／資料**，設定在左下角。繁體中文介面，可用手機或電腦。
- 總覽顯示實際待辦、對話、有效資料及回覆方式；對話與知識可搜尋。
- 空白商戶設定、工作指令、親切／正式語氣。
- 商戶知識的待確認／已確認狀態、有效期、刪除；對話內容不自動變成商戶政策。
- 試聊與對話背景。未設 AI key 時，用明確標示的離線規則示範。
- OpenAI Responses API 接口：商戶設定、有效知識、最近 24 則已接收／已確認發出的對話作上下文；結構化回覆及來源 ID 檢查。
- 回覆草稿、編輯後確認、人工接手、人工回覆、明確交回 AI。
- Evolution API webhook 與 sendText 接口；伺服器憑證驗證、事件去重、持久工作記錄。
- SQLite 保存資料；發送逾時標記「未確認」，不盲目重發；重啟恢復待處理工作。
- 管理員登入、HttpOnly session cookie、同源寫入檢查、基本登入限速、CSP。

未包括：多商戶／多管理員權限、跨次客戶記憶、向量搜尋、付款／退款／改單／預約工具、附件解析、WhatsApp 範本發送、手機／電郵通知、完整送達回報及自動對帳。詳細邊界見 [設計與限制](docs/ARCHITECTURE.md)。

## 快速開始

需要 **Node.js 24.22 或更新的 24.x**。使用內建 HTTP、SQLite、測試工具，沒有第三方執行依賴；倉庫已包含可直接運行的前端檔案。

```sh
git clone https://github.com/collieai-g/BlueSAi-Cs-0001.git
cd BlueSAi-Cs-0001
npm run workbench
```

開啟 `http://127.0.0.1:3101`。資料預設存於使用者目錄的 `.bluesai-local-workbench/`，不在倉庫內。終端機會列出管理員密碼檔案位置，請在本機讀取該檔案並登入。密碼不會印到日誌，不要貼到聊天或提交 Git。

1. 點「配置客服」，在「基本設定」填商戶資料、行業及回覆指令。
2. 在「訓練」用對話教客服，核對記憶後按「確認採用」。
3. 在「接駁」使用「交給 Codex／DOT 處理」，準備任務並檢查交出內容；不支援原生交接時可複製到目前對話。自己的 OpenAI API 為選用路線。WhatsApp 需既有服務及帳戶，裝置連線不會自動啟用對客發送。

本機資料不會同步到測試工作室。詳細啟動方式、憑證保存範圍及功能邊界見 [本機工作台](docs/LOCAL_WORKBENCH.md)。

### 原有客服服務（3100）

執行 `npm start` 可繼續使用原有完整服務介面，其資料與插件工作台分開：

資料預設存於使用者家目錄的 `.blueprint-service/`，**不在倉庫內**。首次開啟的商戶欄位和知識庫完全空白，真實發送預設關閉。這時可以離線試聊，不會呼叫付費 AI 或發送 WhatsApp 訊息。

1. 在「AI → 教客服」填商戶名稱、服務及工作指令，按儲存。
2. 在「資料 → 客服知識」加入資料，核對後勾選「可以用來回答客戶」。未確認／過期資料不使用。
3. 在「AI」試聊後，到「工作 → 客戶對話」確認草稿，試接手、回覆及交回。
4. 需要實際 AI 或訊息渠道時，按 [安裝與連接](docs/INSTALL.md) 設定。

## 驗證

```sh
npm test
npm run check
```

測試使用記憶體／暫存 SQLite、模擬 AI 和渠道，以及本機 HTTP，**不使用真實客戶、密鑰或 API 額度**。包括資料持久化、重複事件、人工接手競態、資料更新、來源過期、HTTP 驗證、發送窗口與未知結果等案例。

目前保留 [產品設計](docs/PRODUCT.md)、[架構與限制](docs/ARCHITECTURE.md)、[安裝指南](docs/INSTALL.md) 及 [驗證記錄](docs/VERIFICATION.md)。請先閱讀這些文件再開啟真實發送。

## 藍圖工作室介面

最新產品方向及卡片尺寸以 [內置插件設計規格](docs/BLUEPRINT_PLUGIN_DESIGN.md) 為準。以下描述保留的 3100 服務介面與共用資產來源；正式插件嵌入時由宿主提供外層導覽。

介面採用 [Blueprint Studio Open Source](https://github.com/collieai-g/Blueprint-Studio-Open-Source) v2.7.3 的共用視覺：白灰背景、方格底紋、224px 側欄、68px 頂列、按鈕及卡片。兩份原版 CSS 與品牌 SVG 保存在 `public/`，不依賴外部 CDN；客服內容及互動另外實作。

| 主列 | 用途 |
| --- | --- |
| 總覽 | 查看待辦、最近對話，按三步準備客服 |
| 工作 | 搜尋對話、確認草稿、人工接手及回覆 |
| AI | 設定服務與工作指令，立即試聊 |
| 資料 | 搜尋、加入及確認客服知識 |
| 設定（左下角） | 回覆方式、人工聯絡方式、連接狀態、登出 |

桌面側欄可收窄，手機使用抽屜選單；更新資料會保留尚未儲存的輸入。參考來源固定於 commit `ea20229b1bbdb5cb55f42456d4b962d66d6898e7`，記錄與檔案雜湊見 [UI_SOURCE.json](UI_SOURCE.json)，設計範圍見 [介面說明](docs/UI_DESIGN.md)。

## Evolution API 與授權

訊息連接採用 [Evolution API](https://github.com/evolution-foundation/evolution-api)，需另外安裝。這個倉庫是獨立寫成的客服服務，沒有複製 Evolution 的前端或服務原始碼。

接口設計參考其 `fa09d37892cdbb1d65a250155d293d92230c5b30` 原始碼；當時 package 版本為 2.3.7。這不是對特定容器或帳戶已完成整合測試的聲明。Evolution 的授權包含額外條件，請依實際使用版本核對其 [LICENSE](https://github.com/evolution-foundation/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/LICENSE)。管理員設定頁保留使用通知。

本倉庫的原創程式及文件採用 [MIT License](LICENSE)，允許使用、修改、分發及商業使用，須保留授權與版權聲明。Evolution API 等獨立服務仍依各自授權；本授權不授予第三方商標或服務權利。

Blueprint Studio 的 CSS、品牌 SVG、圖示路徑及介面結構依其 MIT 授權使用；原版權與授權聲明保存在 [public/vendor/LICENSE.blueprint](public/vendor/LICENSE.blueprint)。

`package.json` 的 `private: true` 只防止意外發佈至 npm，不影響本項目的開源授權或 GitHub 公開狀態。歡迎依 [參與指引](CONTRIBUTING.md) 提交改進。
