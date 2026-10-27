# WhatsApp 失效登入的離線重新配對維護

本目錄是 BlueSAi-Cs-0001 此項維護工具唯一持續維護的來源。通用修正及合成回歸都在本目錄更新；共用 harness 的舊提案僅保留為歷史證據，不再維護或用作新操作。安裝及更新沿用[既有生命週期](../../../docs/INSTALL_PACKAGE.md)，本工具不是另一套更新或備份引擎。

這個工具只處理已核對為 `logged_out` 的同帳戶重新連結。它不會啟停服務、連接 WhatsApp、呼叫 logout、產生 QR、備份、部署或擴大收發授權。它不能判定或修復 WhatsApp 首次／連結後拒絕登入的根因。

沿用現有工作室生命週期：安裝人員先核對實際 bridge PID、正常停止、確認退出，並完成既有私人備份覆蓋核對。工具另外核對該 PID 確實已退出，以原 `bridge.lock` 的獨占建立阻擋其他相容程序啟動。現存鎖一律拒絕，不自行移除其他程序的鎖。

所有資料及收據都留在來源倉庫以外的既有私人 data directory。工具拒絕 Git 祖先、symlink／Windows reparse point，以及跨檔案系統搬移。必須明確同意，並提供預先核對的整個 auth tree SHA-256。雜湊包含相對名稱、目錄結構、大小及內容摘要；函式只回傳檔案數量與總摘要，不輸出檔名或內容。

## 先做合成回歸

在本目錄執行，Python 3.12 標準庫即可：

```powershell
python -X utf8 -m unittest -v test_relink_auth
```

測試只建立獨立暫存資料，mock provider 狀態及檔案系統失敗；唯一建立的子程序只執行 `pass`，用於驗證真正 PID 結束偵測。不讀正在使用的工作室。Windows 若無 symlink 建立權限，只略過真正 symlink 建立個案；另有 Windows reparse point 拒絕回歸。

## 核對並隔離失效登入

以下變數由安裝人員在私人環境中提供；不要把真實路徑、登入、收據或其他私人資料提交到來源倉庫。

- `$PrivateDataDir`：固定且已核對的 bridge 私人 data directory。
- `$StoppedBridgePid`：剛核對並正常停止的 bridge PID。
- `$RelinkOperation`：本次固定 operation ID，限英數、底線及連字號，最多 64 字元。

在服務已退出且既有備份已核對後，於本目錄計算預期摘要：

```powershell
$AuthDigest = python -X utf8 -c "import sys; from pathlib import Path; import relink_auth; print(relink_auth.fingerprint(Path(sys.argv[1]) / 'auth')['digest'])" $PrivateDataDir
python -X utf8 relink_auth.py prepare --data-dir $PrivateDataDir --operation $RelinkOperation --expected-pid $StoppedBridgePid --expected-fingerprint $AuthDigest --reason logged_out --consent
```

成功輸出只有 `status`、`count`、`digest`。`prepared` 表示原 `auth` 已以同檔案系統原子 rename 搬往 `auth-archives/<operation>`；不刪除、不覆寫。`already_prepared` 表示相同操作已完成，任何後來產生的新 auth 都不會再次隔離。

操作計劃及階段收據保存在私人 `auth-archives/receipts/<operation>/`。保留原 `$AuthDigest`；中斷後沿用同 operation 和摘要，先讀回收據，不建立另一個操作。檔案系統失敗可接續已記錄階段；資料不符則停止，交安裝人員核對。

之後沿用原有服務啟動流程，先維持 idle。本人再明確取得新 QR 並自行掃碼；同帳戶身份、收件及發送逐項重新核對。新配對若是另一帳戶，不可把舊對話或授權自動套過去，需另走原有資料遷移流程。

## 還原

再次正常停止並核對現時 bridge PID；仍用同 operation 及原 auth 摘要：

```powershell
python -X utf8 relink_auth.py restore --data-dir $PrivateDataDir --operation $RelinkOperation --expected-pid $StoppedBridgePid --expected-fingerprint $AuthDigest --reason logged_out --consent
```

如果新的 `auth` 已存在，工具先把它搬到 `auth-archives/<operation>-fresh-<隨機ID>`，讀回摘要核對，再把原登入搬回 `auth`。兩份均保留，不合併、不覆寫。中斷後同 operation 可接續；`already_restored` 不會再旋轉登入。還原本機檔案不會令 WhatsApp 已撤銷的授權重新有效。

維護期間只移除自己建立的暫存鎖及收據 staging 檔，不刪除 auth／archive。標準輸出不含路徑、檔名、金鑰或 provider 例外；固定失敗狀態必須先核對，不自動重試配對或發送。
