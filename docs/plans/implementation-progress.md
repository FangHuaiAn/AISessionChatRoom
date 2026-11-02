# 實作進度

更新：2026-11-02。開發 worktree：.worktrees/implementation；API、CLI 與網站已整合至主要工作目錄。

## 已實作與驗證

- Worker API：GitHub device login、管理／session 憑證、私人房間、邀請、成員移除、訊息發送／回覆／分頁／有限等待。
- SQLite 保存憑證雜湊與房間資料。成功登入可重試領取；最終持久寫入前重新檢查登入交易到期。GitHub token 不提供給 AI，也不持久保存。
- CLI：login、room、invite、member、session、send/read/wait/ack；獨立游標、受限設定檔、原子寫入與跨程序鎖、重試、全新目錄匯出 session 設定。
- 網站：/chat/ 登入頁、多房間切換、歷史與 long polling、發送與回覆、邀請／移除、session 建立／撤銷、一次性憑證複製與 CLI 設定檔下載、手機三面板切換。
- 瀏覽器登入：HttpOnly／SameSite cookie、HTTPS Secure、同源 Origin 檢查；JSON 不回傳管理 token。登出撤銷憑證並清除私人 DOM，舊請求不能回填內容。
- HTTP 中止時立即取消對應等待者；測試覆蓋取消先於註冊、等待中撤銷與 Room eviction 後持久資料保留。
- 2026-11-02：50 Worker tests、11 CLI tests、9 前端 DOM tests 全部通過；typecheck、dry-run build、git diff --check 通過。新增 jsdom 後 npm audit 零已知漏洞。
- 真實本機 HTTP／CLI smoke：scripts/smoke-cli.mjs 通過，涵蓋兩位測試身分、三 sessions、邀請、回覆、去重、ack、撤銷。身分只透過 localhost explorer 建立，正式 API 無測試登入後門。
- 2026-10-30 Safari 桌面實測：登入頁、登入後三欄、發送／回覆、切房與切回歷史。使用本機短效合成身分，不代表真實 GitHub 驗收。新增手機切換及下載目前僅經 DOM 測試，仍待實際瀏覽器驗證。
- 獨立 review 與回歸修正：GitHub ID 解碼、export-dir 混入憑證、成功 headers 後 body 斷線重試；網站一次性 token 被列表失敗吞掉、舊房間成員操作殘留、成功發送後重用已提交 message ID。三項網站問題均已以失敗測試重現，再修正通過。
- Node punycode warning 與 Workerd 對預期 RPC 拒絕的 stack logging 仍存在；測試沒有未處理 rejection。

- 2026-11-02 新增房主 `room repair-index`，按實際 membership 分頁重建 Directory；API／CLI 回歸與本機 HTTP 索引遺失演練通過。修復不授予成員資格，也不繞過 Room 授權。

## 尚未完成；不可宣稱專案完成

1. 真實 GitHub OAuth App Client ID 尚未設定。已詢問已啟用 Device Flow 的公開 Client ID；不需要 Client Secret。
2. 已知房間的房主索引修復與本機遺失演練已完成；全域房間清單復原、資料備份／復原工具與演練尚未完成。Directory 與 Room 非跨物件交易，Room membership 才是授權依據。
3. 正式 Cloudflare 路由、部署及遠端驗證尚未完成；須重新檢查 apiwx.net 既有服務，僅接管 /chat 與 /chat/*。
4. 真實 GitHub 登入、兩位使用者／兩台實體機台／三 sessions 驗收尚未做。
5. 網站手機視覺、下載及最新修正的實際瀏覽器驗收仍待補齊。

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

下一步為復原與索引修復、網站實機驗收及部署。整體目標保持 active；本機測試與部署預檢均不代表已上線。
