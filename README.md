# BlueSAI-客服

**Agent 編號：`BlueSAi-Cs-#0001` · MIT 開源授權**

項目名稱為「BlueSAI-客服」，完整編號保留大小寫及 `#`。GitHub 倉庫名稱使用 `BlueSAi-Cs-0001`，身份資料記錄於 [agent.json](agent.json)。

一個可在本機運行的 AI 客服起步版本。商戶以普通說話設定服務，客服用簡短、專業的方式回答；不知道的事不預填，重要決定交給真人。

**目前版本：0.1.0。單商戶、單程序、文字訊息 MVP，未宣稱已在真實 WhatsApp／OpenAI 帳戶上驗證。**

## 已有功能

- 三個頁面：**對話、教客服、設定**。繁體中文介面，可用手機或電腦。
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

需要 **Node.js 24.22 或更新的 24.x**。使用內建 HTTP、SQLite、測試工具，沒有第三方執行依賴，也沒有前端建置步驟。

```sh
git clone https://github.com/collieai-g/BlueSAi-Cs-0001.git
cd BlueSAi-Cs-0001
npm start
```

開啟終端機顯示的本機網址，預設為 `http://127.0.0.1:3100`。終端機會列出管理員密碼檔案位置，請在本機讀取該檔案並登入。密碼不會印到日誌。不要把密碼貼到聊天或提交 Git。

資料預設存於使用者家目錄的 `.blueprint-service/`，**不在倉庫內**。首次開啟的商戶欄位和知識庫完全空白，真實發送預設關閉。這時可以離線試聊，不會呼叫付費 AI 或發送 WhatsApp 訊息。

1. 在「教客服」填商戶名稱、服務及工作指令，按儲存。
2. 加入資料，核對後勾選「可以用來回答客戶」。未確認／過期資料不使用。
3. 試聊後到「對話」確認草稿，試接手、回覆及交回。
4. 需要實際 AI 或訊息渠道時，按 [安裝與連接](docs/INSTALL.md) 設定。

## 驗證

```sh
npm test
npm run check
```

測試使用記憶體／暫存 SQLite、模擬 AI 和渠道，以及本機 HTTP，**不使用真實客戶、密鑰或 API 額度**。包括資料持久化、重複事件、人工接手競態、資料更新、來源過期、HTTP 驗證、發送窗口與未知結果等案例。

目前保留 [產品設計](docs/PRODUCT.md)、[架構與限制](docs/ARCHITECTURE.md)、[安裝指南](docs/INSTALL.md)。請先閱讀這些文件再開啟真實發送。

## Evolution API 與授權

訊息連接採用 [Evolution API](https://github.com/evolution-foundation/evolution-api)，需另外安裝。這個倉庫是獨立寫成的客服服務，沒有複製 Evolution 的前端或服務原始碼。

接口設計參考其 `fa09d37892cdbb1d65a250155d293d92230c5b30` 原始碼；當時 package 版本為 2.3.7。這不是對特定容器或帳戶已完成整合測試的聲明。Evolution 的授權包含額外條件，請依實際使用版本核對其 [LICENSE](https://github.com/evolution-foundation/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/LICENSE)。管理員設定頁保留使用通知。

本倉庫的原創程式及文件採用 [MIT License](LICENSE)，允許使用、修改、分發及商業使用，須保留授權與版權聲明。Evolution API 等獨立服務仍依各自授權；本授權不授予第三方商標或服務權利。

`package.json` 的 `private: true` 只防止意外發佈至 npm，不影響本項目的開源授權或 GitHub 公開狀態。歡迎依 [參與指引](CONTRIBUTING.md) 提交改進。
