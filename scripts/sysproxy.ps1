# sysproxy.ps1 —— 改 Windows 的系统代理设置
#
# 为什么用 PowerShell 而不是在 Node 里直接改注册表：
# 改完注册表还得通知系统「设置变了」，那个 API（InternetSetOption）只有
# 调 wininet.dll 才能碰到，Node 里做不了。用 PowerShell 可以 Add-Type 现编一小段 C#。
#
# 动作：
#   get     读当前系统代理状态，顺便带上备份文件的内容
#   set     设成本机代理（127.0.0.1:端口），第一次设的时候备份原来的值
#   restore 从备份还原
#   notify  只是通知系统「代理设置变了」，让开着的浏览器立刻感知
#
# 约定：
#   - stdout 只输出一段压缩 JSON，别的什么都不打。Node 那边直接 JSON.parse。
#   - 出错也得是 JSON（{"ok":false,"error":"..."}），不能抛原始异常，
#     否则 Node 拿到一堆乱码没法判断。
#   - 这个文件必须是 UTF-8 带 BOM 保存。丢了 BOM，中文在某些 PowerShell
#     版本里会变成乱码，还可能导致解析报错。改这个文件的时候注意别让编辑器
#     把 BOM 去掉。

param(
  [Parameter(Mandatory = $true)][ValidateSet('get', 'set', 'restore', 'notify')][string]$Action,
  # 参数用 base64 传。原因是命令行里带引号、中文、特殊字符时，
  # PowerShell 的参数解析很容易出错（尤其是从 Node 里 spawn 的时候）。
  # base64 之后就是纯 ASCII，怎么传都不会坏。
  [string]$PayloadBase64 = ''
)

# 出错就停，别继续往下执行。不然一个错误后面全是连锁反应，
# 最后返回的 JSON 里根本看不出真正的原因。
$ErrorActionPreference = 'Stop'

# 输出固定用 UTF-8。不设的话中文在某些代码页下会变成问号。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 系统代理就存在这个注册表项里（当前用户，不需要管理员权限）
$Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

# 备份文件。装在 APPDATA 下，跟着当前用户走。
$BackupFile = Join-Path $env:APPDATA 'E621Link\proxy-backup.json'

# 没有备份时用的绕过名单。
# 这些地址不走代理（本机、内网、局域网段），否则本机服务会绕一圈连不上。
# 最后那个 <local> 是 Windows 的特殊写法，表示所有不带点的主机名。
$DefaultOverride = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>'

# 把 -PayloadBase64 解出来变成对象。没传就返回 $null。
function Get-Payload {
  if ([string]::IsNullOrWhiteSpace($PayloadBase64)) { return $null }
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
  return $json | ConvertFrom-Json
}

# 判断对象里有没有某个字段。
#
# 为什么要专门写一个：PowerShell 里访问不存在的属性不会报错，会返回 $null。
# 那就分不清「字段不存在」和「字段存在但值是 null」了。
# restore 的时候必须分清楚 —— 备份里没有 override 字段，跟 override 是空字符串，
# 处理方式不一样。
function Has-Field {
  param($obj, [string]$name)
  return ($null -ne $obj -and $obj.PSObject.Properties.Name -contains $name)
}

# 读当前系统代理。
# 注册表项不存在、或者某个值不存在，都不能报错，返回空值就行 ——
# 系统刚装好、从没设过代理的时候就是这种情况。
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

# 写系统代理。
#
# 三个值的类型必须写对：ProxyEnable 是 DWORD，另外两个是字符串。
# 类型错了不会立刻报错，但系统读的时候会读成 0 或者空，表现就是
# 「明明设了，浏览器还是不走代理」。所以这里显式指定 -Type。
#
# Override 只在明确传了值、且不是空串的时候才写。
# 传空串就保留原来的 —— 把绕过名单清空会导致本机所有流量都往代理走，
# 本机服务立刻断掉。
function Write-Current {
  param([int]$Enable, [string]$Server, [string]$Override)
  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
  Set-ItemProperty -Path $Key -Name ProxyEnable -Value $Enable -Type DWord
  Set-ItemProperty -Path $Key -Name ProxyServer -Value $Server -Type String
  if ($PSBoundParameters.ContainsKey('Override') -and -not [string]::IsNullOrEmpty($Override)) {
    Set-ItemProperty -Path $Key -Name ProxyOverride -Value $Override -Type String
  }
}

# 让已经开着的浏览器立刻知道设置变了，不用重启。
#
# 光改注册表是不够的：已经跑起来的程序（Chrome、Edge、各种 Electron 应用）
# 在启动时读一次代理设置就记住了，之后不再看注册表。必须调 wininet 的通知接口
# 告诉它们「重新读一遍」。
#
# 两个选项号：
#   39 = INTERNET_OPTION_SETTINGS_CHANGED  告诉系统设置改了
#   37 = INTERNET_OPTION_REFRESH           让系统刷新内部缓存
# 两个都要调，只调一个有时候不生效。
#
# 这段 C# 是运行时现编的（Add-Type）。第一次调要编译，会慢个几百毫秒，
# 之后就快了。用 'E621LinkWinInet' -as [type] 判断是不是编过了，
# 避免重复编译报「类型已存在」的错。
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
    # 通知失败不算致命错误 —— 设置已经写进注册表了，
    # 用户手动重启浏览器照样生效。所以这里吞掉异常只返回 false。
    return $false
  }
}

# 读备份。文件不在、内容坏了，都返回 $null，交给调用方决定怎么办。
function Read-Backup {
  if (-not (Test-Path $BackupFile)) { return $null }
  try { return (Get-Content $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# 写备份。目录可能不存在（第一次运行），先建出来。
# -Depth 6 是为了防止嵌套对象被 ConvertTo-Json 截断成类型名。
function Save-Backup {
  param($Data)
  $dir = Split-Path $BackupFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $Data | ConvertTo-Json -Depth 6 | Set-Content -Path $BackupFile -Encoding UTF8
}

# 主逻辑。整个包在 try 里，保证任何异常最后都能输出成 JSON。
# 外面那层 catch 就是兜底的 —— 没它的话，异常会以非零退出码 + 一堆红字结束，
# Node 那边解析不了。
try {
  $payload = Get-Payload

  switch ($Action) {
    # 读当前状态 + 备份内容。前端打开设置页时调这个，用来显示
    # 「现在系统代理是什么样」「有没有备份」。
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

    # 设成本机代理。
    # 需要传 port，端口不合法直接拒绝 —— 宁可报错也不能写个
    # 127.0.0.1:0 进去，那会让整台机器上不了网。
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
      #
      # 这条很关键：如果每次 set 都备份，第二次启动时备份里存的就是
      # 「上一次程序设的代理」，而不是用户真正的原始设置。退出时还原成
      # 一个指向已经关掉的代理的地址，整台机器就上不了网了。
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
      #
      # 为什么不直接用默认值：用户原来可能自己配过绕过名单
      # （比如公司内网地址、自己的内网服务）。直接覆盖会把那些弄丢。
      $override = $cur.override
      if ([string]::IsNullOrEmpty($override)) { $override = $DefaultOverride }

      Write-Current -Enable 1 -Server $server -Override $override
      $notified = Send-Notify

      # 写完立刻读回来对一遍。注册表写入有时候会静默失败
      # （权限、组策略、别的安全软件拦截），不读回来验证的话，
      # 程序以为设成功了，用户那边其实还是不通。
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

    # 从备份还原。
    # 没有备份就报错 —— 无从知道用户原来是什么设置，乱猜不如不猜。
    # 注意这里判断的是 $null（文件不存在或读坏了），不是空对象。
    'restore' {
      $bk = Read-Backup
      if ($null -eq $bk) {
        $r = @{ ok = $false; error = '没有备份，不知道原来是什么样' }
        break
      }
      # 备份可能是旧版本写的，缺字段。缺了就按「没有代理」处理。
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

    # 只发通知，什么都不改。
    # 用在「设置没变但浏览器还在用旧值」的情况，比如用户自己开了个
    # 新浏览器窗口，或者系统那边缓存抽风了。
    'notify' {
      $r = @{ ok = (Send-Notify) }
    }
  }

  # 输出。Compress 去掉所有空白，一行 json，Node 那边好解析。
  $r | ConvertTo-Json -Depth 6 -Compress
} catch {
  # 任何没预料到的错误都变成 JSON 输出。
  # Depth 4 够了，这里只有一层对象。
  @{ ok = $false; error = "脚本出错：$($_.Exception.Message)" } | ConvertTo-Json -Depth 4 -Compress
}
