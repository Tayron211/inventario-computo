# ==============================================================================
# RECOLECTOR AVANZADO DE HARDWARE Y NÚMEROS DE SERIE - INVENTARIO DE CÓMPUTO
# Versión: 2.5 - Auditoría Multi-Usuario (Platinum & Golden)
# ==============================================================================

param(
    [string]$ServerUrl = "https://ivt.onrender.com",
    [string]$Ubicacion = "Soporte Técnico",
    [string]$UsuarioScanner = "Administrador"
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

$fabricanteRaw = ($compSystem.Manufacturer -replace '\s+', ' ').Trim()
$modeloRaw = ($compSystem.Model -replace '\s+', ' ').Trim()
if (-not $modeloRaw -or $modeloRaw -match '^(System Product Name|To be filled by O\.E\.M\.|Default string|System manufacturer|Generic|All Series)$' -or $modeloRaw -eq "") {
    $modeloRaw = ($compSystemProduct.Name -replace '\s+', ' ').Trim()
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

# Limpieza y asignación automática para PCs Ensambladas
if (-not $modeloRaw -or $modeloRaw -match '^(System Product Name|To be filled by O\.E\.M\.|Default string|System manufacturer|Generic|All Series)$' -or $modeloRaw -eq "") {
    if ($placaBaseModelo -and $placaBaseModelo -notmatch '^(System Product Name|To be filled by O\.E\.M\.|Default string|Base Board Product Name)$') {
        $modelo = "PC Ensamblada ($placaBaseModelo)"
    } else {
        $modelo = "PC Ensamblada"
    }
} else {
    $modelo = $modeloRaw
}

if (-not $fabricanteRaw -or $fabricanteRaw -match '^(System manufacturer|To be filled by O\.E\.M\.|Default string|OEM|Generic)$' -or $fabricanteRaw -eq "") {
    if ($placaBaseFabricante -and $placaBaseFabricante -notmatch '^(System manufacturer|To be filled by O\.E\.M\.|Default string)$') {
        $fabricante = $placaBaseFabricante
    } else {
        $fabricante = "Ensamblado"
    }
} else {
    $fabricante = $fabricanteRaw
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
    $diskSerial = $diskSerial -replace '[._\s]+$', ''
    if ($diskSerial -match '(?:0000[_ ]+){2,}') {
        $diskSerial = $diskSerial -replace '^(?:0000[_ ]+)+', ''
    }
    if ($diskSerial -match '^[0-9A-Fa-f]{4}\s+[0-9A-Fa-f]{4}') {
        $diskSerial = $diskSerial -replace '\s+', ''
    }
    $diskSerial = $diskSerial.Trim().TrimEnd('.')
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
    $almacenamientoResumenList += if ($diskSerial -and $diskSerial -ne "N/A") { "${diskModel} (S/N: ${diskSerial})" } else { "${diskModel}" }
}
$almacenamientoResumen = $almacenamientoResumenList -join " | "

# 7. MONITORES (CON DEDICACIÓN, MARCA Y SERIALES)
$monitores = @()
$edidVendors = @{
    'HPN' = 'HP'; 'HWP' = 'HP'; 'HEW' = 'HP'; 'HP' = 'HP'
    'DEL' = 'Dell'; 'DLL' = 'Dell'; 'DELL' = 'Dell'
    'LEN' = 'Lenovo'; 'LNK' = 'Lenovo'; 'LENOVO' = 'Lenovo'
    'SAM' = 'Samsung'; 'SEC' = 'Samsung'; 'SAMSUNG' = 'Samsung'
    'GSM' = 'LG'; 'LGD' = 'LG'; 'LGE' = 'LG'; 'LG' = 'LG'
    'AOC' = 'AOC'
    'VSC' = 'ViewSonic'; 'VIEWSONIC' = 'ViewSonic'
    'BNQ' = 'BenQ'; 'BENQ' = 'BenQ'
    'PHL' = 'Philips'; 'PHILIPS' = 'Philips'
    'ASU' = 'ASUS'; 'AUS' = 'ASUS'; 'ACI' = 'ASUS'; 'ASUS' = 'ASUS'
    'ACR' = 'Acer'; 'ACER' = 'Acer'
    'APP' = 'Apple'; 'APPLE' = 'Apple'
    'MSI' = 'MSI'; 'GIG' = 'Gigabyte'; 'SNY' = 'Sony'
    'TER' = 'Teraware'; 'NEC' = 'NEC'; 'EIZ' = 'Eizo'
}

try {
    $monitorsWmi = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue
    if ($monitorsWmi) {
        foreach ($mon in $monitorsWmi) {
            $rawManuf = [System.Text.Encoding]::ASCII.GetString($mon.ManufacturerName -ne 0).Trim()
            $rawModel = [System.Text.Encoding]::ASCII.GetString($mon.UserFriendlyName -ne 0).Trim()
            $monSerial = [System.Text.Encoding]::ASCII.GetString($mon.SerialNumberID -ne 0).Trim()
            
            $monManuf = if ($edidVendors.ContainsKey($rawManuf.ToUpper())) { $edidVendors[$rawManuf.ToUpper()] } elseif ($rawManuf) { $rawManuf } else { "Monitor" }
            if (-not $rawModel) { $rawModel = "Display HD" }
            if (-not $monSerial) { $monSerial = "No reportado por EDID" }

            $fullMonModel = if ($monManuf -and $rawModel -notmatch "(?i)$monManuf") { "$monManuf $rawModel" } else { $rawModel }

            $monitores += @{
                fabricante = $monManuf
                modelo = $fullMonModel
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
                fabricante = "Monitor Integrado"
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
$genericosExcluir = 'compatible con hid|hid-compliant|dispositivo de |dispositivo del |dispositivo definido|dispositivo port[aá]til|controles de radio|dispositivo de interfaz|usb input device|hid keyboard|hid mouse|touchpad|trackpoint|button driver|wireless button|ideacamera|virtual|composite|dispositivo del sistema|ps/2 compatible|dispositivo de almacenamiento|standard|gen[eé]ric'

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

# 9. SISTEMA OPERATIVO Y RED DETALLADA (ETHERNET, WI-FI, BLUETOOTH SEPARADOS)
$os = Get-CimInstance Win32_OperatingSystem
$osName = $os.Caption
$osArch = $os.OSArchitecture
$hostname = $env:COMPUTERNAME
$usuario = $env:USERNAME

# Función formateadora de MAC a formato estándar XX:XX:XX:XX:XX:XX
$formatMacAddress = {
    param($rawMac)
    if (-not $rawMac -or $rawMac -eq "N/A" -or $rawMac -eq "") { return "N/A" }
    $clean = ($rawMac -replace '[:\-\.]', '').ToUpper().Trim()
    if ($clean.Length -eq 12) {
        return ($clean -replace '..(?!$)', '$&:')
    }
    return $rawMac.ToUpper().Trim()
}

$adapters = Get-NetAdapter -ErrorAction SilentlyContinue

$ethAdapter = $null
$wifiAdapter = $null
$btAdapter = $null

if ($adapters) {
    # 1. Adaptador Ethernet Físico (LAN)
    $ethAdapter = $adapters | Where-Object { 
        ($_.PhysicalMediaType -eq '802.3' -or $_.InterfaceDescription -match 'Ethernet|GbE|Gigabit|Realtek|LAN|I219|Intel.*Ethernet|Broadcom') -and 
        $_.InterfaceDescription -notmatch 'Virtual|Wi-Fi|Wireless|Bluetooth|VPN|Loopback|Hyper-V|TAP|Direct'
    } | Select-Object -First 1

    # 2. Adaptador Wi-Fi / Inalámbrico
    $wifiAdapter = $adapters | Where-Object { 
        ($_.PhysicalMediaType -match '802\.11' -or $_.InterfaceDescription -match 'Wi-Fi|Wireless|802\.11|WLAN' -or $_.Name -match 'Wi-Fi|Wireless') -and 
        $_.InterfaceDescription -notmatch 'Virtual|Direct|TAP|Bluetooth'
    } | Select-Object -First 1

    # 3. Adaptador Bluetooth
    $btAdapter = $adapters | Where-Object { 
        $_.PhysicalMediaType -match 'Bluetooth' -or $_.InterfaceDescription -match 'Bluetooth' -or $_.Name -match 'Bluetooth'
    } | Select-Object -First 1
}

$ethMac = if ($ethAdapter -and $ethAdapter.MacAddress) { $ethAdapter.MacAddress.Trim() } else { "" }
$wifiMac = if ($wifiAdapter -and $wifiAdapter.MacAddress) { $wifiAdapter.MacAddress.Trim() } else { "" }
$btMac = if ($btAdapter -and $btAdapter.MacAddress) { $btAdapter.MacAddress.Trim() } else { "" }

# Respaldo WMI / CIM si no se detectó por Get-NetAdapter
if (-not $ethMac -or -not $wifiMac -or -not $btMac) {
    $cimAdapters = Get-CimInstance Win32_NetworkAdapter -Filter "MACAddress IS NOT NULL" -ErrorAction SilentlyContinue
    if ($cimAdapters) {
        if (-not $ethMac) {
            $ethCim = $cimAdapters | Where-Object {
                $_.PhysicalAdapter -eq $true -and
                ($_.AdapterType -match 'Ethernet' -or $_.Description -match 'Ethernet|GbE|Gigabit|LAN') -and
                $_.Description -notmatch 'Wireless|Wi-Fi|Bluetooth|Virtual|TAP|VPN|Direct'
            } | Select-Object -First 1
            if ($ethCim) { $ethMac = $ethCim.MACAddress }
        }
        if (-not $wifiMac) {
            $wifiCim = $cimAdapters | Where-Object {
                ($_.Description -match 'Wireless|Wi-Fi|802\.11|WLAN' -or $_.Name -match 'Wi-Fi|Wireless') -and
                $_.Description -notmatch 'Virtual|Direct|TAP'
            } | Select-Object -First 1
            if ($wifiCim) { $wifiMac = $wifiCim.MACAddress }
        }
        if (-not $btMac) {
            $btCim = $cimAdapters | Where-Object {
                $_.Description -match 'Bluetooth' -or $_.Name -match 'Bluetooth'
            } | Select-Object -First 1
            if ($btCim) { $btMac = $btCim.MACAddress }
        }
    }
}

$ethMacFormatted = & $formatMacAddress $ethMac
$wifiMacFormatted = & $formatMacAddress $wifiMac
$btMacFormatted = & $formatMacAddress $btMac

# Extracción limpia de Direcciones IPv4 activas
$ipConfigs = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = TRUE" -ErrorAction SilentlyContinue
$ips = @()
foreach ($cfg in $ipConfigs) {
    $validIps = $cfg.IPAddress | Where-Object { $_ -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$' -and $_ -notmatch '^169\.254\.' -and $_ -notmatch '^127\.' }
    if ($validIps) { $ips += $validIps }
}
$ipPrincipal = if ($ips.Count -gt 0) { ($ips -join " | ") } else { "N/A" }

$activeMacsList = @()
if ($ethMacFormatted -ne "N/A") { $activeMacsList += $ethMacFormatted }
if ($wifiMacFormatted -ne "N/A") { $activeMacsList += $wifiMacFormatted }
if ($btMacFormatted -ne "N/A") { $activeMacsList += $btMacFormatted }
$macPrincipal = if ($activeMacsList.Count -gt 0) { ($activeMacsList -join " | ") } else { "N/A" }

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
    creado_por = $UsuarioScanner
    registrado_por = $UsuarioScanner
    creado_por_nombre = $UsuarioScanner
    sistema_operativo = "$osName ($osArch)"
    ip_red = $ipPrincipal
    mac_ethernet = $ethMacFormatted
    mac_wifi = $wifiMacFormatted
    mac_bluetooth = $btMacFormatted
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
Write-Host "  - REGISTRADO POR:   $UsuarioScanner" -ForegroundColor Yellow
Write-Host "  - MODELO:           $modelo" -ForegroundColor White
Write-Host "  - NUMERO DE SERIE:  $numeroSerie" -ForegroundColor White
Write-Host "  - PLACA BASE:       $placaBaseCompleta" -ForegroundColor White
Write-Host "  - TIPO DE EQUIPO:   $tipoEquipo" -ForegroundColor White
Write-Host "  - PROCESADOR:       $cpuName" -ForegroundColor White
Write-Host "  - MEMORIA RAM:      $ramResumen" -ForegroundColor White
Write-Host "  - DISCOS:           $almacenamientoResumen" -ForegroundColor White
$monResumen = ($monitores | ForEach-Object { "$($_.modelo) (S/N: $($_.serie))" }) -join " | "
if (-not $monResumen) { $monResumen = "Pantalla Integrada / Estándar" }
Write-Host "  - MONITORES:        $monResumen" -ForegroundColor White
$perifResumen = ($perifericosDetalles | ForEach-Object { "$($_.tipo): $($_.nombre)" }) -join " | "
if (-not $perifResumen) { $perifResumen = "Estándar / Integrado" }
Write-Host "  - PERIFERICOS:      $perifResumen" -ForegroundColor White
Write-Host "  - HOSTNAME:         $hostname" -ForegroundColor White
Write-Host "  - DIRECCION IP:     $ipPrincipal" -ForegroundColor White
Write-Host "  - MAC ETHERNET:     $ethMacFormatted" -ForegroundColor White
Write-Host "  - MAC WI-FI:        $wifiMacFormatted" -ForegroundColor White
Write-Host "  - MAC BLUETOOTH:    $btMacFormatted" -ForegroundColor White
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
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$payloadBytes = $utf8NoBom.GetBytes($jsonPayload)

foreach ($targetUrl in $urlsToTry) {
    if ($sentSuccess) { break }
    $apiUrl = "$targetUrl/api/agent/report"
    Write-Host "[*] Enviando datos al sistema de inventario ($targetUrl)..." -ForegroundColor Yellow

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $wc = New-Object System.Net.WebClient
            $wc.Encoding = $utf8NoBom
            $wc.Headers.Add("Content-Type", "application/json; charset=utf-8")
            $null = $wc.UploadData($apiUrl, "POST", $payloadBytes)
            Write-Host "[OK] DATOS REGISTRADOS EXITOSAMENTE EN EL INVENTARIO EN LINEA!" -ForegroundColor Green
            $sentSuccess = $true
            break
        } catch {
            try {
                $null = Invoke-RestMethod -Uri $apiUrl -Method Post -Body $jsonPayload -ContentType "application/json; charset=utf-8" -TimeoutSec 60
                Write-Host "[OK] DATOS REGISTRADOS EXITOSAMENTE EN EL INVENTARIO EN LINEA!" -ForegroundColor Green
                $sentSuccess = $true
                break
            } catch {
                if ($attempt -lt 3) {
                    Write-Host "    [*] Estableciendo enlace con el servidor cloud... reintentando en 3s ($attempt/3)..." -ForegroundColor Yellow
                    Start-Sleep -Seconds 3
                }
            }
        }
    }
}

if (-not $sentSuccess) {
    Write-Host "[!] El servidor web no respondio tras varios intentos." -ForegroundColor Yellow
    Write-Host "    (No te preocupes: el archivo JSON quedo guardado localmente en $filePath)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "[OK] Registro completado con exito. Cerrando ventana..." -ForegroundColor Cyan
Start-Sleep -Milliseconds 1500

try {
    [System.Environment]::Exit(0)
} catch {}

try {
    [System.Diagnostics.Process]::GetCurrentProcess().Kill()
} catch {}

Stop-Process -Id $PID -Force
