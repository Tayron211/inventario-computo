# ==============================================================================
# RECOLECTOR AVANZADO DE HARDWARE Y NÚMEROS DE SERIE - INVENTARIO DE CÓMPUTO
# ==============================================================================

param(
    [string]$ServerUrl = "https://ivt.onrender.com"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ESCANER DE HARDWARE Y PERIFERICOS - AUDITORIA DE COMPUTO" -ForegroundColor Red
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "[*] Extrayendo informacion detallada del equipo y componentes..." -ForegroundColor Yellow

# 1. INFORMACIÓN DEL SISTEMA Y FABRICANTE
$compSystem = Get-CimInstance Win32_ComputerSystem
$compSystemProduct = Get-CimInstance Win32_ComputerSystemProduct
$bios = Get-CimInstance Win32_BIOS
$baseBoard = Get-CimInstance Win32_BaseBoard
$enclosure = Get-CimInstance Win32_SystemEnclosure

$fabricante = ($compSystem.Manufacturer -replace '\s+', ' ').Trim()
$modelo = ($compSystem.Model -replace '\s+', ' ').Trim()
if (-not $modelo -or $modelo -eq "System Product Name" -or $modelo -eq "To be filled by O.E.M.") {
    $modelo = ($compSystemProduct.Name -replace '\s+', ' ').Trim()
}

$numeroSerie = ($bios.SerialNumber -replace '\s+', ' ').Trim()
if (-not $numeroSerie -or $numeroSerie -match "Default|None|To be filled|System Serial Number" -or $numeroSerie -eq "") {
    $numeroSerie = ($compSystemProduct.IdentifyingNumber -replace '\s+', ' ').Trim()
}
if (-not $numeroSerie) {
    $numeroSerie = "S/N NO DISPONIBLE"
}

# 2. PLACA BASE (MOTHERBOARD)
$placaBaseModelo = ($baseBoard.Product -replace '\s+', ' ').Trim()
if (-not $placaBaseModelo) {
    $placaBaseModelo = ($baseBoard.Model -replace '\s+', ' ').Trim()
}
$placaBaseFabricante = ($baseBoard.Manufacturer -replace '\s+', ' ').Trim()
$placaBaseSerial = ($baseBoard.SerialNumber -replace '\s+', ' ').Trim()
$placaBase = "$placaBaseModelo"
if ($placaBaseFabricante -and $placaBase -notmatch $placaBaseFabricante) {
    # e.g., "HP 8D19" o "ASUS PRIME B550M-A"
    $placaBaseCompleta = "$placaBaseFabricante $placaBaseModelo".Trim()
} else {
    $placaBaseCompleta = $placaBaseModelo
}

# 3. DETERMINACIÓN DEL TIPO DE EQUIPO (Laptop vs PC de Escritorio vs All-in-One)
$chassisTypes = @($enclosure.ChassisTypes)
$bateria = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue

$tipoEquipo = "PC de Escritorio"
# Tipos de chasis: 8, 9, 10, 11, 12, 14, 30, 31, 32 son Laptops/Notebooks/Portables
# 13 es All-in-One
# 3, 4, 5, 6, 7, 15, 16, 24 son Desktops/Towers
if ($chassisTypes -match '(8|9|10|11|12|14|30|31|32)' -or ($bateria -and $bateria.Count -gt 0)) {
    $tipoEquipo = "Laptop"
} elseif ($chassisTypes -match '13' -or $modelo -match 'All-in-One|AIO') {
    $tipoEquipo = "All-in-One"
} elseif ($chassisTypes -match '35' -or $modelo -match 'Mini') {
    $tipoEquipo = "Mini PC"
} else {
    $tipoEquipo = "PC de Escritorio"
}

# 4. PROCESADOR
$processor = Get-CimInstance Win32_Processor | Select-Object -First 1
$cpuName = ($processor.Name -replace '\s+', ' ').Trim()
$cpuCores = $processor.NumberOfCores
$cpuThreads = $processor.NumberOfLogicalProcessors
$procesadorInfo = "$cpuName ($cpuCores Nucleos / $cpuThreads Hilos)"

# 5. MEMORIA RAM
$ramModules = Get-CimInstance Win32_PhysicalMemory
$totalRamBytes = 0
$ramDetalles = @()
foreach ($ram in $ramModules) {
    $totalRamBytes += $ram.Capacity
    $gbSlot = [Math]::Round($ram.Capacity / 1GB, 1)
    $speed = $ram.Speed
    $part = ($ram.PartNumber -replace '\s+', ' ').Trim()
    $serial = ($ram.SerialNumber -replace '\s+', ' ').Trim()
    $slotName = if ($ram.DeviceLocator) { $ram.DeviceLocator } else { "Slot" }
    $ramDetalles += "$slotName - ${gbSlot}GB @ ${speed}MHz (S/N: $serial - Modelo: $part)"
}
$totalRamGB = [Math]::Round($totalRamBytes / 1GB)
$ramResumen = "${totalRamGB} GB (" + (@($ramModules).Count) + " modulo(s))"

# 6. ALMACENAMIENTO (SOLO DISCOS INTERNOS, EXCLUYENDO USB / EXTERNOS)
$disks = Get-CimInstance Win32_DiskDrive | Where-Object {
    $_.InterfaceType -ne "USB" -and
    $_.MediaType -notmatch "External|Removable" -and
    $_.CapabilityDescriptions -notcontains "Removable Media"
}
$almacenamientoDetalles = @()
$almacenamientoResumenList = @()
foreach ($d in $disks) {
    $diskModel = ($d.Model -replace '\s+', ' ').Trim()
    $diskSerial = ($d.SerialNumber -replace '\s+', ' ').Trim()
    if (-not $diskSerial) { $diskSerial = "N/A" }
    $diskSizeGB = [Math]::Round($d.Size / 1GB)
    if ($diskModel -match "NVMe" -or $d.MediaType -match "NVMe") {
        $diskType = "NVMe SSD"
    } elseif ($diskModel -match "SSD" -or $d.MediaType -match "SSD") {
        $diskType = "SATA SSD"
    } else {
        $diskType = "Disco"
    }
    $almacenamientoDetalles += @{
        modelo = $diskModel
        serie = $diskSerial
        capacidad = "${diskSizeGB} GB"
        tipo = $diskType
        interfaz = $d.InterfaceType
    }
    $almacenamientoResumenList += "${diskModel} (${diskSizeGB} GB, S/N: ${diskSerial})"
}
$almacenamientoResumen = $almacenamientoResumenList -join " | "

# 7. MONITORES (CON DEDICACIÓN Y SERIALES)
$monitores = @()
try {
    $monitorsWmi = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue
    if ($monitorsWmi) {
        foreach ($mon in $monitorsWmi) {
            $monManuf = [System.Text.Encoding]::ASCII.GetString($mon.ManufacturerName -ne 0).Trim()
            $monModel = [System.Text.Encoding]::ASCII.GetString($mon.UserFriendlyName -ne 0).Trim()
            $monSerial = [System.Text.Encoding]::ASCII.GetString($mon.SerialNumberID -ne 0).Trim()
            if (-not $monModel) { $monModel = "Monitor Generico" }
            if (-not $monSerial) { $monSerial = "No reportado por EDID" }
            $monitores += @{
                fabricante = $monManuf
                modelo = $monModel
                serie = $monSerial
            }
        }
    }
} catch {}

if ($monitores.Count -eq 0) {
    $pnpMonitors = Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue
    foreach ($m in $pnpMonitors) {
        $monName = ($m.Name -replace '\s+', ' ').Trim()
        if ($monName) {
            $monitores += @{
                fabricante = "Estándar"
                modelo = $monName
                serie = "PNP-ID"
            }
        }
    }
}

# 8. PERIFÉRICOS DE MARCA RECONOCIDA (LOGITECH, HP, DELL, LENOVO, ETC.)
$perifericosDetalles = @()
$marcasReconocidasPattern = 'Logitech|HP|Dell|Lenovo|Microsoft|Corsair|Razer|HyperX|Kingston|Redragon|Genius|ASUS|Samsung|LG|AOC|ViewSonic|JBL|Sony|Jabra|Poly|Plantronics|SteelSeries|Trust|Targus|Kensington|BenQ|Philips|Epson|Canon|Brother|Apple|Huawei|Xiaomi|Wacom|A4Tech|Cougar'

$pnpPeripherals = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { 
    $_.Name -and $_.Status -eq 'OK' -and 
    ($_.PNPClass -in @('Keyboard', 'Mouse', 'USB', 'HIDClass', 'Camera', 'AudioEndpoint', 'Media', 'Image')) -and
    $_.Name -notmatch 'Hub|Controlador|Root|Generic|Host|Standard|Virtual|Software|Composite|Dispositivo del sistema|Audio de Intel|NVIDIA High Definition'
}

$seenPeripherals = @{}

foreach ($dev in $pnpPeripherals) {
    $devName = ($dev.Name -replace '\s+', ' ').Trim()
    $devClass = $dev.PNPClass
    
    # Determinar tipo amigable
    $tipo = "Dispositivo USB"
    if ($devClass -eq "Keyboard" -or $devName -match "Keyboard|Teclado") { $tipo = "Teclado" }
    elseif ($devClass -eq "Mouse" -or $devName -match "Mouse|Pointing|Ratón") { $tipo = "Mouse" }
    elseif ($devClass -eq "Camera" -or $devName -match "Webcam|Camera|Cámara") { $tipo = "Cámara Web" }
    elseif ($devClass -eq "AudioEndpoint" -or $devName -match "Headset|Audífono|Auricular|Diadema|Microphone|Micrófono|Speaker") { $tipo = "Audio / Diadema" }

    # Verificar si es de marca comercial reconocida
    $esMarcaReconocida = $devName -match $marcasReconocidasPattern -or ($dev.Manufacturer -and $dev.Manufacturer -match $marcasReconocidasPattern)
    
    if ($esMarcaReconocida -or ($tipo -in @('Teclado', 'Mouse', 'Cámara Web', 'Audio / Diadema') -and $devName -notmatch 'HID-compliant|compatible con HID|PS/2|Estándar|Dispositivo de')) {
        $uniqueKey = "$tipo-$devName"
        if (-not $seenPeripherals.ContainsKey($uniqueKey)) {
            $seenPeripherals[$uniqueKey] = $true
            $perifericosDetalles += @{
                tipo = $tipo
                nombre = $devName
                fabricante = $dev.Manufacturer
                id_hardware = $dev.DeviceID
                es_marca = [bool]$esMarcaReconocida
            }
        }
    }
}

# 9. SISTEMA OPERATIVO Y RED
$os = Get-CimInstance Win32_OperatingSystem
$osName = $os.Caption
$osArch = $os.OSArchitecture
$hostname = $env:COMPUTERNAME
$usuario = $env:USERNAME

$netAdapters = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = TRUE" -ErrorAction SilentlyContinue
$ipAddresses = @()
$macAddresses = @()
foreach ($net in $netAdapters) {
    $ipAddresses += ($net.IPAddress -join ", ")
    $macAddresses += $net.MACAddress
}
$ipPrincipal = ($ipAddresses -join " | ")
$macPrincipal = ($macAddresses -join " | ")

# CONSTRUIR PAYLOAD DE AUDITORÍA
$hardwarePayload = [ordered]@{
    modelo = $modelo
    numero_serie = $numeroSerie
    placa_base = $placaBase
    placa_base_completa = $placaBaseCompleta
    placa_base_serial = $placaBaseSerial
    fabricante = $fabricante
    tipo_equipo = $tipoEquipo
    procesador = $procesadorInfo
    ram_total = $ramResumen
    ram_detalles = $ramDetalles
    almacenamiento_resumen = $almacenamientoResumen
    almacenamiento = $almacenamientoDetalles
    monitores = $monitores
    perifericos = $perifericosDetalles
    hostname = $hostname
    usuario_actual = $usuario
    sistema_operativo = "$osName ($osArch)"
    ip_red = $ipPrincipal
    mac_address = $macPrincipal
    fecha_escaneo = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
}

$jsonPayload = $hardwarePayload | ConvertTo-Json -Depth 6

# CREAR CARPETA SCANS SI NO EXISTE
try {
    if ($PSScriptRoot) {
        $scansDir = Join-Path $PSScriptRoot "..\scans"
    } else {
        $scansDir = Join-Path ([System.IO.Path]::GetTempPath()) "SysInventarioScans"
    }

    if (-not (Test-Path $scansDir)) {
        New-Item -ItemType Directory -Path $scansDir -Force | Out-Null
    }
    $fileName = "scan_${hostname}_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json"
    $filePath = Join-Path $scansDir $fileName
    [System.IO.File]::WriteAllText($filePath, $jsonPayload, [System.Text.Encoding]::UTF8)
} catch {
    $filePath = "Temporal en Memoria"
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " [OK] HARDWARE DETECTADO CON EXITO:" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  - MODELO:           $modelo" -ForegroundColor White
Write-Host "  - NUMERO DE SERIE:  $numeroSerie" -ForegroundColor White
Write-Host "  - PLACA BASE:       $placaBaseCompleta" -ForegroundColor White
Write-Host "  - TIPO DE EQUIPO:   $tipoEquipo" -ForegroundColor White
Write-Host "  - PROCESADOR:       $cpuName" -ForegroundColor White
Write-Host "  - MEMORIA RAM:      $ramResumen" -ForegroundColor White
Write-Host "  - DISCOS:           $almacenamientoResumen" -ForegroundColor White
Write-Host "  - HOSTNAME / IP:    $hostname ($ipPrincipal)" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "[+] Copia local guardada en: $filePath" -ForegroundColor DarkGray

# ENVIAR AL SERVIDOR LOCAL VIA REST API
Write-Host "[*] Enviando datos al sistema de inventario ($ServerUrl)..." -ForegroundColor Yellow
try {
    $apiUrl = "$ServerUrl/api/agent/report"
    $response = Invoke-RestMethod -Uri $apiUrl -Method Post -Body $jsonPayload -ContentType "application/json; charset=utf-8" -TimeoutSec 5
    Write-Host "[OK] ¡DATOS REGISTRADOS EXITOSAMENTE EN EL INVENTARIO EN LINEA!" -ForegroundColor Green
    Write-Host "     ID Registro: $($response.item.id)" -ForegroundColor DarkCyan
} catch {
    Write-Host "[!] El servidor web no respondio en $ServerUrl." -ForegroundColor Yellow
    Write-Host "    (No te preocupes: el archivo JSON quedo guardado para importarlo en el sistema)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Presione cualquier tecla para salir..." -ForegroundColor Gray
