# WhatsApp 連結診斷與二維碼顯示候選

案例：`bluesai-whatsapp-link-001`。來源基線固定於 `df37caad532300c4bdf2c03c3d0b371be4c7db27`；本目錄不含私人實例或帳戶證據。

原程式會將已登出與等待掃碼都導向重新取得二維碼，保留已失效圖片，並可能讓舊的異步編碼覆蓋新碼；515 重連也未計入五次上限。本候選保留固定錯誤類別、移除失效圖片、以 generation 核對編碼及限制自動重試。沒有更換 SDK、移除登入資料、改變收發授權或新增真實渠道。

`src/connections.js` 的新增診斷欄位只接受固定 allowlist 的 `lastReason` 及有界 `qrExpiresInMs`；本人要求取碼時仍透過原有受限接口取得真正 QR 圖片。登入失效應先由安裝人員核對，不反覆掃碼。單一狀態碼不能判定帳戶類型相容性或 provider 拒絕根因。

`public/workbench.js` 使用現有卡片節點清除原圖，真正取碼仍由本人按鍵。已驗證的本機 QR 剩餘時間只用於移除圖片，不自動連線；其他 provider 沒有有效期欄位時不猜期限。卡片腳本仍是原有資產，沒有加入宿主外殼或新全域路由。

使用 Node 24.22+（24.x）執行既有命令，不需為這些合成測試安裝依賴：

```sh
npm test
npm run check
```

新增核心狀態與最小 DOM 行為測試，並在既有 bridge 測試內加入 deferred QR encoder 及 fake timer。全部使用合成資料與獨立臨時目錄／loopback 端口；不連接 WhatsApp、不讀私人登入資料、不操作使用中的服務。

共用 runner 保留在工作區原位置，這裡只有薄案例 manifest，沒有複製另一套 engine。既有 runner 0.1 僅接受 Python argv；本次 Node 檢查由上列原有 npm scripts 執行，不宣稱已透過該 runner 執行。私人收據、日誌與實例綁定另存來源倉庫以外。

候選回歸、上游提交、正式發行、私人部署及真實手機驗收分開記錄。這份材料不能證明登入拒絕已解決；如需驗證真實手機，沿用原安裝與本人授權，由本人掃碼並另行核對收發。
