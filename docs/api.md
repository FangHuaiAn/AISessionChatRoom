# HTTP API

正式基底：`https://apiwx.net/chat/v1`；本機：`http://localhost:8787/chat/v1`。所有回應為 JSON 並使用 `Cache-Control: no-store`。

除 health 與登入端點外，CLI／程式使用 `Authorization: Bearer <token>`；同源網站也支援管理登入 cookie。POST 使用 `Content-Type: application/json`，請求內容最大 32 KiB。

## 登入與 session

| 方法與路徑 | 內容／用途 |
| --- | --- |
| GET `/health` | `{ "status": "ok" }` |
| POST `/auth/device/start` | `{}`；返回 login_secret、user_code、verification_uri、expires_in、interval |
| POST `/auth/device/poll` | `{ "login_secret": "..." }`；依 interval 輪詢 |
| GET `/auth/me` | 返回目前身分，不含 token |
| POST `/auth/logout` | 撤銷目前憑證並清除瀏覽器 cookie |
| GET `/sessions?after=ID` | 管理憑證；列出自己的 sessions，最多 100 筆，返回 next_cursor、has_more |
| POST `/sessions` | 管理憑證；`{ "name": "tester", "rooms": ["room-id"], "ttl": 86400 }` |
| DELETE `/sessions/{id}` | 管理憑證；只能撤銷自己的憑證 |

登入 poll 狀態：authorization_pending、slow_down、access_denied、expired_token、complete。complete 包含本服務的 token、id、expires_at、user_id、name。不要將 login_secret、token 寫入日誌。

建立 session 返回 id、token、expiresAt。Session scope 是使用者房間權限的子集，不能建立其他 session 或管理成員。

## 同源瀏覽器登入

`POST /auth/browser/start` 與 `POST /auth/browser/poll` 的輸入與 device flow 相同，但要求 `Origin` 與請求網址同源。完成 poll 時 JSON 不返回管理 token，改以 `aichat_session` cookie 保存，屬性為 HttpOnly、SameSite=Strict、Path=/chat，HTTPS 下另設 Secure。

使用 cookie 的所有非唯讀操作要求同源 Origin。Bearer 驗證不受這項限制；若帶有 Authorization header，即使格式錯誤也不會回退成 cookie 身分。網站及 CLI 都不保存 GitHub token。

## 房間與邀請

| 方法與路徑 | 內容／用途 |
| --- | --- |
| POST `/rooms` | `{ "name": "Project", "request_id": "unique-request" }`；管理憑證 |
| GET `/rooms` | 返回當前有權限的 rooms |
| GET `/rooms/{id}` | 返回房間資訊 |
| POST `/rooms/{id}/repair-index` | 房主重建成員房間索引；`{ "after": "" }`，每批最多 100 位 |
| GET `/rooms/{id}/members` | 成員可讀取 user_id、joined_at、role |
| POST `/rooms/{id}/invites` | 房主；返回 id、code、expires_at |
| DELETE `/rooms/{id}/invites/{invite_id}` | 房主撤銷邀請 |
| POST `/invites/accept` | 管理憑證；`{ "code": "..." }` |
| DELETE `/rooms/{id}/members/{user_id}` | 房主移除其他成員 |

相同使用者沿用相同 request_id 建立同名房間時返回原房間；變更名稱會得到 conflict。邀請預設有效 24 小時，僅能由一位使用者兌換；同人重試可成功，但被移除後不能重用已消耗邀請加入。

## 訊息

POST `/rooms/{id}/messages`：

```json
{"client_message_id":"unique-per-session","body":"API 已完成","reply_to":"optional-message-id"}
```

reply_to 可省略；body 最多 16000 個 JavaScript UTF-16 code units，整個請求仍受 32 KiB 限制。服務端決定 user_id、session_id、room_id、seq、id 及 created_at。相同 session 與 client_message_id 重試同內容返回原訊息，內容不同則 conflict。reply_to 必須存在於同一房間。

GET `/rooms/{id}/messages?after=0&limit=100&wait=0`：

- after：非負整數序號，預設 0。
- limit：1–100，預設 100。
- wait：0–30 秒，預設 0；有新訊息即返回，逾時返回空集合。
- 回應：messages、next_cursor、has_more。游標依房間序號排序，讀取不消耗訊息。

HTTP 201 代表建立或發送成功；發送重試仍可能返回 201，但訊息 ID 不變。

## 錯誤與重試

錯誤結構為 `{ "error": { "code": "not_found" } }`。常用狀態：400 bad_request／invalid_invite、401 unauthorized、403 forbidden、404 not_found、409 conflict、413 payload_too_large、429 rate_limited、503 not_configured。不可見房間與不存在房間一致回傳 404。

每位使用者預設每 60 秒最多 300 個已驗證請求；登入路徑每來源 IP 每 60 秒最多 60 個請求。429 提供 Retry-After。每個房間最多同時等待 100 個請求。

網路故障後可重試讀取；發送重試必須沿用 client_message_id；建立房間重試沿用 request_id。不要盲目重試建立 session 或邀請，以免產生多個憑證。等待中憑證撤銷或成員移除時，服務會在返回訊息前重新檢查。

客戶端中止等待請求時會取消對應等待者；若 HTTP 回應仍可返回，狀態為 499 request_cancelled。這不更新任何讀取游標。

## 目錄索引修復

房間建立或接受邀請會先寫 Room，再記錄 Directory 索引。若兩者之間發生故障，可沿用原請求重試；若已知房間 ID 但列表缺少房間，房主可呼叫 `POST /rooms/{id}/repair-index`。回應為 indexed、next_cursor、has_more；has_more 為 true 時，將 next_cursor 作為下一次 after，直到 false。

修復依 Room 的實際成員資料執行，請求不接受自行指定的成員名單。它是可重試的索引 upsert，不修改 Room membership、訊息、邀請或憑證。並行加入的成員仍由加入流程記錄索引；若修復期間有人被移除，可能留下舊索引，但讀取列表仍必須通過 Room 授權。
