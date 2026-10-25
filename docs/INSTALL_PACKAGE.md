# 版本化安裝套件與更新

單一卡片及宿主內容保護以 [AGENT_UI_CONTRACT.md](AGENT_UI_CONTRACT.md) 為準。卡片只使用 `/api/agents/bluesai-cs-0001`；不得把客服整頁、全域 API 或資料表覆蓋到宿主的總覽、工作及資料。

本版是 `0.3.0-preview.2` 預覽套件。產品顯示身份仍為 `BlueSAi-Cs-#0001`；宿主 manifest 的合法 ID 為 `bluesai-cs-0001`。公開套件位於 `integrations/blueprint/`，不包含私人工作室身份、商戶資料、憑證或備份。

## 先選交付模式

| 模式／能力 | 本版軟件狀態 | 安裝現場仍需的證據 |
| --- | --- | --- |
| `collaboration` | `supported`：standard manifest、指定來源及目前客戶端的草稿流程 | 當前客戶端 context → start → complete → get；UI 同 ID 讀回 |
| `web-chat` | `requires_setup`：Node 客人會話、受限 API、共用客服核心、收件確認 | 明確開啟 `WEB_CHAT_ENABLED`、HTTPS 客人入口及實際客人收件 |
| `whatsapp` | `requires_setup`：Evolution 收件、草稿／人工、發送及回報流程 | 指定帳號、掃碼、已驗證 webhook、明確發送設定及實際收件 |
| 持續 AI | `requires_setup`：獨立服務執行，不依賴管理對話開著 | 可用模型、有效批准知識、持續程序與選定回覆模式 |
| 完整宿主管理三分頁 | `requires_setup`：已提供 renderer/API 規格 | 宿主真正實作 `bluesai-management/1` 及 `bluesai-management-api/1` |
| Sites D1/R2 原生後台適配 | `unsupported`：本套件沒有通用可部署適配 | 先完成宿主相容層；不能把 Node SQLite 直接搬進 Workers |
| 原生本人送出、正式站和真實渠道驗收 | `not_verified`，逐次核對 | 當前工具、本人操作和同筆觀察結果 |

`supported` 只描述已提供的軟件能力；`requires_setup` 需要實際設定；`unsupported` 會阻擋不相容安裝；`not_verified` 不能當作已在目標環境成功。合成 fixture、GitHub 推送、卡片可見、provider 接受和客人收到分開記錄。

## 只讀 preflight

使用 Node.js 24.22+ 的 24.x，在倉庫根目錄執行：

```powershell
npm run preflight -- --host C:\Private\bluesai-host.json --mode collaboration --source FULL_40_CHARACTER_COMMIT
```

`FULL_40_CHARACTER_COMMIT` 必須換成已核對且實際包含套件 manifest 的完整來源 commit。不要使用 `main`。`--mode` 可選 `collaboration`、`web-chat` 或 `whatsapp`；加入 `--management` 會額外檢查完整三分頁的原生 renderer/API。

preflight 只讀指定檔案並輸出 JSON，沒有備份、登記、資料遷移或寫入工作室。退出碼 `0` 代表 `ready`，`2` 代表 `blocked` 或 `requires_setup`，`1` 代表參數或檔案無法讀取。輸出的 `plan_digest` 固定本次目標、模式、套件來源及資料保護範圍。

以下格式沿用 `integrations/blueprint/fixtures/host.json`。內容是**合成示例**；正式檔案須放在倉庫外，填入已從實際宿主與服務核對的資料，不填任何秘密。

```json
{
  "source": {
    "repository": "https://github.com/collieai-g/Blueprint-Studio-Open-Source",
    "revision": "1157aa49538b402e7a54996068e845c44abecb8f"
  },
  "platform": "native",
  "agent_contract": 1,
  "renderers": ["standard"],
  "apis": ["blueprint-agent/1"],
  "role": "owner",
  "target_id": "synthetic-company",
  "runtime": {
    "kind": "external-node",
    "node_version": "24.22.0",
    "persistent_storage": true,
    "public_https": false,
    "provider_configured": false,
    "webhook_configured": false,
    "delivery_enabled": false,
    "web_chat_enabled": false,
    "live_test_receipt": false
  },
  "required_data": [{
    "domain": "synthetic-sqlite",
    "schema": 2,
    "checkpoint": "fixture-before-upgrade",
    "coverage": ["database", "credentials", "pending_jobs", "merchant_settings"]
  }]
}
```

`platform` 為 `native`、`sites` 或 `standalone`。standalone 沒有宿主 Agent 登記需求。渠道模式要求 `external-node` 或 `standalone-node`，不能用 `workers-d1` 冒充 Node。`runtime` 的布林值是所提供證據的摘要；preflight 不會連線驗證供應商，也不會因為值為 true 就產生真實收件證據。`model_configured` 可另行保存，但模型不是人工回覆的必要條件。

## 共用 operation_id、備份與接續

`src/install.js` 提供 `InstallJournal` API，由既有宿主安裝協調流程呼叫；本版沒有宣稱已接入所有宿主的安裝助手。使用同一個 `operation_id`、目標及計劃摘要，不另建第二個安裝工作。journal 檔案須使用倉庫外的絕對 SQLite 路徑，其父目錄須已存在。

```js
import { InstallJournal, preflight } from './src/install.js';

const inspection = preflight({ host, mode: 'collaboration', sourceRevision });
const journal = new InstallJournal(privateJournalAbsolutePath);
try {
  let job = journal.begin({
    operation_id: hostOperationId, preflight: inspection, role: actualHostRole,
  });
  job = journal.advance({
    operation_id: job.operation_id, expected_version: job.version,
    phase: 'plan', evidence: { host_plan_id: hostPlanId }, role: actualHostRole,
  });
  // 繼續前，先從宿主取得涵蓋所有 required_data 的真實備份收據。
  job = journal.advance({
    operation_id: job.operation_id, expected_version: job.version,
    phase: 'backup_gate', evidence: { backup_receipts: receipts },
    role: actualHostRole,
  });
} finally { journal.close(); }
```

以上變數由既有安裝協調器提供；`actualHostRole` 來自已驗證的宿主身份，不能使用瀏覽器自行宣稱的角色。`begin` 只接受 `ready` 的 preflight。同一操作 ID／計劃重跑返回原工作；同一目標及相同計劃即使用另一操作 ID 也重用原工作。相同操作 ID 換計劃、舊版本寫入或跳階段會被拒絕。

正常階段依序為 `preflight → plan → backup_gate → apply → register_or_update → verify → complete`。每次修改使用剛讀回的 `expected_version`。需要本人操作時先轉 `waiting_user`，以 `get(operationId)` 讀回原工作；回到記錄的 `resume_phase` 後才繼續。`complete` 要求 `evidence.verified: true`；協調器須先完成真正的正式 API／UI 讀回，journal 本身不代做驗收。

每個備份 receipt 包含 `receipt_id`、`domain`、`schema`、`checkpoint`、`coverage`、`readable_private_copy: true` 和 `restore_verified: true`，須與該項 `required_data` 一致。宿主已完成且涵蓋相同資料域的有效收據可以重用，不用再備份、下載或排版匯出。D1 收據不能涵蓋外部 SQLite。`validateBackupCoverage(requiredData, receipts)` 只核對收據欄位；可讀副本及還原結果須由負責備份的宿主提供真實證據。journal 拒絕含 token、password、secret、API key 等欄位的 evidence。

## 登記與設定 API

`integrations/blueprint/agent.json` 可交給 `blueprint-agent/1` 正式登記接口。`src/install-blueprint.js` 另提供可重用的登記／設定／讀回 client：

```js
import { createBlueprintInstaller } from './src/install-blueprint.js';

const installer = createBlueprintInstaller({
  request: authenticatedHostRequest,
  getTargetIdentity: readAuthenticatedHostIdentity,
});
const receipt = await installer.ensure({
  source: {
    repository: 'https://github.com/collieai-g/BlueSAi-Cs-0001',
    revision: sourceRevision,
  },
  settings: { merchant_name: '', reply_tone: 'friendly' },
  inspection,
});
```

`authenticatedHostRequest(method, path, body?)` 是現有受信任宿主 client，回傳解析後的 JSON。`readAuthenticatedHostIdentity()` 必須從同一已驗證宿主身份取得 `{target_id, role}`，不能回傳使用者輸入或 preflight 檔案自行宣稱的身份。client 在任何修改前重新核對目標與 `inspection.plan.target_id` 相同、角色為 owner／admin；讀回前亦再次檢查。傳入 `ensure` 的角色字串不構成授權。兩個 callback 必須沿用同一真正登入、公司範圍、同源／請求驗證及正式 API 權限；不要把 owner token 注入前端或關閉伺服器驗證。client 只使用 `/api/studio/agents` 的分頁 GET／POST、單筆 GET 及帶 `expected_version` 的 PATCH。

首次登記後會 GET 同 ID，核對 manifest、來源及設定。期望設定獨立從原要求正規化並保留；不能只將讀回內容與 POST／PATCH 回應互相比較，避免伺服器忽略寫入卻誤報成功。重跑相同版本和來源沿用原 Agent，設定更新合併未指定欄位並用 CAS；不重新部署宿主。已有多個相同產品實例時停止要求核對。若已安裝的 manifest 版本或來源不同，回報 `HOST_PACKAGE_UPGRADE_REQUIRED`：目前公開宿主合約沒有原地替換 manifest 的 API，不能為更新偷偷新增第二張卡片。需要由宿主提供經審閱的升級流程，並保留歷史工作的固定快照。

## 固定來源與生成 preview 發佈物

提交並保持 checkout 乾淨後，使用**新的、倉庫外絕對目錄**：

```powershell
npm run package:release -- --output C:\Private\bluesai-release-0.3.0-preview.2
```

產出 `source.tar` 及 `release.json`。後者保存完整來源 commit、套件版本、preview 標記、宿主合約參考、檔案 inventory SHA-256 及 tar SHA-256。雜湊以 Git commit 的實際 blob bytes 計算，不受 Windows 工作副本換行影響。已存在的輸出目錄、dirty checkout、倉庫內輸出或未經審閱的 symlink 會被拒絕。生成物不回寫到來源，因此沒有把自身 commit 寫回 manifest 的循環問題。

安裝前核對 tar 雜湊、完整來源 pin、manifest 與 inventory；來源必須真正含有該 manifest。生成成功本身不證明測試成功；依相同 commit 的 CI 結果核對。CI 於 Windows／Ubuntu 執行 `npm test`、`npm run check`、固定 fixture preflight 及 commit 產物建置。原生 manifest 已經現有 Python validator 檢查；正式宿主與渠道仍要在現場驗收。

## 計劃落地與剩餘相容工作

| 計劃要求 | 本版交付／邊界 |
| --- | --- |
| P0 機器能力描述、三種模式、只讀 preflight | 已提供；渠道設定及真實驗收分開 |
| P0 可登記 manifest、固定來源與產物雜湊 | 已提供 standard 協作套件及生成工具；preview |
| P0 共用安裝工作、備份 coverage、CAS／冪等 | 已提供 journal／client primitives；宿主協調器須接入 |
| P0 去私人化 Sites 完整 UI／API 適配 | **未交付**通用可部署適配；僅提供 renderer/API 規格與明確阻擋 |
| P1 升級及跨重啟保留 | 客服增量 migration、journal migration、CAS 與重啟測試；宿主 manifest 原地升級仍缺正式接口 |
| P1 發佈前共用驗證 | 已提供 fixture、Windows 清理、CAS／備份／重跑／產物測試和 CI |
| P2 客人渠道垂直流程 | Node 網頁客服及 Evolution 共用核心；不等於已部署或真人收件 |
| 私人工作室部署及完整現場驗收 | 本套件不執行；按已授權目標另行核對 |

這份套件沒有把私人 Sites 安裝紀錄或相容程式當作所有人的公開來源。缺少宿主 renderer、受限 API、持久執行器或正式升級接口時，先交付該相容層，不能把安裝計劃整份標作已完成。完整 WhatsApp／網頁設定操作見 [INSTALL.md](INSTALL.md) 及工作台「接駁」教學。
