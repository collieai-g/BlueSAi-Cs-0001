# 本人 WhatsApp 對話回覆測試

版本：0.4.0-preview.1，2026-10-26。這份文件定義新版設計、操作及驗收界線，**不代表真正回覆已發送或手機已收到**。

「自己傳給自己」預設仍只讀。另行同意「本人對話回覆測試」後，才可在同一已連結帳戶測新的 Hello、已批准 FAQ 自動回覆及專用人工回覆。這條路線不需模型或 API key，不呼叫 Codex CLI、模型 API 或 DOT，也不擴大外部顧客發送範圍。

## 立即測試

1. 啟動真正的客服核心與本機 WhatsApp 橋接，在卡片「管理」核對手機 `open`，並確認新的自身文字可進入「連線測試」。單有瀏覽器頁面或 QR 不足以收發。
2. 要測 Hello 自動回覆，先在知識庫核對完整問題 Hello 有唯一、已批准且仍有效的 FAQ 答案；使用現有已核對答案，不代填商戶資料。在管理開啟「知識庫優先」及「已確認答案自動回覆」（全域 `enabled` 與 `automaticKnowledge`）。未開這兩項時，只測專用人工回覆，或先明確確認該 FAQ 自動授權。
3. 另行開啟「本人對話回覆測試」，明確同意只測目前已連結帳戶；要測 FAQ，再選其獨立「自動 FAQ」選項。後台讀回 `enabled` 及 `automaticFaq`；不因打開卡片、收件或連線就預設啟用。
4. **從手機重新傳一則新 Hello。** 開啟之前的 Hello 及其他歷史不會重跑。每筆新輸入最多自動回答一次；卡片核對對應來訊、答案及提交結果，再到手機查看真正收到的內容。`accepted` 只代表 provider 接受，不等於送達。
5. 要測人工，選中同一本人測試對話，在專用人工回覆欄核對文字後提交。後台以同一交易切至 `self_human` 並排隊；不必使用普通對客發送或 DOT。人工提交有操作鍵去重及速率限制，不要用不同操作鍵重送不明結果。
6. 要再試自動 FAQ，明確交回自動測試。`self_auto` 只對**下一則新來訊**生效，不立即處理舊 Hello；交回後再由手機傳一則新 Hello。完成後關閉本人回覆測試。

FAQ 自動測試同時需要本人測試的 `enabled=true`、`automaticFaq=true`，以及全域知識庫政策的 `enabled=true`、`automaticKnowledge=true`。本人測試開關不修改全域政策。問題不完全吻合、答案未批准／已失效／有衝突時不自動回答，也不交給模型猜答；可由本人核對後使用專用人工路線。

## 保持獨立的權限

| 範圍 | 本人回覆測試的行為 |
| --- | --- |
| 身份及輸入 | 只限當次已核對帳戶、隨機 grant 授權之後的新自身文字；不能由文字指定另一個帳戶或任意號碼 |
| FAQ | 只採用唯一、完整問題吻合、已批准且有效的答案；發送前再查來源、版本、人工狀態與 grant |
| 人工 | 專用 route 接收文字、同一操作鍵及預期版本；原子切至 `self_human`，新來訊或版本改變須重新核對 |
| 交回自動 | 明確 resume 映射至 `self_auto`，僅作用下一筆新來訊，不能補跑歷史 |
| 模型及 DOT | 永不處理自身測試；FAQ 沒命中也沒有 CLI／API／DOT fallback |
| 客戶工作 | 不計入客戶 pending、待處理提示或通知，不當成真正客戶 |
| 外部發送 | 原有 allowlist、顧客授權及渠道範圍完全不變；不開放廣播、外部號碼或其他渠道 |

客服自己發出的訊息按 **provider ID＋address** 記錄及攔截回聲，即使 provider 把 `fromMe` 標成 false 也不能當作新問題再回答。橋接另外核對已觀察自身來訊與冪等記錄；只靠 `fromMe` 不足以防回覆循環。

發送結果 `uncertain` 時停止本人回覆測試，不自動重送。先到手機及卡片核對同一筆結果，不能用刷新、重啟、改 operation ID 或再按一次繞過未知結果。重啟、斷線、換帳戶或撤銷都會關閉當次 grant；恢復連線後須重新確認，不能沿用舊授權或重跑舊 Hello。在途訊息不能保證撤回。

## 受限接口及資料

接口都在已登入的 `/api/agents/bluesai-cs-0001` 命名空間，由後台核對本人會話、可信橋接及帳戶，不接受前端自行指定 grant 或收件地址。

| 方法及路徑 | 契約 |
| --- | --- |
| `GET /connections/whatsapp-self-test-reply` | 讀回 `available`、`enabled`、`automaticFaq`、`grantId`、`requiresNewMessage:true`；可用不等於已啟用 |
| `POST /connections/whatsapp-self-test-reply` | 提交 `{enabled, automaticFaq, consent:true}`；啟用須明確同意，綁定當次隨機 grant，不能觸發舊來訊 |
| `POST /conversations/:id/self-test-reply` | 提交 `{text, operationId, expectedVersion}`；核對本人測試及最新版本後，原子切至 `self_human` 並排隊 |
| `POST /conversations/:id/resume` | 在本人測試映射為明確交回 `self_auto`，不立即生成或發送 |

`operationId` 用於同一次人工提交去重；網絡回應遺失時先讀回同一操作，不新建鍵假設尚未發送。`expectedVersion` 防止舊畫面覆蓋更新。`grantId` 是帳戶綁定測試的識別，不能代替登入或外部發送授權。

核心 schema 6 增量新增 `self_test_reply_links`，保存 grant、input 及 operation ID 的對應；橋接另保存已觀察自身輸入及冪等記錄。舊商戶、知識批准、對話、人工狀態及歷史保留。關聯與去重資料持久保存，不代表重啟後 grant 仍有效。資料庫、手機登入及測試紀錄留在私人資料目錄，不進 Git。

## 分開驗收

- **只讀收件**：手機新自身文字出現在卡片，不代表已回覆。
- **本人 FAQ／人工回覆**：核對新來訊、唯一 FAQ 或本人文字、同一發送記錄及手機實際結果；兩種回覆分開記錄。
- **防循環與停止**：同一輸入／同一人工 operation 不重送，客服回聲不成新輸入；人工期間不自動回答，resume 不補跑；uncertain、重啟、斷線、換帳戶及撤銷後關閉。
- **外部顧客服務**：仍須另一個已授權 WhatsApp 帳戶來訊，在收件手機核對實際回覆。本人測試不代替這項驗收。
- **原生模型／宿主／雲端**：不由這項測試證明；CLI 合成推理、私人工作室安裝及常駐部署各自驗收。

目前真正發送與手機收件的結果應按當次實測另外記錄；本文件及程式測試本身不當成送達證據。接駁及一般收件流程見 [CONNECTION_GUIDE.md](CONNECTION_GUIDE.md) 與 [LIVE_INBOX.md](LIVE_INBOX.md)。
