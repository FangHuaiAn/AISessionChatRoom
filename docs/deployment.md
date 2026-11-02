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
- 檢查 long polling 的執行時間及請求成本。現有 `wrangler.jsonc` 已配置下面兩條正式路由，但尚未發布；workers.dev 與 preview URLs 停用。

部署設定綁定已核對的 Cloudflare 帳號與 apiwx.net zone，路由只有：

```text
https://apiwx.net/chat
https://apiwx.net/chat/*
```

不要改成 `/chat*`，因為它會涵蓋 `/chat-other`。Cloudflare 路由會把 query string 算入匹配，因此含查詢參數的入口請使用 `/chat/?...`；精確 `/chat` 用於無參數入口並導向 `/chat/`。[Cloudflare 路由規則](https://developers.cloudflare.com/workers/configuration/routing/routes/)

唯讀檢查與基準紀錄：

```bash
npm run preflight
```

此命令核對帳號／zone、讀取既有 routes 與 DNS 記錄（權限允許時）、取得公開 DNS 及 HTTP 基準，保存至 `.wrangler/deployment-baseline.json`，不修改 Cloudflare。檔案已存在時拒絕覆寫；新的部署週期應先保存舊紀錄再重新取得基準。

2026-11-02 實測：zone active、Worker routes 為空、首頁 200、`/chat`／`/chat/`／`/chat-other` 為 404；公開 DNS 和 HTTP cf-ray 顯示流量經過 Cloudflare。現有 Wrangler OAuth 權限對 DNS records API 返回 403，仍需在 Cloudflare Dashboard 檢查 apex DNS 的 proxied 設定與 origin。不能把 API 403 當成沒有 DNS 記錄。

完成備份／復原演練、DNS 檢查及 GitHub App 設定後，才進行正式發布。公開 Client ID 可用環境變數傳入（不是 Client Secret）：

```bash
# 先將 GITHUB_CLIENT_ID 設成已啟用 Device Flow 的公開 Client ID。
# 以下命令確實會發布，build 則只有 dry-run。
test -n "$GITHUB_CLIENT_ID" && npx wrangler deploy --var "GITHUB_CLIENT_ID:$GITHUB_CLIENT_ID"
npm run verify:deployment
```

`verify:deployment` 檢查實際 routes 精確符合範圍、未改掉其他 Worker routes、health 正常、網站可用，以及首頁和 `/chat-other` 的狀態／導向與基準一致。它不代替真實登入、多機台協作或全站內容驗收。部署前與部署後須使用同一份基準；本機檢查不能被稱為正式發布。


## 資料與復原

Room SQLite 保存房間、成員、邀請與訊息；Directory SQLite 保存憑證雜湊、短期登入交易、房間索引與限流狀態。訊息目前不自動過期。

Cloudflare SQLite-backed Durable Objects 提供過去 30 天的 PITR，但官方說明此功能不支援本機開發，因此不能把本機 eviction／重啟測試當作 PITR 復原證據。[官方 PITR 文件](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)

已提供私有維運入口與可攜式備份／空環境還原工具，本機跨 Worker 演練已通過；操作、權限重設與一致性界線見 [備份與復原](recovery.md)。遠端 service binding 與正式環境復原仍待驗證。不要直接把舊憑證與邀請資料還原至正式服務而忽略撤銷狀態。

## 本機 CLI 端到端測試

啟動 `npm run dev` 後，在另一個 terminal 執行 `node scripts/smoke-cli.mjs`。腳本限定使用 localhost:8787，透過 Wrangler local explorer 寫入僅用於測試的短效身分，再使用真正的 CLI 子程序與 HTTP API 驗證兩位使用者、三個 sessions 的協作。它不測試 GitHub 登入，也不會呼叫正式網域。測試資料保留於本機 `.wrangler/state`，CLI 暫存憑證目錄會清除。

## 已知房間的目錄修復

Directory 的 room_index 只是列表索引，Room 的 members 才是授權依據。若房間建立／加入已寫入 Room，但 Directory 寫入失敗，先以原 request_id／邀請碼重試原操作。若原請求已不可重試，房主可用保存的房間 ID 修復：

```bash
aichat room repair-index --room ROOM_ID
```

使用人的管理登入執行，不可使用 session token。命令自動以每批最多 100 位成員重建索引，失敗可從頭重跑。房間 ID 可從既有 session 設定對應的工作紀錄或邀請碼前段取得；服務不公開搜尋私人房間。

2026-11-02 本機演練已通過：建立兩位測試成員 → 刪除該房間 Directory 索引 → 確認列表遺失 → 由房主 CLI 修復 → 兩位成員重新看見房間。此演練只證明索引修復，不代表訊息備份／PITR 還原通過。全域災難復原仍須從備份中的房間清單逐一核對；不能只依賴已毀損的 Directory 列表找回所有 Room。
