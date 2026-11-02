# 備份與復原設計

## 範圍與權限

維運只透過 Cloudflare account-authorized service binding 的 named WorkerEntrypoint；公開 fetch router 不映射維運方法。備份內容包含私人訊息，維運端保存為權限 0600 的本機檔案，目錄 0700，不寫入一般日誌或 Git。

提供可攜式邏輯備份；Cloudflare PITR 是補充，不把本機測試當成遠端 PITR 證據。遠端 service binding 可存取已部署 Worker，再由 Worker 操作 DO。DO 本身不支援 remote:true 的本機直連。

## 一致性

訊息不修改或刪除，房間 metadata 不變，因此單房間備份可先保存 last_seq 與 count，再分頁匯出 seq <= last_seq 的訊息；後續新訊息不混入該次備份。每頁最多 100 筆。

Directory 新增持久 room registry，建立 Room 前先登記，避免 Room 建立成功後索引失敗導致無法發現。Registry 以遞增序號固定一輪掃描的上界；尚未完成初始化的登記保留並在備份 manifest 明確標示，不默默省略失敗。已存在的 room_index 可回填 registry；若舊索引本身遺失，仍需已知房間 ID 或既有備份清單。

不同房間的備份時間可以不同，manifest 記錄各房間的 cutoff；不聲稱跨 DO 同一時刻交易快照。

## 還原

僅還原到空的目標 Room，拒絕覆蓋既有使用中房間。還原分為 header、訊息分頁、完成三步；以 snapshot ID 和持久 cursor 支援中斷重試。未完成時房間沒有成員，不能透過公開 API 存取；完成前驗證訊息數量及最後 seq。

保留訊息 id、seq、作者、session_id、client_message_id、reply_to 與時間，以便歷史引用不變。服務不復活舊 token、登入交易或邀請。完成後只恢復原房主的成員資格，房主重新登入、邀請夥伴並建立新 sessions。這是復原時的權限重設，不是一般備份期間移除成員。

存檔以 manifest 與檔案 SHA-256 檢查完整性；restore 先驗證完整備份，再開始寫入，明確指定目標服務。正式資料不得用演練覆寫。

## 驗證

- 備份 cutoff 排除後來新增訊息，分頁無遺漏。
- 空房間與多頁歷史恢復，reply／id／seq 保留。
- 分頁交易原子、重試可續傳、衝突拒絕。
- 未完成還原不可讀寫；非空目標拒絕覆寫。
- 舊憑證／邀請無效，僅房主需重新登入後恢復管理。
- 本機真實 HTTP 維運 bridge 演練；另行驗證遠端 service binding 與正式備份操作。

官方依據：
- https://developers.cloudflare.com/workers/local-development/#using-remote-resources-with-durable-objects-and-workflows
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api
