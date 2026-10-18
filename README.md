# dsh-usage-board

DSH（DeepSeek Harness）插件：会话头部**极简胶囊** + 设置页**「用量与额度」仪表盘**。

- **Token 层（零配置）**：只读 DSH 本地会话投影缓存，统计**全部 provider** 的 token、缓存命中率、按模型/会话下钻
- **金额层（可选）**：读 HotDogAPI 面板的用量接口，显示余额、今日/累计实付、近 14 天花费、失败请求
- 余额低于阈值会变色，并后台发 Windows 通知（每 12 小时最多一次）

---

## 快速安装（第二台电脑也只要 3 步）

### 1. 拿到本仓库

任一方式：

```powershell
git clone https://github.com/zengnanhua228/dsh-usage-board.git
```

或直接在 GitHub 页面点 **Code → Download ZIP** 解压。

> 前提：那台电脑已安装 DSH，并且**至少启动过一次**（首次启动才会生成 `~/.dsh/profiles`）。

### 2. 双击 `安装.cmd`

它会：
1. 把插件复制到 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-usage-board`
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里注册插件（**自动备份**原文件）
3. 校验 YAML（有 Node 时严格校验，没有则文本级检查）

命令行等价写法：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# 只演练不改文件： -DryRun
# Web 版 profile： -Profile web
```

### 3. 重启 DSH

托盘图标右键 → **退出** → 重新打开。

打开 **设置 → 用量与额度**，看到卡片仪表盘即成功。

---

## 可选：启用「金额 / 余额」

不配置也能用 Token 看板；配置后多出余额、实付金额、失败请求。

**双击 `配置面板Token.cmd`**，按提示粘贴面板的 `refresh_token`：

1. 浏览器登录 `https://sub.ihc.qzz.io`
2. `F12` → **Application / 应用** → **Local Storage** → `https://sub.ihc.qzz.io`
3. 复制 **`refresh_token`** 的值（`rt_` 开头）
4. 粘贴进脚本（不回显、不落日志），脚本会先验证"能换票 + 能读余额"再写入

> 更省事的方式（需要 Node）：`node scripts/watch-panel-token.mjs`
> 它会持续监听 Edge 的本地存储，你在浏览器登录面板后自动捕获并写入。

**注意**：每台电脑的面板登录态不同，**每台都要单独配置一次**。凭据存在 `~/.dsh/.credentials.yaml`，明文、仅本机用户可读。

---

## 配置项

安装在 `cordis.patch.yml` 的插件行里，改完重启 DSH：

```yaml
- insert:
    - id: usage-board
      name: dsh-usage-board
      config:
        balanceThreshold: 5     # 美元；余额低于它时胶囊变黄 + 系统通知
        cacheMs: 4000           # Token 聚合缓存（毫秒）
        notifyEnabled: true     # 余额通知开关
        notifyMinHours: 12      # 同一条告警的最小间隔（小时）
```

---

## 界面

**胶囊（会话头部）**：`● 746.27M tok` —— 只显示今日总量 + 状态点（绿=正常 / 黄=余额低 / 红=取数异常）。
点开是快览：今日四桶、余额、今日实付、近 7 天失败数。

**设置页 →「用量与额度」**：

| 区块 | 内容 |
|---|---|
| 指标卡 | 今日 Token / 今日实付 / 面板余额 / 近 7 天失败 |
| 区间 | 今日 / 近 7 天 / 近 30 天 / 全部 |
| 按模型 | 会话数、缓存命中率、token；**点行下钻会话**（标题、命中率、复制完整 ID） |
| 区间汇总 | 总 token + 未缓存输入 / 输出 / 缓存读 / 命中率 |
| 面板金额 | 余额、今日实付、累计实付、`dsh-hotdog` 今日、倍率、累计充值 |
| 趋势 | 近 14 天 Token 柱状图 + 近 14 天花费柱状图 |
| 失败请求 | 近 7 天次数、状态码分布、最近失败明细 |

## 接口（服务端同源，供前端）

| 路径 | 说明 |
|---|---|
| `GET /api/usage-board/usage?range=d1\|d7\|d30\|all` | Token 聚合（4s 缓存） |
| `GET /api/usage-board/sessions?model=&range=` | 某模型的会话下钻 |
| `GET /api/usage-board/panel` | 金额快照（20s 缓存 + 失败回退旧数据） |
| `GET /api/usage-board/errors?days=7` | 失败请求聚合 |
| `GET /api/usage-board/panel/auth` | 面板 token 状态（掩码） |
| `GET /api/usage-board/diag` | 装载/路由诊断 |

---

## 数据口径与已知限制

- **Token 是 provider 上报的真实值**（不是启发式估算）；缓存读单列，长期命中率 97–99%
- **模型归因是会话级**：会话中途换模型，token 全归到最后一次使用的模型
- 时间用会话最后活动时间；跨多天的长会话整体落在最后一天
- 金额是**账号级**（含账号下所有 key）；`dsh-hotdog` 的今日口径来自最近 100 条明细，**近似**
- `actual_cost` = 实付（倍率后），`cost` = 原价
- DSH 或面板升级都可能改数据结构 → 缺字段一律跳过并计数，不报错

---

## 卸载

双击 **`卸载.cmd`**：删除插件目录 + 从配置里移除插件行（带备份）。
**不会**删除你的面板 token / API key。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DryRun   # 只演练
```

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 设置页没有「用量与额度」 | 双击 `检查安装.cmd` 看四项检查；确认已**完全重启** DSH（托盘退出，不是关窗口） |
| 重启后 DSH 起不来 | 回滚 `~\.dsh\profiles\desktop\cordis.patch.yml.bak-install-*`；或删掉整个 `cordis.patch.yml`（DSH 会用默认配置启动） |
| 配置行又没了 | **DSH 设置里点"恢复默认/重置"会整份重写 profile 补丁**，重跑 `安装.cmd` 再重启即可 |
| 金额显示"更新中…" | 正常：面板接口偶尔慢，插件会保留上次成功数据并重试 |
| 金额一直"取数失败" | `配置面板Token.cmd` 换成新的 token（面板登录态会过期/轮换） |
| 通知没弹 | 检查 `notifyEnabled`、Windows 通知权限；DSH 不运行时不会检查余额 |

---

## 安全说明

- 插件**只读**：不写 DSH 数据、不修改你的会话、不调用面板的写接口（建删 key/订单/充值一律不碰）
- 面板 token 等价于面板登录态，存于 `~/.dsh/.credentials.yaml`（明文、仅本机用户可读，但同用户的进程可读——这是已知取舍）
- 不想承担这个风险：不配置金额层即可，Token 层零凭据
- 建议面板使用**专用 API key**（如 `dsh-hotdog`）便于按 key 分账

## 开发

```powershell
powershell -ExecutionPolicy Bypass -File .\sync.ps1          # 把源码同步到本机 profile（开发者用）
node --check lib/client.js; node --check lib/index.js; node --check lib/panel.js
node -e "import('./lib/panel.js').then(m=>m.panelSnapshot())"  # 单独测金额层
```

## License

MIT
