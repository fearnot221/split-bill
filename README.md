# 分帳趣 — 個人記帳分帳 Web App

單一帳本的記帳分帳工具：把朋友加進成員清單，記錄誰付了錢、怎麼分攤，自動算清誰欠誰。支援手機、平板、桌面（響應式設計＋深色模式）。

**線上版**：<https://bill.fearnot.tw>（GitHub Pages 靜態版，資料存為私人 repo `split-bill-data` 的 `data.json`，跨裝置同步）

## 功能

- **單一帳本**：打開就能用，免註冊、免建立群組
- **記錄支出**：項目、金額、日期、分類（餐飲/交通/住宿/購物/娛樂/其他）、付款人
- **編輯支出**：點任一筆支出即可修改
- **彈性分帳**：均分（自動處理除不盡的餘數）或自訂每人分攤金額
- **即時結餘**：每位成員的應收/應付一目了然
- **最少轉帳結算**：自動計算「誰付給誰多少錢」，按「已還款」一鍵記錄還款（還款不計入消費統計）
- **統計圖表**：依月份篩選，查看分類佔比與每位成員的付款/分攤金額
- **搜尋與篩選**：關鍵字搜尋＋分類快篩
- **CSV 匯出**：一鍵下載完整帳目（Excel 可直接開啟）

## 兩種執行方式

| 模式 | 資料存放 | 適用情境 |
|---|---|---|
| **靜態版**（`docs/`，GitHub Pages） | 私人 repo `split-bill-data` 的 `data.json`（GitHub Contents API） | 免自架伺服器，跨裝置同步，改動有完整 git 歷史可回溯 |
| **伺服器版**（`server.js`） | SQLite（`data.db`） | 本機或自架伺服器 |

### 靜態版（GitHub Pages）

資料層在 `docs/remote-store.js`：瀏覽器直接讀寫 `fearnot221/split-bill-data` 私人 repo 的 `data.json`，每次修改都是一個 commit。localStorage 只存連線設定（token），不存帳目。

第一次在某台裝置使用時需輸入 Fine-grained Personal Access Token：

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
2. Repository access 只選 `split-bill-data`
3. Permissions 給 **Contents: Read and write**
4. 貼進網頁的連線設定畫面即可

同一份 token 可在多台裝置使用；在「成員」分頁最下方可中斷連線。寫入衝突（兩台裝置同時記帳）會自動重拉最新資料再套用。

前端改完後執行 `npm run build:pages`，會把 `public/` 的前端複製到 `docs/` 並注入 `remote-store.js`，推上 GitHub 後由 Pages 服務（main 分支 `/docs` 目錄，自訂網域設定在 `docs/CNAME`）。

### 伺服器版

```bash
npm install
npm start
```

打開 http://localhost:3000 即可使用。開發模式（改檔自動重啟）：`npm run dev`，換埠號：`PORT=8080 npm start`。

## 技術架構

| 層 | 技術 |
|---|---|
| 後端 | Node.js + Express |
| 資料庫 | SQLite（better-sqlite3，檔案存於 `data.db`） |
| 前端 | 原生 HTML / CSS / JS，無建置工具 |

### API 一覽

- `GET /api/me` — 取得（或自動建立）預設帳本
- `GET /api/groups/:id` — 取得帳本資料（成員、支出、結餘、結算方案）
- `PATCH /api/groups/:id` — 修改帳本名稱
- `GET /api/groups/:id/export` — 匯出 CSV
- `POST /api/groups/:id/members` — 新增成員
- `DELETE /api/groups/:id/members/:memberId` — 刪除成員（無帳務紀錄者）
- `POST /api/groups/:id/expenses` — 新增支出
- `PUT /api/groups/:id/expenses/:expenseId` — 編輯支出
- `DELETE /api/groups/:id/expenses/:expenseId` — 刪除支出
