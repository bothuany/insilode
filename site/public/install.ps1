# Installs Insilode on Windows from the latest GitHub release, without the SmartScreen prompt:
#
#   irm https://insilode.dev/install.ps1 | iex
#
# SmartScreen checks files that carry the Mark of the Web (the Zone.Identifier stream browsers add to downloads), and
# Invoke-WebRequest does not add it. The installer is not code-signed yet, so one downloaded in a browser shows "Windows
# protected your PC"; the same installer fetched here runs straight away. It is checked against the release's SHA256SUMS.txt
# first, then run silently: the per-user setup (no admin rights), into %LOCALAPPDATA%\Programs\Insilode, with `insilode` on PATH.
# Smart App Control, where it is turned on, blocks unsigned programs however they were downloaded; this does not get past it.
#
# Settings, all optional, as environment variables ($env:INSILODE_VERSION = '0.5.2' before the command):
#   INSILODE_VERSION         a version instead of the latest release
#   INSILODE_DOWNLOAD_BASE   a mirror of the release files (default the GitHub release of that version)
#   INSILODE_DOWNLOAD_ONLY   1: download and check the installer, print where it is, and run nothing
#
# `irm | iex` runs this in the caller's own session, so everything is inside one script block: its settings stay local, and an
# error is thrown rather than `exit`, which would close the caller's window.

& {
	$ErrorActionPreference = 'Stop'
	# Windows PowerShell 5.1 draws Invoke-WebRequest's progress so slowly that it slows the download itself several times over.
	$ProgressPreference = 'SilentlyContinue'
	# Windows PowerShell 5.1 may still offer only TLS 1.0, which GitHub refuses.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$repo = 'bothuany/insilode'

	if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
		throw "insilode install: this script installs the Windows app. On macOS: curl -fsSL https://insilode.dev/install.sh | sh"
	}
	if (-not [Environment]::Is64BitOperatingSystem) {
		throw 'insilode install: Insilode is built for 64-bit Windows only'
	}

	$version = $env:INSILODE_VERSION
	if (-not $version) {
		try {
			$version = (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases/latest").tag_name
		} catch {
			throw "insilode install: could not reach GitHub to find the latest release: $_"
		}
	}
	$version = $version -replace '^v', ''
	$base = if ($env:INSILODE_DOWNLOAD_BASE) { $env:INSILODE_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/$repo/releases/download/v$version" }
	$setup = "Insilode-Setup-$version-x64.exe"
	$downloadOnly = $env:INSILODE_DOWNLOAD_ONLY -eq '1'

	# The installer stops when Insilode is running (it holds the app's mutex), so say so before the download rather than after it.
	if (-not $downloadOnly -and (Get-Process -Name Insilode -ErrorAction SilentlyContinue)) {
		throw 'insilode install: Insilode is running: quit it, then run this again'
	}

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ("insilode-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	# Set only once the installer has passed its check: a download that failed it is never left behind.
	$keep = $false
	try {
		Write-Host "Downloading Insilode $version"
		$exe = Join-Path $tmp $setup
		$sums = Join-Path $tmp 'SHA256SUMS.txt'
		try {
			Invoke-WebRequest -UseBasicParsing -Uri "$base/$setup" -OutFile $exe
			Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $sums
		} catch {
			throw "insilode install: could not download from ${base}: $_"
		}

		$line = Get-Content $sums | Where-Object { ($_ -split '\s+', 2)[1] -replace '^\*', '' -eq $setup } | Select-Object -First 1
		if (-not $line) { throw "insilode install: SHA256SUMS.txt has no line for $setup" }
		$expected = ($line -split '\s+')[0].ToLowerInvariant()
		$actual = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLowerInvariant()
		if ($expected -ne $actual) {
			throw "insilode install: $setup does not match SHA256SUMS.txt (expected $expected, got $actual): nothing was installed"
		}

		if ($downloadOnly) {
			$keep = $true
			Write-Host "Checked $exe against SHA256SUMS.txt. Run it to install Insilode."
			return
		}

		Write-Host 'Installing (per user, no admin rights)'
		# runcode is the setup's "Run Insilode after installation" task, which is on by default in a silent install.
		$run = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/MERGETASKS=!runcode' -Wait -PassThru
		if ($run.ExitCode -ne 0) {
			throw "insilode install: the installer stopped with exit code $($run.ExitCode)"
		}
		Write-Host "Installed Insilode $version in $env:LOCALAPPDATA\Programs\Insilode"
		Write-Host 'Start it from the Start menu, or open a new terminal and run: insilode'
		Write-Host 'Insilode updates itself from now on (Restart to Update in the title bar).'
	} finally {
		if (-not $keep) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
	}
}
