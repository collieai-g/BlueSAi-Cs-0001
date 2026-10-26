# Blueprint 整合套件 0.4.0-preview.1

單一卡片及宿主內容保護以 [AGENT_UI_CONTRACT.md](../../docs/AGENT_UI_CONTRACT.md) 為準。卡片只使用 `/api/agents/bluesai-cs-0001`；不得把客服整頁、全域 API 或資料表覆蓋到宿主的總覽、工作及資料。

`agent.json` 是符合 `blueprint-agent/1` 的可登記 manifest，保留產品顯示身份，宿主 ID 為 `bluesai-cs-0001`。它提供共用 standard 控制項的按需草稿操作。宿主 `1157aa49538b402e7a54996068e845c44abecb8f` 的公開合約已核對；登記不會安裝 Node 程式、啟動 WhatsApp 或產生原生收件匣工作區。

卡片只有一個 Agent／instance：精簡入口展開後顯示「收件匣／知識庫／管理」，日常對話優先；商戶設定、全域政策與渠道教學放在管理。`card-ui.json` 及 `sites/renderer-contract.json` 描述檢視、上下文抽屜與資產邊界，狀態仍待宿主整合。舊 basic／training／connect DOM ID 可作本機程式相容，不是舊導覽的安裝要求。

`package.json` 是機器可讀能力描述。`sites/renderer-contract.json` 明示完整管理介面需要的宿主擴充；本套件沒有把私人 Sites 適配或 D1/R2 身份發佈到公開來源。沒有這些實際能力時，preflight 會拒絕完整管理安裝，轉交宿主相容層開發。網站前端使用的 localhost 不是雲端服務。

執行 `npm run preflight -- --host /private/host-evidence.json --mode collaboration --source FULL_COMMIT`。此命令只讀檔案並輸出 JSON，不備份、不註冊、不寫入工作室。host 檔格式參考 `fixtures/host.json`，fixture 的合成身份及宣告不能當成正式站證據。設定 `--management` 會核對收件匣工作區的原生 renderer/API；`--mode whatsapp` 亦檢查獨立執行器、持久儲存、HTTPS 及渠道設定。`--mode web-chat` 檢查獨立服務、HTTPS 客人入口和明確開啟網頁客服；兩種渠道的真正客人收件需另外驗收。

`src/install.js` 提供共用安裝工作的持久階段、版本檢查、相同操作重跑、備份 scope/schema/checkpoint/私人副本收據驗證。它不會自己做第二份備份；宿主 D1 收據不涵蓋外部 SQLite。安裝器必須將實際宿主 receipt 接到同一 `operation_id`，並在每個階段保存證據。收據格式驗證不等於已讀取或還原備份。

`src/install-blueprint.js` 透過宿主已驗證的 `request` callback 登記、更新設定、讀回；必須另提供同一已驗證上下文的 `getTargetIdentity()` callback，回傳真正 `{target_id,role}`。每次修改前核對公司與 preflight 目標相符及管理員權限，不採用呼叫者自行提供的角色。期望設定獨立從原要求正規化，讀回不能只與寫入回應互相比較。client 不接收或輸出管理員秘密。相同來源／版本會重用原實例，CAS 衝突保留未保存內容。宿主合約沒有原地更改 manifest 的 API；已有不同套件版本時明確要求宿主升級流程，避免偷偷多建卡片。原生工作仍須由目前客戶端依 context → start → complete → get 執行。

在乾淨 commit 執行 `npm run package:release -- --output /private/release-directory`，產出 `release.json` 與 `source.tar`。完整來源 pin 與檔案 SHA-256 在生成物中；Git 內描述檔不寫自身 commit，避免循環。拒絕 dirty checkout 或倉庫內輸出。這是 preview 套件產物，沒有把 main 當作正式 Release。授權沿用根目錄 MIT LICENSE。
