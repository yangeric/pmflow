# 第一次部署：從程式碼到 NAS 跑起來

三個階段：**上 GitHub → Actions 自動 build 推映像 → NAS 拉來跑**。
Docker 映像不用你自己 build，也不用在本機裝 buildx——Actions 會做，而且會同時出
`linux/amd64` 與 `linux/arm64`（很多 NAS 是 ARM）。

---

## 階段一：推上 GitHub

在解壓出來的 `pmflow` 資料夾裡執行。若你拿的是含 `.git` 的版本，前三行可以跳過。

```bash
git init
git add -A
git commit -m "feat: PMFlow 初版"

git branch -M main
git remote add origin https://github.com/<你的帳號>/pmflow.git
git push -u origin main
```

repo 要**先在 GitHub 上建好**（空的，不要勾 README／.gitignore／LICENSE，
不然第一次 push 會衝突）。選 **Public**——Actions 分鐘數無限、GHCR 免費，
而且 NAS 拉映像不用先登入。

推上去之後 `ci.yml` 會自動跑：型別檢查、排程引擎測試、端對端 API 測試、
授權白名單、migration 只加不改檢查、弱點掃描。

---

## 階段二：發第一個版本

```bash
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` 被觸發，做這些事：

1. 交叉編譯 `linux/amd64` + `linux/arm64`
2. 推到 `ghcr.io/<你的帳號>/pmflow-api` 與 `pmflow-web`
3. 產生 SBOM 與供應鏈簽章
4. Trivy 掃描並上傳結果到 Security 分頁
5. 建立 GitHub Release，內容含部署指令

跑完到 repo 首頁右側 **Packages** 就看得到兩個映像。

### 讓映像變成公開

GHCR 的 package **預設是私有的**，即使 repo 是公開的。不改的話 NAS 拉不到。

Packages → 點進 `pmflow-api` → 右側 Package settings →
Danger Zone → **Change visibility → Public**。兩個映像各做一次，只需做這一次。

---

## 也要推 Docker Hub（可選）

你需要準備兩樣東西：

| 要準備 | 哪裡拿 |
|---|---|
| **Docker Hub 帳號** | https://hub.docker.com 註冊，記下 username |
| **Access Token** | 登入後 → 右上頭像 → **Account settings** → **Personal access tokens** → **Generate new token**，權限選 **Read & Write** |

⚠️ 用 access token，**不要用登入密碼**。token 可以單獨撤銷，密碼不行。

拿到之後回 GitHub：repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**，加兩個：

| Name | Value |
|---|---|
| `DOCKERHUB_USERNAME` | 你的 Docker Hub 帳號 |
| `DOCKERHUB_TOKEN` | 剛才產的 access token |

加完之後，下一次打 tag 就會**同時**推 GHCR 和 Docker Hub。
沒設這兩個 secret 的話 workflow 會自動跳過 Docker Hub，不會失敗。

> **建議 NAS 還是拉 GHCR。** Docker Hub 的匿名拉取有速率限制（每 IP 每 6 小時 100 次），
> 免費帳號登入後 200 次。GHCR 對公開映像沒有這個限制。Docker Hub 當作
> 給別人找得到的鏡像就好。

---

## 階段三：NAS 部署

NAS 上不需要 clone 整個 repo，只要三個檔案。

```bash
mkdir -p /volume1/docker/pmflow && cd /volume1/docker/pmflow

curl -O https://raw.githubusercontent.com/<你的帳號>/pmflow/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/<你的帳號>/pmflow/main/.env.example

cp .env.example .env
openssl rand -base64 48        # 產生 JWT_SECRET，貼進 .env
id <你的NAS帳號>                # 查 PUID / PGID，填進 .env
nano .env                      # 至少改 POSTGRES_PASSWORD、JWT_SECRET、IMAGE_OWNER、PUID/PGID、PMFLOW_BASE_URL

docker compose pull
docker compose up -d
docker compose logs -f api     # 看 migration 有沒有跑過
```

瀏覽 `http://<NAS_IP>:8480`，第一個註冊的人自動成為 OWNER。

### 想改拉 Docker Hub 的話

`.env` 改兩行即可，compose 不用動：

```bash
REGISTRY=docker.io
IMAGE_OWNER=<你的 Docker Hub 帳號>
```

### NAS 上最常卡住的三件事

1. **Port 被佔**：Synology DSM 用掉 80/443/5000/5001，所以預設對外映 8480/8443。
   衝突就改 `.env` 的 `HTTP_PORT`。
2. **PUID/PGID 沒設**：附件寫不進去。`id 你的帳號` 查，Synology 常是 `1026:100`。
3. **PostgreSQL 資料放到 SMB/CIFS 掛載點**：fsync 語意不保證，資料庫遲早壞。
   一定要落在本機 Btrfs/ext4。

---

## 之後的升級

「改架構」和「換程式」拆成兩個可分別回滾的動作（理由見 `MIGRATIONS.md`）：

```bash
# 0. 升級前手動備份一次
docker compose exec -T db pg_dump -U pmflow --no-owner pmflow | gzip > pre-upgrade.sql.gz

# 1. 只跑 migration
docker compose run --rm api npm run migrate

# 2. 沒問題再換 image
docker compose pull && docker compose up -d
```

**回滾**只要退版本，不需要反向 migration：

```bash
PMFLOW_VERSION=v0.1.0 docker compose up -d
```

> 不建議掛 Watchtower 自動更新。半夜自動升級遇到 migration 失敗會很難救，
> 手動 `pull && up -d` 是刻意的選擇。
