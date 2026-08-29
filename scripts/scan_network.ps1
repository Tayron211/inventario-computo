# ==============================================================================
# ESCÁNER DE TODA LA RED LOCAL (SUBNET & HARDWARE DISCOVERY)
# ==============================================================================

param(
    [string]$ServerUrl = "http://localhost:3000",
    [string]$SubnetBase = "",
    [int]$StartIP = 1,
    [int]$EndIP = 254
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Auto-detectar la subred principal si no se especifica
if (-not $SubnetBase) {
    $activeAdapter = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = TRUE" | Select-Object -First 1
    if ($activeAdapter -and $activeAdapter.IPAddress) {
        $myIP = $activeAdapter.IPAddress[0]
        $parts = $myIP.Split('.')
        if ($parts.Count -eq 4) {
            $SubnetBase = "$($parts[0]).$($parts[1]).$($parts[2])"
        }
    }
}

if (-not $SubnetBase) {
    $SubnetBase = "192.168.1"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     ESCANEANDO TODA LA RED LOCAL: $SubnetBase.0/24" -ForegroundColor Red
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. PING MULTI-HILO RÁPIDO PARA ENCONTRAR TODAS LAS DIRECCIONES IP ACTIVAS
Write-Host "[*] Realizando barrido de red para detectar dispositivos activos..." -ForegroundColor Yellow

$ipsToScan = $StartIP..$EndIP | ForEach-Object { "$SubnetBase.$_" }
$activeHosts = @()

# Usar jobs/runspaces para ping ultra-rápido en paralelo
$pingScript = {
    param($ip)
    $ping = New-Object System.Net.NetworkInformation.Ping
    try {
        $reply = $ping.Send($ip, 120)
        if ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
            return $ip
        }
    } catch {}
    return $null
}

$runspacePool = [RunspaceFactory]::CreateRunspacePool(1, 35)
$runspacePool.Open()
$tasks = @()

foreach ($ip in $ipsToScan) {
    $ps = [PowerShell]::Create().AddScript($pingScript).AddArgument($ip)
    $ps.RunspacePool = $runspacePool
    $tasks += [PSCustomObject]@{
        Pipe = $ps
        Result = $ps.BeginInvoke()
        IP = $ip
    }
}

foreach ($task in $tasks) {
    $res = $task.Pipe.EndInvoke($task.Result)
    $task.Pipe.Dispose()
    if ($res) {
        $activeHosts += $task.IP
        Write-Host "  [+] Host activo detectado: $($task.IP)" -ForegroundColor Green
    }
}
$runspacePool.Close()
$runspacePool.Dispose()

# Obtener tabla ARP para MACs
$arpTable = @{}
try {
    $arpOutput = arp -a
    foreach ($line in $arpOutput) {
        if ($line -match '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F\-]{17})\s+(\w+)') {
            $arpTable[$matches[1]] = $matches[2].ToUpper()
        }
    }
} catch {}

Write-Host ""
Write-Host "[*] Total de equipos activos encontrados en la red: $($activeHosts.Count)" -ForegroundColor Cyan
Write-Host "[*] Intentando auditar hardware y números de serie de cada equipo..." -ForegroundColor Yellow

$discoveredDevices = @()

foreach ($hostIP in $activeHosts) {
    Write-Host "[-] Analizando $hostIP..." -ForegroundColor Gray
    
    $hostname = ""
    try {
        $hostEntry = [System.Net.Dns]::GetHostEntry($hostIP)
        $hostname = $hostEntry.HostName
    } catch {
        $hostname = "PC-RED-$($hostIP.Split('.')[3])"
    }

    $mac = if ($arpTable.ContainsKey($hostIP)) { $arpTable[$hostIP] } else { "N/A" }

    # Intentar obtener WMI remoto si hay permisos o es la máquina local
    $isLocal = ($hostIP -eq "127.0.0.1" -or (Get-NetIPAddress -IPAddress $hostIP -ErrorAction SilentlyContinue))
    $deviceData = $null

    if ($isLocal) {
        # Extraer datos completos locales
        $cs = Get-CimInstance Win32_ComputerSystem
        $bios = Get-CimInstance Win32_BIOS
        $bb = Get-CimInstance Win32_BaseBoard
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $enc = Get-CimInstance Win32_SystemEnclosure
        $ramMod = Get-CimInstance Win32_PhysicalMemory
        $disks = Get-CimInstance Win32_DiskDrive

        $modeloLocal = ($cs.Model -replace '\s+', ' ').Trim()
        if (-not $modeloLocal -or $modeloLocal -eq "System Product Name") {
            $modeloLocal = ((Get-CimInstance Win32_ComputerSystemProduct).Name -replace '\s+', ' ').Trim()
        }

        $serialLocal = ($bios.SerialNumber -replace '\s+', ' ').Trim()
        if (-not $serialLocal -or $serialLocal -match "Default|None") {
            $serialLocal = ((Get-CimInstance Win32_ComputerSystemProduct).IdentifyingNumber -replace '\s+', ' ').Trim()
        }
        if (-not $serialLocal) { $serialLocal = "S/N NO DISPONIBLE" }

        $totalRamBytes = 0
        foreach ($r in $ramMod) { $totalRamBytes += $r.Capacity }
        $totalRamGB = [Math]::Round($totalRamBytes / 1GB)

        $chassis = @($enc.ChassisTypes)
        $tipo = "PC de Escritorio"
        if ($chassis -match '(8|9|10|11|12|14|30|31|32)') { $tipo = "Laptop" }
        elseif ($chassis -match '13' -or $modeloLocal -match 'All-in-One') { $tipo = "All-in-One" }

        $diskList = @()
        foreach ($d in $disks) {
            $diskList += @{
                modelo = $d.Model
                serie = if ($d.SerialNumber) { $d.SerialNumber.Trim() } else { "N/A" }
                capacidad = "$([Math]::Round($d.Size / 1GB)) GB"
                tipo = "Disco"
            }
        }

        $deviceData = [ordered]@{
            modelo = $modeloLocal
            numero_serie = $serialLocal
            placa_base = $bb.Product
            placa_base_completa = "$($bb.Manufacturer) $($bb.Product)".Trim()
            tipo_equipo = $tipo
            fabricante = $cs.Manufacturer
            procesador = "$($cpu.Name) ($($cpu.NumberOfCores) Nucleos)"
            ram_total = "$totalRamGB GB ($(@($ramMod).Count) Modulos)"
            almacenamiento = $diskList
            almacenamiento_resumen = ($diskList | ForEach-Object { "$($_.modelo) ($($_.capacidad))" }) -join " | "
            hostname = $env:COMPUTERNAME
            usuario_actual = $env:USERNAME
            ip_red = $hostIP
            mac_address = $mac
            ubicacion = "Red Local ($SubnetBase.0/24)"
            estado = "Operativo"
            fecha_escaneo = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
            origen = "Escaneo de Red Local"
        }
    } else {
        # Para equipos remotos en la red: intentar WMI/CIM con timeout corto
        $remoteSuccess = $false
        try {
            $opt = New-CimSessionOption -Protocol DCOM
            $session = New-CimSession -ComputerName $hostIP -SessionOption $opt -OperationTimeoutSec 2 -ErrorAction Stop
            $remCs = Get-CimInstance Win32_ComputerSystem -CimSession $session -ErrorAction Stop
            $remBios = Get-CimInstance Win32_BIOS -CimSession $session -ErrorAction Stop
            $remBb = Get-CimInstance Win32_BaseBoard -CimSession $session -ErrorAction Stop
            $remCpu = Get-CimInstance Win32_Processor -CimSession $session | Select-Object -First 1

            $deviceData = [ordered]@{
                modelo = $remCs.Model
                numero_serie = if ($remBios.SerialNumber) { $remBios.SerialNumber.Trim() } else { "S/N RED-$hostIP" }
                placa_base = $remBb.Product
                placa_base_completa = "$($remBb.Manufacturer) $($remBb.Product)".Trim()
                tipo_equipo = if ($remCs.Model -match 'Laptop|Notebook|ThinkPad|Latitude') { "Laptop" } else { "PC de Escritorio" }
                fabricante = $remCs.Manufacturer
                procesador = $remCpu.Name
                ram_total = "$([Math]::Round($remCs.TotalPhysicalMemory / 1GB)) GB"
                hostname = $hostname
                usuario_actual = $remCs.UserName
                ip_red = $hostIP
                mac_address = $mac
                ubicacion = "Red Local ($SubnetBase.0/24)"
                estado = "Operativo"
                fecha_escaneo = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                origen = "Escaneo de Red Local (WMI)"
            }
            $remoteSuccess = $true
            Remove-CimSession $session -ErrorAction SilentlyContinue
        } catch {}

        # Si no responde a WMI remoto por políticas de firewall de Windows: registrar como dispositivo de red descubierto
        if (-not $remoteSuccess) {
            $deviceData = [ordered]@{
                modelo = "Equipo en Red ($hostname)"
                numero_serie = "MAC-$($mac -replace ':','' -replace '-','')"
                placa_base = "Placa Red Local"
                placa_base_completa = "Dispositivo Activo en Subred $SubnetBase.0"
                tipo_equipo = if ($hostname -match 'laptop|nb-|portatil') { "Laptop" } else { "PC de Escritorio" }
                fabricante = "Detectado en Red"
                procesador = "Hardware en Red ($hostIP)"
                ram_total = "Conectado en LAN"
                hostname = $hostname
                usuario_actual = "Usuario en Red"
                ip_red = $hostIP
                mac_address = $mac
                ubicacion = "Red Local ($SubnetBase.0/24)"
                estado = "Operativo"
                notas = "Detectado mediante barrido de red activo"
                fecha_escaneo = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                origen = "Escaneo de Red Local (Ping/ARP)"
            }
        }
    }

    if ($deviceData) {
        $discoveredDevices += $deviceData
        
        # Enviar al servidor
        try {
            $jsonItem = $deviceData | ConvertTo-Json -Depth 5
            Invoke-RestMethod -Uri "$ServerUrl/api/agent/report" -Method Post -Body $jsonItem -ContentType "application/json; charset=utf-8" -TimeoutSec 3 | Out-Null
            Write-Host "  [OK] Registrado en inventario: $hostname ($hostIP)" -ForegroundColor Green
        } catch {}
    }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " [OK] ESCANEO DE RED COMPLETADO EXITOSAMENTE" -ForegroundColor Green
Write-Host " Total de equipos analizados y sincronizados: $($discoveredDevices.Count)" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green
