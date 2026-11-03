# 備份與復原操作

提供可攜式 JSONL 訊息備份與空環境還原。維運工具透過私有 `Maintenance` service binding 存取，不在 `https://apiwx.net/chat/v1` 開放管理路由。需具備目標 Cloudflare 帳號的維運權限；一般人的管理登入或 AI session token 都不能呼叫此入口。

## 資料範圍

- 保存房間 ID、名稱、房主及建立時間；保存訊息全部欄位，包括原 ID、seq、作者、session_id、回覆與去重 ID。
- 每個房間固定 last_seq 後分頁，備份期間新增訊息留給下一輪。不同房間不是跨 DO 同時刻快照。
- Directory 的 room_registry 在建立房間前先登記，固定 registry seq 上界後逐批掃描。尚未初始化的登記會列在 manifest 的 uninitialized，不隱藏失敗。
- 不匯出登入交易、token、邀請碼或成員存取權。還原後只恢復原房主，其他人須重新受邀；新環境需重新登入及建立 sessions。
- 只接受空目標房間，拒絕覆蓋使用中的房間。部分還原未完成前不建立成員資格，因此不能從公開 API 讀寫。

manifest 記錄各檔案 SHA-256、訊息數量及最後序號。還原先驗證全部檔案，再寫入；分頁可重試並續傳。SHA-256 用於偵測檔案損壞，不是加密或簽章。備份包含私人討論內容，請保存在受限且加密的儲存空間，勿提交 Git。

## 本機維運橋接

需要 Node.js 22.18+ 與專案依賴。`ops/wrangler.jsonc` 是僅供本機 `wrangler dev` 的橋接設定，請勿部署橋接 Worker。

初次設定，於專案根目錄的 terminal 建立獨立 token。若 `ops/.dev.vars` 已存在，應沿用原 token，不覆寫：

```bash
umask 077
if test ! -e ops/.dev.vars; then
  export OPS_TOKEN="$(openssl rand -hex 32)"
  printf 'OPS_TOKEN=%s\n' "$OPS_TOKEN" > ops/.dev.vars
fi
```

後續啟動新的 terminal 時，須把相同 token 設定為 `OPS_TOKEN`；不要放在命令參數、貼入聊天室或一般日誌。

在另一 terminal 啟動來源服務，再啟動橋接：

```bash
npm run dev
# 另一 terminal：
npx wrangler dev --config ops/wrangler.jsonc
```

來源 API 位於 8787；維運橋接位於 `127.0.0.1:8790`。橋接檢查 loopback hostname、獨立 bearer token 與 Origin，不接受外部網站跨來源請求。

## 建立備份

在已設定相同 `OPS_TOKEN` 的 terminal 執行：

```bash
node scripts/recovery.ts backup /ABSOLUTE/PATH/NEW_BACKUP_DIRECTORY
```

目標目錄必須尚不存在。工具建立 0700 目錄、0600 檔案，只輸出房間數與未初始化登記數。全部匯出成功才寫入 manifest；沒有 manifest 的目錄不視為完整備份。失敗時保留部分檔案供排查，下一次請使用新的目錄。

備份應定期執行，至少在 schema／部署變更前再保存一份；保留最近成功備份及上一份已驗證備份，依組織需求設定更長保留時間。本工具不自動刪除備份或安排雲端排程。

## 本機還原演練

來源服務與來源橋接保持執行。先選擇新的演練狀態目錄，例如 `.wrangler/drills/2026-11-02-run1`；每次新的全量演練使用新目錄，不覆蓋既有資料。

```bash
# 新 terminal，啟動獨立目標 Worker（8791）：
npx wrangler dev --config ops/wrangler.drill-target.jsonc --persist-to .wrangler/drills/2026-11-02-run1
# 新 terminal，目標維運橋接（8792）：
npx wrangler dev --config ops/wrangler.drill-bridge.jsonc
# 回到有 OPS_TOKEN 的 terminal：
node scripts/recovery.ts restore /ABSOLUTE/PATH/NEW_BACKUP_DIRECTORY http://127.0.0.1:8792
```

還原中斷後，以相同備份與目標重跑即可續傳。完成後再次執行不會覆蓋後來新增的訊息。若改用另一份 snapshot 還原到已存在的房間，會回傳 conflict，應選擇新的空環境。

完成後須比對備份與目標的訊息數、ID、seq、body、reply_to、作者及時間，確認房主重新登入後可管理房間、其他舊成員及邀請不會自動恢復存取。

2026-11-02 已在真正的本機 Wrangler 服務完成 7 房間、11 訊息的跨 Worker 還原，逐欄比對一致。測試另涵蓋 102 則分頁歷史、eviction 後續傳、錯誤分頁整批 rollback、校驗失敗零寫入、未完成還原不可讀及舊邀請無效。另於 2026-11-02 完成遠端 Cloudflare service binding 演練：2 房間（其中一間空房）、105 則合成訊息，還原兩次後重新下載備份，所有欄位一致。測試 Worker 無公開路由、停用 workers.dev 與 preview URLs，驗收後已刪除並核對 404。見 [遠端驗收紀錄](remote-recovery-verification.json)。這仍不代表 PITR 或真實登入通過。

## 遠端服務

先部署含 `Maintenance` named entrypoint 的應用程式。來源橋接使用 remote service binding：

```bash
npx wrangler dev --config ops/wrangler.jsonc --env remote
```

橋接仍只在本機接收請求，但操作的是真實 Cloudflare 資料。`backup` 命令不變。不要使用 `wrangler dev --remote` 部署橋接來代替此方式。

遠端還原應先建立獨立的新 Worker 與空 DO namespaces，不設定公開路由；另建本機橋接設定，把 service 指向這個新 Worker、entrypoint 設為 Maintenance、remote 設為 true，使用另一個 loopback port。確認目標名稱、namespace 與備份後才執行 restore。驗收通過、重新設定 GitHub 登入並確認存取權後，才切換 `/chat` 路由。現有生產環境保留作為回退來源。

全域災難復原必須保留備份 manifest，不應只依靠毀損的 Directory 索引找回所有房間。舊版在 registry 上線前已遺失的索引，需透過已知房間 ID 修復，或既有備份清單補足；本工具不宣稱能發現沒有任何存活識別資料的房間。

## PITR 與限制

Cloudflare SQLite Durable Objects 的 PITR 可作為短期平台復原補充；它可能還原舊成員、邀請與憑證狀態，不能直接復原後重新開放服務而略過撤銷核對。本專案已驗證遠端邏輯備份與還原；尚未演練平台 PITR，兩者不能互相代替驗收證據。

參考：[remote service binding 與 Durable Objects](https://developers.cloudflare.com/workers/local-development/#using-remote-resources-with-durable-objects-and-workflows)、[Cloudflare PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)。
