# DSH 版本守卫 · dsh-version-guard

**插件冲突导致 DSH 打不开时，用它退回上一个可用版本。**

Many users break their DSH installation by installing a conflicting plugin: the
window never opens, or it opens and immediately exits. `dsh-version-guard`
records plugin versions and configuration snapshots so a broken install can be
rolled back — including from a page that runs **outside DSH**, so it still works
when DSH itself will not start.

---

## 为什么需要它（问题本身）

DSH 的插件装在 profile 目录里，由 `package.json` 的 `dsh.profile.bundles`
决定启动时加载哪些。装了一个有问题的插件之后：

* DSH 启动过程中抛错 → 窗口打不开，或者闪一下就退出；
* 而这个插件是**在 DSH 里装的**，所以你现在**没有办法在 DSH 里把它卸掉** ——
  界面本身就是坏的。这是一个死锁。

`dsh-version-guard` 的做法是把这个死锁拆开：

1. **在 DSH 还健康的时候**，每次成功启动后自动记录一个「回退点」，
   里面存着插件清单、每个插件的版本、以及决定加载哪些插件的配置文件。
2. **在 DSH 坏掉之后**，用一个**独立进程**（只需要 Node，不加载任何 DSH 代码）
   打开恢复页，把配置退回上一个成功启动的版本。

---

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 宿主插件 | `lib/host/index.js` | 写启动记录、成功启动后自动打回退点、把恢复页的 HTTP 接口挂到 DSH 上 |
| 设置页 | `lib/client/client.js` | 在 DSH 设置里加一页「版本守卫」，内嵌上面那个恢复页 |
| 离线恢复页 | `lib/recovery/` + `lib/bin/version-guard.js` | **脱离 DSH 进程**运行的恢复服务，DSH 起不来时唯一的入口 |
| 共享核心 | `lib/core/` | 快照、恢复、版本识别、插件启停、pnpm 调用；两个前端共用同一套逻辑 |

> 设计上最要紧的一点：**恢复能力不放在恢复对象里面**。离线恢复页不 import 任何
> `@deepseek-ai/*` 代码，只依赖 Node 与 profile 目录，因此插件把 DSH 搞坏时它照样能用。

---

## 安装

### 1. 放到插件目录

把整个 `dsh-version-guard` 目录放到 DSH 的插件目录，例如：

```
E:\dsh\plugins\dsh-version-guard
```

### 2. 让 profile 加载它

以 `E:\dsh\data\profiles\web-enhanced` 为例，编辑该目录下的 `package.json`：

```jsonc
{
  "dependencies": {
    // 新增这一行；用 link: 指向上面的目录，源码改动会立刻生效
    "dsh-version-guard": "link:E:/dsh/plugins/dsh-version-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        // 新增这一行；这一行才是真正决定启动时加载它的地方
        "dsh-version-guard"
      ]
    }
  }
}
```

然后在 profile 目录里同步依赖：

```cmd
cd /d E:\dsh\data\profiles\web-enhanced
pnpm install --ignore-scripts
```

重启 DSH。设置里会出现「版本守卫」一页。

> 用 `link:` 而不是复制，是为了避免「插件目录里的源码」和「profile 里实际加载的
> 那份」两份代码不一致 —— 那正是这类工具最容易出的问题。

### 3. 放好恢复入口

把 `dsh-version-guard.cmd` 放到顺手的位置（桌面即可）。它自己会去找 DSH 自带的
Node 运行时，所以不要求用户装 Node。

---

## 崩了以后怎么办

### 方式一：双击 `dsh-version-guard.cmd`（推荐）

打开浏览器里的离线恢复页，点「一键救援」。它会：

1. 找到最近一次**成功启动**时记录的回退点；
2. 先把当前状态记录成一个新的回退点（所以这一步本身也能撤销）；
3. 把 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 等配置文件写回去；
4. 如果插件版本有变化，提示你点「立即同步依赖」跑一次 `pnpm install`。

然后关闭页面，重新启动 DSH。

### 方式二：命令行

```cmd
dsh-version-guard.cmd --rescue --dry-run    :: 先看看会退回哪一版，不改任何东西
dsh-version-guard.cmd --rescue              :: 直接回退
dsh-version-guard.cmd --status              :: 查看各插件版本与启动健康状况
dsh-version-guard.cmd --list                :: 列出所有 profile
```

### 方式三：手动定位问题插件

如果不想整体回退，在恢复页的「当前插件版本」里找到可疑的那个，点「停用」。
停用只是把它从加载列表里移掉，**不会删除任何文件**，随时可以「恢复启用」。

---

## 恢复页能做什么

* **当前插件版本**：每个插件的「要求版本 / 实际安装版本 / lockfile 锁定版本」、
  启用状态、以及为什么是这个状态（例如「不在加载列表里」「node_modules 里缺失」
  「所有 Cordis 行都被停用」）。
* **版本回退点**：时间、类型（成功启动 / 手动记录 / 改动前 / 回退前）、当时的插件
  数量与 DSH 版本，可对比、回退、删除。
* **一键救援 / 预演**：预演只计算会退回哪一版，不做任何修改。
* **单插件停用 / 恢复启用 / 锁定版本**。
* **同步依赖**：显式点击才跑 `pnpm install --ignore-scripts`。

---

## 它到底改了什么

回退点的内容是**决定 profile 是什么**的那些文件：

| 文件 | 说明 |
| --- | --- |
| `package.json` | 依赖版本 + `dsh.profile.bundles` 加载列表 |
| `cordis.patch.yml` | 用户补丁层（插件的启停与配置覆盖） |
| `pnpm-lock.yaml` | 实际解析到的版本 |
| `.dsh-version-guard/cordis.disabled.json` | 本工具记录的停用列表 |
| `.dsh-market/state.json` | 插件市场的启停与分组（如果存在） |

**不复制 `node_modules`。** 它可以从 `package.json` + `pnpm-lock.yaml` 用 pnpm
重新装出来，复制它只会让快照大到无法管理。所以「配置回退」和「依赖同步」是两步，
恢复页会在需要时明确提示第二步。

**不碰会话、密钥、设置。** 回退点只覆盖上面这几个文件。

---

## 安全设计

* **恢复能力与被恢复对象隔离**：离线恢复页不加载任何 DSH 代码。
* **写入原子性**：所有文件写入都是「同目录临时文件 + rename」，中途崩溃不会留下
  半截的 `package.json`。Windows 上 rename 被占用时会重试，最后才退回原地写。
* **回退是事务性的**：先把每个目标文件的当前内容读出来，中途失败会把已完成的改动
  逐个还原。
* **回退前先记录**：所以「回退」这个动作本身也可以被回退。
* **路径校验**：profile 名称在拼接前就校验，快照 id 也必须符合固定格式，
  拒绝 `..` 与绝对路径，防止越出 profile 目录。
* **请求令牌**：恢复页所有写操作都要带上本进程生成的令牌，其它页面的脚本拿不到它。
* **不改系统**：不装东西、不动 PATH。依赖同步用 `--ignore-scripts`，
  避免在救援这个最不该出意外的时刻执行第三方安装脚本。

---

## 数据文件

都在 profile 目录下的 `.dsh-version-guard/`：

```
.dsh-version-guard/
├── boot.json                  启动记录：上次是否走完、连续失败次数
├── cordis.disabled.json       本工具记录的停用列表（含停用时的版本）
├── guard.lock                 并发写锁
└── snapshots/                 回退点，默认保留最近 30 个
    └── snap-<时间>-<类型>.json
```

删掉整个 `.dsh-version-guard/` 目录不会影响 DSH 启动，只是会丢掉回退点。

---

## 工作原理：崩坏是怎么被发现的

「DSH 打不开」这件事本身没法在坏掉的进程里报告，所以用的是**启动记录**：

1. 宿主插件在启动早期写一条「启动中」记录；
2. 只有当 HTTP 服务**真的能应答**（对自身发一次请求并拿到响应）之后，
   才把这条记录标记为成功，并打一个回退点；
3. 下一次启动时如果发现上一条记录还停在「启动中」，就说明上一次启动**没走完**
   —— 这就是崩溃信号；连续 2 次就判定为崩溃循环，并在控制台打印救援指引。

关键点是第 2 步不只判断端口是否被监听：端口通了不等于界面能用。

---

## 已知限制

* **不做应用版本回退**。这里回退的是插件与配置，不是 DeepSeek Harness 应用本身
  （那需要保存安装包，是另一套机制）。
* **依赖同步需要网络**。回退点里的版本范围如果指向一个本地已经没有的版本，
  必须联网才能装回来。恢复页会在此时明确提示。
* **社区插件自带的前端入口依赖 `dsh.client` 约定**。本插件的客户端是按
  `window.__ModuleLoader__.load({ id, factory })` 这个 classic script 约定写的，
  顶层不能用 `import`/`export`（那会让插件页整体加载失败）。
* **客户端远程调用走的是自己的 HTTP 路由**（`/dsh-version-guard/*`），
  而不是 typert/remote。这样不需要维护一份严格的类型描述文件，代价是它没有
  网关的计量与取消能力。
* **单插件「停用」会同时从 `dependencies` 移除**，这是为了让 `pnpm install`
  不会把它装回来。恢复启用时需要给一个版本范围（停用时会记下当时的版本）。

### 关于 profile 识别

宿主插件必须知道「当前这个 DSH 进程用的是哪个 profile」，因为它要把启动记录和
回退点写进那个 profile。判断顺序是：

1. 命令行上的 `--profile <名称>`；
2. 环境变量 `DSH_PROFILE`；
3. 插件配置里的 `profile`；
4. 最近修改过的那个 profile（这种情况下会打印警告）。

第 1 项排在第 2 项前面是有原因的：实测中 DSH 启动
`--profile web-enhanced` 时，环境里仍带着 `DSH_PROFILE=desktop`。若先信环境变量，
在多 profile 的机器上就会把回退点写进另一个 profile —— 用户以为被保护了，
实际用的那个 profile 一直没被记录。这个顺序有专门的回归测试
（`lab4/profile-detect-test.mjs`）。

---

## 排障

**恢复页打不开**

```cmd
dsh-version-guard.cmd --status
```

它只依赖 Node。如果连它都报「找不到 Node 运行时」，用 `--NodePath` 指定：

```powershell
.\dsh-version-guard.ps1 -NodePath "D:\node\node.exe" -Status
```

**回退之后 DSH 还是打不开**

说明问题不在配置层。在恢复页里逐个「停用」社区插件（从最近装的那个开始），
每次停用后重启 DSH 试一次。全停用之后仍然打不开，那就是 DSH 应用本身或
环境问题，与插件无关。

**回退后提示「还需要同步依赖」**

点恢复页里的「立即同步依赖」，或者命令行：

```cmd
dsh-version-guard.cmd --install
```

**设置里没有「版本守卫」**

宿主插件没有加载。检查 profile 的 `dsh.profile.bundles` 里是否有
`dsh-version-guard`，以及 `node_modules` 里能不能找到它。注意：即使这一页不出现，
**离线恢复页依然可用**。

---

## 自检

```cmd
node lib/tools/verify-package.js
```

检查包约定（`exports`、`dsh.bundle`、`dsh.client`）、客户端必须是 classic script、
所有相对 import 可解析、Cordis 补丁只做插入、以及路由挂载与前缀处理。

## 许可

MIT
