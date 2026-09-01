# Premiere Highlight MCP

這是一個本機優先的 MCP，用來把直播影片轉成可檢查的 highlight 候選，再交接給 Premiere Pro。核心分析、評分、JSON plan 與 FCP 7 XML 都是本專案自己的程式；它不使用 UXP，也不啟動 HTTP listener。

## 工作流程

1. 將影片放在專案 allowlist 內，或在 `.codex/config.toml` 的 `HIGHLIGHT_ALLOWED_ROOTS` 加入影片所在資料夾。
2. 呼叫 `analyze_video`，傳入絕對路徑、目標片段長度與可選風格/關鍵字。
3. 用 `get_analysis_status` 輪詢 `analysisId`。結果會包含候選的開始/結束時間、分數、理由與 audio/transcript/scene evidence。
4. 用 `get_frame` 檢查候選畫面。
5. 明確確認候選後，呼叫 `export_premiere_plan`。它會在 allowlist 內寫入 JSON plan 與 XML；不會改動 Premiere 或原始 sequence。
6. 在 Premiere Pro 匯入 XML，或交由專案內的 `premiere_cep` MCP 依 plan 做後續剪輯。

## 分析訊號

- FFprobe：媒體長度、影像尺寸、幀率與音訊資訊。
- FFmpeg：逐秒 RMS/peak 音訊能量與 scene-change 訊號。
- 字幕：優先讀取影片同名 `.srt` 或 `.vtt` sidecar。
- ASR：沒有 sidecar 時可使用已快取的本機 Transformers Whisper 模型；設定檔預設使用 `auto`，不會在剪輯時自動下載模型。
- 評分：以透明的 heuristic 組合 transcript/ASR、逐秒 audio energy、相對局部音訊 burst、scene boundary 與低權重 frame-difference motion；每個候選會回傳 evidence，而不是只給黑箱分數。完整的一秒 signal timeline 會寫入分析快取，供檢查與重新排序。

## 預設 scoring profile

- transcript/ASR 是主要語意訊號；保留 cue timestamp、短引文、說話覆蓋率、語句密度與興奮詞證據。
- audio burst 以影片內 rolling local baseline/MAD 衡量，不使用固定的 dB 閾值。
- scene change 主要用來偏好乾淨的剪輯起訖點；motion 只作低權重的輔助訊號。
- objects/actions 不會預設啟用，除非內容設定指定目標標籤且本機 detector 可用。

Motion 預設啟用但可用 `HIGHLIGHT_MOTION_ENABLED=false` 關閉；`HIGHLIGHT_MOTION_SAMPLE_RATE` 預設為每秒 1 個低解析度影格，`HIGHLIGHT_MOTION_DIFF_THRESHOLD` 預設為 `0.08`。

## 安全預設

- 只接受 allowlist 內的絕對本機路徑，並檢查 symlink 是否逃出 allowlist。
- 只用 `execFile` 傳遞 FFmpeg 參數，不拼接 shell command。
- 快取與分析結果寫在專案 `.cache`，匯出拒絕覆蓋既有檔案，除非明確傳入 `overwrite=true`。
- 原始影片與 Premiere sequence 不會被刪除或修改。

## 開發檢查

```powershell
npm test
npm start
```

MCP server 只把協定訊息寫到 stdout；啟動與錯誤訊息寫到 stderr，適合由 Codex 的 STDIO MCP 設定啟動。
