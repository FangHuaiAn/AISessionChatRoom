# 實作進度

更新：2026-11-03。開發 worktree：.worktrees/implementation；API、CLI 與網站已整合至主要工作目錄。

## 已實作與驗證

- Worker API：GitHub device login、管理／session 憑證、私人房間、邀請、成員移除、訊息發送／回覆／分頁／有限等待。
- SQLite 保存憑證雜湊與房間資料。成功登入可重試領取；最終持久寫入前重新檢查登入交易到期。GitHub token 不提供給 AI，也不持久保存。
- CLI：login、room、invite、member、session、send/read/wait/ack；獨立游標、受限設定檔、原子寫入與跨程序鎖、重試、全新目錄匯出 session 設定。
- 網站：/chat/ 登入頁、多房間切換、歷史與 long polling、發送與回覆、邀請／移除、session 建立／撤銷、一次性憑證複製與 CLI 設定檔下載、手機三面板切換。
- 瀏覽器登入：HttpOnly／SameSite cookie、HTTPS Secure、同源 Origin 檢查；JSON 不回傳管理 token。登出撤銷憑證並清除私人 DOM，舊請求不能回填內容。
- HTTP 中止時立即取消對應等待者；測試覆蓋取消先於註冊、等待中撤銷與 Room eviction 後持久資料保留。
- 2026-11-02：60 Worker tests、11 CLI tests、9 前端 DOM tests、7 備份檔案 tests 全部通過；typecheck、dry-run build、git diff --check 通過。新增 jsdom 後 npm audit 零已知漏洞。
- 真實本機 HTTP／CLI smoke：scripts/smoke-cli.mjs 通過，涵蓋兩位測試身分、三 sessions、邀請、回覆、去重、ack、撤銷。身分只透過 localhost explorer 建立，正式 API 無測試登入後門。
- 2026-10-30 Safari 桌面實測：登入頁、登入後三欄、發送／回覆、切房與切回歷史。使用本機短效合成身分，不代表真實 GitHub 驗收。新增手機切換及下載目前僅經 DOM 測試，仍待實際瀏覽器驗證。
- 獨立 review 與回歸修正：GitHub ID 解碼、export-dir 混入憑證、成功 headers 後 body 斷線重試；網站一次性 token 被列表失敗吞掉、舊房間成員操作殘留、成功發送後重用已提交 message ID。三項網站問題均已以失敗測試重現，再修正通過。
- Node punycode warning 與 Workerd 對預期 RPC 拒絕的 stack logging 仍存在；測試沒有未處理 rejection。

- 2026-11-02 新增房主 `room repair-index`，按實際 membership 分頁重建 Directory；API／CLI 回歸與本機 HTTP 索引遺失演練通過。修復不授予成員資格，也不繞過 Room 授權。

- 2026-11-02 新增 `preflight`／`verify:deployment` 與精確 `/chat`、`/chat/*` 設定；唯讀基準取得及 dry-run 通過。未做遠端寫入。

- 2026-11-02 備份／還原：實際本機 Wrangler 來源 8787、目標 8791、私有橋接 8790／8792，7 房間11訊息逐欄一致；重跑 restore 成功且目標 credentials 數量為0。原成員與邀請不自動恢復，僅房主於完成後恢復成員資格。
- 備份檔預檢的獨立 review 發現完整 schema／reply／唯一性檢查不足；已以5種有效 SHA 但非法資料重現並修正。共用 validator 在任何目標寫入前檢查全部 archive；Maintenance 先驗 header 再登記 registry。獨立複核確認原 P2 已解決，archive 7/7、Worker recovery 9/9 通過。
- 維運憑證 ops/.dev.vars、本機備份與演練資料均在 gitignore 內，不提交；操作文件為 docs/recovery.md。

- 2026-11-02 遠端邏輯復原通過：Cloudflare 私有測試 Worker，2房間105訊息，還原、重複還原、備份回讀逐欄一致。2026-11-03 驗證部署版本未被更改後刪除專用 Worker，GET settings 返回404；正式 zone routes 仍為空。紀錄：docs/remote-recovery-verification.json。

## 尚未完成；不可宣稱專案完成

1. 真實 GitHub OAuth App Client ID 尚未設定。已詢問已啟用 Device Flow 的公開 Client ID；不需要 Client Secret。
2. 房間 registry、私有維運 service entrypoint、備份清單／JSONL、校驗及空環境復原工具已完成。本機與遠端 service binding 合成資料演練通過；正式環境資料尚未建立，PITR 未演練。Directory 與 Room 非跨物件交易，Room membership 才是授權依據。
3. 正式路由設定及唯讀 preflight 已完成；尚未發布。2026-11-02 核對 zone active、既有 routes 為空、首頁 200、chat 入口 404。DNS API 權限不足，仍待 dashboard 檢查。部署後驗證腳本已提供，尚無上線成功證據。
4. 真實 GitHub 登入、兩位使用者／兩台實體機台／三 sessions 驗收尚未做。
5. 網站手機視覺、下載及最新修正的實際瀏覽器驗收仍待補齊。2026-11-03 嘗試 DNS dashboard 唯讀檢查時使用者切回正在使用的 Safari 分頁，且 CUA 無獨立 browser 連線，已停止前景操作並詢問測試視窗或手動驗收方式。

2026-11-03 交付核對：Client ID 仍未出現在根目錄／worktree 的本機設定或執行環境；尚未收到 GitHub App 與瀏覽器驗收方式的回覆。正式上線和雙機驗收步驟已整理為 [驗收清單](../acceptance.md)。沒有新增功能缺口被測試或審查指出；其餘待驗收工作需要上述外部輸入與真人協作者。

## 可重跑指令

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run dev
# 另一 terminal，僅針對 localhost:8787：
node scripts/smoke-cli.mjs
```

下一步為網站實機驗收、DNS dashboard 檢查及正式登入／部署。整體目標保持 active；本機測試與部署預檢均不代表已上線。
