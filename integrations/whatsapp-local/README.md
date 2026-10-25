# 本機真實 WhatsApp 連結裝置接駁

這個獨立 Node 子套件讓客服卡片取得 WhatsApp 真正提供的二維碼，經本人手機掃碼後收發指定測試號碼的文字。它不需要 Docker、PostgreSQL、Redis 或另購主機，不會把客服介面寫到工作室的總覽／工作／資料。

採用維護者發布的 `@whiskeysockets/baileys@7.0.0-rc14`、`qrcode@1.5.4`，固定於 `package-lock.json`。Baileys 是**非 Meta 官方的連結裝置程式庫**；請先用專用測試帳號，遵守 WhatsApp 條款。這是單使用者本機預覽，不宣稱企業帳戶或正式營運驗證。[維護者說明](https://github.com/WhiskeySockets/Baileys) · [QR 認證文件](https://github.com/WhiskeySockets/docs/blob/main/authentication/qr-code.mdx)

## 私人安裝與啟動

1. 準備 Node 24.22+（24.x）。把此子套件的程式及 lockfile 複製到倉庫外的私人 runtime 目錄，例如 `~/.bluesai-whatsapp-local/runtime`；授權及訊息資料放另一個 `~/.bluesai-whatsapp-local/state`。Windows 要限制兩者上層資料夾 ACL 只有本人；不要把 WhatsApp auth、SQLite、api key 或 `.env` 提交 Git。
2. 在 runtime 執行 `npm ci --ignore-scripts --omit=optional --no-fund`。這是純文字路線，毋須影像／音訊 peer 的安裝腳本。此版已在隔離 Node 24 Windows 匯入真實 Baileys 與 QR encoder；npm audit 無已知漏洞不等於帳號連接已驗證。
3. 依 `.env.example` 在私人設定填 `WA_LOCAL_DATA_DIR`、固定 instance、callback URL 和至少 32 字元的 webhook secret。客服服務的 `EVOLUTION_URL` 使用 `http://127.0.0.1:3105`、`EVOLUTION_INSTANCE` 使用相同名稱，`EVOLUTION_API_KEY` 使用私人 `bridge-api-key`；兩端共用 webhook secret。金鑰經安全設定入口處理，不貼到聊天或命令參數。
4. 用 `node --env-file=私人設定檔 start.js` 啟動。只監聽 `127.0.0.1`；啟動不會自動登入 WhatsApp。先到客服卡片的「接駁 WhatsApp」，按「取得二維碼」才開始真實 provider 連線。
5. 本人用手機 WhatsApp 的「已連結裝置 → 連結裝置」掃碼，回卡片檢查連線、登記／讀回收件設定。最後在卡片填含國家／地區碼的另一個帳戶測試號碼並明確確認，才可開始該次測試。剛連結帳戶的自身號碼會被拒絕：自己傳給自己的訊息不是客戶來訊。暫時沒有另一個帳戶時，可以保留手機連結，稍後才測試收發。模型金鑰不是手機連線或人工回覆的前置條件。

## 測試範圍與發送

空白名單只取得 QR／連線狀態，**不轉送任何客人訊息，也不發送**。名單最多三個完整國際電話號碼；只向 WhatsApp 查詢這些已同意測試號碼的 LID 映射，群組、廣播及無法確認身份的 LID 忽略。已知發送 ID 的回執依發送前保存的電話識別。關閉歷史同步，只轉送 `notify` 新來訊；帶 placeholder `requestId`、過舊及未有時間的訊息忽略。

橋接和客服 Engine 各有獨立發送開關。橋接啟動預設關閉；卡片的明確測試確認可在 `WA_LOCAL_ALLOW_TEST_ACTIVATION=true`、手機真正 open、webhook 已設定及名單非空時，開啟一次程序內的測試發送。重啟不保留這個動態發送授權。來訊只供指定名單，回覆仍經客服草稿批准或人工操作；沒有模型時不把離線示範自動發到 WhatsApp。

`accepted` 只表示 WhatsApp socket 返回訊息 ID。實際回執才更新 delivered／read。發送失敗、逾時或未知結果不自動重發，先到手機核對。callback 事件先寫私人 SQLite outbox，失敗按原事件 ID 重試，客服端去重；這只保證本程序已觀察事件的持久排隊，不能補回 WhatsApp 根本未交付的事件。

## 受限服務接口

所有 instance／webhook／send API 都需要伺服器端 `apikey`，不提供瀏覽器 CORS；主客服服務代為呼叫。

| 路由 | 結果 |
| --- | --- |
| `GET /healthz` | 不含身份資料的本機存活檢查 |
| `GET /instance/connect/{instance}` | 啟動真正 socket，回傳目前 provider QR；未有 QR 就不生成假圖 |
| `GET /instance/connectionState/{instance}` | 真實狀態、測試名單數量、遮罩末四碼、callback 排隊數 |
| `GET /instance/testRecipients/{instance}` | `{count,maskedNumbers,deliveryEnabled,activationAvailable,mappingState}` |
| `PUT /instance/testRecipients/{instance}` | `{numbers:["含地區碼的數字"],consent:true,activateSending:true}`；先驗證整組前置條件才套用 |
| `POST /webhook/set/{instance}` | 只接受私人環境預先指定的 loopback callback 及 secret，禁止任意轉送目的地 |
| `GET /webhook/find/{instance}` | 供客服伺服器讀回設定，不能轉交前端 |
| `POST /message/sendText/{instance}` | 只發到已確認名單，最多 4000 字、每分鐘 20 次；無自動重發 |

手機斷線、登出或撤銷連結時停止發送，重新連線後需再確認測試發送，不自行刪除 auth。更換帳號、instance 或 callback 需獨立資料目錄及明確遷移，避免把舊來訊歸給另一個帳號。`bridge.lock` 只容許一個程序；異常退出先核對記錄 PID，不能自動刪鎖啟動第二個 worker。

## 驗證界線

`npm test` 在此目錄執行 13 項不連接外部帳號的協定及範圍保護測試；`npm run check` 檢查程式。它們驗證 callback、去重、名單、自身帳戶拒絕、持久 outbox、身份映射、斷線競態及不重發，不代表真實手機已掃碼或收到回覆。真正完成須由本人掃碼，並用另一個帳戶的指定測試號碼核對同一筆收發及 provider 回執。
