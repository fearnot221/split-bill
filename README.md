# 分帳小工具 — 個人記帳分帳 Web App

單一帳本的記帳分帳工具：把朋友加進成員清單，記錄誰付了錢、怎麼分攤，自動算清誰欠誰。支援手機、平板、桌面（響應式設計＋深色模式）。

**線上版**：<https://bill.fearnot.tw>（自架伺服器，所有裝置共用同一份資料）

## 功能

- **單一帳本**：打開就能用，免註冊、免建立群組
- **記錄支出與收入**：項目、金額、日期、分類、付款人／收款人；收入以綠色「+」顯示
- **自訂類別**：內建餐飲/交通/住宿/購物/娛樂/其他，記帳視窗按「＋ 新類別」即可自行新增；管理面板可刪除未使用的類別
- **編輯支出**：點任一筆支出即可修改
- **彈性分帳**：均分（自動處理除不盡的餘數）、自訂每人分攤金額或不分攤；分攤成員可一鍵全選／全不選
- **轉帳與公帳**：記帳視窗選「轉帳」可把錢匯給特定成員，或存入內建的「公帳」；公帳也能當付款人記公費支出，結算頁直接顯示公帳餘額（轉帳不計入消費統計）
- **即時結餘**：每位成員的應收/應付一目了然
- **精簡轉帳結算**：自動計算「誰付給誰多少錢」；完成付款後可用「轉帳」記錄（不計入消費統計）
- **統計圖表**：以天為單位的日期區間（含近 7 天／近 30 天／本月快選），顯示支出、收入、淨額與分類佔比
- **搜尋與篩選**：關鍵字搜尋＋分類快篩
- **單據照片**：記帳時可附上單據，前端自動壓縮後上傳（存於 `uploads/`），列表以迴紋針標示
- **金額顏色**：支出紅、還款綠，一眼分辨
- **回收桶**：刪除的支出可從管理面板復原（清空回收桶會連單據檔案一併刪除）

## 管理面板

隱藏入口 `/admin`（主畫面沒有連結），第一次造訪時設定管理密碼，之後密碼登入（session 7 天、登入防爆破）。功能：

主畫面只保留記帳（支出/結算/統計），所有管理功能集中在這裡：

- **成員管理**：新增、改名（帳目跟著更新）、刪除；「公帳」為系統帳戶，可改名但不可刪除
- **類別管理**：新增、刪除（「其他」為備援類別、被支出使用中的類別不可刪）
- **帳本設定**：修改帳本名稱與顯示幣別
- **回收桶**：主畫面刪除的支出是軟刪除，這裡可復原、永久刪除或一鍵清空
- **變更密碼**

密碼以 scrypt 雜湊存在 `data.db` 的 `admin_config`；忘記密碼時在伺服器上刪掉該列即可重設：

```bash
sqlite3 data.db "DELETE FROM admin_config WHERE key='password'; DELETE FROM admin_sessions;"
```

## 執行

```bash
npm install
npm start
```

打開 http://localhost:3000 即可使用。開發模式（改檔自動重啟）：`npm run dev`，換埠號：`PORT=8080 npm start`。

資料存在伺服器的 `data.db`（SQLite，已列入 `.gitignore`），所有裝置連同一台伺服器即共用同一份帳本。

### 存取保護

本機可維持免登入使用；對外服務應設定 `APP_PASSWORD`，啟用整站 HTTP Basic Auth，帳目、API 與單據都會受到保護：

```bash
APP_USERNAME=ledger APP_PASSWORD='請使用足夠長的密碼' npm start
```

`APP_USERNAME` 預設為 `ledger`，`APP_PASSWORD` 至少需要 8 碼。管理面板密碼仍獨立存在，只負責成員、帳本設定與回收桶等管理操作。

`NODE_ENV=production` 時若未設定 `APP_PASSWORD`，服務會拒絕啟動。若已由 Cloudflare Access、VPN 或可信任的反向代理完成驗證，需明確設定 `ALLOW_PUBLIC_ACCESS=1` 才能略過內建密碼。

## 備份

使用內建指令同時備份資料庫與單據：

```bash
npm run backup
```

每次備份會建立新的 UTC 時間戳目錄，例如 `backups/2026-07-13T14-30-00-000Z/`，其中包含一致的 `data.db` 快照與完整的 `uploads/`。可用 `BACKUP_DIR` 指定其他備份根目錄：

```bash
BACKUP_DIR=/path/to/backups npm run backup
```

資料庫使用 WAL 模式，服務執行期間不可只複製專案根目錄的 `data.db`，否則可能漏掉尚在 `data.db-wal` 的已提交資料。備份指令透過 SQLite backup API 建立快照，可在服務運行時執行。還原時應先停止服務，以備份內的 `data.db` 和 `uploads/` 取代現有版本，並移除舊的 `data.db-wal`、`data.db-shm` 後再啟動。

若服務使用 `DB_PATH` 或 `UPLOAD_DIR` 指向自訂位置，執行備份時也要帶入相同環境變數。備份會核對資料庫引用的每一份單據；遇到備份期間正在替換的檔案會自動重試，持續不一致則直接失敗，不會產生表面成功但缺檔的備份。

## 部署到自己的伺服器

```bash
git clone https://github.com/fearnot221/split-bill.git
cd split-bill
npm install
NODE_ENV=production APP_PASSWORD='請使用足夠長的密碼' PORT=3000 npm start
```

建議用 systemd 常駐（`/etc/systemd/system/split-bill.service`）：

```ini
[Unit]
Description=split-bill
After=network.target

[Service]
WorkingDirectory=/opt/split-bill
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=NODE_ENV=production
EnvironmentFile=-/etc/split-bill.env
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

在 `/etc/split-bill.env` 設定 `APP_USERNAME` 與 `APP_PASSWORD`，並限制檔案權限。對外可使用 Cloudflare Tunnel 或 Nginx/Caddy；只有在應用程式前方確實只有一層可信任代理時才設定 `TRUST_PROXY=1`，讓 HTTPS session cookie 與來源 IP 判斷正確。

## 驗證

```bash
npm test
npm run verify
```

測試涵蓋整數分運算、收入／支出／轉帳、1 分錢結算、API 輸入驗證、整站密碼、管理權限、版本衝突與單據格式。

## 技術架構

| 層 | 技術 |
|---|---|
| 後端 | Node.js + Express |
| 資料庫 | SQLite（better-sqlite3，檔案存於 `data.db`） |
| 前端 | 原生 HTML / CSS / JS，無建置工具 |

### API 一覽

- `GET /api/me` — 取得（或自動建立）預設帳本
- `GET /api/groups/:id` — 取得帳本資料（成員、支出、結餘、結算方案）
- `PATCH /api/groups/:id` — 修改帳本名稱與幣別（管理員）
- `POST /api/groups/:id/members` — 新增成員（管理員）
- `DELETE /api/groups/:id/members/:memberId` — 刪除無帳務紀錄的成員（管理員）
- `POST /api/groups/:id/categories` — 新增類別
- `DELETE /api/groups/:id/categories/:categoryId` — 刪除未使用類別（管理員）
- `POST /api/groups/:id/expenses` — 新增支出
- `PUT /api/groups/:id/expenses/:expenseId` — 依版本編輯支出
- `DELETE /api/groups/:id/expenses/:expenseId?version=:version` — 依版本軟刪除支出
- `POST /api/groups/:id/expenses/:expenseId/receipt` — 依 body `version` 上傳或替換單據
- `DELETE /api/groups/:id/expenses/:expenseId/receipt?version=:version` — 依版本移除單據
- `/api/admin/*` — 管理登入、總覽、密碼與回收桶操作

設定 `APP_PASSWORD` 時所有端點都需要整站 Basic Auth；標示「管理員」的端點還需要 `/api/admin/login` 建立的 session。
