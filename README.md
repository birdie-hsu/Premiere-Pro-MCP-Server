# Premiere Pro Livestream Highlight Solution

這個 repository 是「本機影片分析 → 候選片段 → 使用者核准 → Premiere Pro
非破壞性剪輯」的完整 solution。它不是單一 Premiere MCP，而是三個本地 MCP
server 加上一個給 Hermes agent 使用的 canonical skill。

## 先看這張圖

~~~text
本地影片
   |
   +--> highlight_local: 預設評分（transcript + audio + scene + motion）
   |        |
   |        +--> 候選表（ID / 時間 / 分數 / 證據）
   |
   +--> video_context: 只有需要主題搜尋或額外 transcript 證據時使用
            |
            v
      使用者明確核准 candidate IDs
            |
            v
   premiere_cep: CEP bridge -> 複製 source sequence -> 放入 approved clips
            |
            v
      tracks + gaps + offline media 驗證
            |
            v
   sequence 完成；預設不 save、不 render
~~~

重要順序：

1. 先分析，不碰 Premiere。
2. 顯示候選後停止，等待使用者明確核准 ID。
3. 核准後才驗證 CEP、複製 sequence、匯入影片、放置片段。
4. 驗證完成後仍不自動儲存或輸出。

## 三個 MCP 各自做什麼

| Server | 來源 | 主要工作 | 何時使用 |
|---|---|---|---|
| video_context | Hermes Node 的 @smallthinkingmachines/video-context-mcp | ingest、ASR、transcript、timeline、主題搜尋、keyframe/OCR | 額外搜尋/證據；不是預設評分器 |
| highlight_local | 本 repository 的 src/index.js | 本地 transcript、相對 audio、scene boundary、低權重 motion 評分；JSON/FCP7 handoff | 每次分析的預設入口 |
| premiere_cep | Hermes Node 的 adobe-premiere-pro-mcp | CEP 連線、sequence、import、timeline、驗證、save/render | 只有明確核准後 |

三個 server 都必須在環境中註冊，但不必每一次請求都呼叫三個。最短可靠路徑
是 highlight_local 分析，核准後才使用 premiere_cep。video_context 是可選的
transcript/search 證據工具。

## Hermes agent 從哪裡開始

Agent 必須先遵守 AGENTS.md，再讀 canonical skill：

[.agents/skills/local-livestream-premiere/SKILL.md](.agents/skills/local-livestream-premiere/SKILL.md)

第一次 clone 後，從 repository root 執行：

~~~powershell
hermes skills trust "<REPO_ROOT>"
hermes skills list --source all
~~~

確認看到 local-livestream-premiere 後，開啟新的 Hermes session。不要讓使用者
層的舊版同名 skill 覆蓋 repo-local 版本。

## 9B local LLM 快速操作卡

Canonical skill 已把這條流程寫成固定操作。這裡只保留判斷規則，方便人類檢查。

### 分析前固定值

| 變數 | 預設 |
|---|---|
| VIDEO_PATH | 使用者提供的絕對本機影片路徑；沒有就詢問 |
| STYLE | general |
| CLIP_SECONDS | 45（允許 10–600） |
| MAX_CANDIDATES | 5 |
| KEYWORDS | [] |

### ANALYZE

Hermes 依序呼叫：

1. mcp_highlight_local_server_info({})
2. mcp_highlight_local_analyze_video({video_path, clip_length_seconds, max_candidates, style, keywords})
3. mcp_highlight_local_get_analysis_status({analysis_id, include_transcript:false})
   直到 status=completed；最多 30 次，error 就停止。

回傳 result.candidates 的 id、startSeconds、endSeconds、durationSeconds、
score、reasons、quote、evidence。

候選表至少要有：

| ID | source start–end | duration | score | reason | quote/evidence | limitation |
|---|---|---:|---:|---|---|---|

然後輸出：

~~~text
請只回覆要剪的候選 ID，例如：使用 highlight-001、highlight-003。
我在收到 ID 前不會修改 Premiere。
~~~

分析、找亮點、顯示候選，都不是 Premiere 編輯授權。

### EDIT

只有收到候選 ID 後，依序呼叫：

~~~text
get_capabilities(checkConnection=false)
verify_premiere_connection
list_sequences（只有 activeSequence 為 null 時需要）
duplicate_sequence(clearContents=true)
import_media
add_to_timeline_batch(linkAudio=true)
set_active_sequence
list_sequence_tracks
validate_project_for_export
~~~

固定成功條件：

- get_capabilities：success=true 且 bridge.cep.status=installed。
- verify_premiere_connection：success=true 且 status=connected。
- duplicate_sequence：success=true 且有 newSequenceId。
- import_media：success=true 且有 id。
- add_to_timeline_batch：success=true、status=success、failed=0、
  placed=total。
- 最後驗證：readyForExport=true、offlineMediaCount=0、gapCount=0。

9B 簡化模式要求 Premiere 已有一個 source sequence：

- 有 activeSequence.id 就使用它。
- 沒有 active sequence 且 list_sequences.count=1 就使用唯一 sequence。
- count=0 或 count>1 就停止，請使用者建立/開啟正確的 source sequence。
- 不猜 sequence、不猜 .sqpreset，不使用 create_sequence_from_clips。
- 原始 sequence 只作為複製來源，永遠不是 timeline 寫入目的地。

任何 success=false、isError=true、partial、驗證錯誤，都停止並報告；不做盲目
重試。最小模式不加 marker。儲存 .prproj 或 render MP4 必須另一次明確授權。

## Scoring 行為

highlight_local 是透明 heuristic，不是語意真相。預設訊號：

- transcript/ASR：有字幕時作主要語意證據；
- audio energy / relative audio burst：相對於同一影片的 local baseline；
- scene boundary：協助切點與候選生成，不代表亮點；
- motion：低權重 frame difference，只能作輔助證據。

Objects/actions 目前不是預設 detector，不能因為工具存在就自行啟用。完整欄位與
權重請看 [scoring-profile.md](.agents/skills/local-livestream-premiere/references/scoring-profile.md)。

如果使用者只要交接檔而不是 live Premiere edit，在候選 ID 核准後才呼叫
highlight_local.export_premiere_plan，使用 local output directory、
include_xml=true、overwrite=false。JSON/FCP7 檔案不是 Premiere 已完成剪輯。

## 全新 Windows 機器部署

完整且可逐步執行的文件在
[mcp-setup-windows.md](.agents/skills/local-livestream-premiere/references/mcp-setup-windows.md)。

### 先決條件

- Windows PowerShell、Git、Node.js 22+、npm、Hermes。
- Adobe Premiere Pro。
- repository 本身的 npm ci dependencies。
- Hermes Node tree 中的 video-context-mcp 與 adobe-premiere-pro-mcp。
- ffmpeg.exe、ffprobe.exe、yt-dlp.exe，預設在
  <REPO_ROOT>\tools\bin。
- 本地 ASR runtime/model cache，或明確的 .srt/.vtt sidecar。

### 最短部署步驟

~~~powershell
$RepoRoot = 'C:\Work\Premiere-Pro-MCP-Server'
$VideoRoot = 'D:\Videos\Livestreams'

git clone https://github.com/birdie-hsu/Premiere-Pro-MCP-Server.git $RepoRoot
Set-Location -LiteralPath $RepoRoot
npm ci
npm test
hermes skills trust $RepoRoot

$Bootstrap = Join-Path $RepoRoot '.agents\skills\local-livestream-premiere\scripts\ensure-hermes-config.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -VideoRoot $VideoRoot
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -VideoRoot $VideoRoot -Apply
~~~

先 preview，再 -Apply。非英文影片在兩次 command 都傳同一個 -AsrModel。如果 CEP
extension 缺少，且使用者已授權 setup，再執行：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -VideoRoot $VideoRoot -Apply -InstallPremiereCep
~~~

bootstrap 會生成 project-scoped .codex\config.toml，驗證三個 entrypoint、Node、
FFmpeg/FFprobe/yt-dlp 和 ASR runtime，並在覆寫既有 config 前建立 backup。不要
commit .codex 或任何使用者路徑。

### Premiere bridge 必做步驟

1. 重開 Premiere Pro。
2. 開啟 Window > Extensions > MCP Bridge (CEP)。
3. Temp Directory 填入 bootstrap 顯示的完整 PREMIERE_TEMP_DIR。
4. 依序按 Save Configuration、Start Bridge、Test Connection。
5. 重新開啟 Hermes session。
6. 先跑 get_capabilities(checkConnection=false)，再跑
   verify_premiere_connection。

### Readiness 不可混淆

| 檢查 | 只代表 |
|---|---|
| bootstrap preview | 本機路徑、package、tool、runtime 存在 |
| hermes mcp test premiere_cep | stdio MCP process 能啟動 |
| get_capabilities(checkConnection=false) | CEP extension/bridge 安裝可被檢查 |
| verify_premiere_connection | Premiere panel 與 live CEP bridge 可回應 |

只有最後一項成功才可以修改 Premiere。

## 安全邊界

- 所有影片、ASR、cache、分析結果留在本機。
- 只接受 allowlist 內的絕對路徑，不掃描整台電腦。
- 不用 UXP、raw ExtendScript、cloud video service、network listener。
- 原始 sequence 保留；只在新複製的 AI Highlights sequence 放片段。
- 不自動 save、render 或覆寫既有輸出。
- 不 commit .codex、.cache、node_modules、tools\bin、影片、Premiere
  project、exports 或使用者絕對路徑。

## Repository map

| 路徑 | 內容 |
|---|---|
| src/index.js | highlight_local STDIO MCP entrypoint |
| src/server.js | local analysis/plan tools |
| src/analysis.js / src/scoring.js | analysis pipeline and scoring |
| src/ffmpeg.js / src/motion.js / src/transcribe.js | local media/ASR |
| src/premiere-xml.js | JSON/FCP7 XML handoff |
| .agents/skills/local-livestream-premiere | canonical skill, references, bootstrap |
| test/unit.test.js | local scoring, signals, allowlist, handoff tests |

## 驗證

~~~powershell
npm ci
npm test
node --check src\index.js
hermes skills list --source all
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
~~~

最後必須以 premiere_cep.get_capabilities 和
premiere_cep.verify_premiere_connection 確認 live readiness；process test 本身
不足以宣稱可以剪輯。
