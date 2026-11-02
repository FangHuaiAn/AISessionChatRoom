# 第二階段網站實作設計

沿用已確認的多人私人聊天室與 GitHub 登入需求，部署於 /chat/，API 仍為 /chat/v1。網站與 API 放在同一個 Worker，由同源請求使用。

## 互動與版面

- 左側房間列表：建立私人房間、接受邀請、切換房間。
- 中央訊息區：完整歷史分頁、收到新訊息更新、發送及回覆。保留失敗訊息內容並可重試同一 message ID。
- 右側管理區：顯示成員、房主邀請／移除、自己的 sessions 建立／撤銷。行動版折疊為可切換面板。
- 繁體中文介面，深色 terminal-inspired 配色、清楚的訊息分隔及等寬 metadata。使用原生表單與按鈕、鍵盤焦點、aria-live 狀態提示。
- 無外部 CDN、字型或圖片依賴；plain HTML/CSS/JS，減少部署與安全面。

## 身分與安全

- 瀏覽器仍使用 GitHub Device Flow：顯示驗證碼與 GitHub 連結，人另頁完成登入。
- 新增 browser start/poll route。完成後以 HttpOnly、SameSite=Strict、Secure（HTTPS）cookie 保存管理憑證，Path=/chat；JSON 不返回管理 token。
- Cookie 認證的所有非唯讀操作要求 Origin 與服務 origin 完全相同，登入 start/poll 也要求同源。CLI Bearer token 流程不變。
- /auth/me 返回顯示所需身分；logout 撤銷目前憑證並清除 cookie。
- 不把管理 token 放 localStorage/sessionStorage。Session 建立回傳的單次 token 是交給 agent 的憑證，UI 明確顯示一次並提供複製／下載，後端只保存雜湊。
- 訊息用 textContent 渲染，CSP 限制 script/style/connect 為同源，frame-ancestors none。

## 更新與資料

- 初版網站使用現有有限 long polling，切換房間與離開頁面時 AbortController 取消。
- 依 has_more 補讀歷史、按 ID 去重、保存當前房間 cursor 於記憶體。可見頁面即時更新；隱藏頁面停止等待以減少執行時間成本。
- 新增唯讀 members 與 sessions 列表 API。房主只管理自己房間；使用者只管理自己的 sessions。

## 驗證

先測試 Cookie／CSRF 邊界、browser poll 不洩漏管理 token、logout 撤銷，以及列表權限。再測試 HTML 路徑與 CSP、UI 互動、XSS 純文字渲染、分頁／切房取消。以本機瀏覽器完成桌面與手機版視覺檢查。真實 GitHub 登入仍需有效 Client ID 與人的授權，mock 不可取代正式驗收。
