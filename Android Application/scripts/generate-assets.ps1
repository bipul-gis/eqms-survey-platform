# generate-assets.ps1
#
# Regenerate every brand asset (Android launcher icons, splash screens, PWA
# icons, in-app header logo) from a single source PNG. Run this any time the
# EQMS logo changes — no need to manually re-export each density.
#
# Usage:
#   pwsh -File scripts/generate-assets.ps1
#
# Source logo: ./logo/EQMS_Logo.png (transparent PNG, any size).

Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $here                 # Android Application/
$projectRoot = Split-Path -Parent $appRoot          # Field Survey Platform/
$source = Join-Path $appRoot 'logo\EQMS_Logo.png'
$androidRes = Join-Path $appRoot 'android\app\src\main\res'
$publicDir = Join-Path $projectRoot 'public'

if (-not (Test-Path $source)) {
    Write-Error "Source logo not found at: $source"
    exit 1
}

$srcImage = [System.Drawing.Image]::FromFile($source)
Write-Host "Source: $($srcImage.Width) x $($srcImage.Height) px"

# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------
function New-LogoOnBg {
    <#
        Draw the source logo, scaled to fit inside `containerSize`, centered
        on a solid background `bg`. `padPct` reserves whitespace around the
        edge (0.15 = 15% on each side) so the logo doesn't touch the icon
        border on adaptive icons.
    #>
    param(
        [int]$width,
        [int]$height,
        [System.Drawing.Color]$bg,
        [double]$padPct = 0.15,
        [bool]$transparentBg = $false
    )
    $bmp = New-Object System.Drawing.Bitmap $width, $height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    if ($transparentBg) {
        $g.Clear([System.Drawing.Color]::Transparent)
    } else {
        $g.Clear($bg)
    }
    $innerW = $width * (1 - 2 * $padPct)
    $innerH = $height * (1 - 2 * $padPct)
    $scale = [Math]::Min($innerW / $srcImage.Width, $innerH / $srcImage.Height)
    $drawW = [int]($srcImage.Width * $scale)
    $drawH = [int]($srcImage.Height * $scale)
    $x = [int](($width - $drawW) / 2)
    $y = [int](($height - $drawH) / 2)
    $g.DrawImage($srcImage, $x, $y, $drawW, $drawH)
    $g.Dispose()
    return $bmp
}

function Save-Png {
    param(
        [System.Drawing.Bitmap]$bmp,
        [string]$path
    )
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# ---------------------------------------------------------------------------
# 1. Android launcher icons (legacy square + round)
# ---------------------------------------------------------------------------
# Densities: mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi
$icoDensities = @{
    'mdpi'    = 48
    'hdpi'    = 72
    'xhdpi'  = 96
    'xxhdpi'  = 144
    'xxxhdpi' = 192
}
# Foreground icons for adaptive (always 108dp safe → full bitmap is 108*scale).
$fgDensities = @{
    'mdpi'    = 108
    'hdpi'    = 162
    'xhdpi'   = 216
    'xxhdpi'  = 324
    'xxxhdpi' = 432
}
$iconBg = [System.Drawing.Color]::White

Write-Host "`n[1/4] Android launcher icons…"
foreach ($d in $icoDensities.Keys) {
    $sz = $icoDensities[$d]
    $legacy = Join-Path $androidRes "mipmap-$d/ic_launcher.png"
    $round  = Join-Path $androidRes "mipmap-$d/ic_launcher_round.png"
    Save-Png (New-LogoOnBg -width $sz -height $sz -bg $iconBg -padPct 0.18) $legacy
    Save-Png (New-LogoOnBg -width $sz -height $sz -bg $iconBg -padPct 0.18) $round
    Write-Host "  mipmap-$d (${sz}x${sz}): legacy + round"
}

# Adaptive icon foreground — needs more inset (safe zone is inner 72/108).
# Background lives in the existing ic_launcher_background drawable (white).
Write-Host "`n[2/4] Adaptive icon foreground (transparent bg)…"
foreach ($d in $fgDensities.Keys) {
    $sz = $fgDensities[$d]
    $fg = Join-Path $androidRes "mipmap-$d/ic_launcher_foreground.png"
    # Foreground has transparent bg; inner padding scaled so logo sits in
    # the 66% safe circle that Android masks for adaptive icons.
    Save-Png (New-LogoOnBg -width $sz -height $sz -bg $iconBg -padPct 0.30 -transparentBg $true) $fg
    Write-Host "  mipmap-$d/ic_launcher_foreground (${sz}x${sz})"
}

# ---------------------------------------------------------------------------
# 2. Splash screens — logo centered on slate-900 (#0f172a) brand background.
# ---------------------------------------------------------------------------
Write-Host "`n[3/4] Splash screens…"
$splashBg = [System.Drawing.Color]::FromArgb(15, 23, 42)   # slate-900
$splashSizes = @{
    'port-mdpi'    = @(320, 480)
    'port-hdpi'    = @(480, 800)
    'port-xhdpi'   = @(720, 1280)
    'port-xxhdpi'  = @(960, 1600)
    'port-xxxhdpi' = @(1280, 1920)
    'land-mdpi'    = @(480, 320)
    'land-hdpi'    = @(800, 480)
    'land-xhdpi'   = @(1280, 720)
    'land-xxhdpi'  = @(1600, 960)
    'land-xxxhdpi' = @(1920, 1280)
}

function New-SplashImage {
    param([int]$w, [int]$h)
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $bg = New-Object System.Drawing.SolidBrush $splashBg
    $g.FillRectangle($bg, 0, 0, $w, $h)

    # Logo target width ≈ 55% of the smaller dimension.
    $targetW = [Math]::Min($w, $h) * 0.55
    $scale = $targetW / $srcImage.Width
    $drawW = [int]($srcImage.Width * $scale)
    $drawH = [int]($srcImage.Height * $scale)

    # Tinted logo: the source is dark on transparent — but our background is
    # also dark. Draw it onto a white pill first so it stays readable.
    $padPill = [int]($drawW * 0.08)
    $pillW = $drawW + 2 * $padPill
    $pillH = $drawH + 2 * $padPill
    $pillX = [int](($w - $pillW) / 2)
    $pillY = [int](($h - $pillH) / 2) - [int]($h * 0.04)
    $pillBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    # Rounded rectangle pill
    $radius = [int]($pillH * 0.18)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($pillX, $pillY, $radius*2, $radius*2, 180, 90)
    $path.AddArc($pillX + $pillW - $radius*2, $pillY, $radius*2, $radius*2, 270, 90)
    $path.AddArc($pillX + $pillW - $radius*2, $pillY + $pillH - $radius*2, $radius*2, $radius*2, 0, 90)
    $path.AddArc($pillX, $pillY + $pillH - $radius*2, $radius*2, $radius*2, 90, 90)
    $path.CloseFigure()
    $g.FillPath($pillBrush, $path)
    $g.DrawImage($srcImage, $pillX + $padPill, $pillY + $padPill, $drawW, $drawH)

    # "Geosurvey" tagline below the pill.
    $tagSize = [Math]::Max(12, [int]([Math]::Min($w, $h) * 0.045))
    $tagFont = $null
    foreach ($family in @('Segoe UI Semibold','Segoe UI','Arial')) {
        try {
            $tagFont = New-Object System.Drawing.Font([string]$family, [single]$tagSize, [System.Drawing.FontStyle]::Bold)
            break
        } catch { continue }
    }
    if ($tagFont) {
        $tagBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(226, 232, 240))
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = 'Center'
        $sf.LineAlignment = 'Center'
        $tagRect = New-Object System.Drawing.RectangleF 0, ($pillY + $pillH + ($h * 0.025)), $w, ($h * 0.1)
        $g.DrawString('Geosurvey', $tagFont, $tagBrush, $tagRect, $sf)
        $tagFont.Dispose()
    }
    $g.Dispose()
    return $bmp
}

foreach ($k in $splashSizes.Keys) {
    $dim = $splashSizes[$k]
    $splash = Join-Path $androidRes "drawable-$k/splash.png"
    Save-Png (New-SplashImage -w $dim[0] -h $dim[1]) $splash
    Write-Host "  drawable-$k/splash ($($dim[0]) x $($dim[1]))"
}
# Default drawable/splash.png — large fallback used by older devices.
Save-Png (New-SplashImage -w 1280 -h 1920) (Join-Path $androidRes 'drawable/splash.png')
Write-Host "  drawable/splash (1280 x 1920)"

# ---------------------------------------------------------------------------
# 3. PWA icons (web) + in-app logo asset.
# ---------------------------------------------------------------------------
Write-Host "`n[4/4] PWA icons + web logo…"
if (-not (Test-Path $publicDir)) { New-Item -ItemType Directory -Path $publicDir -Force | Out-Null }
# PWA install icons: keep a safe inset so the logo doesn't touch the edge
# when a launcher applies its own rounded mask.
Save-Png (New-LogoOnBg -width 192 -height 192 -bg $iconBg -padPct 0.15) (Join-Path $publicDir 'pwa-192.png')
Save-Png (New-LogoOnBg -width 512 -height 512 -bg $iconBg -padPct 0.15) (Join-Path $publicDir 'pwa-512.png')
Write-Host "  public/pwa-192.png + public/pwa-512.png (with safe inset)"

# Browser tab favicon: zero padding so the wordmark fills the canvas
# edge-to-edge. The logo is wider than tall so there's natural transparent
# space above / below, but the visible logo itself is as large as a square
# slot allows without distorting the aspect ratio. Tabs render this scaled
# to ~16/32px — the larger source means crisper letterforms.
Save-Png (New-LogoOnBg -width 64 -height 64 -bg $iconBg -padPct 0.00 -transparentBg $true) (Join-Path $publicDir 'favicon-64.png')
Save-Png (New-LogoOnBg -width 192 -height 192 -bg $iconBg -padPct 0.00 -transparentBg $true) (Join-Path $publicDir 'favicon-192.png')
# Wide variant for browsers that honour rectangular favicons (Safari pinned
# tabs, Edge collections). Sized to the logo's native ratio so nothing gets
# squashed when the OS scales it down.
Save-Png (New-LogoOnBg -width 384 -height 162 -bg $iconBg -padPct 0.00 -transparentBg $true) (Join-Path $publicDir 'favicon-wide.png')
Write-Host "  public/favicon-64.png + public/favicon-192.png + public/favicon-wide.png (logo only, transparent)"

# Logo for in-app header use — keep aspect ratio so React can size by height.
# Copy the master directly; consuming components scale it via CSS.
Copy-Item -LiteralPath $source -Destination (Join-Path $publicDir 'eqms-logo.png') -Force
Write-Host "  public/eqms-logo.png (master copy for in-app header)"

$srcImage.Dispose()
Write-Host "`nAll assets regenerated."
