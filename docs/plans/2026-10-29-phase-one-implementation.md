# Phase One Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建立可供多人 terminal AI 主動協作的私人聊天室 API 與 CLI。

**Architecture:** Worker 提供 API；Directory DO 管理身分與目錄；Room DO 保存成員、邀請與訊息。GitHub device flow 辨識人，獨立的受限 session tokens 授權 AI。

**Tech Stack:** TypeScript、Cloudflare Workers、SQLite-backed Durable Objects、Node.js CLI、Vitest／Cloudflare Workers 測試工具。實作時依官方文件鎖定相容版本。

---

依序執行；此文件是尚未執行的計畫。每個功能先寫下列行為測試，確認因未實作而失敗，再最小實作、重跑並提交。部署前讀取 cloudflare、durable-objects、workers-best-practices、wrangler 技能；不要將範例識別碼當成真實雲端資源。

### 1. 專案骨架與測試環境

建立 package.json、tsconfig.json、wrangler.jsonc、vitest.config.ts、src/index.ts、src/directory.ts、src/room.ts、tests/health.test.ts。使用 SQLite DO migration，設定本機與測試環境。

建立 npm scripts：typecheck、test、dev、build；build 使用 wrangler deploy --dry-run。

公開入口預定為 https://apiwx.net/chat，API 基底為 https://apiwx.net/chat/v1。Worker 與本機測試使用相同 /chat/v1 路徑前綴；CLI 預設使用正式 API 基底，並允許開發及測試覆寫。加入路由測試，驗證 /chat、/chat/ 下的路徑與 /chat-other 的邊界。

執行 npm run typecheck、npm test -- tests/health.test.ts、npm run build。驗證 health endpoint 與兩種 DO binding 可用。只建立本機設定，不建立遠端資源。

### 2. 身分、token 與 schema

建立 src/auth/tokens.ts、src/contracts.ts、tests/auth.test.ts，擴充 Directory schema。

測試 token 雜湊保存、到期與撤銷、用途區分、session 房間 scope、客戶端偽造 user_id 無效。管理 token 與 session token 不可互換。確認日誌不輸出 secrets。

執行 npm test -- tests/auth.test.ts；實作後全數通過再提交。

### 3. GitHub device 登入

建立 src/auth/github.ts、tests/github-login.test.ts，實作 start/poll routes 與短期登入交易。

使用 GitHub API mock 測試 pending、slow_down、拒絕、過期、重試領取、並發領取、GitHub /user ID 綁定與 token 不外洩。不得在單元測試要求真實 GitHub 憑證。

執行 npm test -- tests/github-login.test.ts。文件列出 OAuth App 啟用 device flow、client ID 與所需 secret 的設定方式，不把 secret 寫入 repo。

### 4. 房間與邀請

建立 src/routes/rooms.ts、tests/rooms.test.ts、tests/invites.test.ts，擴充 Room schema 與 Directory 目錄。

測試房間初始化重試、房主權限、邀請限時及撤銷、兩位使用者競爭兌換、同人重試、完整歷史可見性、成員移除、session 無管理權、目錄列表不得暴露其他房間。目錄是可重建索引，Room membership 才是授權依據。

執行 npm test -- tests/rooms.test.ts tests/invites.test.ts。

### 5. 持久訊息與游標

建立 src/routes/messages.ts、tests/messages.test.ts。

測試並發發送 seq 唯一且遞增、持久化後確認、冪等重試、payload 衝突 409、跨房間 reply 拒絕、游標分頁無遺漏、重建物件後仍可補讀、超大訊息拒絕、撤銷憑證拒絕。messages 與去重資料同交易提交。

執行 npm test -- tests/messages.test.ts。

### 6. 有限等待與限流

建立 tests/wait.test.ts、src/limits.ts，擴充 Room 等待處理。

測試現有訊息立即返回、新訊息喚醒所有合格等待者、超時空結果、註冊等待時的競爭、成員移除及 token 撤銷後不得返回資料、斷線清理、重啟後重試補讀。使用可控計時，不讓測試真的等待 30 秒。

執行 npm test -- tests/wait.test.ts。限流回傳 429 及可供 CLI 使用的重試資訊。

### 7. CLI

建立 cli/index.ts、cli/client.ts、cli/config.ts、tests/cli.test.ts。

提供 login、room create/list、invite create/accept、session create/revoke、send/read/wait/ack。明確選擇 session，不以機台作為唯一身分。支援 JSON 輸出、非零錯誤 exit code、stdin 傳入訊息及敏感邀請值。

測試 token 不輸出至一般日誌、憑證檔權限、每 session/room 獨立游標、未 ack 可重讀、send 重試沿用同一 key、429 退避、wait 中斷不跳過訊息。

執行 npm test -- tests/cli.test.ts，再以本機 Worker 完成人工 CLI smoke test。

### 8. 操作文件、驗收與部署準備

建立 README.md、docs/api.md、docs/agent-guide.md、tests/integration.test.ts。記錄 API、登入與撤銷、協作指引、備份／保留策略、錯誤處理與成本觀察方式。第一階段訊息不自動過期；資料備份與復原流程須在正式使用前驗證。

部署前確認 apiwx.net 的 Cloudflare zone、DNS 與既有 Worker／origin 路由，依官方規則設定 /chat 路徑範圍，避免接管整個網域或誤匹配其他前綴。驗收包含 /chat/v1 API 可用，以及網域其他路徑未受影響。第二階段網站須檢查 /chat 前綴下的深層連結、資源 URL 與登入導向。

執行 npm run typecheck、npm test、npm run build。整合測試涵蓋兩使用者三 sessions、私人邀請、隔離、重試及補讀。確認 git diff --check 無錯誤。

提供可審查的部署設定後再進行正式部署授權；目前對話只確認技術設計，尚未授權建立付費資源或公開服務。遠端部署後才進行真實 GitHub 登入及兩機台驗收，不可用 mock 通過宣稱真實登入已驗證。
