# 真實 WhatsApp 連結與收發

版本：0.4.0-preview.1。這是客服卡片的實際渠道路線，日常操作見 [CONNECTION_GUIDE.md](CONNECTION_GUIDE.md)。

## 兩種實際服務

| 路線 | 運行要求與界線 |
| --- | --- |
| 既有 Evolution instance | 安裝人員先啟動服務、固定版本及 instance；客服使用其 QR、連線、webhook、sendText 和回執接口 |
| 本機連結裝置橋接 | `integrations/whatsapp-local/` 的獨立 Node 子套件，使用固定 Baileys 依賴連到真實 WhatsApp；同機 loopback 接口及私人登入狀態，不需要 Docker 或公開 tunnel |

Baileys 是第三方非官方連結裝置整合，不是 Meta Cloud API。依賴版本、安裝命令、所需設定及限制以該子套件 README 與 lockfile 為準。不能把套件安裝、socket 啟動或二維碼出現當作手機已授權。

```text
本人手機掃描真實 QR → 真實 socket／instance open
指定測試 WhatsApp 號碼 → allowlist → 認證 callback
  → 客服 SQLite 去重及對話 → 卡片內草稿／人工接手
  → 本人指定測試發送 + 範圍／版本／來源／窗口檢查
  → 真實 sendText → accepted → 可對應 delivery/read 回執
  → 測試手機確認實際收到
```

## 本機私人設定

橋接只監聽 loopback；登入、API key、webhook secret、recipient allowlist 和訊息 outbox 留在倉庫外 `WA_LOCAL_DATA_DIR`。客服的 `EVOLUTION_URL`、`EVOLUTION_INSTANCE`、`EVOLUTION_API_KEY` 指向該固定實例，`PUBLIC_BASE_URL` 與獨立 `WEBHOOK_SECRET` 生成並保護 callback。具體橋接環境變數見子套件 README，不能把真實秘密寫進公開範例。

同機服務可以使用 `http://127.0.0.1` callback；電話由 WhatsApp 自身網絡和橋接的出站連線處理，不需要把管理卡片暴露到互聯網。遠端 Evolution 則需要真正可達且受保護的 HTTPS callback，不能使用你的 localhost 當遠端地址。

## 測試範圍及發送

本機測試先選定本人同意的測試號碼，最多三個。空 allowlist 只提供 QR／連線狀態：不把其他客戶的來訊轉送給 Engine／模型，也不對外發送。接駁範圍由私人設定及受限 API 控制，不由 prompt 控制。

一般 `DELIVERY_ENABLED` 預設 false。可信橋接模式另外需要 `LOCAL_WHATSAPP_TEST=true`、卡片中選定測試號碼及明確確認後的程序內測試發送；保持 review，重啟後重新核對及確認，不默默沿用啟用狀態。

首次手動測試不需要模型金鑰。商戶名稱、服務與人工聯絡方式使用本人真實資料；未知欄位保持空白，不能預填虛構政策繞過發送門檻。要測自動 AI，再設定可用模型、有效批准知識及相應回覆模式。

## 本人帳戶的獨立回覆測試

自身新文字預設只讀；另行開啟「本人對話回覆測試」及本人同意後，核心與橋接以當次帳戶綁定隨機 grant，才可測新自身來訊的唯一有效 approved FAQ 或專用人工回覆。沒有 CLI／API／DOT 後備，不開放外部號碼。舊 Hello 不補跑；手機須再傳新 Hello。人工後明確交回自動只影響下一則來訊。

核心 schema 6 保存 grant／input／operation 關聯，橋接保存已觀察自身來訊及冪等記錄。客服發訊息的 ID＋address 回聲不論 fromMe 值都攔截；uncertain 自停不重送；重啟、斷線、換帳戶或撤銷關閉授權。這是自己的真實手機回覆測試，外部顧客驗收仍按下一節另做。[操作與接口](SELF_REPLY_TEST.md)

## 卡片驗收順序

1. 啟動客服執行器及真實橋接／Evolution，登入 `/` 的客服卡片。
2. 「管理 → 接駁 WhatsApp」取得真實 QR，由本人手機確認及掃碼。已正常連接時從渠道狀態直接核對缺項，不重走完整教學。畫面按實際回應顯示等待、open 或錯誤；QR 過期重新取得。
3. 核對指定測試號碼、callback 網址、Bearer 驗證及 `MESSAGES_UPSERT`／`MESSAGES_UPDATE` 事件。讀回相符只證明配置，不證明收到訊息。
4. 由指定另一個 WhatsApp 號碼來訊，在同一卡片內讀回同筆對話。先核對草稿，再依當次授權啟用測試發送，或人工接手回覆。
5. 收件手機實際核對內容，卡片按對應回執顯示 accepted／delivered／read。沒有收到或結果不明時先核對，不直接重發。

`/diagnostics/console` 僅為獨立診斷，不能作為宿主 Agent 的正式介面。網頁聊天與離線規則的成功不列入這份真實 WhatsApp 手機證據。

## 持久性與失敗

客服 schema v3 保存 instance 對應、回執 inbox 及渠道觀察；v4 的客人網頁會話與 WhatsApp 分開。新增版本不清除商戶設定、批准、人工接手或既有工作。更換已固定的 URL／instance 要用獨立資料目錄或經審閱的遷移，避免舊對話流向另一帳號。

回執按 instance、電話及 provider ID 配對；先到的 callback 保留，重複或舊回執不降級已觀察的 delivered／read。沒有可靠電話映射的 LID、群組、廣播及未知形狀不猜配。媒體需按支援範圍交人工查看。

provider 錯誤、HTTP 逾時、重啟時仍在 sending 或結果不明會保留 uncertain，不自動重發。未知手機發出回聲保守轉人工；已在途的訊息不能保證撤回。橋接的 callback 重試及持久性以子套件實作與測試為準，不能宣稱能補回供應商根本未送達的事件。

本文件定義驗收步驟，不宣稱當前手機已掃碼或已收件。完整結果必須以當次真正帳戶、指定測試手機及可對應訊息為證據，並清楚列出等待本人操作或缺少的能力。
