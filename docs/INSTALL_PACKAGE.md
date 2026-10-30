# 版本化安裝套件與更新

單一卡片及宿主內容保護以 [AGENT_UI_CONTRACT.md](AGENT_UI_CONTRACT.md) 為準。卡片只使用 `/api/agents/bluesai-cs-0001`；不得把客服整頁、全域 API 或資料表覆蓋到宿主的總覽、工作及資料。

本版是 `0.4.0-preview.2` 預覽套件。產品顯示身份仍為 `BlueSAi-Cs-#0001`；宿主 manifest 的合法 ID 為 `bluesai-cs-0001`。公開套件位於 `integrations/blueprint/`，不包含私人工作室身份、商戶資料、憑證或備份。

## 新安裝與升級的資料契約

公開來源及 source.tar 只包含可重用程式、文件、去私人化設定範本及合成測試資料。商戶知識／學習資料庫、對話、帳戶記錄、WhatsApp 真實來源／登入、手機身份、部署設定、日誌及備份不得打包；正式安裝 evidence／journal 也留在私人目錄。

- **fresh：新工作室或新商戶。** 核對新目標的已驗證身份，以空白 manifest 商戶設定開始，另設未使用的倉庫外核心與橋接私人目錄、獨立 runtime／origin／instance、憑證及 callback。由本人重新連結該工作室的渠道，重新核對模型及明確授權；不複製舊 SQLite、知識匯出、帳戶紀錄、環境檔或 auth。卡片不能指向舊本機核心、共用預設目錄或另一工作室渠道。讀回資料空白及新 runtime 的正確綁定後才進行功能測試。
- **開發預覽：來源修正的隔離驗證。** 使用指定候選與 Git 外合成資料，不借用原工作室的資料、登入或渠道。預覽可驗證新版來源，但不能替代指定原工作室的更新及資料保留驗收；未提交來源不得偽造遠端 pin 進入正式登記。
- **upgrade：同一已驗證工作室。** 重用原入口、Agent ID、私人資料目錄及有效連線；本次已有升級工作才接續其 operation_id，新的來源／計劃另建升級工作。核對有效備份／還原後，使用固定新版及相容遷移，保留知識、對話、批准／撤銷、權限、設定、個人化與可恢復草稿。完整改版依[功能對應及保留契約](FEEDBACK_LOOP.md#固定產物更新同一實例)呈現新版，不凍結舊排版或清空資料重裝。重啟後的程序內 grant 按實際狀態及既有授權核對，未知結果不重送。

這是流程分流，不是目前 preflight 的新旗標或已完成的預覽協調器。新目標需自己的 operation_id／journal；同一目標重試才接續原工作。現有 client 處理宿主 Agent 登記、設定與已授權同 ID 套件升級，不會配置、隔離或搬移外部 runtime。缺少宿主 renderer、受限 API、目標綁定或獨立執行服務時仍為 requires_setup，不能因 manifest 已登記就聲稱工作室可用。完整操作見 [INSTALL.md](INSTALL.md#新工作室與同工作室升級)。

## 先選交付模式

| 模式／能力 | 本版軟件狀態 | 安裝現場仍需的證據 |
| --- | --- | --- |
| `collaboration` | `supported`：standard manifest、指定來源及目前客戶端的草稿流程 | 當前客戶端 context → start → complete → get；UI 同 ID 讀回 |
| `web-chat` | `requires_setup`：Node 客人會話、受限 API、共用客服核心、收件確認 | 明確開啟 `WEB_CHAT_ENABLED`、HTTPS 客人入口及實際客人收件 |
| `whatsapp` | `requires_setup`：Evolution 收件、草稿／人工、發送及回報流程 | 指定帳號、掃碼、已驗證 webhook、明確發送設定及實際收件 |
| 持續 AI | `requires_setup`：獨立服務執行，不依賴管理對話開著 | 可用模型、有效批准知識、持續程序與選定回覆模式 |
| 收件匣／知識庫／管理原生工作區 | `requires_setup`：已提供 renderer/API 規格及受限卡片資產邊界 | 宿主真正實作 `bluesai-management/1` 及 `bluesai-management-api/1` |
| Sites D1/R2 原生後台適配 | `unsupported`：本套件沒有通用可部署適配 | 先完成宿主相容層；不能把 Node SQLite 直接搬進 Workers |
| 原生本人送出、正式站和真實渠道驗收 | `not_verified`，逐次核對 | 當前工具、本人操作和同筆觀察結果 |

`supported` 只描述已提供的軟件能力；`requires_setup` 需要實際設定；`unsupported` 會阻擋不相容安裝；`not_verified` 不能當作已在目標環境成功。合成 fixture、GitHub 推送、卡片可見、provider 接受和客人收到分開記錄。

## 只讀 preflight

使用 Node.js 24.22+ 的 24.x，在倉庫根目錄執行：

```powershell
npm run preflight -- --host C:\Private\bluesai-host.json --mode collaboration --source FULL_40_CHARACTER_COMMIT
```

`FULL_40_CHARACTER_COMMIT` 必須換成已核對且實際包含套件 manifest 的完整來源 commit。不要使用 `main`。`--mode` 可選 `collaboration`、`web-chat` 或 `whatsapp`；加入 `--management` 會額外檢查收件匣工作區所需的原生 renderer/API。導覽及資產邊界見 `integrations/blueprint/card-ui.json`；basic／training／connect 舊內部 ID 不要求宿主沿用舊介面。

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

`src/install.js` 提供 `InstallJournal` API，由既有宿主安裝協調流程呼叫；本版沒有宣稱已接入所有宿主的安裝助手。在同一目標的同一安裝／重試中使用同一個 `operation_id`、目標及計劃摘要，不另建第二個工作；新工作室使用自己的安裝工作，不借用舊目標的 journal。journal 檔案須使用倉庫外的絕對 SQLite 路徑，其父目錄須已存在。

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

新目標首次登記只從明確提供的設定及 manifest 空白商戶預設開始，不讀取另一工作室或本機的知識／帳戶／渠道資料。首次登記後會 GET 同 ID，核對 manifest、來源及設定。期望設定獨立從原要求正規化並保留；不能只將讀回內容與 POST／PATCH 回應互相比較，避免伺服器忽略寫入卻誤報成功。重跑相同版本和來源沿用原 Agent，設定更新合併未指定欄位並用 CAS；不重新部署宿主。已有多個相同產品實例時停止要求核對。沒有明確升級參數而 manifest 版本或來源不同時，仍回報 `HOST_PACKAGE_UPGRADE_REQUIRED`，不能為更新偷偷新增第二張卡片。

### 已授權的同 ID 套件升級

原生宿主來源新增既有 `PATCH /api/studio/agents/{id}` 的套件升級分支；BlueSAI 透過以下顯式參數接駁。這是來源能力，須先確認指定宿主已支援並部署該合約；舊宿主或未適配 Sites 不因 client 更新而取得能力。下列變數由已授權的私人更新計劃提供：`selectedExistingAgentId` 是讀回的原 Agent ID，`savedOperationUpgradeKey` 是本次操作保存的固定 key，`sourceRevision` 是真實候選的完整 commit。不得每次重試另生 key，亦不得以虛構遠端 commit 登記未提交來源。

```js
const upgraded = await installer.ensure({
  source: {
    repository: 'https://github.com/collieai-g/BlueSAi-Cs-0001',
    revision: sourceRevision,
  },
  expected_agent_id: selectedExistingAgentId,
  upgrade_key: savedOperationUpgradeKey,
  settings: { reply_tone: 'formal' },
  inspection,
});
```

`expected_agent_id` 與 `upgrade_key` 必須同時提供；key 只接受 1–100 個英數字、底線或連字號。指定 Agent 不存在、與實際結果不同或同產品有多個實例時拒絕，不進入 POST 新建。宿主只接受同 manifest ID、同來源 repository 及完整固定 revision；同一來源 pin 不能換 manifest 內容。client 在 PATCH 回應與最後獨立 GET 都核對原 ID，不跟隨伺服器回傳的替代 ID。

升級 PATCH 同時提交 `manifest`、`source`、`upgrade_key`、當前 `expected_version` 及本次明確提供的部分 `settings`，不提交 `enabled`。宿主合併相容的舊設定並保留啟用狀態、連線及舊工作的固定快照；移除仍有保存值的設定、改共用欄位型別或合併後的值不再相容時拒絕，需另行設計遷移。可明確提供有效新值取代已移除的 select 選項；舊 optional 欄位從未保存值時可移除宣告。一般設定 PATCH 仍使用原本完整設定替換語意。

同一 Agent 與 key 的原子收據綁定正規化的 manifest、source 和明確設定；CAS `expected_version` 不屬操作內容。同內容重試可讀回原成功快照，key 改內容回報衝突；之後 client 再 GET 當前狀態，獨立核對同 ID、來源、manifest、合併設定與原控制狀態，歷史收據不代替目前成功。網絡結果不明會交回呼叫方，不自動重送；先核對同一實例，需要明確重試時沿用原 key 與內容。舊宿主拒絕／忽略升級欄位時失敗，不回退為新建。

此步只更新宿主的套件登錄，不下載或執行來源、不替換已部署的客服服務／資產，也不遷移個人化或保存頁面記憶體草稿。新版 UI 仍須完成[來源至實際載入的交付鏈](FEEDBACK_LOOP.md#元件來源與更新責任)；runtime、備份及草稿保護、模型與渠道驗收按 [UPDATE_AI.txt](../UPDATE_AI.txt) 分別完成。相容設定讀回不能代替以上驗收。

## 固定來源與生成 preview 發佈物

提交並保持 checkout 乾淨後，使用**新的、倉庫外絕對目錄**：

```powershell
npm run package:release -- --output C:\Private\bluesai-release-0.4.0-preview.2
```

產出 `source.tar` 及 `release.json`。後者保存完整來源 commit、套件版本、preview 標記、宿主合約參考、檔案 inventory SHA-256 及 tar SHA-256。雜湊以 Git commit 的實際 blob bytes 計算，不受 Windows 工作副本換行影響。已存在的輸出目錄、dirty checkout、倉庫內輸出或未經審閱的 symlink 會被拒絕。生成物不回寫到來源，因此沒有把自身 commit 寫回 manifest 的循環問題。

生成前亦逐檔檢查固定 commit 的路徑及 blob：即使私人環境檔、資料庫／日誌、手機 auth、管理員 token、備份或明確客戶／知識匯出曾被誤追蹤，也會阻擋套件建立；可識別的私鑰及 API key 格式同樣拒絕。空白 `.env.example` 可保留。這層檢查補充 `.gitignore`，仍須審閱變更，避免把商戶文字或其他私人資料寫進普通程式檔；不會讀取或打包倉庫外的實際私人後台。

安裝前核對 tar 雜湊、完整來源 pin、manifest 與 inventory；來源必須真正含有該 manifest。生成成功本身不證明測試成功；依相同 commit 的 CI 結果核對。CI 於 Windows／Ubuntu 執行 `npm test`、`npm run check`、固定 fixture preflight 及 commit 產物建置。原生 manifest 已經現有 Python validator 檢查；正式宿主與渠道仍要在現場驗收。

## 計劃落地與剩餘相容工作

| 計劃要求 | 本版交付／邊界 |
| --- | --- |
| P0 機器能力描述、三種模式、只讀 preflight | 已提供；渠道設定及真實驗收分開 |
| P0 可登記 manifest、固定來源與產物雜湊 | 已提供 standard 協作套件及生成工具；preview |
| P0 共用安裝工作、備份 coverage、CAS／冪等 | 已提供 journal／client primitives；宿主協調器須接入 |
| P0 去私人化 Sites 完整 UI／API 適配 | **未交付**通用可部署適配；僅提供 renderer/API 規格與明確阻擋 |
| P1 升級及跨重啟保留 | 客服增量 migration、journal migration、CAS；同 ID 套件升級 client 已接原生宿主 PATCH 合約並有合成測試，指定宿主部署／能力、runtime 及草稿保護仍須分別驗收 |
| P1 發佈前共用驗證 | 已提供 fixture、Windows 清理、CAS／備份／重跑／產物測試和 CI |
| P2 客人渠道垂直流程 | Node 網頁客服及 Evolution 共用核心；不等於已部署或真人收件 |
| 私人工作室部署及完整現場驗收 | 本套件不執行；按已授權目標另行核對 |

這份套件沒有把私人 Sites 安裝紀錄或相容程式當作所有人的公開來源。缺少宿主 renderer、受限 API、持久執行器或正式升級接口時，先交付該相容層，不能把安裝計劃整份標作已完成。完整 WhatsApp／網頁設定操作見 [INSTALL.md](INSTALL.md) 及卡片「管理」中的渠道狀態與接駁教學。
