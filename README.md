# dsh-tool-comfyui

给 **DeepSeek Harness** 用的自建工具插件：在 dsh 里一句话直接调用本机/局域网的
**ComfyUI 机队** 出图。

> **Compatibility**: built and tested against dsh `0.2.0-rc.2` (preview).
> The `apply(ctx)` plugin spec is stable; verify against your own dsh version if newer.

---

## 安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-comfyui
# or, if published to npm:
# dsh plugin --profile desktop add dsh-tool-comfyui
```

Replace `desktop` with your own profile name. After install, restart the profile —
the three tools appear immediately.

### 手动安装（本机开发用）

<details>
<summary>展开：不走 CLI 的手工装法</summary>

**1. 插件位置**

```
C:\Users\<你>\.dsh\plugins\dsh-tool-comfyui\
├─ lib\index.js            插件实现（三个工具全在这）
├─ workflows\txt2img.json  SDXL 文生图模板
├─ cordis.patch.yml        bundle 补丁：把插件行插进 profile
├─ start-comfyui-worker.bat  素材机上的 ComfyUI 启动器（GBK+CRLF）
└─ package.json
```

**2. 让 profile 认识它**

`%USERPROFILE%\.dsh\profiles\desktop\package.json`：

```json
{
  "dependencies": {
    "dsh-tool-comfyui": "link:C:/Users/<你>/.dsh/plugins/dsh-tool-comfyui"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-tool-comfyui"
      ]
    }
  }
}
```

> `bundles` 里必须列出包名，dsh 才会去读它的 `dsh.bundle.patch`。
> 只在 `dependencies` 里出现是**不够**的 —— 那不叫启用。

**3. 在 profile 的 `node_modules` 建链接**

```
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-tool-comfyui" ^
          "%USERPROFILE%\.dsh\plugins\dsh-tool-comfyui"
```

</details>

---

## 它做什么

注册三个模型可调用的工具：

| 工具 | 作用 |
|---|---|
| `comfyui_status` | 探测全机队：谁在线、ComfyUI 版本、显卡型号/显存、队列深度；顺带列出可用工作流模板 |
| `comfyui_generate` | 按命名工作流模板出图：提交 prompt → 等 GPU 跑完 → 把成图下载到本地，返回文件路径 |
| `comfyui_queue` | 查某台机器的运行/排队情况，或一键中断+清空队列 |

**关键点：轮询是它存在的理由。** ComfyUI 出图是两段式协议（`POST /prompt` 拿
`prompt_id`，再轮询 `/history/<id>` 直到出图）。裸 `web_fetch` 做不到「提交后等待」，
所以必须写成插件。

> **实测**：RTX 5090D 上 SDXL 1024×1024 三十步，**单张约 15.1 秒**，
> 批量两张约 16.7 秒；同 seed 两次输出**字节完全一致**。
> 见下方[实测数据](#实测数据)一节。

---

## 🔐 权限与隐私

这是理解本插件安全边界最重要的一节。

| 项目 | 说明 |
|---|---|
| **网络访问** | 仅访问你在配置文件里 `workers[].url` 指定的地址。默认只连 `127.0.0.1:8188` 和你的局域网机器。**不访问任何第三方服务** |
| **凭据** | **不需要任何 API key**。ComfyUI 默认无鉴权；本插件不读取、不存储、不传输任何凭据 |
| **数据外发** | **无**。prompt 发给你的 ComfyUI，成图下载到你的 `outputDir`。插件本身**没有任何遥测** |
| **文件写入** | 只写 `outputDir`（默认 `comfyui-output`），每次调用生成一个子目录 |
| **进程启动** | 插件本身**不启动任何进程**。仓库里的 `start-comfyui-worker.bat` 是给你**手动双击**的素材机启动脚本，不会被插件自动执行 |
| **生命周期脚本** | **无** `preinstall` / `postinstall` / `prepare`。安装时不会跑任何代码 |
| **运行时依赖** | 仅 `@deepseek-ai/schemastery`（配置校验）。其余为 peer，由 dsh 提供 |

⚠️ `comfyui_queue` 的 `cancelAll` 参数会**中断并清空目标机器的队列**。这是破坏性操作，
只在你明确要求时使用。

---

## 用法

装好并在 profile 里启用后，在 dsh 对话里直接说人话即可：

```
帮我出一张白底咖啡杯的电商图
→ 调 comfyui_generate(prompt="a white ceramic mug on pure white background, e-commerce catalog photo")

先看看素材机活着没
→ 调 comfyui_status

把 109 上排队的任务清掉
→ 调 comfyui_queue(worker="spark5060", cancelAll=true)
```

---

## 配置机队

在 profile 的 `cordis.patch.yml` 覆盖插件行：

```yaml
- id: tool-comfyui
  config:
    workers:
      - id: local5090
        url: http://127.0.0.1:8188
        label: RTX 5090D 主力机
      - id: spark5060
        url: http://192.168.11.109:8188
        label: 5060 Ti 素材机 A
    workflowsDir: <插件目录>/workflows
    outputDir: C:/Users/<你>/Pictures/comfyui
    defaultWorkflow: txt2img
    maxBatchSize: 8
    timeoutMs: 900000
```

加机器 = 往 `workers` 追加一项。

---

## 素材机上跑 ComfyUI

把 `start-comfyui-worker.bat` 拷到素材机，双击：

```bat
start-comfyui-worker.bat          :: 只听 127.0.0.1
start-comfyui-worker.bat 8188 lan :: 听 0.0.0.0，允许本机 dsh 跨机调用
```

脚本会先 `taskkill /F /IM pminer.exe` 停矿（否则 GPU 满载，出图极慢）。

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `workers[]` | 必填 | 机队。每项 `{id, url, label?, timeoutMs?}` |
| `workflowsDir` | `workflows` | 命名工作流模板目录（`<名字>.json` → 模板名） |
| `defaultWorkflow` | `txt2img` | 不传 `workflow` 时用哪个 |
| `timeoutMs` | `600000` | 单次调用的协作超时预算 |
| `pollIntervalMs` | `2000` | 轮询 `/history` 的间隔 |
| `outputDir` | `comfyui-output` | 成图落地目录 |
| `generate` / `status` / `queue` | `true` | 分别开关三个工具 |
| `maxBatchSize` | `8` | 单次最多出几张 |

---

## 工作流模板

模板是 **ComfyUI API 格式**的图（不是 UI 格式），存在 `workflows/` 下，
文件名即模板名。

插件按 **`_meta.title`** 约定注入参数：

| 节点 title 命中 | 注入 |
|---|---|
| `prompt` / `positive` / `提示词` | `args.prompt` |
| `negative` / `负面` | `args.negativePrompt` |
| `seed` / `noise_seed` / `随机种子` | `args.seed` |
| 任意带 `batch_size` 的节点 | `args.batchSize` |

> 只覆盖**字面量**输入；被连线（link）的输入绝不碰，所以不会把
> CLIP 文本节点接错。找不到 prompt 节点会直接报错并提示你去给节点起名。

加一个新模板（比如电商场景图）：

1. 在 ComfyUI 里搭好图 → 「导出（API 格式）」
2. 把 `CLIPTextEncode` 的 `_meta.title` 改成 `prompt` / `negative`
3. 存成 `workflows/scene.json`
4. 直接调 `comfyui_generate(prompt="...", workflow="scene")`

---

## 实测数据

在 RTX 5090D 主力机上、SDXL base 1.0、1024×1024、30 步：

| 场景 | 耗时 |
|---|---|
| 单张 | ~15.1 s |
| 批量 2 张 | ~16.7 s（摊薄后 8.4 s/张） |

同 seed 两次输出**字节完全一致**（可复现）。

产出示例（本机实跑，白底电商图）：

```
comfyui-output/2026-10-01T23-30-12-local5090/
  └─ dsh_comfyui_00001_.png   1024×1024  ← 白底咖啡杯，可直接用作商品主图
```

> 本仓库不内嵌截图；实跑输出保存在你的 `outputDir` 下，每次调用都会生成带时间戳的子目录。

---

## 故障排查

| 症状 | 原因 / 解法 |
|---|---|
| `comfyui_status` 全部 offline | ComfyUI 没起，或素材机没加 `lan` 参数（只听 127.0.0.1） |
| 出图极慢（几分钟一张） | **素材机在挖矿**（`pminer.exe` 占满 GPU）。用 `start-comfyui-worker.bat` 启动，它会先停矿 |
| `unknown workflow "xxx"` | 模板文件名与 `workflow` 参数不符；错误信息里会列出全部可用模板 |
| `unknown worker "xxx"` | worker id 拼错；错误信息里会列出配置里的全部 id |
| 找不到 prompt 节点 | 模板里 `CLIPTextEncode` 的 `_meta.title` 没改成 `prompt` / `negative` |
| 局域网机器连不上 | ⚠️ 先测 **TCP** 端口，别 ping —— 本机 OpenVPN 场景下 ICMP 常不通 |

---

## 开发笔记（踩过的坑）

1. **`parameters` 是扁平属性表，不是 JSON Schema 包装对象。**
   `defineTool({ parameters: { prompt: {type:"string", required:true} } })`，
   由 `parameterSchemaSpecToJsonSchema` 编译成 `{type:"object", properties, required}`。
   直接塞 `{type:"object", properties:{...}}` 会被当成一个叫 `type`、`properties`
   的参数，模型侧完全不可用。

2. **`Config` 用 `z.object({...})`，必填项写 `.required()`，可选项写 `.default(...)`。**

3. **bundle 补丁只能用 `insert:` 加新行。**
   直接写 `- id: xxx` 会被报 `patch: entry "xxx" not found` ——
   因为补丁是**按 id 改现有行**的，新行必须放进 `insert:` 数组。

4. **插件包本身不要带 `node_modules`。**
   dsh 的 desktop profile `node_modules` 只是 **局部 overlay**，`@deepseek-ai/cordis`
   等包只在 `app.asar` 里；运行时由 dsh 自己兜底解析。给插件塞一份
   `node_modules` 反而会在 Windows junction 的 realpath 语义下解析到错的地方。

5. **`package.json` 要有 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`**，
   否则 dsh 不认这是个 bundle。

---

## 许可

MIT