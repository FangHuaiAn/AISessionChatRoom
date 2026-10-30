# 實作進度

更新：2026-10-30。工作分支：feat/phase-one；worktree：.worktrees/implementation。

## 本輪進展與證據

- Worker API：GitHub device login 交易、登入節流與到期、管理／session 憑證、房間建立／列表、私人邀請、成員移除、訊息發送／回覆／分頁／有限等待。
- SQLite 保存憑證雜湊與房間資料。成功登入可重試領取；GitHub token 不提供給 AI，也不持久保存。
- CLI：login、room、invite、member、session、send/read/wait/ack，獨立游標、設定檔權限、原子寫入與跨程序鎖、退避重試、全新目錄匯出 session 設定。
- 2026-10-30 驗證：36 Worker tests + 10 CLI tests 通過；typecheck、dry-run build、git diff --check 通過；npm audit 零已知漏洞。
- 真實本機 HTTP／CLI smoke：scripts/smoke-cli.mjs 通過。兩位本機測試身分、三 sessions、邀請、回覆、去重、ack、撤銷。測試只透過 Wrangler localhost explorer 建立 disposable 身分，正式 API 無測試登入後門。
- integration.test.ts 驗證 Room eviction 後資料保留、私人隔離及等待中撤銷憑證不返回內容。
- 獨立 review 找到 3 問題並已紅綠回歸修正：GitHub ID URL 解碼、export-dir 混入管理憑證、成功 headers 後 body 斷線未重試。已請 reviewer 複核。
- Cloudflare Wrangler 已登入，zone apiwx.net active，查詢當時既有 Worker routes 為空；未做任何遠端寫入。
- Node punycode deprecation warning 與 Workerd 對預期 RPC 拒絕的 stack logging 仍存在；測試本身通過且沒有未處理 rejection。

## 尚未完成；不可宣稱專案完成

1. 真實 GitHub OAuth App Client ID 尚未設定。已向使用者詢問已啟用 Device Flow 的公開 Client ID；未要求 Client Secret。不可把 mock 測試稱為真實登入成功。
2. 正式環境、GitHub 登入與跨實體機台驗收尚未做。
3. HTTP client 斷線後，等待者目前靠最長 30 秒 timeout 清理；需要依計畫補立即取消／清理及其測試。
4. 目錄索引可重建策略、備份與復原演練尚未完成。Directory 與 Room 非跨物件交易。
5. 正式路由／環境設定、部署與遠端驗證尚未完成。不得影響 apiwx.net 其他路徑。
6. 第二階段網站尚未開始：需同一 API 的 GitHub 登入、多房間列表、歷史／更新、成員與 session 管理。第一階段用 bearer tokens；網站需要適當瀏覽器登入與憑證保管設計。
7. 程式目前仍在 worktree，整合回主要工作目錄與最終文件／驗收尚未完成。

## 可重跑指令

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run dev
# 在另一 terminal，僅針對 localhost:8787：
node scripts/smoke-cli.mjs
```

下一步：處理上述缺口，保持整體目標 active。使用者已要求實踐專案，毋須再次詢問是否開始實作；正式外部設定如需人登入或提供 App ID，只在確實缺少時請求。
