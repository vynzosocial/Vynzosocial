$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$androidAppRoot = Join-Path $repositoryRoot 'android-app'
$keystorePath = Join-Path $androidAppRoot 'android\app\upload-keystore.jks'
$keyAlias = 'upload'

Push-Location $androidAppRoot
try {
    $securePassword = Read-Host 'Enter or create the upload keystore password' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }

    if ($password.Length -lt 6) {
        throw 'The keystore password must contain at least 6 characters.'
    }

    $env:ANDROID_UPLOAD_STORE_FILE = $keystorePath
    $env:ANDROID_UPLOAD_STORE_PASSWORD = $password
    $env:ANDROID_UPLOAD_KEY_ALIAS = $keyAlias
    $env:ANDROID_UPLOAD_KEY_PASSWORD = $password

    if (-not (Test-Path $keystorePath)) {
        & keytool -genkeypair -v `
            -keystore $keystorePath `
            -storetype PKCS12 `
            -keyalg RSA `
            -keysize 2048 `
            -validity 10000 `
            -alias $keyAlias `
            -dname 'CN=Vynzo' `
            '-storepass:env' ANDROID_UPLOAD_STORE_PASSWORD `
            '-keypass:env' ANDROID_UPLOAD_KEY_PASSWORD
        if ($LASTEXITCODE -ne 0) {
            throw "keytool failed with exit code $LASTEXITCODE."
        }
        Write-Warning 'Back up android-app\android\app\upload-keystore.jks and its password securely. Losing either can prevent future app updates.'
    }

    & npm run sync
    if ($LASTEXITCODE -ne 0) {
        throw "Web preparation or Capacitor sync failed with exit code $LASTEXITCODE."
    }

    & .\android\gradlew.bat -p .\android assembleRelease bundleRelease
    if ($LASTEXITCODE -ne 0) {
        throw "Release build failed with exit code $LASTEXITCODE."
    }
    Write-Output 'Release APK: android-app\android\app\build\outputs\apk\release\app-release.apk'
    Write-Output 'Play Store bundle: android-app\android\app\build\outputs\bundle\release\app-release.aab'
}
finally {
    Remove-Item Env:ANDROID_UPLOAD_STORE_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:ANDROID_UPLOAD_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ANDROID_UPLOAD_KEY_ALIAS -ErrorAction SilentlyContinue
    Remove-Item Env:ANDROID_UPLOAD_KEY_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
    $securePassword = $null
    Pop-Location
}
