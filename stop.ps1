# 할일 쪼개기 서버를 찾아 종료한다. 자동 실행으로 띄우면 Ctrl+C 할 창이 없어서 필요하다.
#
# 명령줄로는 못 찾는다 - 'node server.js'로 뜨기 때문에 경로가 안 남는다.
# 그래서 server.js가 쓰는 포트 범위(4321부터 열 개)를 듣고 있는 node를 잡는다.
$ErrorActionPreference = 'SilentlyContinue'

$pids = @()
foreach ($port in 4321..4331) {
  foreach ($c in (Get-NetTCPConnection -LocalPort $port -State Listen)) {
    $proc = Get-Process -Id $c.OwningProcess
    if ($proc -and $proc.ProcessName -eq 'node') {
      $pids += [pscustomobject]@{ Id = $proc.Id; Port = $port }
    }
  }
}

$pids = $pids | Sort-Object Id -Unique

if (-not $pids) {
  Write-Host '  실행 중인 서버가 없습니다.'
} else {
  foreach ($p in $pids) {
    Write-Host ('  종료: PID ' + $p.Id + ' (포트 ' + $p.Port + ')')
    Stop-Process -Id $p.Id -Force
  }
  Write-Host '  완료했습니다.'
}
