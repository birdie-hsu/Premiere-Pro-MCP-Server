# 全新 Windows 機器部署 local-livestream-premiere

本文件把「全新機器 → Hermes → 三個本地 MCP → Premiere Pro CEP 剪輯」整理成
可重複執行的部署流程。部署完成後，Hermes agent 可以讀取本 skill，分析本地
livestream，並在使用者明確核准後把片段組成 Premiere sequence。

| MCP server | 階段 | 負責內容 |
|---|---|---|
| 'video_context' | 分析 | 本地轉錄、時間軸、語意搜尋、keyframe/OCR |
| 'highlight_local' | 分析/交接 | scene、motion、audio、transcript 評分，以及 JSON/FCP7 handoff |
| 'premiere_cep' | 剪輯 | 透過 CEP bridge 連接 Premiere，建立非破壞性 sequence |

三個 server 不一定同時執行。正常順序是先用 'video_context' 分析，再由
'highlight_local' 補充評分或交接；只有使用者明確核准候選片段後，才調用
'premiere_cep' 修改 Premiere。

## 完成定義

從 repository root 開啟新的 Hermes session 後，應能確認：

1. Hermes 找得到並啟用 'local-livestream-premiere' skill。
2. project-scoped <REPO_ROOT>\.codex\config.toml 已註冊三個 server。
3. 三個 'hermes mcp test' 都能啟動 stdio process；這不等於 Premiere live connection。
4. 'get_capabilities(checkConnection=false)' 能確認 CEP 安裝狀態。
5. Premiere CEP panel 已 Started/Connected，且 'verify_premiere_connection' 成功；activeSequence 可以是 null。
6. 影片、轉錄、cache、分析結果和暫存檔都留在本機。

只複製 repository 再讀取 skill 不足以完成全新機器部署。Skill 會自動化設定與
檢查，但不會替代一次性的主機 provisioning。

## 0. 準備路徑與先決條件

先在 PowerShell 設定新機器的實際絕對路徑：

~~~powershell
$RepoRoot = 'C:\Work\Premiere Pro MCP'
$VideoRoot = 'D:\Videos\Livestreams'
$HermesRoot = Join-Path $env:LOCALAPPDATA 'hermes'
~~~

需要準備：

| 項目 | 用途 | 檢查 |
|---|---|---|
| Git | 取得 repository | 'git --version' |
| Node.js 22+/npm | 安裝與測試本地 MCP；video_context 要求 Node 22 | 'node --version'、'npm --version' |
| Hermes agent | skill discovery、MCP 啟動和 tool routing | 'hermes --version' |
| Adobe Premiere Pro | 匯入影片與編輯 sequence | 啟動應用程式 |
| Premiere CEP bridge | 讓 'premiere_cep' 連到 Premiere | 安裝並開啟 bridge panel |
| 本地影片資料夾 | source media | 必須是現存絕對資料夾 |
| FFmpeg、FFprobe、yt-dlp | 本地媒體探勘和分析 | 放在 'tools\bin' |
| Hermes Node/MCP packages | 啟動兩個 Hermes-side server | 見第 3 節 |

~~~powershell
git --version
node --version
npm --version
hermes --version
Test-Path -LiteralPath $VideoRoot -PathType Container
~~~

若 'hermes' 找不到，先完成 'hermes setup' 或組織核准的 Hermes 安裝流程，並讓
它加入目前使用者的 PATH。Premiere 必須透過 Adobe 官方方式安裝；CEP extension
會在第 6 節以明確 opt-in 安裝。不要用 UXP、raw ExtendScript、cloud video
service 或 network listener 代替 CEP。

## 1. 取得 repository 並安裝本地 server

~~~powershell
git clone 'https://github.com/birdie-hsu/Premiere-Pro-MCP-Server.git' $RepoRoot
Set-Location -LiteralPath $RepoRoot
npm ci
npm test
~~~

'npm ci' 只會安裝 repository 的 'highlight_local' 依賴。它不會安裝 Hermes 內的
'video_context'、'premiere_cep' package，也不會安裝 FFmpeg、yt-dlp、ASR model
或 Premiere CEP bridge。

確認 repository 至少包含：

~~~text
<REPO_ROOT>\package.json
<REPO_ROOT>\src\index.js
<REPO_ROOT>\.agents\skills\local-livestream-premiere\SKILL.md
~~~

## 2. 準備本地媒體工具

將相容 executable 放到：

~~~text
<REPO_ROOT>\tools\bin\ffmpeg.exe
<REPO_ROOT>\tools\bin\ffprobe.exe
<REPO_ROOT>\tools\bin\yt-dlp.exe
~~~

這些檔案被 .gitignore 排除，不會隨 Git clone 一起出現。完成 provisioning 後
執行：

~~~powershell
$ToolPaths = @(
    (Join-Path $RepoRoot 'tools\bin\ffmpeg.exe'),
    (Join-Path $RepoRoot 'tools\bin\ffprobe.exe'),
    (Join-Path $RepoRoot 'tools\bin\yt-dlp.exe')
)

$ToolPaths | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_ -PathType Leaf)) {
        throw "Missing local media tool: $_"
    }
}

& (Join-Path $RepoRoot 'tools\bin\ffmpeg.exe') -version | Select-Object -First 1
& (Join-Path $RepoRoot 'tools\bin\ffprobe.exe') -version | Select-Object -First 1
& (Join-Path $RepoRoot 'tools\bin\yt-dlp.exe') --version
~~~

若工具不在預設位置，bootstrap 時傳入 '-FfmpegBin' 和 '-FfprobeBin'。目前
'yt-dlp' 的預設路徑仍是 <REPO_ROOT>\tools\bin\yt-dlp.exe。

## 3. 準備 Hermes Node、MCP entrypoint 和本地 ASR

預設 Hermes layout：

~~~text
%LOCALAPPDATA%\hermes\node\node.exe
%LOCALAPPDATA%\hermes\node\node_modules\@smallthinkingmachines\video-context-mcp\dist\index.js
%LOCALAPPDATA%\hermes\node\node_modules\adobe-premiere-pro-mcp\dist\index.js
%LOCALAPPDATA%\hermes\node\node_modules\@smallthinkingmachines\video-context-mcp\vendor\transformers.node.min.mjs
~~~

請使用目前 Hermes distribution 或組織指定的 provisioning/update 流程，將相容
版本安裝到同一個 Hermes Node 'node_modules' tree。不要只把 package 裝到
repository 的 'node_modules'，因為 bootstrap 會用 Hermes Node 啟動 entrypoint。

若 Hermes Node tree 確實缺少 package，且使用者已核准從 npm registry 下載，可
安裝本 repository 驗證過的 baseline；這只下載 runtime package，不會上傳影片：

~~~powershell
$HermesNodeRoot = Join-Path $HermesRoot 'node'
$HermesNpm = Join-Path $HermesNodeRoot 'npm.cmd'
& $HermesNpm install --prefix $HermesNodeRoot --no-save --package-lock=false `
    '@smallthinkingmachines/video-context-mcp@0.8.0' `
    'adobe-premiere-pro-mcp@1.2.5'
~~~

版本升級應視為獨立變更，閱讀 upstream release notes 後重跑本文件全部驗證。

本地 ASR 需要 Transformers runtime 與可用的 model cache。若新機器沒有 cache，
先在允許下載模型的 provisioning 階段完成模型準備；影片本身仍必須是本地檔案。
若暫時沒有 ASR runtime，可以使用本地 '.srt' 或 '.vtt' sidecar 作為明確 fallback，
但結果必須標示不是完整 ASR。

~~~powershell
$HermesNodeRoot = Join-Path $HermesRoot 'node'
$HermesChecks = @(
    (Join-Path $HermesNodeRoot 'node.exe'),
    (Join-Path $HermesNodeRoot 'node_modules\@smallthinkingmachines\video-context-mcp\dist\index.js'),
    (Join-Path $HermesNodeRoot 'node_modules\adobe-premiere-pro-mcp\dist\index.js'),
    (Join-Path $HermesNodeRoot 'node_modules\@smallthinkingmachines\video-context-mcp\vendor\transformers.node.min.mjs')
)

$HermesChecks | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_ -PathType Leaf)) {
        throw "Missing Hermes runtime or MCP asset: $_"
    }
}
~~~

如果 Hermes 不在 '%LOCALAPPDATA%\hermes'，保留實際安裝位置，稍後以
'-HermesRoot <實際路徑>' 傳給 bootstrap；不需要複製或改名 runtime。

若新機器尚未 cache ASR/OCR model，經使用者核准網路下載後可預先準備。以下
cache 路徑與 bootstrap 生成的 config 一致：

~~~powershell
$VideoContextCli = Join-Path $HermesNodeRoot 'video-context-mcp.cmd'
$env:VCM_CACHE_DIR = Join-Path $RepoRoot '.cache\video-context-mcp'
$env:VCM_TOOLCHAIN_MODE = 'system'
$env:VCM_FFMPEG_BIN = Join-Path $RepoRoot 'tools\bin\ffmpeg.exe'
$env:VCM_FFPROBE_BIN = Join-Path $RepoRoot 'tools\bin\ffprobe.exe'
$env:VCM_YTDLP_BIN = Join-Path $RepoRoot 'tools\bin\yt-dlp.exe'
$env:VCM_OCR_BACKEND = 'wasm'
$env:VCM_ASR_BACKEND = 'transformers'
$env:VCM_ASR_MODEL = 'Xenova/whisper-base.en'
& $VideoContextCli setup --all
& $VideoContextCli doctor --json
~~~

若要使用多語 model，把 'VCM_ASR_MODEL' 與第 5 節的 '-AsrModel' 設成同一值。
這個 provisioning 只下載 runtime/model，不會上傳本地影片。

## 4. 讓 Hermes 找得到 skill

Hermes 只從受信任 repository 的 '.agents/skills' 或 '.hermes/skills' 載入
project-local skill。先明確 trust，再檢查 discovery：

~~~powershell
Set-Location -LiteralPath $RepoRoot
hermes skills trust $RepoRoot
hermes skills list --source all
~~~

輸出應包含本地啟用的 'local-livestream-premiere'。Project-local skill 優先於
'%LOCALAPPDATA%\hermes\skills' 的使用者副本；這可避免讀到舊版同名 skill。若仍
找不到，確認從 repository root 啟動，且
'.agents\skills\local-livestream-premiere\SKILL.md' 存在。不要自行建立另一份
同名 skill。

## 5. 生成 project-scoped MCP config

本 repository 的唯一 canonical config 是：

~~~text
<REPO_ROOT>\.codex\config.toml
~~~

不要使用舊的 YAML config.yaml，也不要把尚未替換的 <REPO_ROOT> 或 <HERMES_ROOT>
寫進 live config。

先在 preview mode 驗證路徑：

~~~powershell
Set-Location -LiteralPath $RepoRoot
$Bootstrap = Join-Path $RepoRoot '.agents\skills\local-livestream-premiere\scripts\ensure-hermes-config.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -HermesRoot $HermesRoot -VideoRoot $VideoRoot
~~~

確認 preview 沒有 missing path 後，才套用設定：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -HermesRoot $HermesRoot -VideoRoot $VideoRoot -Apply
~~~

工具不在預設位置時：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -HermesRoot $HermesRoot -VideoRoot $VideoRoot -FfmpegBin 'D:\Tools\ffmpeg.exe' -FfprobeBin 'D:\Tools\ffprobe.exe' -Apply
~~~

bootstrap 會：

- 驗證 Hermes Node、三個 entrypoint、FFmpeg/FFprobe/yt-dlp 和 VideoRoot。
- 產生或合併 <REPO_ROOT>\.codex\config.toml。
- 只管理 'video_context'、'highlight_local'、'premiere_cep' 三個 server block，保留其他設定。
- 若 config 已存在，先建立 timestamped .bak-* backup。
- 將 <VIDEO_ROOT> 放入 'HIGHLIGHT_ALLOWED_ROOTS'，不放寬到整台機器。
- 指向本地 cache、Transformers runtime 和 system FFmpeg toolchain。
- 讓 video_context 與 highlight_local 使用相同的 ASR model。

預設 ASR model 是英文 'Xenova/whisper-base.en'。多語或非英文影片在 preview
和 apply 都傳入相同的 '-AsrModel'，例如：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -HermesRoot $HermesRoot -VideoRoot $VideoRoot -AsrModel 'Xenova/whisper-base' -Apply
~~~

生成的 server map 應符合：

| Server | 啟動方式 | 重要環境 |
|---|---|---|
| 'video_context' | Hermes Node → video-context-mcp entrypoint | system FFmpeg/FFprobe/yt-dlp、local cache、Transformers ASR/OCR |
| 'highlight_local' | Hermes Node → <REPO_ROOT>\src\index.js | project root、VideoRoot allowlist、local FFmpeg/FFprobe、ASR runtime/cache、motion enabled |
| 'premiere_cep' | Hermes Node → adobe-premiere-pro-mcp entrypoint | local PREMIERE_TEMP_DIR、CEP bridge |

'.codex'、'.cache'、'node_modules'、'tools\bin' 和使用者路徑都是本機生成或安裝
內容，不應 commit 到 repository。

## 6. 安裝並啟動 Premiere CEP bridge

Bootstrap preview 會顯示 CEP extension 是 installed 或 missing。只有使用者要求
或核准 environment setup 後，才用明確 opt-in 安裝：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot $RepoRoot -HermesRoot $HermesRoot -VideoRoot $VideoRoot -Apply -InstallPremiereCep
~~~

這個 switch 會使用已安裝 'adobe-premiere-pro-mcp' package 的官方 Windows
installer，並：

- 替換前把目前使用者的 extension 備份到
  '<HERMES_ROOT>\backups\premiere-cep'（不放在 Adobe extensions 目錄，避免重複載入）；
- 安裝 CEP panel、設定 Adobe CSXS PlayerDebugMode、建立 'PREMIERE_TEMP_DIR'；
- 跳過 VS Code/Copilot 與 Claude Desktop config，避免修改無關 client。

完成後執行 package doctor：

~~~powershell
$PremiereCli = Join-Path $HermesNodeRoot 'node_modules\adobe-premiere-pro-mcp\dist\cli.js'
& (Join-Path $HermesNodeRoot 'node.exe') $PremiereCli --doctor
~~~

接著：

1. 完全關閉並重新開啟 Premiere Pro，載入 project。
2. 開啟 'Window > Extensions > MCP Bridge (CEP)'。
3. 將 panel 的 Temp Directory 設成 bootstrap 顯示的 'Premiere temp' 完整路徑。
4. 依序按 'Save Configuration'、'Start Bridge'、'Test Connection'。
5. Panel 必須顯示 Started/Connected。

Panel 不出現時，確認
'%APPDATA%\Adobe\CEP\extensions\MCPBridgeCEP\CSXS\manifest.xml'、doctor 與
debug mode，然後重啟 Premiere。不要啟用 package 內的 experimental UXP panel。

## 7. 重新啟動 Hermes 並驗證三個 MCP

套用 config 後，關閉舊 session，從 repository root 開啟新的 Hermes session：

~~~powershell
Set-Location -LiteralPath $RepoRoot
hermes mcp list
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
~~~

預期 server 至少提供：

- 'video_context'：list_videos、ingest_video、get_ingest_status、get_video_timeline、search_videos、get_transcript，以及可用時的 peek_frame。
- 'highlight_local'：server_info、analyze_video、get_analysis_status、get_frame，以及可用時的 export_premiere_plan。
- 'premiere_cep'：get_capabilities、verify_premiere_connection、import_media、duplicate_sequence、add_to_timeline_batch、add_marker、set_active_sequence、list_sequence_tracks、validate_project_for_export。

'hermes mcp test premiere_cep' 能連到 MCP process，不代表 Premiere 已準備好。
實際剪輯前先呼叫 'get_capabilities(checkConnection=false)' 檢查本地安裝，再依
第 6 節啟動 panel，最後以 'verify_premiere_connection' 確認 host 與 project。
只有最後一步成功才可修改 Premiere；若 activeSequence 是 null，建立新 sequence
而不是拿不存在的 ID 呼叫 duplicate。

如果 'highlight_local' 的 'server_info' 可用，應確認 local-only、'uxp: false'
和 'networkListener: false'。連線失敗時修正安裝或 CEP panel，不要切換協定。

## 8. 第一次實際剪輯的安全流程

### 8.1 分析階段：不修改 Premiere

向 Hermes 提供影片絕對本地路徑、目標風格和期望片段長度：

~~~text
使用 local-livestream-premiere 分析 C:\Videos\stream.mp4，找出 15–60 秒的 viral moments。
先只回傳候選清單，不要修改 Premiere。
~~~

正常順序：

1. 'video_context' ingest 影片，或重用相同本地影片的 video_id。
2. 長影片優先採 ASR-first：visual=false、embed=false、whisper_fallback=true。
3. 用 transcript、timeline 和短搜尋找候選。
4. 'highlight_local' 必要時補 scene boundary、低權重 motion、相對 audio burst、transcript score，或輸出 JSON/FCP7 handoff。
5. 只對 shortlist 取 frame/OCR。
6. 回傳 candidate ID、起訖時間、duration、score、理由、短 quote/visual cue 和證據限制。

### 8.2 核准閘門

分析結果出來後必須停止，等待使用者明確核准 candidate ID 或時間範圍：

~~~text
使用 candidate highlight-001 和 highlight-004，建立一個新的 vertical highlights sequence。
~~~

單純說「分析影片」不包含修改 Premiere 的授權。

### 8.3 剪輯階段：使用 CEP、保留原始 sequence

核准後才執行：

1. 'premiere_cep.get_capabilities(checkConnection=false)'，確認 CEP 已安裝。
2. 'premiere_cep.verify_premiere_connection'；失敗立即停止。
3. 'duplicate_sequence(clearContents=true)' 或建立新 sequence；不要清空、刪除或覆寫原始 sequence。
4. 'import_media'（若素材尚未在 project）。
5. 用 'add_to_timeline_batch' 加入核准的 in/out，保留需要的 linked audio。
6. 用 'add_marker' 標記來源時間或 candidate ID，並 'set_active_sequence'。
7. 用 'list_sequence_tracks'、'validate_project_for_export' 做 read-only verification。
8. 只有使用者另外要求時，才 'save_project'、Save As 或 export。

完成回報列出 sequence、clip 數、audio linkage、gap/offline media、duration，以及
目前仍未儲存或未輸出的項目。

## 9. 常見問題與回復

| 現象 | 處理 |
|---|---|
| Skill 不存在 | 確認 Hermes 從 repository root 啟動、skill discovery/trust 已完成，且 SKILL.md 路徑正確；然後重啟。 |
| server not found / 沒有 tools | 確認 '<REPO_ROOT>\.codex\config.toml' 已生成，從 repository root 開新 session，再跑 'hermes mcp list'。 |
| Cannot find module | Hermes Node 與 entrypoint 不在同一個 node_modules tree，或 MCP package 未安裝；重新檢查第 3 節。 |
| FFmpeg/FFprobe/yt-dlp missing | 檢查 tools\bin，或用 '-FfmpegBin'、'-FfprobeBin' 傳入絕對路徑；VideoRoot 也必須存在。 |
| ASR 不可用 | 確認 Transformers runtime/model cache；或提供本地 .srt/.vtt sidecar，並在結果中標示 fallback。 |
| highlight_local 拒絕影片路徑 | 用影片所在的本地父資料夾作為 '-VideoRoot'，不要用整台磁碟或根目錄放寬 allowlist。 |
| premiere_cep process 已連線但 Premiere verify 失敗 | process test 不是 live test；確認 panel Temp Directory 完全一致，依序 Save/Start/Test，再重跑 verify。 |
| 分析超時 | 重用 indexed video_id，以 ASR-first、短搜尋和 shortlist frame inspection 降低成本。 |

遇到 bootstrap 失敗時，保留它回報的第一個 missing path，先補齊該依賴再重跑
preview。不要用替代協定繞過安全邊界。

## 10. 更新與最終檢查

repository 更新後：

~~~powershell
Set-Location -LiteralPath $RepoRoot
git pull
npm ci
npm test
~~~

若 MCP 路徑或 Hermes 位置改變，重新執行 preview，再以 '-Apply' 更新
'.codex\config.toml'。不要 commit 以下本機內容：

- '.codex\config.toml' 及 '.codex\config.toml.bak-*'
- '.cache\'、'.analysis\'、ASR/model cache
- 'tools\bin\' 下的 executable
- 'node_modules\'
- 影片、'.prproj'、export 和包含使用者路徑的分析 artifact

最終 checklist：

- [ ] Hermes 可執行，且從 <REPO_ROOT> 啟動。
- [ ] npm ci 與 npm test 通過。
- [ ] FFmpeg、FFprobe、yt-dlp 位於預期位置或已傳入 override。
- [ ] Hermes Node、三個 entrypoint 和 Transformers runtime 存在。
- [ ] local-livestream-premiere 已被 Hermes discovery 啟用。
- [ ] bootstrap preview 通過，-Apply 已生成 project-scoped TOML。
- [ ] 三個 hermes mcp test 都通過。
- [ ] get_capabilities 確認 CEP 安裝，panel 已 Started/Connected，verify_premiere_connection 成功。
- [ ] 分析先於剪輯，且取得 candidate approval。
- [ ] 原始 sequence 保留，新 sequence 完成 read-only verification。
- [ ] 儲存或 export 只在使用者明確要求後執行。
