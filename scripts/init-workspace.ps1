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

function Join-Parts {
    # Windows PowerShell 5.1 принимает у Join-Path только 2 позиционных аргумента
    # (multi-child появился в PS 6+): сворачиваем цепочку вручную. Работает везде.
    $result = $args[0]
    for ($i = 1; $i -lt $args.Count; $i++) {
        $result = Join-Path $result $args[$i]
    }
    return $result
}

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
$TemplatesSource = Join-Parts $BaseDir "workspaces" "minimal-agentic" "docs" "templates"
$TemplatesTarget = Join-Path $DocsDir "templates"

$CopyMap = @{
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" "docs" "architecture" "overview.md") = (Join-Parts $DocsDir "architecture" "overview.md")
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" "docs" "decisions" "0001-initial-architecture.md") = (Join-Parts $DocsDir "decisions" "0001-initial-architecture.md")
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" "docs" "navigation-index.md") = (Join-Path $DocsDir "navigation-index.md")
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" "docs" "notes-index.md") = (Join-Path $DocsDir "notes-index.md")
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
    $DynamicTemplatePath = Join-Parts $BaseDir "rules" $DynamicTemplateName
    if (Test-Path $DynamicTemplatePath) {
        $templateContent = Get-Content -Path $DynamicTemplatePath -Raw -Encoding UTF8
        $rendered = $templateContent.Replace("{{PROJECT_NAME}}", $ProjectName)
        $rendered = $rendered.Replace("{{PROJECT_STACK}}", $ProjectStack)
        $rendered = $rendered.Replace("{{INIT_DATE}}", $Today)
        
        [System.IO.File]::WriteAllText($TargetRuleFile, $rendered, [System.Text.Encoding]::UTF8)
        Write-Host "  [+] Сгенерирован динамический файл правил: $RuleFileName (< 3.5 КБ)" -ForegroundColor Green
    }
} else {
    $SourceRuleTemplate = Join-Parts $BaseDir "rules" ($RuleFileName.Replace('.md', '.template.md'))
    if (Test-Path $SourceRuleTemplate) {
        Copy-Item -Path $SourceRuleTemplate -Destination $TargetRuleFile -Force
        Write-Host "  [+] Развернут файл правил: $RuleFileName" -ForegroundColor Green
    }
}

# 4. Файловая гигиена: .gitignore, .dockerignore, .env.example, README.md
$HygieneMap = @{
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" ".gitignore.template") = (Join-Path $ResolvedTarget ".gitignore")
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" ".dockerignore.template") = (Join-Path $ResolvedTarget ".dockerignore")
    (Join-Parts $BaseDir "workspaces" "minimal-agentic" ".env.example.template") = (Join-Path $ResolvedTarget ".env.example")
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
    $ReadmeTemplate = Join-Parts $BaseDir "workspaces" "minimal-agentic" "README.template.md"
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
    $PythonCmd = Get-Command "python" -ErrorAction SilentlyContinue
    if (-not $PythonCmd) { $PythonCmd = Get-Command "python3" -ErrorAction SilentlyContinue }
    if (-not $PythonCmd) {
        Write-Host "  [!] Python не найден, пропуск регистрации AgentDB." -ForegroundColor Yellow
    } else {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $regOutput = & $PythonCmd.Source $RegisterScript --project "$ProjectName" --path "$($ResolvedTarget.Path)" --stack "$ProjectStack" 2>&1
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [!] Предупреждение регистрации AgentDB: $regOutput" -ForegroundColor Yellow
        } else {
            Write-Host "  $regOutput" -ForegroundColor Gray
        }
    }
}

# 6. Обязательная инициализация Git и подключение к Remote
# Git может отсутствовать на машине: тогда секция пропускается целиком,
# а хук PreInvocation напомнит агенту предложить установку (маркер ниже).
$GitCmd = Get-Command "git" -ErrorAction SilentlyContinue
if (-not $GitCmd) {
    Write-Host "  [!] Git не найден в PATH: шаги git init/commit/remote пропущены. Установите git и выполните их вручную." -ForegroundColor Yellow
    Write-Output "AGENT_INIT_GIT_SKIPPED"
} else {
$GitDir = Join-Path $ResolvedTarget ".git"
$targetPathStr = "$($ResolvedTarget.Path)"

# Удаление случайных артефактов Windows перенаправления (nul, $null), ломающих Git
$badFiles = @("nul", "`$null")
foreach ($bf in $badFiles) {
    $bfPath = "\\?\$targetPathStr\$bf"
    if ([System.IO.File]::Exists($bfPath)) {
        try { [System.IO.File]::Delete($bfPath) } catch {}
    }
}

if (-not (Test-Path $GitDir)) {
    Write-Host "  [*] Инициализация Git-репозитория..." -ForegroundColor Yellow
    git -C "$targetPathStr" init -b main | Out-Null
    git -C "$targetPathStr" add . | Out-Null
    # Коммит не должен ронять весь скрипт при отсутствии identity/изменений
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    git -C "$targetPathStr" commit -m "chore: initial project scaffold, rules, and docs" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [!] Git commit пропущен (проверьте user.name/user.email): файлы проиндексированы через 'git add'." -ForegroundColor Yellow
    } else {
        Write-Host "  [+] Git репозиторий инициализирован, создан первый коммит в ветке 'main'" -ForegroundColor Green
    }
    $ErrorActionPreference = $prevEAP
} else {
    git -C "$targetPathStr" add . | Out-Null
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    git -C "$targetPathStr" commit -m "chore: update agent workspace templates and rules" -q | Out-Null
    $ErrorActionPreference = $prevEAP
}

if ($GitRemoteUrl) {
    Write-Host "  [*] Подключение к remote: $GitRemoteUrl" -ForegroundColor Yellow
    $existingRemotes = git -C "$targetPathStr" remote
    if ($existingRemotes -contains "origin") {
        git -C "$targetPathStr" remote set-url origin $GitRemoteUrl
    } else {
        git -C "$targetPathStr" remote add origin $GitRemoteUrl
    }
    Write-Host "  [+] Remote 'origin' успешно настроен: $GitRemoteUrl" -ForegroundColor Green
} else {
    Write-Host "  [!] ВНИМАНИЕ: Git Remote URL не указан. Агент обязан запросить данные для подключения у пользователя." -ForegroundColor Yellow
}
} # end else (git present)

Write-Host "==> Workspace '$ProjectName' полностью подготовлен к работе с агентами!" -ForegroundColor Green
