<#
.SYNOPSIS
  Установщик бандла agent-templates (клонируй репо -> запусти этот скрипт -> вуаля).
.DESCRIPTION
  Разворачивает автоматизацию из клона репозитория в машину:
  0. Проверка prerequisites (git, python, node, rtk) - только предупреждения.
  1. Стабильный рантайм -> $RuntimeDir (~/.agent-templates): скрипты и dist aislop.
     Рантайм НЕ зависит от папки клона: клон можно удалить/переместить.
  2. Antigravity: хук PreInvocation -> ~/.gemini/config/hooks.json (merge по ключу).
  3. OpenCode: плагины -> ~/.config/opencode/plugins/ (включая rtk.ts).
  4. Скиллы -> ~/.config/opencode/skills/ и ~/.gemini/config/skills/.
  5. OpenCode: merge MCP-записи aislop -> ~/.config/opencode/opencode.json (остальное не трогает).
  6. Самопроверка: hook self-test, наличие файлов, версии. "Вуаля" только если все зеленое.
  Совместим с Windows PowerShell 5.1 и PowerShell 7+ (только двухаргументный Join-Path).
.EXAMPLE
  git clone <repo-url> agent-bundle
  powershell -ExecutionPolicy Bypass -File agent-bundle/scripts/install.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [string]$RuntimeDir = "",
  [string]$HomeDir = "",
  [switch]$SkipVerify
)
# NOTE: $PSScriptRoot нельзя вызывать внутри default-значений param в PS 5.1
# (автопеременная еще не заселена для выражений с командлетами) - только в теле.
if ([string]::IsNullOrEmpty($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$BaseHome = if ([string]::IsNullOrEmpty($HomeDir)) { $HOME } else { $HomeDir }
$ErrorActionPreference = "Stop"

function Join-Two([string]$a, [string]$b) { Join-Path -Path $a -ChildPath $b }
function Test-Cmd([string]$name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

if ([string]::IsNullOrEmpty($RuntimeDir)) { $RuntimeDir = Join-Two $BaseHome ".agent-templates" }
$issues = @()

# --- 0. Prerequisites (warn-only, graceful degradation) ---
Write-Host "== [0/6] Prerequisites =="
if (-not (Test-Cmd "git")) {
  $issues += "git не найден: init-скрипты пропустят git-секцию (создадут маркер AGENT_INIT_GIT_SKIPPED)."
  Write-Warning $issues[-1]
}
if (-not (Test-Cmd "python")) {
  $issues += "Команда 'python' не найдена: хук Antigravity не сможет запускаться."
  Write-Warning $issues[-1]
}
if (-not (Test-Cmd "node")) {
  $issues += "Команда 'node' не найдена: MCP aislop и TS-плагины OpenCode не запустятся."
  Write-Warning $issues[-1]
}
if (Test-Cmd "rtk") {
  $verOut = (rtk --version 2>$null | Out-String)
  if ($verOut -match "rtk\s+(\d+\.\d+\.\d+)") {
    if ([version]$Matches[1] -lt [version]"0.23.0") {
      $issues += "rtk $($Matches[1]) < 0.23.0: плагин rtk.ts требует >= 0.23.0."
      Write-Warning $issues[-1]
    } else {
      Write-Host ("rtk OK: {0}" -f $Matches[1])
    }
  }
} else {
  $issues += "rtk не найден в PATH: плагин rtk.ts самоотключится (graceful). Доставьте rtk для экономии токенов."
  Write-Warning $issues[-1]
}

# --- 1. Stable runtime (независим от папки клона) ---
Write-Host "== [1/6] Runtime -> $RuntimeDir =="
$rtScripts = Join-Two $RuntimeDir "scripts"
$rtDist = Join-Two (Join-Two (Join-Two $RuntimeDir "tools") "aislop") "dist"
foreach ($d in @($rtScripts, $rtDist)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$hookSrc = Join-Two (Join-Two $RepoRoot "scripts") "hook-pre-invocation.py"
if (-not (Test-Path $hookSrc)) { throw "Hook not found in bundle: $hookSrc" }
foreach ($name in @("hook-pre-invocation.py", "init-workspace.ps1", "init-workspace.sh", "register-agentdb-domain.py")) {
  $src = Join-Two (Join-Two $RepoRoot "scripts") $name
  if (Test-Path $src) { Copy-Item $src (Join-Two $rtScripts $name) -Force }
}
$distSrc = Join-Two (Join-Two (Join-Two $RepoRoot "tools") "aislop") "dist"
if (-not (Test-Path (Join-Two $distSrc "mcp.js"))) { throw "aislop dist not built in bundle: $distSrc (запустите сборку tools/aislop)" }
Copy-Item (Join-Two $distSrc "*") $rtDist -Recurse -Force
$pkgSrc = Join-Two (Join-Two (Join-Two $RepoRoot "tools") "aislop") "package.json"
if (Test-Path $pkgSrc) { Copy-Item $pkgSrc (Join-Two (Join-Two $RuntimeDir "tools") "aislop") -Force }
# Init templates: init-workspace.* resolves them from $BaseDir (== runtime root),
# so the runtime needs rules/ and workspaces/ too, not just scripts/.
foreach ($td in @("rules", "workspaces")) {
  $tsrc = Join-Two $RepoRoot $td
  if (Test-Path $tsrc) {
    $tdst = Join-Two $RuntimeDir $td
    if (Test-Path $tdst) { Remove-Item $tdst -Recurse -Force }
    Copy-Item $tsrc $tdst -Recurse -Force
  } else {
    Write-Warning "Template dir missing in bundle, init will fail loudly: $tsrc"
  }
}
$hookScript = Join-Two $rtScripts "hook-pre-invocation.py"
$mcpJs = Join-Two $rtDist "mcp.js"
Write-Host "Runtime OK."

# --- 2. Antigravity hook (user scope, merge) ---
Write-Host "== [2/6] Antigravity hook =="
$geminiDir = Join-Two (Join-Two $BaseHome ".gemini") "config"
$hooksFile = Join-Two $geminiDir "hooks.json"
if (-not (Test-Path $geminiDir)) { New-Item -ItemType Directory -Path $geminiDir -Force | Out-Null }
$hooks = if (Test-Path $hooksFile) {
  Get-Content $hooksFile -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  New-Object psobject
}
$hookEntry = [pscustomobject]@{
  enabled       = $true
  PreInvocation = @(
    [pscustomobject]@{
      type    = "command"
      command = 'python "' + $hookScript + '"'
      timeout = 20
    }
  )
}
$hooks | Add-Member -NotePropertyName "workspace-auto-init" -NotePropertyValue $hookEntry -Force
$hooks | ConvertTo-Json -Depth 10 | Set-Content $hooksFile -Encoding UTF8
Write-Host "Hook -> $hooksFile"

# --- 3. OpenCode plugins ---
Write-Host "== [3/6] OpenCode plugins =="
$ocPlugins = Join-Two (Join-Two (Join-Two $BaseHome ".config") "opencode") "plugins"
if (-not (Test-Path $ocPlugins)) { New-Item -ItemType Directory -Path $ocPlugins -Force | Out-Null }
$deployedPlugins = @()
Get-ChildItem (Join-Two (Join-Two $RepoRoot "plugins") "opencode") -Filter *.ts | ForEach-Object {
  Copy-Item $_.FullName (Join-Two $ocPlugins $_.Name) -Force
  $deployedPlugins += $_.Name
}
Write-Host ("Plugins -> {0} : {1}" -f $ocPlugins, ($deployedPlugins -join ", "))

# --- 4. Skills (обе платформы, один формат: skills/<name>/SKILL.md) ---
Write-Host "== [4/6] Skills =="
$ocSkills = Join-Two (Join-Two (Join-Two $BaseHome ".config") "opencode") "skills"
$geminiSkills = Join-Two $geminiDir "skills"
foreach ($d in @($ocSkills, $geminiSkills)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$deployedSkills = @()
Get-ChildItem (Join-Two $RepoRoot "skills") -Directory | Where-Object {
  $_.Name -ne "_skill_template" -and (Test-Path (Join-Two $_.FullName "SKILL.md"))
} | ForEach-Object {
  foreach ($d in @($ocSkills, $geminiSkills)) {
    $dest = Join-Two $d $_.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse -Force
  }
  $deployedSkills += $_.Name
}
Write-Host ("Skills -> {0} + {1} : {2}" -f $ocSkills, $geminiSkills, ($deployedSkills -join ", "))

# --- 5. OpenCode MCP merge (только запись aislop, остальное не трогаем) ---
Write-Host "== [5/6] OpenCode MCP (aislop) =="
$ocDir = Join-Two (Join-Two $BaseHome ".config") "opencode"
$ocJson = Join-Two $ocDir "opencode.json"
if (-not (Test-Path $ocDir)) { New-Item -ItemType Directory -Path $ocDir -Force | Out-Null }
$oc = if (Test-Path $ocJson) {
  Get-Content $ocJson -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  New-Object psobject
}
if (-not ($oc | Get-Member -Name "mcp" -MemberType NoteProperty)) {
  $oc | Add-Member -NotePropertyName "mcp" -NotePropertyValue (New-Object psobject)
}
$aislopEntry = [pscustomobject]@{
  type    = "local"
  command = @("node", $mcpJs)
  enabled = $true
  timeout = 30000
}
$oc.mcp | Add-Member -NotePropertyName "aislop" -NotePropertyValue $aislopEntry -Force
$oc | ConvertTo-Json -Depth 10 | Set-Content $ocJson -Encoding UTF8
Write-Host "MCP aislop -> $ocJson"
Write-Host "Примечание: MCP agentdb и codebase-memory-mcp внешние (ставятся отдельно), бандл их не разворачивает."

# --- 6. Verify ---
if (-not $SkipVerify) {
  Write-Host "== [6/6] Verify =="
  $coreFail = @()
  foreach ($f in @($hookScript, $mcpJs)) {
    if (-not (Test-Path $f)) { $coreFail += "Отсутствует рантайм-файл: $f" }
  }
  if (Test-Cmd "python") {
    $probe = "{}" | & python "$hookScript" 2>$null
    $probeOut = ($probe -join "")
    if ($LASTEXITCODE -ne 0 -or $probeOut -notmatch "injectSteps") {
      $coreFail += "Hook self-test провален (RC=$LASTEXITCODE, out=$($probeOut.Substring(0, [Math]::Min(60, $probeOut.Length))))."
    } else {
      Write-Host "Hook self-test OK."
    }
  } else {
    Write-Warning "Hook self-test пропущен: нет python."
  }
  if ($coreFail.Count -gt 0) { throw ($coreFail -join "`n") }
}

Write-Host ""
if ($issues.Count -eq 0) {
  Write-Host "Вуаля: бандл установлен, все проверки зеленые. Перезапустите Antigravity / OpenCode."
} else {
  Write-Host "Установлено с предупреждениями (ядро зеленое):"
  $issues | ForEach-Object { Write-Host ("  - {0}" -f $_) }
  Write-Host "Перезапустите Antigravity / OpenCode."
}
