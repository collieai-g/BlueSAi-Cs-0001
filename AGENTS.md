# BlueSAI-客服開發指引

項目名稱：BlueSAI-客服。Agent 編號：`BlueSAi-Cs-#0001`。更改身份資料時，同步 agent.json、介面及文件。

- 產品定位是藍圖工作室的內置客服 AI 插件。介面與卡片改動先讀 docs/BLUEPRINT_PLUGIN_DESIGN.md，沿用宿主原生設計；三個設定分頁保持在同一卡片內。
- 卡片移動、縮放及每類固定最小／最大尺寸由宿主整合落實。文件中的整合規格不可寫成已可用功能；未授權不要直接修改測試工作室。
- 先讀 README.md、docs/INSTALL.md、docs/ARCHITECTURE.md。保留空白商戶設定，不加入虛構商戶政策或真實客戶資料。
- 本版是單商戶單程序 MVP；不要把它描述成已完成多租戶隔離或生產部署。
- 密鑰、.env、SQLite、日誌及備份在 Git 之外。不要印出秘密，不要將使用者憑證傳入模型。
- 人工接手、資料批准、發送開關、來源有效性及版本檢查必須在程式落實，不能只靠 prompt。
- 未明確授權實際發送時，不連接真實客戶渠道。測試使用暫存資料和模擬 provider。
- 修改後執行 npm test 及 npm run check。涉及介面時，用瀏覽器驗證主要操作和手機版面。
- 介面沿用 Blueprint Studio：先讀 docs/UI_DESIGN.md 及 UI_SOURCE.json。不要直接改 vendor CSS；客服補充樣式放 public/style.css。升級共用樣式時同步來源版本、雜湊及 MIT 聲明。
- 所有對外狀態必須依實際結果：configured 不是 connected，accepted 不是 delivered，repository written 不是 deployed。
- 未獲使用者明確授權，不要更改 GitHub 倉庫可見性、覆寫他人提交或加入付費資源。
