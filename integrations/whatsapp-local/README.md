# 本機真實 WhatsApp 連結裝置接駁

這個獨立 Node 子套件讓客服卡片取得 WhatsApp 真正提供的二維碼，經本人手機掃碼後收發指定測試號碼的文字。亦可經明確同意啟用所有新私人文字的收件箱，再獨立授權只回覆最近來訊的客戶。它不需要 Docker、PostgreSQL、Redis 或另購主機，不會把客服介面寫到工作室的總覽／工作／資料。

採用維護者發布的 `@whiskeysockets/baileys@7.0.0-rc14`、`qrcode@1.5.4`，固定於 `package-lock.json`。Baileys 是**非 Meta 官方的連結裝置程式庫**；請先用專用測試帳號，遵守 WhatsApp 條款。這是單使用者本機預覽，不宣稱企業帳戶或正式營運驗證。[維護者說明](https://github.com/WhiskeySockets/Baileys) · [QR 認證文件](https://github.com/WhiskeySockets/docs/blob/main/authentication/qr-code.mdx)

## 私人安裝與啟動

1. 準備 Node 24.22+（24.x）。把此子套件的程式及 lockfile 複製到倉庫外的私人 runtime 目錄，例如 `~/.bluesai-whatsapp-local/runtime`；授權及訊息資料放另一個 `~/.bluesai-whatsapp-local/state`。Windows 要限制兩者上層資料夾 ACL 只有本人；不要把 WhatsApp auth、SQLite、api key 或 `.env` 提交 Git。
2. 在 runtime 執行 `npm ci --ignore-scripts --omit=optional --no-fund`。這是純文字路線，毋須影像／音訊 peer 的安裝腳本。此版已在隔離 Node 24 Windows 匯入真實 Baileys 與 QR encoder；npm audit 無已知漏洞不等於帳號連接已驗證。
3. 依 `.env.example` 在私人設定填 `WA_LOCAL_DATA_DIR`、固定 instance、callback URL 和至少 32 字元的 webhook secret。客服服務的 `EVOLUTION_URL` 使用 `http://127.0.0.1:3105`、`EVOLUTION_INSTANCE` 使用相同名稱，`EVOLUTION_API_KEY` 使用私人 `bridge-api-key`；兩端共用 webhook secret。金鑰經安全設定入口處理，不貼到聊天或命令參數。
4. 用 `node --env-file=私人設定檔 start.js` 啟動。只監聽 `127.0.0.1`；啟動不會自動登入 WhatsApp。先到客服卡片的「接駁 WhatsApp」，按「取得二維碼」才開始真實 provider 連線。
5. 本人用手機 WhatsApp 的「已連結裝置 → 連結裝置」掃碼，回卡片檢查連線、登記／讀回收件設定。最後在卡片填含國家／地區碼的另一個帳戶測試號碼並明確確認，才可開始該次測試。剛連結帳戶的自身號碼會被拒絕：自己傳給自己的訊息不是客戶來訊。暫時沒有另一個帳戶時，可以保留手機連結，稍後才測試收發。模型金鑰不是手機連線或人工回覆的前置條件。

## 測試範圍與發送

預設 `test` 模式下，空白名單只取得 QR／連線狀態，**不轉送任何客人訊息，也不發送**。名單最多三個完整國際電話號碼；只向 WhatsApp 查詢這些已同意測試號碼的 LID 映射，群組、廣播及無法確認身份的 LID 忽略。已知發送 ID 的回執依發送前保存的電話識別。歷史同步保持關閉。SDK 的新訊息可能是 `notify`、離線排隊後剛送到的 `append`，或附 `requestId` 的解密重取內容；三者均須通過同一帳戶、私人身份、有效收件授權及新近時間核對，不再單憑事件名稱略過真正新文字。缺時間、超過五分鐘、異常未來時間及早於收件同意的內容不轉送；秒級時間戳容許與同意操作同一秒的新來訊。

橋接和客服 Engine 各有獨立發送開關。橋接啟動預設關閉；卡片的明確測試確認可在 `WA_LOCAL_ALLOW_TEST_ACTIVATION=true`、手機真正 open、webhook 已設定及名單非空時，開啟一次程序內的測試發送。重啟不保留這個動態發送授權。來訊只供指定名單，回覆仍經客服草稿批准或人工操作；沒有模型時不把離線示範自動發到 WhatsApp。

`accepted` 只表示 WhatsApp socket 返回訊息 ID。實際回執才更新 delivered／read。發送失敗、逾時或未知結果不自動重發，先到手機核對。callback 事件先寫私人 SQLite outbox，失敗按原事件 ID 重試，客服端去重；這只保證本程序已觀察事件的持久排隊，不能補回 WhatsApp 根本未交付的事件。

真正訊息 ID 另作持久去重，避免初次通知及稍後 SDK 重取同一筆內容在 callback 成功後再轉送。只解開 `ephemeralMessage` 內的純文字／extended text，不解開 view-once、媒體、編輯或其他不支援內容；不下載通訊錄或舊對話。

SDK 亦使用 `@hosted`／`@hosted.lid` 私人地址；原始節點篩選只讓其合法私人形狀交給 SDK 正規化，最終仍須得到明確可信的電話身份才轉送，不能改字尾猜電話。群組、廣播、newsletter 及 bot 地址仍被排除。

## 所有新私人文字的收件箱

已登入的客服卡片可在手機真正 `open`、webhook 已核對後，向 `PUT /instance/inboxScope/{instance}` 提交 `{mode:"all_private_text",consent:true}`。這是另一個明確的收件範圍；**接收不會開啟發送**，原有測試名單亦不會自動擴大。此收件同意綁定當時已核對的手機帳戶，只記錄在私人 SQLite，API 不返回帳戶身份。同帳戶重啟可保留同意，但排隊內文須等手機真正重新連接並再次核對同一身份才轉送；換成另一個或無法確認的帳戶時，撤銷廣泛收件、關閉發送並清除其排隊內文，不沿用舊帳戶同意。同帳戶重新核對原有廣泛收件或回覆授權時，核對期間暫停 callback 及發送，驗證成功後保留仍未轉送的內文與原有收件同意時間；失敗、撤銷或換帳戶才清除。改回 `{mode:"test",consent:true}` 即撤銷。無效或未同意的範圍變更亦先關閉廣泛收件及發送，再回報錯誤。

只接收開啟後觀察到的新一對一純文字，最多 4000 字；不讀取歷史、群組、廣播、自己傳給自己的訊息、圖片、語音或其他媒體。若你在手機向最近已來訊的客戶人工回覆，該筆新文字會以 `outgoing` 交給核心接手，避免知識庫繼續搶答；已知機器發送 ID 的回聲不會誤觸人工接手，對未曾來訊對象發出的手機訊息不會轉送。電話身份只來自真正 PN／明確 `remoteJidAlt`，或 SDK 對該筆新事件 LID 的實際映射；不列舉通訊錄、不把 LID 數字當成電話。撤銷時清除依廣泛收件授權排隊的內文（包括手機人工回覆）；已開始傳送的 callback 無法保證收回。callback 每次最多處理 25 筆，避免爆量時每則多等待一秒。

如要從卡片人工回覆或由已批准知識自動回覆，再獨立提交 `{mode:"all_private_text",replyToReceived:true,consent:true}`。此授權只准回覆**同一已連結帳戶曾實際觀察到、最近 24 小時內有新私人來訊的客戶**；不准主動傳給未曾來訊或自己的號碼。接收紀錄包含私人帳戶身份，換帳戶不沿用舊帳戶的收件證據。這個程序內發送授權在重啟、斷線、變更收件範圍或變更測試名單時關閉，不能單靠持久收件同意重新開啟。選擇「只開放指定測試號碼」會先撤銷廣泛收件、清除其排隊內文及關閉兩個發送閘門，再核對測試號碼；即使該次號碼或同意核對失敗，也不繼續保留廣泛收件。明確測試名單仍保留自己的獨立授權路線。

收件箱回應的 `replyToReceived`／`deliveryEnabled` 只表示上述最近來訊回覆授權，`testMode.deliveryEnabled` 則只表示測試名單授權。兩者不能互相代替；客服核心仍須另有自己的發送閘門及版本／來源核對。實際送達／已讀回執按已知發送 ID 及電話配對，即使不在測試名單亦能核對已授權的收件箱回覆。

## 受限服務接口

所有 instance／webhook／send API 都需要伺服器端 `apikey`，不提供瀏覽器 CORS；主客服服務代為呼叫。

| 路由 | 結果 |
| --- | --- |
| `GET /healthz` | 不含身份資料的本機存活檢查 |
| `GET /instance/connect/{instance}` | 啟動真正 socket，回傳目前 provider QR；未有 QR 就不生成假圖 |
| `GET /instance/connectionState/{instance}` | 真實狀態、測試名單數量、遮罩末四碼、callback 排隊數 |
| `GET /instance/inboxScope/{instance}` | 收件模式、支援／排除範圍、`replyToReceived` 及最近來訊回覆閘門；不返回電話或秘密 |
| `PUT /instance/inboxScope/{instance}` | `{mode:"test"\|"all_private_text",consent:true,replyToReceived?:boolean}`；明確收件／回覆授權分開，每次變更先關閉發送 |
| `GET /instance/testRecipients/{instance}` | `{count,maskedNumbers,deliveryEnabled,activationAvailable,mappingState}` |
| `PUT /instance/testRecipients/{instance}` | `{numbers:["含地區碼的數字"],consent:true,activateSending:true}`；先驗證整組前置條件才套用 |
| `POST /webhook/set/{instance}` | 只接受私人環境預先指定的 loopback callback 及 secret，禁止任意轉送目的地 |
| `GET /webhook/find/{instance}` | 供客服伺服器讀回設定，不能轉交前端 |
| `POST /message/sendText/{instance}` | 只發到已確認測試名單，或獨立授權的最近私人來訊客戶；最多 4000 字、每分鐘 20 次，無自動重發 |

手機斷線、登出或撤銷連結時停止發送，重新連線後需再確認測試發送，不自行刪除 auth。更換帳號、instance 或 callback 需獨立資料目錄及明確遷移，避免把舊來訊歸給另一個帳號。`bridge.lock` 只容許一個程序；異常退出先核對記錄 PID，不能自動刪鎖啟動第二個 worker。

## 不含客戶內容的收件診斷

連線狀態提供程序內 `receiveDiagnostics`，重啟重新計數：upsert 的 notify／append／其他／requestId 數量及最近時間、固定拒絕原因、已排隊來訊／人工回覆／重複數量，以及 callback 成功／失敗數量與時間。拒絕原因只用固定類別，例如時間無效、非文字、身份未能對應、超出範圍及自身訊息；不保留或回傳文字、ID、姓名、電話、JID、QR、金鑰或原始錯誤。這可以分辨「SDK 尚未交出事件」、「事件被哪一類檢查拒絕」及「已排隊但 callback 失敗」，不把 `open` 當成已收到訊息。

## 驗證界線

`npm test` 在此目錄執行不連接外部帳號的協定及範圍保護測試；`npm run check` 檢查程式。它們驗證 callback、去重、名單、自身帳戶拒絕、持久 outbox、身份映射、獨立收件／回覆授權、帳戶與 24 小時範圍、斷線競態及不重發，不代表真實手機已掃碼或收到回覆。真正完成須由本人掃碼，並用另一個帳戶核對同一筆收發及 provider 回執。
