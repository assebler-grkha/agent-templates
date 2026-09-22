<#
.SYNOPSIS
    Инициализирует стандартизированный workspace с динамическими правилами,
    файлами гигиены (.gitignore, .dockerignore, .env.example, README.md),
    доменом AgentDB и обязательной инициализацией Git + Remote.
.PARAMETER TargetPath
    Путь к целевому проекту (по умолчанию: текущая директория).
.PARAMETER ProjectName
    Имя проекта (по умолчанию: имя целевой папки).
.PARAMETER ProjectStack
    Технологический стек проекта (по умолчанию: 'TypeScript/Node').
.PARAMETER RuleType
    Тип файла правил: 'agents' (AGENTS.md), 'gemini' (GEMINI.md), 'claude' (CLAUDE.md).
.PARAMETER UseDynamic
    Использовать динамический шаблон с зонами и индексами (по умолчанию: $true).
.PARAMETER GitRemoteUrl
    URL удаленного репозитория Git (если передан, подключается origin).
#>
param (
    [string]$TargetPath = ".",
    [string]$ProjectName = "",
    [string]$ProjectStack = "TypeScript/Node",
    [ValidateSet("agents", "gemini", "claude")]
    [string]$RuleType = "agents",
    [bool]$UseDynamic = $true,
    [string]$GitRemoteUrl = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Split-Path -Parent $ScriptDir
$ResolvedTarget = Resolve-Path $TargetPath -ErrorAction SilentlyContinue
if (-not $ResolvedTarget) {
    New-Item -ItemType Directory -Path $TargetPath -Force | Out-Null
    $ResolvedTarget = Resolve-Path $TargetPath
}

if (-not $ProjectName) {
    $ProjectName = (Get-Item $ResolvedTarget).Name
}

$Today = (Get-Date).ToString("yyyy-MM-dd")

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Инициализация рабочего пространства для ИИ-агентов        " -ForegroundColor Cyan
Write-Host " Проект: $ProjectName | Стек: $ProjectStack"
Write-Host " Целевой путь: $($ResolvedTarget.Path)"
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Создание полной структуры папок по Канону
$DirsToCreate = @(
    "docs/architecture",
    "docs/decisions",
    "docs/specs/ui",
    "docs/specs/api",
    "docs/plans",
    "docs/guides",
    "docs/templates",
    "docs/archive",
    "scratch"
)

foreach ($dir in $DirsToCreate) {
    $fullDir = Join-Path $ResolvedTarget $dir
    if (-not (Test-Path $fullDir)) {
        New-Item -ItemType Directory -Path $fullDir -Force | Out-Null
    }
}
Write-Host "  [+] Создана структура папок docs/ и лаборатория scratch/" -ForegroundColor Green

# 2. Развертывание документации, индексов и шаблонов
$DocsDir = Join-Path $ResolvedTarget "docs"
$TemplatesSource = Join-Path $BaseDir "workspaces\minimal-agentic\docs\templates"
$TemplatesTarget = Join-Path $DocsDir "templates"

$CopyMap = @{
    (Join-Path $BaseDir "workspaces\minimal-agentic\docs\architecture\overview.md") = (Join-Path $DocsDir "architecture\overview.md")
    (Join-Path $BaseDir "workspaces\minimal-agentic\docs\decisions\0001-initial-architecture.md") = (Join-Path $DocsDir "decisions\0001-initial-architecture.md")
    (Join-Path $BaseDir "workspaces\minimal-agentic\docs\navigation-index.md") = (Join-Path $DocsDir "navigation-index.md")
    (Join-Path $BaseDir "workspaces\minimal-agentic\docs\notes-index.md") = (Join-Path $DocsDir "notes-index.md")
}

foreach ($src in $CopyMap.Keys) {
    $dst = $CopyMap[$src]
    if ((Test-Path $src) -and (-not (Test-Path $dst))) {
        Copy-Item -Path $src -Destination $dst
        Write-Host "  [+] Развернут документ: $(Split-Path $dst -Leaf)" -ForegroundColor Green
    }
}

# Копирование шаблонов спек и планов
if (Test-Path $TemplatesSource) {
    Get-ChildItem -Path $TemplatesSource -File | ForEach-Object {
        $destFile = Join-Path $TemplatesTarget $_.Name
        if (-not (Test-Path $destFile)) {
            Copy-Item -Path $_.FullName -Destination $destFile
        }
    }
    Write-Host "  [+] Развернуты шаблоны спецификаций в docs/templates/" -ForegroundColor Green
}

# 3. Развертывание файла правил (AGENTS.md / GEMINI.md / CLAUDE.md)
$RuleFileName = switch ($RuleType) {
    "agents" { "AGENTS.md" }
    "gemini" { "GEMINI.md" }
    "claude" { "CLAUDE.md" }
}
$TargetRuleFile = Join-Path $ResolvedTarget $RuleFileName

if ($UseDynamic) {
    $DynamicTemplateName = switch ($RuleType) {
        "agents" { "DYNAMIC_AGENTS.template.md" }
        "gemini" { "DYNAMIC_GEMINI.template.md" }
        "claude" { "DYNAMIC_CLAUDE.template.md" }
    }
    $DynamicTemplatePath = Join-Path $BaseDir "rules\$DynamicTemplateName"
    if (Test-Path $DynamicTemplatePath) {
        $templateContent = Get-Content -Path $DynamicTemplatePath -Raw -Encoding UTF8
        $rendered = $templateContent.Replace("{{PROJECT_NAME}}", $ProjectName)
        $rendered = $rendered.Replace("{{PROJECT_STACK}}", $ProjectStack)
        $rendered = $rendered.Replace("{{INIT_DATE}}", $Today)
        
        [System.IO.File]::WriteAllText($TargetRuleFile, $rendered, [System.Text.Encoding]::UTF8)
        Write-Host "  [+] Сгенерирован динамический файл правил: $RuleFileName (< 3.5 КБ)" -ForegroundColor Green
    }
} else {
    $SourceRuleTemplate = Join-Path $BaseDir "rules\$($RuleFileName.Replace('.md', '.template.md'))"
    if (Test-Path $SourceRuleTemplate) {
        Copy-Item -Path $SourceRuleTemplate -Destination $TargetRuleFile -Force
        Write-Host "  [+] Развернут файл правил: $RuleFileName" -ForegroundColor Green
    }
}

# 4. Файловая гигиена: .gitignore, .dockerignore, .env.example, README.md
$HygieneMap = @{
    (Join-Path $BaseDir "workspaces\minimal-agentic\.gitignore.template") = (Join-Path $ResolvedTarget ".gitignore")
    (Join-Path $BaseDir "workspaces\minimal-agentic\.dockerignore.template") = (Join-Path $ResolvedTarget ".dockerignore")
    (Join-Path $BaseDir "workspaces\minimal-agentic\.env.example.template") = (Join-Path $ResolvedTarget ".env.example")
}

foreach ($src in $HygieneMap.Keys) {
    $dst = $HygieneMap[$src]
    if ((Test-Path $src) -and (-not (Test-Path $dst))) {
        Copy-Item -Path $src -Destination $dst
        Write-Host "  [+] Создан гигиенический файл: $(Split-Path $dst -Leaf)" -ForegroundColor Green
    }
}

# Генерация README.md если отсутствует
$TargetReadme = Join-Path $ResolvedTarget "README.md"
if (-not (Test-Path $TargetReadme)) {
    $ReadmeTemplate = Join-Path $BaseDir "workspaces\minimal-agentic\README.template.md"
    if (Test-Path $ReadmeTemplate) {
        $readmeContent = Get-Content -Path $ReadmeTemplate -Raw -Encoding UTF8
        $readmeRendered = $readmeContent.Replace("{{PROJECT_NAME}}", $ProjectName)
        $readmeRendered = $readmeRendered.Replace("{{PROJECT_DESCRIPTION}}", "Рабочий проект с архитектурными стандартами и поддержкой ИИ-агентов.")
        $readmeRendered = $readmeRendered.Replace("{{LANG_RUNTIME}}", "Node.js 22+ / Python 3.11+")
        $readmeRendered = $readmeRendered.Replace("{{FRAMEWORK}}", $ProjectStack)
        $readmeRendered = $readmeRendered.Replace("{{DATABASE_ORM}}", "PostgreSQL / SQLite")
        [System.IO.File]::WriteAllText($TargetReadme, $readmeRendered, [System.Text.Encoding]::UTF8)
        Write-Host "  [+] Создан витринный README.md" -ForegroundColor Green
    }
}

# 5. Автономная регистрация домена проекта в AgentDB
$RegisterScript = Join-Path $ScriptDir "register-agentdb-domain.py"
if (Test-Path $RegisterScript) {
    Write-Host "  [*] Регистрация домена проекта в AgentDB..." -ForegroundColor Yellow
    $regOutput = python $RegisterScript --project "$ProjectName" --path "$($ResolvedTarget.Path)" --stack "$ProjectStack" 2>&1
    Write-Host "  $regOutput" -ForegroundColor Gray
}

# 6. Обязательная инициализация Git и подключение к Remote
$GitDir = Join-Path $ResolvedTarget ".git"
if (-not (Test-Path $GitDir)) {
    Write-Host "  [*] Инициализация Git-репозитория..." -ForegroundColor Yellow
    git -C $ResolvedTarget init -b main | Out-Null
    git -C $ResolvedTarget add . | Out-Null
    git -C $ResolvedTarget commit -m "chore: initial project scaffold, rules, and docs" | Out-Null
    Write-Host "  [+] Git репозиторий инициализирован, создан первый коммит в ветке 'main'" -ForegroundColor Green
} else {
    git -C $ResolvedTarget add . | Out-Null
    git -C $ResolvedTarget commit -m "chore: update agent workspace templates and rules" -q 2>$null | Out-Null
}

if ($GitRemoteUrl) {
    Write-Host "  [*] Подключение к remote: $GitRemoteUrl" -ForegroundColor Yellow
    $existingRemotes = git -C $ResolvedTarget remote
    if ($existingRemotes -contains "origin") {
        git -C $ResolvedTarget remote set-url origin $GitRemoteUrl
    } else {
        git -C $ResolvedTarget remote add origin $GitRemoteUrl
    }
    Write-Host "  [+] Remote 'origin' успешно настроен: $GitRemoteUrl" -ForegroundColor Green
} else {
    Write-Host "  [!] ВНИМАНИЕ: Git Remote URL не указан. Агент обязан запросить данные для подключения у пользователя." -ForegroundColor Yellow
}

Write-Host "==> Workspace '$ProjectName' полностью подготовлен к работе с агентами!" -ForegroundColor Green
