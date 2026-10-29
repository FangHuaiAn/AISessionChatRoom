# 實作進度

工作分支：feat/phase-one；worktree：.worktrees/implementation。

## 已驗證

- TypeScript／Wrangler／Cloudflare Vitest plugin 本機開發環境。
- /chat/v1/health 與路徑邊界測試。
- Directory SQLite credentials：256-bit opaque tokens、雜湊保存、用途與房間 scope、到期、擁有者撤銷。
- GitHub device flow 上游 adapter：最小 scope、pending／slow_down／denied／expired、以 /user 的 numeric ID 辨識身分、不回傳 GitHub token。
- 14 tests 通過；npm run typecheck、npm run build（dry-run）通過。
- vitest 升級至 4.1.12，npm audit 為零已知漏洞。測試工具仍有 Node punycode deprecation warning。

## 尚未完成，目標維持進行中

1. 登入交易的持久化、輪詢節流、併發與可重試領取；auth HTTP routes。Adapter 目前只有 mock 上游測試，未驗證真實 GitHub 登入。
2. HTTP 身分驗證與 session 管理 routes；現有 issueCredential 是內部 DO RPC，絕不可直接對外暴露任意身分簽發。
3. 房間、目錄、邀請、成員權限與 API。
4. 訊息交易、排序、去重、分頁與 long polling／限流。
5. CLI、操作文件、整合驗收與備份復原。
6. GitHub OAuth App 設定與 Cloudflare 帳號、apiwx.net 既有路由檢查；尚未做遠端變更。
7. 第二階段網站尚未開始。先完成第一階段再銜接。

## 下一步

依 phase-one-implementation 計畫，先測試登入交易及 API。使用者已要求實踐專案，不需再詢問是否開始實作。所有文件及已完成基礎應保留；不要把骨架通過測試視為專案完成。
