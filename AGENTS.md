# BlueSAI-客服開發指引

項目名稱：BlueSAI-客服。Agent 編號：`BlueSAi-Cs-#0001`。更改身份資料時，同步 agent.json、介面及文件。

- 先讀 docs/HARNESS_ENGINEERING.md。產品以「本人＋左側 Codex／DOT＋右側客服卡片＋渠道後台」共同形成服務；以同一客服工作的要求、選定材料、版本、成果、核對與接續為開發單位，不以自研底層模型或照搬獨立客服平台取代此分工。
- 新功能先區分個人化、專業工作組合及核心能力擴充，重用現有工具與資料邊界。私有工作資料與可重用方法分開；工程回饋依 docs/FEEDBACK_LOOP.md、feedback/registry.json 及 feedback/harness.json，重用外置共用 runner；AI 行為評估仍待後續，既有必要測試與真實渠道驗收照常執行。原生 CLI 是獨立受限生成路線，不是喚醒或控制目前左側聊天、通用背景 DOT 或跨 AI 接續。
- 回覆路線分為 FAQ-only、本機原生 Codex CLI、選用模型 API。FAQ 優先不需要模型；aiFallback／automaticAi 預設 false，接駁成功不改政策。原生接駁必須由本人同意並通過真合成推理，沿用 CLI 的 ChatGPT 登入與額度，不搬移 auth、不另索 API key。登入可用、生成成功與真正客戶送達分開驗收。
- 原生 CLI 每次只給單一客戶有限資料及已批准知識，使用 ephemeral 獨立工作、固定 schema 與後台來源核對；即時回覆推理最多 25 秒，獨立背景教學／對話整理推理最多 60 秒、服務等候含清理最多 65 秒，不延長客戶回覆窗口或阻塞人工發送。關閉 shell、MCP、plugins、hooks、電腦及瀏覽器等工具。執行檔只接受伺服器可信設定，runtime 在 Git 之外；不能讓客戶文字選路徑、開工具、改政策或直接執行渠道動作。
- 產品是「AI → Agent 工作台」內的一個客服卡片項目。先讀 docs/AGENT_UI_CONTRACT.md 及 docs/BLUEPRINT_PLUGIN_DESIGN.md；精簡入口展開為同一實例的工作區，主要檢視是「收件匣／知識庫／管理」。對話優先；商戶設定、全域回覆政策及渠道教學放在管理，不再把收件匣藏於基本設定。保留舊 basic／training／connect 內部 ID 只作程式相容，不代表舊導覽仍為產品規格。
- 收件匣按可用卡片寬度呈現列表、對話及上下文：864px 預設採雙欄加上下文抽屜，內容寬達 1080px 才可三欄；手機以列表／詳情返回切換。新來訊、切換對話或檢視不得清空未送出文字。只呈現後台已有狀態，不加入假 CRM、分派、SLA 或結案功能。
- 禁止把客服整頁或「總覽／工作／AI／資料」外殼當成 Agent 介面。禁止覆蓋宿主導覽、總覽卡片、工作記錄、資料、全域路由及 CSS；只掛載客服根節點及受限資料域。
- 卡片前端只使用 /api/agents/bluesai-cs-0001 命名空間。不得把宿主整個 /api 代理到客服，不得共用或直接改寫宿主資料表；既有資料只經明確授權整合讀取。
- 卡片移動、縮放及每類固定最小／最大尺寸由宿主整合落實。文件中的整合規格不可寫成已可用功能；未授權不要直接修改測試工作室。
- 先讀 README.md、docs/INSTALL.md、docs/ARCHITECTURE.md。保留空白商戶設定，不加入虛構商戶政策或真實客戶資料。
- 本版是單商戶單程序 MVP；不要把它描述成已完成多租戶隔離或生產部署。
- 密鑰、.env、SQLite、日誌及備份在 Git 之外。不要印出秘密，不要將使用者憑證傳入模型。
- 公開來源及套件只含可重用程式、空白設定結構與合成測試材料；真實知識、對話、帳戶紀錄及 WhatsApp 來源／登入留在各工作室私人後台，不可硬編碼、commit 或隨套件搬移。新工作室使用新的空白核心／橋接資料目錄及獨立接駁；同一工作室升級才保留原資料。發佈前檢查固定 commit 的私人檔案／憑證閘門，不能只依賴 .gitignore。
- 人工接手、資料批准、發送開關、來源有效性及版本檢查必須在程式落實，不能只靠 prompt。
- 未明確授權實際發送時，不連接真實客戶渠道。測試使用暫存資料和模擬 provider。
- 使用者要求真實 WhatsApp 測試時，實作真實連結裝置／收件／回覆路線；本人掃碼及指定測試號碼不可省略。不能用離線規則、模擬 provider 或網頁扮演客人代替真實 WhatsApp 驗收。未完成項目列明缺項及可執行下一步。
- WhatsApp 自傳測試預設只讀，另列且不計入客戶待處理或外部驗收。本人可明確同意獨立「本人對話回覆測試」：只有當次帳戶綁定隨機 grant 之後的新自身文字，才可 exact-approved FAQ 自動回覆或專用人工回覆；自動 FAQ 另需 self automaticFaq 及全域 enabled／automaticKnowledge；不呼叫 CLI／API／DOT、不發待處理通知。人工提交原子切至 self_human；明確交回 self_auto 只作用下一筆新來訊。舊 Hello 不重跑；已發送 ID＋address 的回聲不論 fromMe 值都攔截，uncertain 自停不重送。重啟、斷線、換帳戶或撤銷關閉 grant，外部顧客授權不變。見 docs/SELF_REPLY_TEST.md。
- FAQ 必須唯一吻合且已確認、仍有效；AI answer 須有批准來源才可按獨立授權自動發送，clarify 先存草稿，退款／衝突／無依據／失敗／逾時轉人工。目前聊天的 DOT 工具仍只保存最新版本綁定草稿，不能因開啟編輯器就聲稱已處理或已發送。
- 人工對話學習只收錄一般渠道已成功提交的 staff 示範，保留實際角色及來源，使用有界去識別材料。AI 提議一律待本人核對，事實／處理流程／風格分開；procedure 不能充當到貨時間等事實來源。pending 分析不 revise、不取消人工發送，正式批准才改知識 revision。模型未接駁不能假裝已理解；自動整理與自動發送分開。詳見 docs/KNOWLEDGE_LEARNING.md。
- 修改後執行 npm test 及 npm run check。涉及介面時，用瀏覽器驗證主要操作和手機版面。
- 介面沿用 Blueprint Studio：先讀 docs/UI_DESIGN.md 及 UI_SOURCE.json。不要直接改 vendor CSS；客服樣式修改 design/customer-agent-card-design.html 後經建置產生，宿主只載入 agent-card.css 的根節點內樣式。public/style.css 僅供舊診斷頁，不能加入宿主卡片 bundle。升級共用樣式時同步來源版本、雜湊及 MIT 聲明。
- 所有對外狀態必須依實際結果：configured 不是 connected，accepted 不是 delivered，repository written 不是 deployed。
- 未獲使用者明確授權，不要更改 GitHub 倉庫可見性、覆寫他人提交或加入付費資源。

- 開發回饋以同一 canonical checkout 為準；運行實例來源只讀，通用改動回到本來源。案例 ID 不重建，私人綁定／證據在 Git 之外。執行 npm run feedback:audit，所有來源差異都須映射；100% 映射不代表已部署。
- 修改生成來源後執行 python tools/build-workbench.py；npm run check 會唯讀核對生成結果。宿主資產只由 tools/build-blueprint-card.py 產生，保留同一對話的開始人工回覆／交回知識庫／AI 語意，不維護第二份介面。
