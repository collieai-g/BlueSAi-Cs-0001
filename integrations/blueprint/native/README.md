# 原生卡片產生邊界

卡片按鈕、文案、知識庫與對話操作只在 BlueSAI 原始設計及 HTTP client 維護。
此目錄只保留宿主所需的生命週期、身份／寫入保護及尺寸外框；不是第二份客服介面。
模板取自已審閱的 Blueprint 原生 adapter 修訂
`770ea2e5076f32466d4d4be9e7f6c1a2899f8477`，沿用 MIT 授權。
宿主後台 adapter、私有 binding、資料庫、登入及服務部署仍由 Blueprint 安裝流程管理。

1. 修改 `design/customer-agent-card-design.html`，執行 `python tools/build-workbench.py`。
2. 執行 `python tools/build-workbench.py --check` 核對五個產出檔。
3. 執行 `python tools/build-blueprint-card.py --source-revision <完整 commit> --output-dir <Git 以外的獨立空目錄>`，準備六個宿主資產與 `PROVENANCE.json`。
4. 同一命令加 `--check` 只核對差異，不覆寫檔案。宿主部署前另核對 adapter 合約、完整 commit、輸入／產出雜湊及私有 instance。

產生器拒絕 Git checkout、連結／junction 及不屬於自己的非空目錄。它不安裝卡片、不重啟服務、不改資料或私有 binding。
傳入的完整 commit 是宿主來源 pin；所有實際讀取的來源、設計與檢查資產、三份宿主模板及兩份產生程式都與該 commit 相同，`source_revision_verified` 才會是 `true`。比對與雜湊一律使用 UTF-8／LF 正規化，`source_inputs` 列明全部輸入；只改模板或產生程式亦不可沿用舊 commit 的已核對標記。
尚未提交的候選仍可產生供審閱的包，但會明確標為 working-tree candidate，以輸入雜湊作實際依據，不能當已發佈／已部署。

| 單一來源 | 產出 | 固定轉換 |
| --- | --- | --- |
| `public/agent-card.html` | `renderer.js` 的 `COMPONENT_TREE` | 建置時解析為 createElement 資料；不在瀏覽器注入 HTML |
| `public/agent-card.css` | `agent-card.css` | 加上 `host-bounds.css` 外框，不加入獨立頁面 CSS |
| `public/workbench.js` | `workbench.js` | 顯式初始化、受限 scope、關閉 SSE、移除設計用 Tweak 控件 |
| `public/workbench-api.js` | `workbench-api.js` | 原有 endpoint methods 原文保留；改由宿主身份、CSRF 及活動卡片保護 |
| `public/agent-handoff.js` | `agent-handoff.js` | IIFE 轉成顯式 scope 初始化 |
| `public/inbox-tools.js` | `inbox-tools.js` | IIFE 轉成顯式 scope 初始化 |

所有轉換先核對唯一錨點；來源結構改變時停止並要求審閱，不以猜測替換繼續。
對話仍是同一筆記錄：`開始人工回覆` 暫停自動處理，`交回知識庫`／`交回知識庫／AI`／`交回 AI` 依已儲存政策及模型狀態顯示。
產生器不變更這些互動或後台接手／恢復語意。

## 單一卡片掛載

宿主須提供 `BlueprintAgents.registerCardRenderer(id, renderer)`、`blueprint:agents-ready` 事件及 `context.cardTarget` 專用容器。renderer 在載入時或宿主就緒時登記；只有宿主明確載入的經審閱模組可執行，不從 manifest 下載腳本。宿主的靜態入口負責載入產生的 `renderer.js` 及 `agent-card.css`；產生檔案或登記 metadata 本身不會安裝入口。

宿主以單一穩定外框承載客服與收合的「進階 Agent 設定與工作」，由 `renderer.layoutSpec()` 取得入口／展開尺寸。客服只把同一元件掛入 `context.cardTarget`，不在整頁尋找通用設定表單作插入位置；舊宿主缺少接口時明確報錯並保留通用設定。這避免通用工作按鈕、設定及客服內容被排版引擎拆成多張卡片。來源套件、宿主靜態入口、固定版本與真正畫面仍須分開驗證。
