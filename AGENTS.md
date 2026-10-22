# BlueSAI-客服開發指引

項目名稱：BlueSAI-客服。Agent 編號：`BlueSAi-Cs-#0001`。更改身份資料時，同步 agent.json、介面及文件。

- 先讀 README.md、docs/INSTALL.md、docs/ARCHITECTURE.md。保留空白商戶設定，不加入虛構商戶政策或真實客戶資料。
- 本版是單商戶單程序 MVP；不要把它描述成已完成多租戶隔離或生產部署。
- 密鑰、.env、SQLite、日誌及備份在 Git 之外。不要印出秘密，不要將使用者憑證傳入模型。
- 人工接手、資料批准、發送開關、來源有效性及版本檢查必須在程式落實，不能只靠 prompt。
- 未明確授權實際發送時，不連接真實客戶渠道。測試使用暫存資料和模擬 provider。
- 修改後執行 npm test 及 npm run check。涉及介面時，用瀏覽器驗證主要操作和手機版面。
- 所有對外狀態必須依實際結果：configured 不是 connected，accepted 不是 delivered，repository written 不是 deployed。
- 未獲使用者明確授權，不要更改 GitHub 倉庫可見性、覆寫他人提交或加入付費資源。
