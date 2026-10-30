# 原生受管更新

`0.4.0-preview.2` 加入 `bluesai-node` 執行器 adapter，供 Blueprint 原生安裝器管理獨立客服核心。這是公開來源及合成測試能力，沒有更新任何現有工作室或接駁真實渠道。一般 `npm start`、本機預覽及手動安裝仍沿用原入口。

## 元件與資料界線

`managed-component.json` 宣告 `bluesai-cs-0001`、adapter、套件版本、核心資料 schema 7，以及宿主 manifest `integrations/blueprint/agent.json`。安裝器核對簽章、來源、完整檔案清單及依賴後，才用自己已信任的 Node 執行 `src/managed-runtime.js`。套件不能指定任意命令、下載執行檔或修改私人啟動設定。需要 Node `>=24.22.0 <25`。

每個客戶使用獨立程序、Agent ID、核心資料目錄、憑證、備份及復原狀態；五個客戶是五份私人實例。`service.sqlite`、`admin-token`、`managed-owner.json` 及其他私人檔案留在來源倉庫以外。已有 SQLite 必須明確 `existing_data:true` 才能首次納管；Agent ID 不符、核心 schema 不是 7、非空白的新資料目錄、來源路徑、符號連結及已持有的 `service.lock` 均停止啟動，不重設資料或自動移除鎖。

核心與 WhatsApp 本機橋接是分開的元件。本 adapter 不啟停或升級橋接、搬移手機登入、修改橋接資料，亦不自動恢復收件／發送或原生模型授權。支援重試的既有橋接會把核心的 503 留在自己的持久 callback outbox，之後重試；其他來源須先明確暫停，不能宣稱未收到的輸入已保存。`ingress_policy` 只記錄安裝時選定的安排，並不替外部來源增加重試能力。

## 私人啟動設定

安裝器提供倉庫外 JSON，執行：

```text
<trusted-node> src/managed-runtime.js --config <absolute-private-config.json>
```

必要欄位為 `contract_version:1`、`component_id:"bluesai-cs-0001"`、`expected_agent_id`、絕對 `data_dir`、`host:"127.0.0.1"` 及獨立 `port`。`initialize:true` 只供新的空白核心目錄；既有實例保留原目錄及 admin-token。

選用欄位：`existing_data`、`web_chat_enabled`、`ingress_policy`（`manual_pause` 或 `retry_503`）、`native_codex_executable`、`webhook_secret_file`、`model_config`（`model`、`api_key_file`）及 `provider_config`（`url`、`instance`、`api_key_file`、`delivery_enabled`）。未宣告的欄位一律拒絕。秘密檔必須在該核心資料目錄內，內容由本機讀取；不要貼到聊天、提交 Git 或寫入發行 manifest。受管入口不讀 `.env`，不沿用其他程序的模型／渠道秘密，也不自動啟動原生推理。

安裝器每次啟動提供新的 `BLUEPRINT_MODULE_TOKEN`（32 至 256 字元）與固定產物的 `BLUEPRINT_MODULE_RELEASE_ID`（64 位小寫十六進位）。控制 token 不寫入資料庫、回覆或日誌。秘密檔及可信執行檔是安裝者的私人設定，不由下載的 manifest 選擇。

## 暫停、切換及恢復

程序完成私人資料初始化後，必定先處於 `ready:true, paused:true`。只有本機 `GET /api/managed/internal` 與 JSON POST 的控制路線可用；其餘路線回覆 `503 MANAGED_UPDATE_PAUSED` 及 `Retry-After:3`，不寫入新來訊。控制請求須有 `X-Blueprint-Installer` token，帶 `Origin`、遠端來源或錯誤 token 回覆 404。

狀態提供 `pid`、`release_id`、`version`、`node_version`、`data_schema`／`database_schema:7`、`managed_schema:1`、`expected_agent_id`、`ready`、`busy`、`paused`、`active_requests`、`ingress_policy` 及 `bridge_managed:false`，不含商戶資料或秘密。PID 和版本來自實際子程序。

POST 只接受一個 `action`：

- `quiesce`：立即關閉新 HTTP／Engine 工作的入口，暫停背景學習並關閉 SSE；既有生成、發送、學習及已進入的 HTTP handler 繼續完成。瀏覽器斷線不會提早釋放仍在寫入的 handler。
- `resume`：恢復入口和排程，保留現有人工控制、渠道範圍及授權檢查。不得把 resume 當作重新授權。
- `shutdown`：只在已暫停且 `busy:false` 時接受，否則 409；正常關閉核心、checkpoint SQLite 並釋放自己的鎖。控制請求可繼續輪詢，不會被業務排空阻塞。

安裝器先暫停、輪詢至閒置，再關閉舊程序，離線保護完整核心資料。等待上限應至少涵蓋 65 秒的背景學習與清理；受管關閉使用 70 秒排空期限。逾時保留暫停狀態並回報，不能硬殺後宣稱安全備份。備份與隔離還原由宿主安裝器負責；本來源沒有獨立完整備份 CLI。

新程序啟動後仍暫停。宿主須用固定來源與 manifest 完成同 ID 的 package PATCH，GET 讀回 Agent ID、版本及來源，再檢查實際子程序狀態，最後才 resume。任一步失敗按安裝器的資料保護及復原流程處理，不能新增第二張卡片或以 metadata 成功代替 runtime 切換。

## 未完成工作與版本證據

受管 Engine 在首次開始生成時，把 runtime 版本／release ID、隨產物固定的 prompt 來源、政策摘要、模型 provider／已知 model、知識 revision 和知識雜湊寫入 `managed_job_versions`。它是獨立 `managed_schema:1` 的附加審計表；既有 `schema_migrations` 仍為 7，不更改舊 jobs／messages 欄位或歷史。

已開始但中斷的工作若屬於另一個 release，或已知模型、政策及知識與原快照不同，不默默重跑，轉交人工核對。尚未開始的 pending 工作在真正開始時綁定當前版本；在途生成先排空。既有草稿與佇列仍保留原內容、來源及版本，發送前繼續核對資料、知識、人工狀態、發送政策與渠道窗口。不明發送結果保持 `uncertain`，不自動重送。未知的模型版本保持空值，不宣稱已固定供應商內部模型或已啟用 API。

`test/managed-runtime.test.js` 用模擬 provider 和臨時資料驗證控制認證、斷線 HTTP 排空、在途生成、版本記錄、重啟資料、uncertain 不重送、授權不恢復、五實例隔離，以及真正 CLI 程序的 PID／正常關閉。這些結果不等於真實客服送達或現有工作室部署驗收。
