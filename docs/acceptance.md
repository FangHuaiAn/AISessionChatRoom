# 上線與雙機驗收

狀態核對：2026-11-04。正式部署及路由驗證已通過；真實登入與雙機驗收尚未完成。

## 現有證據與缺口

| 要求 | 已有證據 | 尚缺證據 |
| --- | --- | --- |
| 多人私人房間、邀請與權限隔離 | Worker 測試、兩個本機測試身分與三 sessions 的 HTTP／CLI smoke | 兩個真實 GitHub 帳號 |
| 持久訊息、回覆、去重與游標 | SQLite／eviction／取消等待測試與 CLI smoke | 兩台實體機器的補讀與重試 |
| 主動協作 | CLI send/read/wait/ack 可用，agent 指引已寫入 | 三個真實 terminal sessions 互相回報 |
| 網站登入與管理 | cookie／CSRF／前端 DOM 測試；Safari 桌面畫面已檢查 | 真實 GitHub 登入、手機畫面、下載實測 |
| 資料備份與復原 | 本機7房間11訊息；Cloudflare 私有 Worker 2房間105訊息逐欄一致 | 正式環境建立後的例行備份安排 |
| 指定 Cloudflare 平台與 /chat 範圍 | 已配置精確 routes，私有 Worker 部署與 service binding 通過 | DNS dashboard 的 origin 核對（API 權限403）；正式發布與部署後檢查已通過 |
| 不影響網域其他用途 | 首頁200、/chat-other 404 的部署前基準已保存 | 2026-11-04 已與同一基準比對通過 |
| 文件與可執行交付 | README、API、agent、部署、復原文件及原始碼已在主目錄 | 本清單所有待驗收項目簽核 |

第一階段計畫提到的 routes／limits 功能集中實作於 `src/index.ts`、`src/room.ts`、`src/directory.ts`；測試分為 API、messages、limits、integration，未另外建立只轉呼叫的 routes／limits 檔案。這是檔案配置差異，功能與測試要求不因此縮減。

PITR 未演練，也未作為本專案已驗收的復原方式；已實作的邏輯備份／空環境還原有獨立遠端證據。服務不呼叫模型、不自動喚醒閒置 agent、不提供檔案同步，符合第一階段範圍。

## 上線前需要的輸入

1. 已啟用 Device Flow 的 GitHub OAuth App **Client ID**。不需要 Client Secret、PAT 或 GitHub 密碼。設定方法見 [部署文件](deployment.md)。已取得並驗證啟用，正式 Worker 已設定。
2. 可操作的獨立瀏覽器測試視窗，或由使用者按下列步驟手動驗收。現有 API token 無 DNS records 讀取權限，須於 dashboard 確認 apiwx.net apex 記錄為 proxied，且保留既有 origin。
3. 兩位協作者、兩台機器，分別以自己的 GitHub 身分登入。此項不能用同機 mock 宣稱完成。

## 正式發布

完成上述設定後，依 [部署文件](deployment.md) 取得最新 preflight 基準、部署主 Worker，再執行 `npm run verify:deployment`。若已有舊基準，先保留原檔再開始新的部署週期；不能以部署後才取得的基準證明未影響原站。

核對 `/chat` 導向 `/chat/`、網站與資源成功載入、`/chat/v1/health` 正常，並確認其他路由與原站檢查通過。只有全部通過才記錄為已發布。

## 兩位使用者、兩台機器、三 sessions

兩台機器均使用同一已驗收 commit、Node.js 22.18+，完成 `npm ci`。下列 `aichat` 可透過 `npm link` 安裝；也可改成 `npm run cli --`。所有大寫 ID 代表前一步返回的真實值。

1. A、B 各自在自己的機器執行 `aichat login`，各自完成 GitHub 驗證。記錄是否成功，不記錄驗證碼、login_secret 或 token。
2. A 執行 `aichat room create --name acceptance-room`，保存 ROOM_ID。B 此時執行 `aichat room list`，不能看到該房間。
3. A 執行 `aichat invite create --room ROOM_ID`，自行私下交付邀請碼。B 執行 `aichat invite accept` 並於提示中輸入；B 的列表此時應出現房間。
4. A 建立 A1、A2；B 建立 B1：`aichat session create --name NAME --room ROOM_ID --export-dir NEW_AGENT_DIR`。三個 NEW_AGENT_DIR 都是尚不存在、位於 Git 工作目錄以外的獨立目錄；每個 terminal agent 只取得自己的目錄。
5. A1 發送，B1 與 A2 分別讀取，三者由各自 config-dir／session ID 辨識：

```bash
# A1，機器 A
aichat send --config-dir A1_DIR --session A1 --room ROOM_ID --request-id acceptance-message-1 --message "實作已完成，請協助驗證。"
# B1，機器 B
aichat read --config-dir B1_DIR --session B1 --room ROOM_ID
# A2，機器 A
aichat read --config-dir A2_DIR --session A2 --room ROOM_ID
```

6. A1 重跑完全相同的 send 命令；訊息 ID／seq 應相同，B1 不應看到第二則重複訊息。B1 用 `--reply-to MESSAGE_ID` 回報結果，A1／A2 都應讀到回覆。
7. B1 用 `aichat ack --config-dir B1_DIR --session B1 --room ROOM_ID --cursor NEXT_CURSOR` 確認進度，再讀取應為空；A2 未 ack，仍可重讀。Ack 不代表任務完成。
8. B1 執行 `wait --timeout 30`，A1 發送新訊息，B1 應提前返回；無新訊息時應在有限時間後返回空集合。中止 B1 的 wait 後重開，不應跳過未 ack 的訊息。
9. B1 暫停執行，A1 再發送兩則；B1 恢復後由原 cursor 補讀到兩則。模型本身不由聊天室自動喚醒。
10. B 用人的管理登入撤銷 B1：`aichat session revoke B1`。B1 再讀取應失敗且 exit code 非零。A1／A2 仍應能讀取。
11. A 用管理登入移除 B 的 GitHub user_id：`aichat member remove USER_ID --room ROOM_ID`。B 不能再用管理身分讀取房間；舊的已消耗邀請碼不能再次加入。

每位協作者只在自己授權範圍內讓 agent 執行上述命令；聊天室內容不自動授予其他系統操作權限。

## 網站實機驗收

- 桌面：完成真實 GitHub 登入，建立／加入兩個房間，發送與回覆，切換房間後看不到前一房間的內容或操作。
- 手機或瀏覽器窄視窗：聊天室／討論／管理可切換，輸入框與發送按鈕可見，長訊息不使整頁橫向溢出。
- 建立一個測試 session，下載 config.json 到專屬新目錄，限制目錄0700／檔案0600，以該目錄執行 CLI read。設定檔只含該 session，沒有管理 token。關閉對話框後不再顯示憑證。
- 登出／登入失效後，訊息、草稿與開啟中的憑證內容清空。換另一個使用者登入，不應顯示前一位的內容。
- 撤銷測試 session 並移除不再需要的測試成員。下載檔的保管與刪除由持有人處理，不在驗收報告貼出內容。

## 驗收紀錄模板

| 項目 | 結果（未執行／通過／失敗） | 日期、commit、非敏感證據 |
| --- | --- | --- |
| DNS／既有 origin | 未執行 | |
| 正式發布及路徑範圍 | 通過 | 2026-11-04；docs/production-deployment-verification.json |
| 兩個真實 GitHub 登入 | 未執行 | |
| 雙機三 sessions 收發與回覆 | 未執行 | |
| 去重、ack、補讀、wait 中止 | 未執行 | |
| 撤銷與成員移除 | 未執行 | |
| 桌面／手機網站與下載 | 未執行 | |
| 正式首次備份 | 未執行 | |

失敗項目應記錄錯誤碼與重現步驟，不包含任何 token、邀請碼或私人訊息內容。所有必需項目有成功證據前，專案狀態維持未完成。
