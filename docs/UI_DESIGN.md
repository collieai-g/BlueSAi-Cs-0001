# 客服工作台介面

版本：0.2.0，2026-10-24。

## 最新插件介面

BlueSAI-客服專為藍圖工作室的內置插件用途設計。最新入口是「AI → Agent 工作台」客服卡片；基本設定、訓練、接駁統一放在一張設定卡片內。詳細結構、原生縮放與移動、每種卡片固定最小／預設／最大尺寸、窄畫布例外及實作狀態，以 [BLUEPRINT_PLUGIN_DESIGN.md](BLUEPRINT_PLUGIN_DESIGN.md) 為準。

本機 3101 版使用工作室外殼預覽插件，目前未接入宿主排版引擎。其介面來源為 `design/customer-agent-card-design.html`，由 `tools/build-workbench.py` 產生 `public/workbench.*`；不可只改產出檔案。下面記錄原有 3100 服務的共用資產與介面，供兼容維護。

## 參考來源

採用 [Blueprint Studio Open Source v2.7.3](https://github.com/collieai-g/Blueprint-Studio-Open-Source/tree/ea20229b1bbdb5cb55f42456d4b962d66d6898e7) 的實際前端，固定於 commit `ea20229b1bbdb5cb55f42456d4b962d66d6898e7`。

原版 `library_web/style.css`、`library_web/studio.css`、`library_web/brand.svg` 及 MIT 授權完整保留；只統一為 UTF-8、LF 換行。對應檔案和 SHA-256 見 [UI_SOURCE.json](../UI_SOURCE.json)。圖示路徑參考原版 `library_web/app.js`。

## 共用外觀與客服內容

直接使用原版字體、色彩、方格背景、224px 側欄、68px 頂列、主列圖示、導覽按鈕、卡片和表單樣式。原版四項主列「總覽／工作／AI／資料」及左下角設定的位置相同。保留專用名稱 BlueSAI-客服 及完整編號 `BlueSAi-Cs-#0001`。

客服內容重新排列：總覽看待辦；工作處理對話；AI 設定指令與試聊；資料確認知識；設定控制回覆方式。這是客服用途的共用介面，不是把 Studio 的資產庫、看板拖放、工作流程及 AI 供應商設定搬過來。功能、內容與資料量不同，不能把共用樣式相同說成每一頁逐像素相同。

桌面核對共用元件的 computed styles，並以原版與客服版實際瀏覽器畫面作目視比較。手機再檢查內容可讀性、換行及操作；驗證範圍見 [VERIFICATION.md](VERIFICATION.md)。

## 簡單易明的規則

- 一頁一個主要工作，按鈕寫出結果，例如「確認採用」「我來接手」。
- 用短句解釋狀態：草稿尚未發送、試聊不發 WhatsApp、已設定不等於已連線。
- 空白就是未知；不預填商戶名稱、價錢、政策或示範對話。
- 總覽數字來自實際資料；沒有資料時顯示下一步。
- 從對話整理的知識預設待確認，不因新版面而改變批准或發送規則。
- 手機選單可用鍵盤操作；背景更新不清除未儲存的輸入。

## 後續維護

不要修改 `public/vendor/` 的原版 CSS。客服專屬排版放在 `public/style.css`；若要跟進 Studio 新版，明確更新固定 commit、複製檔案、更新來源雜湊及授權，再重新比對桌面和手機。瀏覽器不從 GitHub 即時載入樣式，因此上游更新不會突然改動現有安裝。
