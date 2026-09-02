# Premiere Pro Livestream Highlight Solution

這個 repository 是一套本機優先的自動剪輯 solution，不只是單一 MCP server。它把
影片理解、透明 highlight 評分、人工核准與 Adobe Premiere Pro 實際剪輯串成一條
可驗證、可回復的流程。

> 重要：Git clone 只會取得本 repository 的 `highlight_local` 與 agent workflow。
> `video_context`、`premiere_cep`、FFmpeg/FFprobe/yt-dlp、ASR model，以及
> Premiere CEP extension 都是新機器上必須另外 provision 的本地依賴。

## Solution 組成

| 元件 | 來源 | 負責內容 | 是否修改 Premiere |
|---|---|---|---|
| `video_context` | Hermes Node 內的 `@smallthinkingmachines/video-context-mcp` | ingest、ASR/transcript、timeline、search、keyframes、OCR | 否 |
| `highlight_local` | 本 repository 的 `src/index.js` | sidecar/本地 ASR、audio、scene、motion、透明評分、JSON/FCP7 XML handoff | 否 |
| `premiere_cep` | Hermes Node 內的 `adobe-premiere-pro-mcp` | 透過 Premiere CEP bridge 匯入媒體、建立 sequence、放置片段、marker、驗證、儲存與輸出 | 是，僅在核准後 |
| `local-livestream-premiere` | `.agents/skills/local-livestream-premiere` | 告訴 agent 如何設定、路由三個 MCP、等待核准並安全完成剪輯 | 依 workflow 階段而定 |

~~~mermaid
flowchart LR
    A[本地影片] --> B[video_context<br/>ASR / timeline / search]
    A --> C[highlight_local<br/>audio / scene / motion / transcript]
    B --> D[Timestamped candidates]
    C --> D
    D --> E{使用者明確核准？}
    E -->|否| F[停止；不修改 Premiere]
    E -->|是| G[premiere_cep]
    G --> H[CEP Bridge panel]
    H --> I[新建或複製的 highlight sequence]
    I --> J[Tracks / gaps / offline media 驗證]
    C -.核准後可選.-> K[JSON / FCP7 XML handoff]
~~~

## Agent 從哪裡開始

Repository 內有兩個 agent-facing 入口：

- `AGENTS.md`：所有在此 repository 工作的 agent 都應先遵守的 solution 邊界。
- `.agents/skills/local-livestream-premiere/SKILL.md`：Hermes 的 canonical repo-local skill。

Hermes 只會在受信任的 repository 內自動載入 `.agents/skills` 或
`.hermes/skills`。第一次 clone 後，從 repository root 執行：

~~~powershell
hermes skills trust "<REPO_ROOT>"
hermes skills list --source all
~~~

Project-local skill 是最高優先層。這可避免 `%LOCALAPPDATA%\hermes\skills` 內的
舊版同名 skill 覆蓋本 repository 的 workflow。設定完成後，從 repository root
開啟新的 Hermes session，再呼叫：

~~~text
/local-livestream-premiere
~~~

詳細文件：

- [全新 Windows 機器部署](.agents/skills/local-livestream-premiere/references/mcp-setup-windows.md)
- [實際分析與剪輯 runbook](.agents/skills/local-livestream-premiere/references/operational-playbook.md)
- [本地 scoring profile](.agents/skills/local-livestream-premiere/references/scoring-profile.md)

## 全新 Windows 機器快速部署

以下是最短的正確路徑；完整例外與 troubleshooting 請看上面的部署文件。

### 1. 準備主機

需要：

- Windows PowerShell、Git、Node.js 22+ 與 npm。
- Hermes agent，以及同一 Hermes Node tree 內的 `video-context-mcp` 和
  `adobe-premiere-pro-mcp`。
- Adobe Premiere Pro。
- 本地影片資料夾。
- `ffmpeg.exe`、`ffprobe.exe`、`yt-dlp.exe`，預設放在
  `<REPO_ROOT>\tools\bin`。
- 已預先 provision 的本地 ASR runtime/model cache，或同名 `.srt`/`.vtt` sidecar。

### 2. Clone 並安裝 repository dependencies

~~~powershell
$RepoRoot = 'C:\Work\Premiere-Pro-MCP-Server'
$VideoRoot = 'D:\Videos\Livestreams'
git clone https://github.com/birdie-hsu/Premiere-Pro-MCP-Server.git $RepoRoot
Set-Location -LiteralPath $RepoRoot
npm ci
npm test
hermes skills trust $RepoRoot
~~~

### 3. Preview，再生成三個 MCP 的 project config

Canonical config 是 `<REPO_ROOT>\.codex\config.toml`。不要建立舊式 YAML
`config.yaml`，也不要 commit 這個含使用者絕對路徑的檔案。

~~~powershell
$Bootstrap = Join-Path $RepoRoot '.agents\skills\local-livestream-premiere\scripts\ensure-hermes-config.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -VideoRoot $VideoRoot
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -VideoRoot $VideoRoot -Apply
~~~

Preview 會先驗證 Hermes Node、三個 entrypoint、媒體工具和 local Transformers
runtime。`-Apply` 只在 setup 已被要求或核准後使用；它會保留無關設定，並在改寫
既有 config 前建立 timestamped backup。

預設 ASR model 是英文 `Xenova/whisper-base.en`。非英文或多語影片應在 preview
與 apply 都傳入相同的 `-AsrModel`，例如
`-AsrModel 'Xenova/whisper-base'`。

### 4. 安裝或更新 Premiere CEP extension

若 bootstrap 顯示 CEP extension missing，使用明確的 opt-in switch：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -VideoRoot $VideoRoot -Apply -InstallPremiereCep
~~~

`-InstallPremiereCep` 會使用已安裝的 `adobe-premiere-pro-mcp` 官方 Windows
installer，更新目前使用者的 `MCPBridgeCEP` extension、啟用 Adobe CEP debug
mode，並建立與 `PREMIERE_TEMP_DIR` 相同的 bridge directory。它不會改寫
Claude Desktop 或 VS Code MCP config。因為它會替換既有同名 CEP extension，
agent 必須在使用者要求 setup 或明確核准後才使用。

### 5. 啟動 Premiere bridge

1. 關閉並重新開啟 Premiere Pro。
2. 開啟 `Window > Extensions > MCP Bridge (CEP)`。
3. 將 panel 的 `Temp Directory` 設成 bootstrap 顯示的
   `PREMIERE_TEMP_DIR` 完整路徑。
4. 依序按 `Save Configuration`、`Start Bridge`、`Test Connection`。
5. 重新啟動 Hermes 或開啟新的 session。

如果 panel 沒出現在 Extensions，先確認 CEP extension 已安裝；必要時在 Premiere
preferences 啟用 plugin developer mode，重啟 Premiere，再開啟 CEP panel。本
solution 不使用 bundled experimental UXP panel。

### 6. 驗證 readiness

~~~powershell
hermes mcp list
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
~~~

Readiness 有四層，不可混為一談：

| 層級 | 驗證 | 代表意義 |
|---|---|---|
| 0. Files | bootstrap preview | executable、package entrypoint、tool 和路徑存在 |
| 1. MCP process | `hermes mcp test premiere_cep` | stdio server 能啟動並列出 tools；不代表 Premiere 可剪輯 |
| 2. Bridge install | `premiere_cep.get_capabilities(checkConnection=false)` | CEP extension、bridge directory 與本機能力可被檢查 |
| 3. Live Premiere | `premiere_cep.verify_premiere_connection` | panel 已啟動、project/host 可回應；只有這層通過後才可剪輯 |

若 live check 失敗，開啟/啟動 panel 並修正 Temp Directory；不要重試迴圈，也不要
切換到 UXP、raw ExtendScript、cloud service 或 network listener。

## Runtime workflow

### 1. DISCOVER

取得使用者提供的絕對本地影片路徑、highlight 風格與目標長度。不要掃描整台機器。
`highlight_local` 只接受 `HIGHLIGHT_ALLOWED_ROOTS` 內的路徑。

### 2. ANALYZE

長影片優先用 `video_context` 的 ASR-first route：

1. `list_videos`，重用相同 source 的 `video_id`。
2. 必要時 `ingest_video`，長影片先用
   `visual=false`、`embed=false`、`whisper_fallback=true`。
3. Poll `get_ingest_status`，再讀一次 `get_video_timeline`。
4. 用數個短 query 執行 `search_videos`，對命中區間切片
   `get_transcript`。
5. 只對 shortlist 使用 `peek_frame` 或 `highlight_local.get_frame`。

`highlight_local` 是透明 heuristic fallback，也可補充相對 audio burst、scene
boundary、低權重 frame-difference motion 與 reusable plan。Objects/actions
不是預設訊號。

### 3. REVIEW

回傳候選表，至少包含 ID、source start/end、duration、0–100 score、理由、短
quote/visual cue 和 evidence limitations。Score 只是排序工具，不是語意真相。

分析完成後停止。`analyze`、`show candidates` 或 `find highlights` 都不是修改
Premiere 的授權。

### 4. ASSEMBLE

只有使用者明確核准 candidate ID 或時間範圍後：

1. `get_capabilities(checkConnection=false)`。
2. `verify_premiere_connection`；失敗就停止。
3. Read-only 檢查 project、active sequence、tracks 和 media。
4. 優先 `duplicate_sequence(clearContents=true)`，保留原始 sequence 的設定與內容。
   若沒有可複製來源，使用 `create_sequence_from_clips`，或提供真實 `.sqpreset`
   給 `create_sequence`，避免觸發 Premiere native dialog。
5. `import_media`，取得真實 `projectItemId`。
6. `add_to_timeline_batch`，對每個核准片段設定 source in/out、timeline cursor、
   `trackIndex=0`、`linkAudio=true`。
7. 用實際回傳的 start/out point 推進 cursor 並加入 markers。
8. `set_active_sequence` 讓使用者看到新 sequence。

`verify_premiere_connection` 成功但回傳 `activeSequence: null` 並不代表 bridge
失敗；此時不可憑空呼叫 `duplicate_sequence`，應改走
`create_sequence_from_clips`，或使用使用者指定的真實 sequence。

### 5. VERIFY

對新 sequence 執行 `list_sequence_tracks` 與
`validate_project_for_export(requireNonEmptyTimeline=true, checkGaps=true)`，確認：

- video/audio clip 數量符合預期；
- linked audio、來源路徑與 in/out 正確；
- 沒有 blocking gaps；
- `offlineMediaCount=0`；
- 實際 duration 符合組裝結果。

每個 mutation 都要用最窄的 read-only tool 驗證。Tool 回傳
`success:false` 是停止條件，不可直接盲目重試。

### 6. PERSIST / EXPORT

編輯核准不等於儲存或輸出核准：

- `save_project` 會覆寫目前 `.prproj`，使用前再次取得明確授權。
- 有新路徑時優先 `save_project_as`，既有 target 不得靜默覆寫。
- MP4 export 前確認 output path、preset 與 overwrite 行為，再驗證並輸出。
- 未要求時清楚回報「sequence 已建立，但尚未儲存/輸出」。

## JSON / FCP7 XML fallback

核准候選後，`highlight_local.export_premiere_plan` 可以生成 non-destructive JSON
plan 與 FCP7 XML。這是 live CEP 不可用或使用者明確想要 handoff file 時的 fallback；
產生檔案不等於 Premiere 已完成剪輯。既有輸出預設拒絕覆寫。

## 安全邊界

- 所有 source media 與 analysis artifact 保持本機。
- Agent 不直接呼叫 UXP 或 raw ExtendScript；Premiere 操作一律經
  `premiere_cep` 的 CEP tool surface。
- 不以 cloud video service 或 network listener 當 fallback。
- 原始 sequence 保留；剪輯在新建或複製的 sequence 進行。
- 不刪除 source media、sequence 或 project item，除非使用者明確要求。
- 不 commit `.codex`、`.cache`、`node_modules`、`tools\bin`、影片、project
  或使用者絕對路徑。

## Repository map

| 路徑 | 內容 |
|---|---|
| `src/index.js` | `highlight_local` STDIO MCP entrypoint |
| `src/server.js` | 5 個本地分析/plan tools |
| `src/analysis.js`、`src/scoring.js` | analysis pipeline 與透明 scoring |
| `src/ffmpeg.js`、`src/motion.js`、`src/transcribe.js` | 本地音訊、scene、motion、ASR |
| `src/premiere-xml.js` | JSON plan 與 FCP7 XML handoff |
| `.agents/skills/local-livestream-premiere` | canonical agent workflow、references、bootstrap |
| `test/unit.test.js` | captions、signals、allowlist、Premiere handoff 測試 |

## 開發與驗證

~~~powershell
npm ci
npm test
node --check src\index.js
~~~

完整 solution 驗證還要包含：

~~~powershell
hermes skills list --source all
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
~~~

最後由 agent 呼叫 `get_capabilities` 與 `verify_premiere_connection`，才能確認
Premiere live editing readiness。
