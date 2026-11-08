# sysproxy.ps1 —— 改 Windows 的系统代理设置
# 动作：get（读）/ set（设成本机代理）/ restore（还原成原来的）
# stdout 只输出一段 JSON

param(
  [Parameter(Mandatory = $true)][ValidateSet('get', 'set', 'restore', 'notify')][string]$Action,
  [string]$PayloadBase64 = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$BackupFile = Join-Path $env:APPDATA 'E621Link\proxy-backup.json'
$DefaultOverride = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>'

function Get-Payload {
  if ([string]::IsNullOrWhiteSpace($PayloadBase64)) { return $null }
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
  return $json | ConvertFrom-Json
}

function Has-Field {
  param($obj, [string]$name)
  return ($null -ne $obj -and $obj.PSObject.Properties.Name -contains $name)
}

function Read-Current {
  $p = Get-ItemProperty -Path $Key -ErrorAction SilentlyContinue
  if ($null -eq $p) {
    return @{ enable = 0; server = ''; override = '' }
  }
  $enable = 0
  if ($null -ne $p.ProxyEnable) { $enable = [int]$p.ProxyEnable }
  $server = ''
  if ($null -ne $p.ProxyServer) { $server = [string]$p.ProxyServer }
  $override = ''
  if ($null -ne $p.ProxyOverride) { $override = [string]$p.ProxyOverride }
  return @{ enable = $enable; server = $server; override = $override }
}

function Write-Current {
  param([int]$Enable, [string]$Server, [string]$Override)
  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
  Set-ItemProperty -Path $Key -Name ProxyEnable -Value $Enable -Type DWord
  Set-ItemProperty -Path $Key -Name ProxyServer -Value $Server -Type String
  if ($PSBoundParameters.ContainsKey('Override') -and -not [string]::IsNullOrEmpty($Override)) {
    Set-ItemProperty -Path $Key -Name ProxyOverride -Value $Override -Type String
  }
}

# 让已经开着的浏览器立刻知道设置变了，不用重启
function Send-Notify {
  try {
    if (-not ('E621LinkWinInet' -as [type])) {
      Add-Type -Namespace '' -Name 'E621LinkWinInet' -MemberDefinition @'
[DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
    }
    # 39 = INTERNET_OPTION_SETTINGS_CHANGED，37 = INTERNET_OPTION_REFRESH
    [E621LinkWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
    [E621LinkWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Read-Backup {
  if (-not (Test-Path $BackupFile)) { return $null }
  try { return (Get-Content $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Save-Backup {
  param($Data)
  $dir = Split-Path $BackupFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $Data | ConvertTo-Json -Depth 6 | Set-Content -Path $BackupFile -Encoding UTF8
}

try {
  $payload = Get-Payload

  switch ($Action) {
    'get' {
      $cur = Read-Current
      $bk = Read-Backup
      $r = @{
        ok         = $true
        enable     = $cur.enable
        server     = $cur.server
        override   = $cur.override
        backupPath = $BackupFile
        hasBackup  = ($null -ne $bk)
        backup     = $bk
      }
    }

    'set' {
      $port = 0
      if (Has-Field $payload 'port') { $port = [int]$payload.port }
      if ($port -le 0) {
        $r = @{ ok = $false; error = '端口不对' }
        break
      }

      $server = "127.0.0.1:$port"
      $cur = Read-Current
      $existing = Read-Backup

      $note = ''

      # 只在没备份过的时候备份，免得把改过的值当成原始值
      if ($null -eq $existing) {
        Save-Backup -Data @{
          createdAt = (Get-Date).ToString('o')
          enable    = $cur.enable
          server    = $cur.server
          override  = $cur.override
        }
        $note = "原来的设置存到 $BackupFile"
      } else {
        $note = "已经有备份了，这次不覆盖"
      }

      # 绕过名单沿用用户原来的，没有就用默认的
      $override = $cur.override
      if ([string]::IsNullOrEmpty($override)) { $override = $DefaultOverride }

      Write-Current -Enable 1 -Server $server -Override $override
      $notified = Send-Notify
      $after = Read-Current

      $r = @{
        ok            = ($after.enable -eq 1 -and $after.server -eq $server)
        server        = $after.server
        enable        = $after.enable
        override      = $after.override
        notified      = $notified
        note          = $note
        backupPath    = $BackupFile
        previousServer = $cur.server
        previousEnable = $cur.enable
      }
    }

    'restore' {
      $bk = Read-Backup
      if ($null -eq $bk) {
        $r = @{ ok = $false; error = '没有备份，不知道原来是什么样' }
        break
      }
      $enable = 0
      if (Has-Field $bk 'enable') { $enable = [int]$bk.enable }
      $server = ''
      if (Has-Field $bk 'server') { $server = [string]$bk.server }
      $override = ''
      if (Has-Field $bk 'override') { $override = [string]$bk.override }

      Write-Current -Enable $enable -Server $server -Override $override
      $notified = Send-Notify
      $after = Read-Current

      $r = @{
        ok       = ($after.enable -eq $enable -and $after.server -eq $server)
        enable   = $after.enable
        server   = $after.server
        override = $after.override
        notified = $notified
      }
    }

    'notify' {
      $r = @{ ok = (Send-Notify) }
    }
  }

  $r | ConvertTo-Json -Depth 6 -Compress
} catch {
  @{ ok = $false; error = "脚本出错：$($_.Exception.Message)" } | ConvertTo-Json -Depth 4 -Compress
}
