# 学校服务器 / 云服务器部署手册（含权限申请清单）

适合“正式活动、要稳定、要微信 openid、要长期保存数据”的场景。整体架构：

```
用户(手机/微信) ──https──► Nginx(443) ──http──► Node 进程(127.0.0.1:8787) ──► SQLite 文件
                                   │
                                   └── /img 静态图片可直接由 Nginx 托管（可选）
```

---

## 1. 先搞清楚要申请什么

### 1.1 资源与权限清单

| # | 需要的东西 | 找谁申请 | 具体权限/材料 | 大概耗时 |
| --- | --- | --- | --- | --- |
| 1 | 活动线上发布审批 | **学院团委 / 学生会指导老师** | 活动名称、投票规则、奖项、数据使用说明；有时需要盖章的活动通知 | 1–3 天 |
| 2 | Linux 服务器（或容器） | **学校信息化办 / 网络中心**（或学院自购云主机） | 一台 2C2G 起、Ubuntu 22.04/Debian 12、能装 Node 24 | 1–5 天 |
| 3 | 登录账号 + 目录 | 同上 | SSH 账号；`/var/www/campus-vote` 的读写权限；建议单独 `vote` 用户 | 同上 |
| 4 | 端口放行 | 同上（网络安全组/防火墙） | 内网放行 `8787`（只给 Nginx 用），公网放行 **443**（80 用于跳转/证书续签） | 1–2 天 |
| 5 | 域名（子域） | **学校信息化办**（学校域名）或 **云厂商**（自购域名） | 一条 A 记录：`vote.xxx.edu.cn → 服务器 IP`；你要有**解析记录添加权限** | 1–3 天 |
| 6 | ICP 备案 | 学校域名一般已备案（用子域即可）；自购域名需 **云厂商备案系统** | 主体证件、负责人身份证、核验拍照、承诺书 | **7–20 天**（务必提前） |
| 7 | HTTPS 证书 | 学校统一证书（信息化办）或 **Let's Encrypt 免费证书** | 证书 + 私钥文件放服务器；或给 Nginx 配 certbot 自动续期权限 | 当天 |
| 8 | 微信公众号（"哲样青春"） | **公众号管理员（学院宣传/新媒体负责人）** | ① 公众号后台 → 设置与开发 → 公众号设置 → 功能设置 → **网页授权域名** 填 `vote.xxx.edu.cn`（需上传 `MP_verify_xxx.txt` 到域名根目录）② 开发 → 基本配置 → **AppID / AppSecret**（生成后只显示一次）③ 若开了 IP 白名单，需把服务器**公网出口 IP** 加进去 | 1–2 天 |
| 9 | systemd 服务权限（可选） | 运维 | 允许你自己 `systemctl enable campus-vote`，或请运维代建 | 当天 |

> 只要用**微信 openid 模式**，第 8 项是硬门槛：**需要认证的服务号**（订阅号没有网页授权），且域名必须能通过微信的域名校验（一般要求已备案 + https）。

### 1.2 一句话结论

- **什么都有现成的**（学校已给服务器 + 子域 + 证书 + 认证服务号）：直接跳到第 3 节，1 天内可上线。
- **只有服务器没有域名/公众号**：先用 Cookie 模式跑起来（第 3 节不做第 6 步），openid 以后再加。
- **什么都没有**：先用 Render 免费版做活动（见 README 第 5 节），正式评选再迁移。

---

## 2. 环境准备（由运维或你执行）

```bash
# 1) 建用户与目录
sudo useradd -m -s /bin/bash vote || true
sudo mkdir -p /var/www/campus-vote
sudo chown -R vote:vote /var/www/campus-vote

# 2) 装 Node 24（推荐用 NodeSource 源）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # 期望 v24.x

# 3) 装 Nginx（若用学校统一反代则跳过）
sudo apt-get install -y nginx
```

> 服务器不能上外网时，让运维提供**内网 npm 镜像**，或直接把 `node` 二进制包拷进去（本项目零依赖，只需要 node 本体）。

---

## 3. 部署步骤

### 3.1 上传代码

```bash
# 方式 A：git（推荐，后续更新一条命令）
sudo -u vote git clone <你的仓库地址> /var/www/campus-vote

# 方式 B：本地打包上传
# 本地执行：tar czf campus-vote.tar.gz campus-vote
# 上传后：sudo -u vote tar xzf campus-vote.tar.gz -C /var/www
```

### 3.2 配置环境变量

```bash
sudo tee /etc/campus-vote.env > /dev/null <<'EOF'
NODE_ENV=production
PORT=8787
PUBLIC_BASE_URL=https://vote.xxx.edu.cn
VOTE_DEADLINE=2026-11-24T23:59:59+08:00
VOTE_DEADLINE_LABEL=11 月 24 日 24:00
VOTE_WINDOW_MODE=calendar
ADMIN_PASSWORD=换成强密码
WX_APPID=wx____________
WX_SECRET=____________
DB_PATH=/var/www/campus-vote/data/votes.db
EOF
sudo chmod 600 /etc/campus-vote.env
sudo chown root:root /etc/campus-vote.env
```

### 3.3 首次启动自检

```bash
cd /var/www/campus-vote
sudo -u vote env $(cat /etc/campus-vote.env | xargs) node --experimental-sqlite server.js
# 另开终端：curl -s localhost:8787/healthz   → 应输出 ok
```

### 3.4 交给 systemd 守护

```bash
sudo cp deploy/campus-vote.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now campus-vote
sudo systemctl status campus-vote
sudo journalctl -u campus-vote -f      # 看日志
```

### 3.5 Nginx 反代 + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/campus-vote.conf
sudo vi /etc/nginx/conf.d/campus-vote.conf   # 改 server_name / 证书路径
sudo nginx -t && sudo systemctl reload nginx
```

用 Let's Encrypt（学校没有统一证书时）：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d vote.xxx.edu.cn
sudo systemctl list-timers | grep certbot    # 自动续期
```

### 3.6 微信网页授权域名（openid 模式必做）

1. 把微信给的校验文件放到 `public/MP_verify_xxxx.txt`（随项目部署，可通过 `https://vote.xxx.edu.cn/MP_verify_xxxx.txt` 访问）
2. 公众号后台 → 设置与开发 → 公众号设置 → 功能设置 → **网页授权域名** → 填 `vote.xxx.edu.cn`（不带 https、不带路径）
3. 若公众号开了 IP 白名单：把服务器公网出口 IP 加进去（`curl ifconfig.me` 查看）
4. 重新部署生效后，在微信里打开首页，应无感知地完成授权（不弹窗）

> 注意：`PUBLIC_BASE_URL` 必须与网页授权域名完全一致，否则回调会失败。

---

## 4. 验收清单（上线前逐条打勾）

- [ ] `https://vote.xxx.edu.cn/healthz` 返回 `ok`
- [ ] 手机 4G 打开首页，6 张卡片图正常、无横向滚动
- [ ] 点投票 → 确认 → 提示“今日已完成投票，请明天再来” → 所有按钮置灰
- [ ] 同一手机再投被拒；换手机可投（说明按身份不按 IP）
- [ ] `https://vote.xxx.edu.cn/admin` 能登录，能看到刚才的记录（含 IP）
- [ ] 导出两份 CSV，Excel 打开中文不乱码
- [ ] 微信内打开首页，`/api/me` 的 `identityType` 为 `wechat`（说明 openid 生效）
- [ ] 把 `VOTE_DEADLINE` 临时改成 1 分钟后，验证截止置灰与 403

---

## 5. 备份与数据安全

SQLite 是单文件，备份很简单，但**别直接 cp**（可能拷到写入中途的页），用官方 `.backup`：

```bash
# /usr/local/bin/vote-backup.sh
#!/usr/bin/env bash
set -e
DB=/var/www/campus-vote/data/votes.db
OUT=/var/backups/campus-vote
mkdir -p "$OUT"
sqlite3 "$DB" ".backup '$OUT/votes-$(date +%F-%H%M).db'"
find "$OUT" -name 'votes-*.db' -mtime +14 -delete
```

```bash
sudo chmod +x /usr/local/bin/vote-backup.sh
# 每小时备份一次
echo "0 * * * * root /usr/local/bin/vote-backup.sh" | sudo tee /etc/cron.d/campus-vote-backup
```

另外：**截止前每天**在后台点一次「导出票数 CSV / 导出明细」，存一份到群文件或网盘，双保险。

---

## 6. 更新与回滚

```bash
cd /var/www/campus-vote
sudo -u vote git pull
sudo systemctl restart campus-vote      # 只有改 server.js/src 才需要重启；只换图片不用

# 回滚
sudo -u vote git log --oneline -5
sudo -u vote git checkout <上一个提交>
sudo systemctl restart campus-vote
```

**改内容要不要重启？**

| 改动 | 是否需要重启 | 生效方式 |
| --- | --- | --- |
| `data/players.json`（作品名、阐述、序号、图片路径、增删作品） | **不需要** | 保存文件即热加载，刷新页面可见（终端会打印 `[players] 已加载 N 个作品`） |
| `public/img/` 里的图片 | **不需要** | 覆盖文件后强刷（Ctrl+F5）；Nginx 对 `/img/` 有 7 天缓存，可先清 CDN/浏览器缓存 |
| `server.js` / `src/*` 代码 | 需要 | `sudo systemctl restart campus-vote` |
| `/etc/campus-vote.env`（密码、截止时间、公众号参数） | 需要 | 同上 |

> 热加载有安全网：JSON 写坏时服务会继续用上一版并在日志里报错，不会导致白屏；改完 `journalctl -u campus-vote -n 20` 看一眼即可。

---

## 7. 常见故障

| 现象 | 排查 |
| --- | --- |
| 502 Bad Gateway | `systemctl status campus-vote`；多半是端口/环境变量错，或被 `ProtectSystem` 挡住写权限 |
| 微信里一直跳授权、循环 | `PUBLIC_BASE_URL` 与网页授权域名不一致；或 Cookie 的 `Secure` 未生效（必须 https） |
| 投票全是同一 IP | Nginx 没传 `X-Forwarded-For`；检查 `proxy_set_header` 三行 |
| 时间显示对不上 | 服务器时区随意，但本项目内部统一按 +08:00 计算，无需改时区 |
| 数据“消失” | 检查 `DB_PATH` 是否指向持久目录；容器部署时务必挂卷 |
