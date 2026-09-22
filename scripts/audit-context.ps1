<#
.SYNOPSIS
    Проверяет репозиторий на утечки токенов, соблюдение лимитов правил (< 3.5 КБ),
    файловую гигиену (.gitignore, .dockerignore, .env.example, README.md) и целостность индексов.
.PARAMETER TargetPath
    Путь к целевой директории для аудита (по умолчанию: текущая).
#>
param (
    [string]$TargetPath = "."
)

$ResolvedPath = Resolve-Path $TargetPath -ErrorAction SilentlyContinue
if (-not $ResolvedPath) {
    Write-Error "Директория '$TargetPath' не найдена."
    exit 1
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Аудит контекста, гигиены и документации" -ForegroundColor Cyan
Write-Host "Целевой путь: $($ResolvedPath.Path)"
Write-Host "==========================================" -ForegroundColor Cyan

$IssuesFound = 0
$Warnings = 0

# 1. Проверка .gitignore
$GitignorePath = Join-Path $ResolvedPath ".gitignore"
if (-not (Test-Path $GitignorePath)) {
    Write-Host "[FAIL] Отсутствует файл .gitignore! Агенты могут читать кэши и зависимости." -ForegroundColor Red
    $IssuesFound++
} else {
    $GitignoreContent = Get-Content $GitignorePath -Raw
    $CrucialPatterns = @("node_modules", "dist", "build", "*.log", ".env", "scratch")
    $MissingPatterns = @()
    foreach ($pattern in $CrucialPatterns) {
        if ($GitignoreContent -notmatch [regex]::Escape($pattern)) {
            $MissingPatterns += $pattern
        }
    }
    if ($MissingPatterns.Count -gt 0) {
        $missingStr = $MissingPatterns -join ', '
        Write-Host "[WARN] В .gitignore не найдены ключевые паттерны: $missingStr" -ForegroundColor Yellow
        $Warnings++
    } else {
        Write-Host "[OK] .gitignore содержит все базовые фильтры от раздувания контекста." -ForegroundColor Green
    }
}

# 2. Проверка .dockerignore
$DockerignorePath = Join-Path $ResolvedPath ".dockerignore"
if (-not (Test-Path $DockerignorePath)) {
    Write-Host "[WARN] Отсутствует .dockerignore! Билд образов Docker может быть медленным и тяжелым." -ForegroundColor Yellow
    $Warnings++
} else {
    Write-Host "[OK] .dockerignore присутствует." -ForegroundColor Green
}

# 3. Проверка .env и .env.example
$EnvExamplePath = Join-Path $ResolvedPath ".env.example"
$EnvPath = Join-Path $ResolvedPath ".env"

if (-not (Test-Path $EnvExamplePath)) {
    Write-Host "[WARN] Отсутствует .env.example! Разработчикам и агентам сложнее поднимать окружение." -ForegroundColor Yellow
    $Warnings++
} else {
    Write-Host "[OK] .env.example присутствует." -ForegroundColor Green
}

if (Test-Path $EnvPath) {
    if ((Test-Path $GitignorePath) -and ((Get-Content $GitignorePath -Raw) -notmatch "\.env")) {
        Write-Host "[FAIL] Файл .env существует, но НЕ добавлен в .gitignore! Риск утечки секретов." -ForegroundColor Red
        $IssuesFound++
    }
}

# 4. Проверка README.md
$ReadmePath = Join-Path $ResolvedPath "README.md"
if (-not (Test-Path $ReadmePath)) {
    Write-Host "[WARN] Отсутствует витринный файл README.md." -ForegroundColor Yellow
    $Warnings++
} else {
    Write-Host "[OK] README.md присутствует." -ForegroundColor Green
}

# 5. Проверка правил для агентов и их бюджета
$RuleFiles = @("AGENTS.md", "GEMINI.md", "CLAUDE.md")
$FoundRules = @()
foreach ($rf in $RuleFiles) {
    $p = Join-Path $ResolvedPath $rf
    if (Test-Path $p) {
        $item = Get-Item $p
        $sizeKb = [math]::Round($item.Length / 1024, 2)
        $FoundRules += ("{0} ({1} KB)" -f $rf, $sizeKb)

        # Жесткий лимит: 3.5 КБ для предотвращения раздувания промпта
        if ($item.Length -gt 3584) {
            Write-Host ("[FAIL] Файл правил {0} превышает жесткий лимит 3.5 КБ ({1} KB)! Перенесите детали в docs/navigation-index.md или AgentDB." -f $rf, $sizeKb) -ForegroundColor Red
            $IssuesFound++
        } else {
            Write-Host ("[OK] Файл правил {0} укладывается в бюджет токенов ({1} KB <= 3.5 KB)." -f $rf, $sizeKb) -ForegroundColor Green
        }

        # Проверка динамических зон и ссылок на индексы
        $ruleContent = Get-Content $p -Raw -Encoding UTF8
        if ($ruleContent -match "ZONE: IMMUTABLE") {
            Write-Host "  [+] Зонирование обнаружено: ZONE: IMMUTABLE присутствует." -ForegroundColor Green
        }
        if ($ruleContent -match "docs/navigation-index\.md") {
            $navPath = Join-Path $ResolvedPath "docs\navigation-index.md"
            if (Test-Path $navPath) {
                Write-Host "  [+] Навигационный индекс найден: docs/navigation-index.md" -ForegroundColor Green
            } else {
                Write-Host "  [WARN] Ссылка на docs/navigation-index.md есть в правилах, но сам файл отсутствует!" -ForegroundColor Yellow
                $Warnings++
            }
        }
    }
}

if ($FoundRules.Count -eq 0) {
    Write-Host "[FAIL] Не найден ни один файл правил (AGENTS.md / GEMINI.md / CLAUDE.md)." -ForegroundColor Red
    $IssuesFound++
}

# 6. Поиск тяжелых файлов (> 250 КБ) вне gitignore/исключений
Write-Host "`nСканирование на тяжелые файлы (> 250 КБ)..." -ForegroundColor Cyan
$HeavyFiles = Get-ChildItem -Path $ResolvedPath -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { 
        $_.FullName -notmatch '\\node_modules\\' -and
        $_.FullName -notmatch '\\\.git\\' -and
        $_.FullName -notmatch '\\dist\\' -and
        $_.FullName -notmatch '\\build\\' -and
        $_.FullName -notmatch '\\scratch\\' -and
        $_.Length -gt 256000
    } | Select-Object -First 10

if ($HeavyFiles) {
    Write-Host "[WARN] Найдены тяжелые файлы, которые могут раздувать контекст при чтении:" -ForegroundColor Yellow
    foreach ($hf in $HeavyFiles) {
        $sizeKb = [math]::Round($hf.Length / 1024, 1)
        $rel = $hf.FullName.Substring($ResolvedPath.Path.Length)
        Write-Host ("  - {0} ({1} KB)" -f $rel, $sizeKb) -ForegroundColor Yellow
    }
    $Warnings++
} else {
    Write-Host "[OK] Тяжелых файлов в исходных директориях не обнаружено." -ForegroundColor Green
}

# 7. Проверка Git репозитория и подключения к Remote
Write-Host "`nПроверка Git и Remote подключения..." -ForegroundColor Cyan
$GitDir = Join-Path $ResolvedPath ".git"
if (-not (Test-Path $GitDir)) {
    Write-Host "[FAIL] Отсутствует инициализированный Git репозиторий! Требуется 'git init'." -ForegroundColor Red
    $IssuesFound++
} else {
    Write-Host "[OK] Локальный репозиторий Git инициализирован." -ForegroundColor Green
    $remotes = git -C $ResolvedPath.Path remote -v 2>$null
    if (-not $remotes) {
        Write-Host "[WARN] Remote 'origin' не подключен! Агент обязан запросить Remote URL у пользователя." -ForegroundColor Yellow
        $Warnings++
    } else {
        $firstRemote = ($remotes | Select-Object -First 1)
        Write-Host "  [+] Remote подключен: $firstRemote" -ForegroundColor Green
    }
}

# Итог
$statusColor = if ($IssuesFound -gt 0) { "Red" } elseif ($Warnings -gt 0) { "Yellow" } else { "Green" }
Write-Host "`n------------------------------------------"
Write-Host ("Итог аудита: Ошибок: {0}, Предупреждений: {1}" -f $IssuesFound, $Warnings) -ForegroundColor $statusColor
Write-Host "------------------------------------------`n"
