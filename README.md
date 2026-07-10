# 分帳趣 — 個人記帳分帳 Web App

單一帳本的記帳分帳工具：把朋友加進成員清單，記錄誰付了錢、怎麼分攤，自動算清誰欠誰。支援手機、平板、桌面（響應式設計＋深色模式）。

**線上版**：<https://bill.fearnot.tw>（自架伺服器，所有裝置共用同一份資料）

## 功能

- **單一帳本**：打開就能用，免註冊、免建立群組
- **記錄支出**：項目、金額、日期、分類、付款人
- **自訂類別**：內建餐飲/交通/住宿/購物/娛樂/其他，記帳視窗按「＋ 新類別」即可自行新增；管理面板可刪除未使用的類別
- **編輯支出**：點任一筆支出即可修改
- **彈性分帳**：均分（自動處理除不盡的餘數）或自訂每人分攤金額
- **即時結餘**：每位成員的應收/應付一目了然
- **最少轉帳結算**：自動計算「誰付給誰多少錢」，按「已還款」一鍵記錄還款（還款不計入消費統計）
- **統計圖表**：依月份篩選，查看分類佔比與每位成員的付款/分攤金額
- **搜尋與篩選**：關鍵字搜尋＋分類快篩
- **CSV 匯出**：一鍵下載完整帳目（Excel 可直接開啟）
- **回收桶**：刪除的支出可從管理面板復原

## 管理面板

隱藏入口 `/admin`（主畫面沒有連結），第一次造訪時設定管理密碼，之後密碼登入（session 7 天、登入防爆破）。功能：

- **成員管理**：改名（帳目跟著更新）、新增、刪除
- **類別管理**：新增、刪除（「其他」為備援類別、被支出使用中的類別不可刪）
- **回收桶**：主畫面刪除的支出是軟刪除，這裡可復原或永久刪除
- **變更密碼**

密碼以 scrypt 雜湊存在 `data.db` 的 `admin_config`；忘記密碼時在伺服器上刪掉該列即可重設：

```bash
sqlite3 data.db "DELETE FROM admin_config WHERE key='password'"
```

## 執行

```bash
npm install
npm start
```

打開 http://localhost:3000 即可使用。開發模式（改檔自動重啟）：`npm run dev`，換埠號：`PORT=8080 npm start`。

資料存在伺服器的 `data.db`（SQLite，已列入 `.gitignore`），所有裝置連同一台伺服器即共用同一份帳本；備份直接複製 `data.db` 或用網頁裡的「匯出 CSV」。

## 部署到自己的伺服器

```bash
git clone https://github.com/fearnot221/split-bill.git
cd split-bill
npm install
PORT=3000 npm start
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
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

對外可用 Cloudflare Tunnel（`cloudflared tunnel --url http://localhost:3000` 綁 `bill.fearnot.tw`）或反向代理（Nginx/Caddy）＋ DNS A 記錄。注意：App 本身沒有登入機制，公開到網際網路前建議加一層保護（Cloudflare Access、basic auth 或僅限內網/VPN）。

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
