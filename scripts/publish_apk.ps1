# Build + publish the companion APK (run on a Windows PC with the Android SDK):
#   powershell -ExecutionPolicy Bypass -File scripts\publish_apk.ps1
# 1. gradle assembleRelease, signed with android/keystore (never lose it: a different key
#    cannot install over an existing install)
# 2. verifies the signer, reads versionCode/versionName back out of the APK
# 3. writes the sidecar storie.apk.json {versionCode, versionName, sha256} that
#    /storie.apk.json serves to the in-app updater
# 4. scp both to deployHost:deployDir (android/companion.properties) - the server serves
#    them at /storie.apk and /storie.apk.json, no redeploy needed
# Remember to bump versionCode/versionName in android/app/build.gradle.kts first.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$proj = Join-Path $root "android"
$props = @{}
Get-Content (Join-Path $proj "companion.properties") | ForEach-Object {
  if ($_ -match "^\s*([^#=]+)=(.*)$") { $props[$matches[1].Trim()] = $matches[2].Trim() }
}
$mini = $props["deployHost"]
$dest = $props["deployDir"]
if (-not $mini -or -not $dest) { throw "deployHost / deployDir missing in android/companion.properties" }
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Set-Location $proj
.\gradlew.bat assembleRelease --no-daemon -q
$apk = Get-Item "app\build\outputs\apk\release\app-release.apk"

$bt = Get-ChildItem "$env:ANDROID_HOME\build-tools" | Sort-Object Name -Descending | Select-Object -First 1
$signer = & (Join-Path $bt.FullName "apksigner.bat") verify --print-certs $apk.FullName 2>&1 | Select-String "SHA-256 digest"
if (-not $signer) { throw "APK is not signed - is android/keystore/keystore.properties in place?" }
$badging = & (Join-Path $bt.FullName "aapt.exe") dump badging $apk.FullName 2>$null | Select-String "^package:" | ForEach-Object { $_.Line }
$vc = [int][regex]::Match($badging, "versionCode='(\d+)'").Groups[1].Value
$vn = [regex]::Match($badging, "versionName='([^']+)'").Groups[1].Value
$sha = (Get-FileHash $apk.FullName -Algorithm SHA256).Hash.ToLower()
$side = Join-Path $env:TEMP "storie.apk.json"
Set-Content -Path $side -Value "{`"versionCode`": $vc, `"versionName`": `"$vn`", `"sha256`": `"$sha`"}" -Encoding ascii

ssh $mini "mkdir -p $dest"
scp -q $apk.FullName "${mini}:$dest/storie.apk"
scp -q $side "${mini}:$dest/storie.apk.json"
"published $vn (versionCode $vc), $([math]::Round($apk.Length/1MB,1)) MB, sha256 $($sha.Substring(0,16))..."
"phones will be offered the update on the next launch of the app"
