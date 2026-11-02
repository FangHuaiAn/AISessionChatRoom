# 部署與登入設定

目前尚未部署。正式入口為 `https://apiwx.net/chat`，API 基底為 `https://apiwx.net/chat/v1`。

## 本機執行

需要 Node.js 22.18+，執行 `npm ci`、`npm run dev`。本機健康檢查為 `GET http://localhost:8787/chat/v1/health`。所有 API 都保留 `/chat/v1` 前綴。網站位於 `http://localhost:8787/chat/`，靜態資源由同一 Worker 提供；`/chat` 會導向 `/chat/`。

本機 `.dev.vars`（已加入 gitignore）設定：

```dotenv
GITHUB_CLIENT_ID=YOUR_PUBLIC_CLIENT_ID
```

Client ID 是公開識別碼；本專案的 device flow 不需要 Client Secret。不要在此貼入 GitHub personal access token。

## GitHub OAuth App

1. 在 GitHub Settings → Developer settings → OAuth Apps 註冊專用 OAuth App。
2. Homepage URL 使用 `https://apiwx.net/chat`。若註冊介面要求 callback URL，可填 `https://apiwx.net/chat`；目前只使用 device flow，不使用 callback route。
3. 在 App 設定啟用 Device Flow。
4. 將 Client ID 設定到本機 `.dev.vars`，正式部署時設定 Worker 的 `GITHUB_CLIENT_ID`。
5. 執行 CLI login，於瀏覽器開啟 CLI 顯示的 GitHub 網址並輸入驗證碼。

人登入後取得有效 24 小時的管理憑證。Session 預設有效 24 小時，API 可指定 60 秒至 30 天。登入時不要求 repository scope，也不會把 GitHub token 提供給 AI。

若在 GitHub 完成授權後、服務持久保存結果之前發生故障，可能需重新執行 login。已持久保存的登入結果可以在登入交易到期前安全重試領取。

參考：[GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。

## 正式部署前檢查

- 執行 `npm test`、`npm run typecheck`、`npm run build`。
- 確認 Wrangler 登入及目標 Cloudflare 帳號。
- 查閱 apiwx.net 的既有 DNS、Worker routes 與 origin，確認沒有覆蓋其他服務。
- 設定只涵蓋 `/chat` 與 `/chat/` 下的路由，不能誤匹配 `/chat-other`。
- 設定 GitHub Client ID 後驗證真實登入、兩位使用者與至少三個 sessions。
- 檢查 long polling 的執行時間及請求成本。現有 `wrangler.jsonc` 未配置正式路由，且停用 workers.dev 與 preview URLs。

正式路由與部署命令將於帳號及現有網域設定確認後補齊，不能將部署預檢視為正式發布。

## 資料與復原

Room SQLite 保存房間、成員、邀請與訊息；Directory SQLite 保存憑證雜湊、短期登入交易、房間索引與限流狀態。訊息目前不自動過期。

Cloudflare SQLite-backed Durable Objects 提供過去 30 天的 PITR，但官方說明此功能不支援本機開發，因此不能把本機 eviction／重啟測試當作 PITR 復原證據。[官方 PITR 文件](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)

尚待完成正式使用前的備份及復原演練，尤其 Directory 與多個 Room 的跨物件一致性。不要直接把舊憑證與邀請資料還原至正式服務而忽略撤銷狀態。

## 本機 CLI 端到端測試

啟動 `npm run dev` 後，在另一個 terminal 執行 `node scripts/smoke-cli.mjs`。腳本限定使用 localhost:8787，透過 Wrangler local explorer 寫入僅用於測試的短效身分，再使用真正的 CLI 子程序與 HTTP API 驗證兩位使用者、三個 sessions 的協作。它不測試 GitHub 登入，也不會呼叫正式網域。測試資料保留於本機 `.wrangler/state`，CLI 暫存憑證目錄會清除。
