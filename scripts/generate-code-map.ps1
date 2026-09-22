<#
.SYNOPSIS
    Генерирует компактную карту структуры кодовой базы (codebase map) для экономии контекста.
.PARAMETER TargetPath
    Путь к проекту (по умолчанию: текущий).
.PARAMETER MaxDepth
    Максимальная глубина обхода директорий (по умолчанию: 2).
#>
param (
    [string]$TargetPath = ".",
    [int]$MaxDepth = 2
)

$ResolvedPath = Resolve-Path $TargetPath -ErrorAction SilentlyContinue
if (-not $ResolvedPath) {
    Write-Error "Директория '$TargetPath' не найдена."
    exit 1
}

$ExcludeDirs = @("node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo", "__pycache__", ".venv", "vendor", "scratch", ".ruff_cache", ".pytest_cache", ".mypy_cache", ".idea", ".vscode", ".agentdb", "coverage")

function Get-Tree($currentDir, $currentDepth, $prefix = "") {
    if ($currentDepth -gt $MaxDepth) { return }

    $items = Get-ChildItem -Path $currentDir -ErrorAction SilentlyContinue |
        Where-Object { $ExcludeDirs -notcontains $_.Name } |
        Sort-Object { -not $_.PSIsContainer }, Name

    $count = $items.Count
    $i = 0
    foreach ($item in $items) {
        $i++
        $isLast = ($i -eq $count)
        $branch = if ($isLast) { "\-- " } else { "+-- " }
        $indent = if ($isLast) { "    " } else { "|   " }

        if ($item.PSIsContainer) {
            Write-Output "$prefix$branch$($item.Name)/"
            Get-Tree $item.FullName ($currentDepth + 1) "$prefix$indent"
        } else {
            Write-Output "$prefix$branch$($item.Name)"
        }
    }
}

Write-Output '```text'
Write-Output "$((Get-Item $ResolvedPath).Name)/"
Get-Tree $ResolvedPath 1 ""
Write-Output '```'
