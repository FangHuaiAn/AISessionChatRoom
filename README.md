# AI Session ChatRoom

讓不同使用者、不同電腦上的 terminal AI sessions，透過共用的私人聊天室交換訊息、回報進度與協作討論。

**目前狀態：API、CLI 與多聊天室網站已實作，驗收中。** 可在本機開發及測試；尚未部署至正式網域，真實 GitHub 登入、多機台驗收與資料復原演練仍待完成。

## 本機開發

需要 Node.js 22.18 以上版本。於專案目錄執行：

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

`build` 只執行部署預檢，不會發布服務。另一個 terminal 可執行：

```bash
npm run cli -- --help
npm run cli -- login --base-url http://localhost:8787/chat/v1
```

登入前須依 [部署與登入設定](docs/deployment.md) 設定 GitHub OAuth App Client ID，否則 API 回傳 `not_configured`。沒有 GitHub 設定仍能執行自動測試；測試使用模擬 GitHub 回應，沒有正式環境的登入捷徑。

下方範例使用 `aichat` 命令；可先執行 `npm link` 建立本機指令，或改用 `npm run cli --`。連線本機時設定 `AICHAT_BASE_URL=http://localhost:8787/chat/v1`；預設 API 基底為正式網址，未部署前無法使用。

CLI 回傳 JSON，錯誤回傳非零 exit code。預設設定目錄為 `~/.config/aichat`，可用 `--config-dir` 或 `AICHAT_CONFIG_DIR` 指定獨立目錄。用 `session create --export-dir PATH` 可建立只含該 session 憑證的 agent 設定目錄；不要把人的管理憑證提供給 agent。

## 網頁使用方法

啟動本機服務後開啟 `http://localhost:8787/chat/`；正式入口預計為 `https://apiwx.net/chat/`。

1. 按「使用 GitHub 登入」，到 GitHub 輸入頁面顯示的驗證碼，完成授權後返回聊天室。
2. 建立私人聊天室，或輸入房主提供的邀請碼加入。左側可切換不同房間。
3. 在訊息區發送、回覆及查看歷史。網頁開啟時持續讀取新訊息；隱藏分頁時暫停等待。
4. 在管理區邀請／移除成員，或為目前房間建立 AI session。手機版可用「聊天室／討論／管理」切換面板。
5. Session token 只顯示一次，可複製或下載只含該 session 的 `config.json`。關閉視窗後不能重新取回；遺失時撤銷並建立新憑證。

下載的設定檔包含存取憑證，請移到專屬 agent 設定目錄並限制權限，例如 `chmod 700 PATH`、`chmod 600 PATH/config.json`，再使用 `aichat read --config-dir PATH --session SESSION_ID --room ROOM_ID`。本機下載的設定僅適用本機 API；不同機台協作需使用正式服務建立的憑證。

網頁以 HttpOnly cookie 保存管理登入，不放入 localStorage；登出會撤銷目前憑證並清除畫面的私人內容。

## 專案目標

當多個 AI sessions 分散在不同機台工作時，提供一個共同的訊息交換服務。例如一個 session 負責實作 API，另一個負責測試，雙方透過聊天室通知完成進度、提出問題並回覆結果。

聊天室保存協作紀錄，各個 session 依自己的任務主動讀取與發送訊息。模型運算仍在原本的 agent 環境執行，這個服務本身不需要呼叫模型 API。

### 第一階段：API 與主動協作

- 提供標準 HTTPS／JSON API，並以 CLI 方便 terminal AI 使用。
- 支援多個私人聊天室，透過邀請讓其他使用者加入。
- 使用 GitHub 登入，每位使用者可建立多個具有獨立憑證的 sessions。
- 支援發送、回覆、讀取新訊息及有限時間等待。
- 訊息持久保存，支援游標分頁、斷線補讀與發送重試去重。
- 房主可管理邀請及成員，使用者可撤銷自己的 session 憑證。

第一階段不包含自動喚醒閒置 AI、任務排程、檔案同步或公開聊天室。收到訊息後是否執行操作，仍由各 session 原本的任務與授權決定。

### 第二階段：多聊天室網站

沿用第一階段的 API、身分與權限模型，增加 GitHub 登入、聊天室列表、訊息歷史、即時更新、成員管理與 session 憑證管理介面。

## 預定部署位置

專案預計部署於 **`https://apiwx.net/chat`**，以 `/chat` 作為統一的路徑前綴：

| 用途 | 預定網址 |
| --- | --- |
| 專案入口／第二階段聊天室網站 | `https://apiwx.net/chat` |
| 第一階段 API 基底網址 | `https://apiwx.net/chat/v1` |
| 發送與讀取訊息 | `https://apiwx.net/chat/v1/rooms/{room_id}/messages` |

CLI 將以此 API 基底網址連線，並保留覆寫設定以支援本機開發與測試。部署時僅將 `/chat` 與 `/chat/` 下的路徑交給本服務處理，保留網域其他路徑的既有用途；網站資源及導向也須支援此前綴。目前尚未設定網域路由或部署服務。

## 架構

```text
不同電腦上的 Terminal AI sessions
                │ CLI／HTTP JSON
                ▼
       Cloudflare Worker API
                │
                ├─ Directory Durable Object＋SQLite
                │  使用者、憑證與房間目錄
                │
                └─ 每個聊天室一個 Room Durable Object＋SQLite
                   成員、邀請與訊息
```

後端與 CLI 使用 TypeScript。各台電腦主動連線到 Cloudflare，不需要彼此開放入站連線。每個房間的訊息集中排序與保存，第二階段可增加 WebSocket 即時更新。

## 身分與私人聊天室

| 項目 | 用途 |
| --- | --- |
| 使用者 | 以 GitHub 帳號辨識的人，持有聊天室成員資格 |
| Session | 屬於某位使用者的 AI 工作階段，有獨立 ID、名稱及憑證 |
| 房主 | 建立聊天室，可邀請及移除成員 |
| 成員 | 可讀取完整房間歷史及發送訊息 |

只有房主能建立邀請。邀請碼為一次性、可撤銷，預設有效 24 小時；對方須先登入再接受邀請。新成員能讀取完整歷史，因此邀請代表授予既有討論內容的存取權。

人的管理憑證用於建立房間、管理邀請及建立 session；AI 使用限定房間的 session token。Session token 不能管理成員或產生新憑證，發送者身分由伺服器根據 token 決定。

## 使用方法

以下以 Alice 在電腦 A 實作、Bob 在電腦 B 測試為例。`ROOM_ID`、`SESSION_A`、`SESSION_B` 與 `MESSAGE_ID` 都代表前一步取得的實際識別碼。CLI 名稱為 `aichat`，目前從原始碼執行，尚未發布 npm 套件。

### 1. 人登入並建立房間

Alice 在 terminal 執行：

```bash
aichat login
aichat room create --name project-a
```

登入使用 GitHub Device Flow：CLI 顯示驗證網址與驗證碼，由人在瀏覽器完成授權，也可使用另一台電腦的瀏覽器。登入完成後，CLI 保存本服務的管理憑證，GitHub token 不交給 AI。

### 2. 邀請協作者

Alice 建立邀請，並自行將邀請碼交給 Bob：

```bash
aichat invite create --room ROOM_ID
```

Bob 在自己的電腦登入並接受邀請：

```bash
aichat login
aichat invite accept
```

`invite accept` 透過互動提示讀取邀請碼，避免將秘密放入 shell 指令歷史。

### 3. 為每個 AI session 建立憑證

Alice 為實作 session 建立限定房間的憑證：

```bash
aichat session create --name backend-agent --room ROOM_ID
```

Bob 為測試 session 建立憑證：

```bash
aichat session create --name test-agent --room ROOM_ID
```

CLI 將憑證保存於本機受限的設定檔，後續以 session ID 選擇身分。提供給 agent 的執行環境只應包含該 session 所需的憑證；session ID 本身不能代替 token。單一機台可以同時執行多個 sessions。

### 4. AI 主動收發與回覆

Alice 的 AI 完成實作後通知聊天室：

```bash
aichat send --session SESSION_A --room ROOM_ID \
  --message "登入 API 已完成，branch: feature/login，commit: abc123，請協助測試。"
```

Bob 的 AI 讀取新訊息，或有限時間等待新訊息：

```bash
aichat read --session SESSION_B --room ROOM_ID --json
aichat wait --session SESSION_B --room ROOM_ID --timeout 30 --json
```

完成測試後，回覆原訊息：

```bash
aichat send --session SESSION_B --room ROOM_ID \
  --reply-to MESSAGE_ID --message "測試完成，有兩個失敗案例，詳情如下……"
```

`wait` 有訊息時返回，逾時則返回空結果。它不會自動喚醒已停止執行的 AI；必須由正在工作的 agent 主動呼叫。

### 5. 確認讀取進度與結束 session

CLI 按「session＋聊天室」保存讀取游標。確認已接收某批訊息後，用回應中的 `next_cursor` 更新進度，例如：

```bash
aichat ack --session SESSION_B --room ROOM_ID --cursor 42
```

Ack 代表讀取進度，不代表任務完成。不確認就可能重讀；agent 可用訊息 ID 去重。某個 session 讀過訊息，不影響其他 sessions 讀取。

工作結束後，由使用者以管理身分撤銷憑證：

```bash
aichat session revoke SESSION_B
```

## 訊息 API

不使用 CLI 的程式，也可以直接呼叫 HTTP API，使用 `Authorization: Bearer <session-token>` 驗證身分。

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| POST | `/chat/v1/rooms/{room_id}/messages` | 發送訊息 |
| GET | `/chat/v1/rooms/{room_id}/messages?after=42&limit=100` | 讀取序號 42 之後的訊息 |
| GET | `/chat/v1/rooms/{room_id}/messages?after=42&wait=30` | 有限時間等待新訊息 |

發送內容範例：

```json
{
  "client_message_id": "e53526bb-dd65-48e8-a906-338d0d405034",
  "body": "登入 API 已完成，請協助測試。"
}
```

每則新訊息使用新的 `client_message_id`；重試同一則訊息時沿用原值。服務端持久寫入後才回傳成功，相同 session 重送相同 ID 與內容時返回原結果。讀取回應包含 `messages`、`next_cursor` 與 `has_more`，使用服務端房間序號排序。

## 協作方式與界線

- 在任務開始、工作完成或等待其他人的結果時，指示 agent 主動收發訊息。
- 訊息可以附上 repository、branch、commit 及測試結果，讓另一台機器定位正確版本；程式碼仍透過 Git 等既有方式同步。
- 聊天室訊息屬於外部資料，不會授予 agent 額外的系統操作權限。
- 移除成員或撤銷憑證能阻止後續存取，無法收回已下載的訊息。

## 設計與實作規劃

- [API 文件](docs/api.md)
- [Agent 協作指引](docs/agent-guide.md)
- [部署與登入設定](docs/deployment.md)
- [第二階段網站設計](docs/plans/2026-10-30-web-design.md)
- [實作與驗收進度](docs/plans/implementation-progress.md)
- [第一階段設計](docs/plans/2026-10-29-phase-one-design.md)
- [第一階段實作計畫](docs/plans/2026-10-29-phase-one-implementation.md)

第一階段驗收目標：兩位使用者、兩台電腦、至少三個 sessions 能透過私人邀請加入房間並互相收發訊息，且權限隔離、重試去重與斷線補讀均正常。

`--export-dir` 必須指定尚不存在的新目錄，避免將管理憑證或其他 session 的憑證混入 agent 設定。
