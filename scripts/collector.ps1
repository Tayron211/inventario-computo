# ==============================================================================
# RECOLECTOR AVANZADO DE HARDWARE Y NÚMEROS DE SERIE - INVENTARIO DE CÓMPUTO
# ==============================================================================

param(
    [string]$ServerUrl = "https://ivt.onrender.com",
    # Ambientes disponibles:
    # Bloque A (Admin): Topico, Lactario, Guarderia, Psicopedagogico, ATP, Admision, Finanzas, Defensoria, Garita
    # Bloque A (Aulas y Labs): Aula 201-206, 207 (Sala SUM), Aula 301-303, Laboratorio 304, Laboratorio 305, Aula 306, Centro de Informacion, Aula 401-409, Aula 501-509, Aula 601-609
    # Bloque B (Admin): Auditorio, Direccion, Counter, GTH, Coordinacion Academica, Retencion, SSOMA, DTC, Sala de Reuniones, Comedor
    # Bloque A (Admin): Soporte Técnico, CAE, Topico, Lactario, Guarderia, Psicopedagogico, ATP, Admision, Finanzas, Defensoria, Garita
    [string]$Ubicacion = "Soporte Técnico"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
} catch {}

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

# 8. PERIFÉRICOS PROPIETARIOS / DE MARCA CON DRIVER DEL FABRICANTE
$perifericosDetalles = @()
$marcasReconocidasPattern = 'Logitech|HP|Dell|Lenovo|Microsoft|Corsair|Razer|HyperX|Kingston|Redragon|Genius|ASUS|ROG|Samsung|LG|AOC|ViewSonic|JBL|Sony|Jabra|Poly|Plantronics|SteelSeries|Trust|Targus|Kensington|BenQ|Philips|Epson|Canon|Brother|Apple|Huawei|Xiaomi|Wacom|A4Tech|Bloody|Cougar|Audio-Technica|Sennheiser|EPOS|T-Force|Crucial|Western Digital|Seagate|SanDisk|Teraware|Halion|Micronics|Antryx|Marvo|Gamemax|Fantech|VSG|EVGA|MSI|Gigabyte|ZOTAC|Elgato|Anker|Ugreen|Baseus|StarTech|Belkin|Kyocera|Ricoh|Zebra'

# Excluir drivers de audio interno, adaptadores genéricos de Windows y stubs virtuales
$audioChipsetsExcluir = 'Realtek|High Definition Audio|Intel|NVIDIA|AMD|Sonido Intel|Dispositivo de audio|Audio digital|Mezcla est|Altavoces|Micr[oó]fono|Audio Endpoint|Audio del sistema|Controlador de audio|Wave|Stereo Mix|S/PDIF'
$genericosExcluir = 'Dispositivo de entrada USB|Dispositivo de teclado HID|Dispositivo de mouse HID|Dispositivo compatible con HID|Dispositivo de control|Dispositivo definido por el proveedor|Dispositivo del sistema|Dispositivo de interfaz|USB Input Device|HID Keyboard Device|HID-compliant device|HID-compliant mouse|HID-compliant|PS/2 Compatible|Dispositivo de almacenamiento|IdeaCamera|Virtual|Generic|Standard|Controlador|Composite'

$pnpPeripherals = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { 
    $_.Name -and $_.Status -eq 'OK' -and 
    ($_.PNPClass -in @('Keyboard', 'Mouse', 'USB', 'HIDClass', 'Camera', 'Image')) -and
    $_.Name -notmatch $genericosExcluir -and
    $_.Name -notmatch $audioChipsetsExcluir -and
    $_.Name -notmatch 'Hub|Root|Host|Standard|Virtual|Software|Composite'
}

$seenPeripherals = @{}

foreach ($dev in $pnpPeripherals) {
    $devName = ($dev.Name -replace '\s+', ' ').Trim()
    $devClass = $dev.PNPClass
    $devManuf = if ($dev.Manufacturer) { ($dev.Manufacturer -replace '\s+', ' ').Trim() } else { '' }
    
    # Descartar si el nombre o fabricante es genérico
    if (-not $devName -or $devName -match $genericosExcluir -or $devName -match $audioChipsetsExcluir) { continue }
    if ($devManuf -match '^\(Dispositivos estándar|^Microsoft$|^Generic$|^Standard$' -and $devName -match $genericosExcluir) { continue }

    # Verificar si es de marca comercial/propietaria reconocida
    $esMarcaReconocida = ($devName -match $marcasReconocidasPattern) -or ($devManuf -and $devManuf -match $marcasReconocidasPattern)
    
    # REGLA ESTRICTA: Omitir cualquier driver genérico. Solo registrar si es propietario/marca reconocida
    if (-not $esMarcaReconocida) { continue }

    # Determinar tipo amigable
    $tipo = "Dispositivo USB"
    if ($devClass -eq "Keyboard" -or $devName -match "Keyboard|Teclado") { $tipo = "Teclado" }
    elseif ($devClass -eq "Mouse" -or $devName -match "Mouse|Pointing|Ratón") { $tipo = "Mouse" }
    elseif ($devClass -eq "Camera" -or $devName -match "Webcam|Camera|Cámara") { $tipo = "Cámara Web" }
    elseif ($devName -match "Headset|Aud[ií]fono|Auricular|Diadema|HyperX|Jabra|Poly|Plantronics|Kraken|Void|Quantum|Sennheiser") { $tipo = "Audífonos / Diadema" }

    $uniqueKey = "$tipo-$devName"
    if (-not $seenPeripherals.ContainsKey($uniqueKey)) {
        $seenPeripherals[$uniqueKey] = $true
        $perifericosDetalles += @{
            tipo = $tipo
            nombre = $devName
            fabricante = if ($devManuf) { $devManuf } else { "OEM / Propietario" }
            id_hardware = $dev.DeviceID
            es_marca = $true
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
    ubicacion = $Ubicacion
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

# ENVIAR AL SERVIDOR VIA REST API CON RETRY Y TIMEOUT EXTENDIDO (PARA DESPERTAR SERVIDOR CLOUD)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
try {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}
} catch {}

$urlsToTry = @($ServerUrl)
if ($ServerUrl -match 'ivt\.onrender\.com') {
    $urlsToTry += "https://inventario-computo.onrender.com"
} elseif ($ServerUrl -match 'inventario-computo\.onrender\.com') {
    $urlsToTry += "https://ivt.onrender.com"
}

$sentSuccess = $false
$payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonPayload)

foreach ($targetUrl in $urlsToTry) {
    if ($sentSuccess) { break }
    $apiUrl = "$targetUrl/api/agent/report"
    Write-Host "[*] Enviando datos al sistema de inventario ($targetUrl)..." -ForegroundColor Yellow

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $wc = New-Object System.Net.WebClient
            $wc.Encoding = [System.Text.Encoding]::UTF8
            $wc.Headers.Add("Content-Type", "application/json; charset=utf-8")
            $responseBytes = $wc.UploadData($apiUrl, "POST", $payloadBytes)
            $responseStr = [System.Text.Encoding]::UTF8.GetString($responseBytes)
            Write-Host "[OK] ¡DATOS REGISTRADOS EXITOSAMENTE EN EL INVENTARIO EN LINEA!" -ForegroundColor Green
            $sentSuccess = $true
            break
        } catch {
            try {
                $response = Invoke-RestMethod -Uri $apiUrl -Method Post -Body $payloadBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 60
                Write-Host "[OK] ¡DATOS REGISTRADOS EXITOSAMENTE EN EL INVENTARIO EN LINEA!" -ForegroundColor Green
                $sentSuccess = $true
                break
            } catch {
                if ($attempt -lt 3) {
                    Write-Host "    [*] Despertando servidor en la nube... reintentando en 3s (intento $attempt/3)..." -ForegroundColor Yellow
                    Start-Sleep -Seconds 3
                }
            }
        }
    }
}

if (-not $sentSuccess) {
    Write-Host "[!] El servidor web no respondió tras varios intentos." -ForegroundColor Yellow
    Write-Host "    (No te preocupes: el archivo JSON quedó guardado localmente en $filePath)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Presione cualquier tecla para salir..." -ForegroundColor Gray
