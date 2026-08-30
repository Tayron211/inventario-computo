const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

let mongoClient = null;
let mongoCollection = null;
let memoryCache = null;

app.use(cors());
app.use(express.text({ type: ['application/json', 'text/plain', '*/*'], limit: '10mb' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
    try {
      let str = req.body.trim();
      if (str.charCodeAt(0) === 0xFEFF) {
        str = str.slice(1);
      }
      req.body = JSON.parse(str);
    } catch (e) {
      console.error('Error parseando JSON:', e.message);
    }
  }
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'inventory.json');
const SCANS_DIR = path.join(__dirname, 'scans');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCANS_DIR)) fs.mkdirSync(SCANS_DIR, { recursive: true });

function deduplicateInventory(items) {
  const uniqueList = [];
  const seen = new Set();

  for (const item of (items || [])) {
    if (!item) continue;
    const cleanSerial = (item.numero_serie || '').trim().toLowerCase();
    const isGeneric = !cleanSerial || /^(s\/n no disponible|default string|to be filled by o\.e\.m\.|system serial number|none|n\/a|0|0123456789|1234567890|invalid|not specified|oem|all series)$/i.test(cleanSerial);

    let key;
    if (!isGeneric) {
      key = `serial:${cleanSerial}`;
    } else {
      const host = (item.hostname || '').trim().toLowerCase();
      const mb = (item.placa_base || '').trim().toLowerCase();
      const cpu = (item.procesador || '').trim().toLowerCase().substring(0, 30);
      key = `host:${host}|mb:${mb}|cpu:${cpu}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      uniqueList.push(item);
    }
  }
  return uniqueList;
}

// Conexión e inicialización automática de Base de Datos en la Nube
let mongoConnecting = false;
let mongoError = null;

async function initCloudDatabase() {
  if (MONGODB_URI && !mongoCollection && !mongoConnecting) {
    mongoConnecting = true;
    try {
      console.log('🔄 Conectando a Base de Datos en la Nube (MongoDB Atlas)...');
      mongoClient = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 10000
      });
      await mongoClient.connect();
      const db = mongoClient.db('sys_inventory');
      mongoCollection = db.collection('equipos');
      mongoError = null;
      console.log('✅ Base de Datos en la Nube (MongoDB Atlas) conectada con éxito.');

      // Cargar todos los equipos existentes en MongoDB
      const cloudItems = await mongoCollection.find({}).toArray();
      if (cloudItems.length > 0) {
        const cleaned = deduplicateInventory(cloudItems.map(item => {
          const { _id, ...clean } = item;
          return normalizeItem(clean);
        }));
        memoryCache = cleaned;
        saveLocalFile(cleaned);
        // Persistir la base de datos limpia y sin duplicados en MongoDB
        await mongoCollection.deleteMany({});
        await mongoCollection.insertMany(cleaned);
        console.log(`📦 Sincronizados y deduplicados ${cleaned.length} equipos en MongoDB Atlas.`);
      } else {
        // Si MongoDB está vacío, subir los datos locales iniciales
        const local = deduplicateInventory(loadLocalFile().map(normalizeItem));
        if (local.length > 0) {
          await mongoCollection.insertMany(local);
          memoryCache = local;
          console.log(`📤 Subidos ${local.length} equipos iniciales a MongoDB Atlas.`);
        }
      }
    } catch (err) {
      mongoError = err.message;
      console.error('⚠️ Error conectando a MongoDB Atlas:', err.message);
      mongoCollection = null;
    } finally {
      mongoConnecting = false;
    }
  }
}
initCloudDatabase();

// Reintento periódico de conexión a MongoDB si falló al inicio
if (MONGODB_URI) {
  setInterval(() => {
    if (!mongoCollection) {
      initCloudDatabase();
    }
  }, 30000);
}

// Datos iniciales de demostración basados en el modelo del usuario
const DEFAULT_INVENTORY = [
  {
    id: "item-1",
    modelo: "HP ProStudio 4",
    numero_serie: "8CN60500Y3",
    placa_base: "8D19",
    placa_base_completa: "HP 8D19 Motherboard",
    placa_base_serial: "PB8D190011",
    tipo_equipo: "PC de Escritorio",
    fabricante: "HP",
    procesador: "Intel Core i7-10700 @ 2.90GHz (8 Núcleos / 16 Hilos)",
    ram_total: "16 GB (2x 8GB DDR4)",
    ram_detalles: ["Slot 1: 8GB DDR4-3200 (S/N: HP8GB001)", "Slot 2: 8GB DDR4-3200 (S/N: HP8GB002)"],
    almacenamiento_resumen: "KIOXIA NVMe SSD 512GB (S/N: KX9087123)",
    almacenamiento: [
      { modelo: "KIOXIA NVMe SSD", serie: "KX9087123", capacidad: "512 GB", tipo: "NVMe SSD", interfaz: "PCIe" }
    ],
    monitores: [
      { fabricante: "HP", modelo: "HP E24 G4 FHD", serie: "CNC1234XYZ" }
    ],
    perifericos: [
      { tipo: "Teclado", nombre: "HP Business Slim USB Keyboard", id_hardware: "USB\\VID_03F0&PID_0024" },
      { tipo: "Mouse / Puntero", nombre: "HP Optical USB Mouse", id_hardware: "USB\\VID_03F0&PID_094A" }
    ],
    hostname: "DESKTOP-HP-ADM01",
    usuario_actual: "Administrador",
    ubicacion: "Oficina Central - Piso 2",
    estado: "Operativo",
    notas: "Equipo de administración general",
    fecha_escaneo: "2026-08-28 10:15:00",
    origen: "Manual"
  },
  {
    id: "item-2",
    modelo: "HP ProStudio 4",
    numero_serie: "8CN60500X9",
    placa_base: "8D19",
    placa_base_completa: "HP 8D19 Motherboard",
    placa_base_serial: "PB8D190012",
    tipo_equipo: "PC de Escritorio",
    fabricante: "HP",
    procesador: "Intel Core i7-10700 @ 2.90GHz (8 Núcleos / 16 Hilos)",
    ram_total: "16 GB (2x 8GB DDR4)",
    ram_detalles: ["Slot 1: 8GB DDR4-3200 (S/N: HP8GB003)", "Slot 2: 8GB DDR4-3200 (S/N: HP8GB004)"],
    almacenamiento_resumen: "Samsung NVMe 980 500GB (S/N: S98000912)",
    almacenamiento: [
      { modelo: "Samsung SSD 980 500GB", serie: "S98000912", capacidad: "500 GB", tipo: "NVMe SSD", interfaz: "PCIe" }
    ],
    monitores: [
      { fabricante: "HP", modelo: "HP E24 G4 FHD", serie: "CNC1234ABC" }
    ],
    perifericos: [
      { tipo: "Teclado", nombre: "HP Business Slim USB Keyboard", id_hardware: "USB\\VID_03F0&PID_0024" },
      { tipo: "Mouse / Puntero", nombre: "HP Optical USB Mouse", id_hardware: "USB\\VID_03F0&PID_094A" }
    ],
    hostname: "DESKTOP-HP-ADM02",
    usuario_actual: "Contabilidad",
    ubicacion: "Departamento Contable",
    estado: "Operativo",
    notas: "Equipo para análisis financiero",
    fecha_escaneo: "2026-08-28 10:20:00",
    origen: "Manual"
  },
  {
    id: "item-3",
    modelo: "HP ProStudio 4",
    numero_serie: "8CN60500WT",
    placa_base: "8D19",
    placa_base_completa: "HP 8D19 Motherboard",
    placa_base_serial: "PB8D190013",
    tipo_equipo: "PC de Escritorio",
    fabricante: "HP",
    procesador: "Intel Core i5-10500 @ 3.10GHz (6 Núcleos / 12 Hilos)",
    ram_total: "8 GB (1x 8GB DDR4)",
    ram_detalles: ["Slot 1: 8GB DDR4-2666 (S/N: HP8GB005)"],
    almacenamiento_resumen: "Kingston SSD 480GB (S/N: KG4801123)",
    almacenamiento: [
      { modelo: "Kingston A400 480GB", serie: "KG4801123", capacidad: "480 GB", tipo: "SATA SSD", interfaz: "SATA" }
    ],
    monitores: [
      { fabricante: "HP", modelo: "HP V22 FHD", serie: "CNC7899XYZ" }
    ],
    perifericos: [
      { tipo: "Teclado", nombre: "Genius USB Keyboard", id_hardware: "USB\\VID_0458&PID_0001" },
      { tipo: "Mouse / Puntero", nombre: "Logitech B100 Optical Mouse", id_hardware: "USB\\VID_046D&PID_C077" }
    ],
    hostname: "DESKTOP-HP-REC01",
    usuario_actual: "Recepción",
    ubicacion: "Recepción Principal",
    estado: "Operativo",
    notas: "Estación de atención al público",
    fecha_escaneo: "2026-08-28 10:25:00",
    origen: "Manual"
  },
  {
    id: "item-4",
    modelo: "HP ProStudio 4",
    numero_serie: "8CN60500YQ",
    placa_base: "8D19",
    placa_base_completa: "HP 8D19 Motherboard",
    placa_base_serial: "PB8D190014",
    tipo_equipo: "PC de Escritorio",
    fabricante: "HP",
    procesador: "Intel Core i7-10700 @ 2.90GHz (8 Núcleos / 16 Hilos)",
    ram_total: "32 GB (2x 16GB DDR4)",
    ram_detalles: ["Slot 1: 16GB DDR4-3200", "Slot 2: 16GB DDR4-3200"],
    almacenamiento_resumen: "WD Black SN770 1TB (S/N: WDB1000998)",
    almacenamiento: [
      { modelo: "WD Black SN770 1TB NVMe", serie: "WDB1000998", capacidad: "1000 GB", tipo: "NVMe SSD", interfaz: "PCIe" }
    ],
    monitores: [
      { fabricante: "Dell", modelo: "Dell UltraSharp U2720Q", serie: "CN0U270098" }
    ],
    perifericos: [
      { tipo: "Teclado", nombre: "Logitech MX Keys Wireless", id_hardware: "USB\\VID_046D&PID_B35B" },
      { tipo: "Mouse / Puntero", nombre: "Logitech MX Master 3", id_hardware: "USB\\VID_046D&PID_B023" }
    ],
    hostname: "DESKTOP-HP-DEV01",
    usuario_actual: "Desarrollo",
    ubicacion: "Laboratorio de Sistemas",
    estado: "Operativo",
    notas: "Estación para desarrollo y compilación",
    fecha_escaneo: "2026-08-28 10:30:00",
    origen: "Manual"
  },
  {
    id: "item-5",
    modelo: "Lenovo ThinkPad T14 Gen 2",
    numero_serie: "PF29X8YZ",
    placa_base: "20W0005VUS",
    placa_base_completa: "Lenovo ThinkPad T14 Motherboard",
    placa_base_serial: "LNV009817",
    tipo_equipo: "Laptop",
    fabricante: "Lenovo",
    procesador: "Intel Core i7-1165G7 @ 2.80GHz (4 Núcleos / 8 Hilos)",
    ram_total: "16 GB (Soldada + 8GB DDR4)",
    ram_detalles: ["Slot 1: 16GB DDR4-3200"],
    almacenamiento_resumen: "Samsung NVMe 512GB (S/N: S512998811)",
    almacenamiento: [
      { modelo: "Samsung PM991a NVMe 512GB", serie: "S512998811", capacidad: "512 GB", tipo: "NVMe SSD", interfaz: "PCIe" }
    ],
    monitores: [
      { fabricante: "Lenovo", modelo: "Pantalla Integrada 14\" FHD IPS", serie: "LEN40A0" }
    ],
    perifericos: [
      { tipo: "Teclado", nombre: "ThinkPad Integrated Keyboard", id_hardware: "ACPI\\LEN0071" },
      { tipo: "Mouse / Puntero", nombre: "Synaptics TrackPoint + Touchpad", id_hardware: "ACPI\\LEN0072" },
      { tipo: "Webcam", nombre: "Integrated 720p HD Camera", id_hardware: "USB\\VID_04F2&PID_B685" }
    ],
    hostname: "LAPTOP-LNV-DIR01",
    usuario_actual: "Dirección",
    ubicacion: "Gerencia General",
    estado: "En Uso",
    notas: "Laptop asignada a gerencia para movilidad",
    fecha_escaneo: "2026-08-28 11:00:00",
    origen: "Manual"
  }
];

function loadLocalFile() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error leyendo base de datos local:', err);
  }
  saveLocalFile(DEFAULT_INVENTORY);
  return DEFAULT_INVENTORY;
}
function saveLocalFile(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando base de datos local:', err);
  }
}

const GENERIC_DRIVER_EXCLUDE_REGEX = /compatible con hid|hid-compliant|dispositivo de |dispositivo del |dispositivo definido|dispositivo port[aá]til|controles de radio|dispositivo de interfaz|usb input device|hid keyboard|hid mouse|touchpad|trackpoint|button driver|wireless button|ideacamera|virtual|composite|dispositivo del sistema|realtek|high definition audio|altavoces|micr[oó]fono|audioendpoint|dispositivo de audio|audio digital|mezcla est|controlador de audio|wave|stereo mix|s\/pdif/i;

const PROPRIETARY_BRANDS_PATTERN = /logitech|hp|dell|lenovo|microsoft|corsair|razer|hyperx|kingston|redragon|genius|asus|rog|samsung|lg|aoc|viewsonic|jbl|sony|jabra|poly|plantronics|steelseries|trust|targus|kensington|benq|philips|epson|canon|brother|apple|huawei|xiaomi|wacom|a4tech|bloody|cougar|audio-technica|sennheiser|epos|t-force|crucial|western digital|seagate|sandisk|teraware|halion|micronics|antryx|marvo|gamemax|fantech|vsg|evga|msi|gigabyte|zotac|elgato|anker|ugreen|baseus|startech|belkin|kyocera|ricoh|zebra/i;

function isValidPeripheral(p) {
  if (!p) return false;
  const n = (p.nombre || '').trim();
  const f = (p.fabricante || '').trim();
  const t = (p.tipo || '').trim();
  const full = `${f} ${n} ${t}`.trim();
  if (!n || GENERIC_DRIVER_EXCLUDE_REGEX.test(full)) return false;
  return PROPRIETARY_BRANDS_PATTERN.test(full) || p.es_marca === true;
}

function normalizeItem(item) {
  if (!item) return item;
  if (item.perifericos && Array.isArray(item.perifericos)) {
    item.perifericos = item.perifericos.filter(isValidPeripheral);
  }
  return item;
}

function loadDB() {
  if (memoryCache && Array.isArray(memoryCache)) {
    return memoryCache.map(normalizeItem);
  }
  const data = loadLocalFile().map(normalizeItem);
  memoryCache = data;
  return data;
}

function saveDB(data) {
  const normalized = (data || []).map(normalizeItem);
  memoryCache = normalized;
  saveLocalFile(normalized);
  
  if (mongoCollection) {
    (async () => {
      try {
        await mongoCollection.deleteMany({});
        if (normalized.length > 0) {
          await mongoCollection.insertMany(normalized);
        }
      } catch (err) {
        console.error('⚠️ Error sincronizando en MongoDB Atlas:', err.message);
      }
    })();
  }
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const validIPs = [];
  
  for (const [name, ifaceList] of Object.entries(interfaces)) {
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Descartar IPs automáticas APIPA (169.254.x.x)
        if (iface.address.startsWith('169.254.')) continue;

        const isWifi = /wi-fi|wifi|inalámbrica/i.test(name);
        const isEthernet = /ethernet/i.test(name) && !/virtual|vbox|vmware|vethernet/i.test(name);
        const isHotspot = iface.address.startsWith('192.168.137.') || /área local\*/i.test(name);

        validIPs.push({
          name,
          address: iface.address,
          priority: isWifi ? 1 : (isEthernet ? 2 : (isHotspot ? 4 : 3))
        });
      }
    }
  }

  // Ordenar por prioridad (Wi-Fi primero, luego Ethernet, luego otros)
  validIPs.sort((a, b) => a.priority - b.priority);
  return validIPs.map(v => v.address);
}

function getServerUrl(req) {
  if (req && req.headers && req.headers.host) {
    const isRender = req.headers.host.includes('.onrender.com');
    const proto = isRender ? 'https' : (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'));
    return `${proto}://${req.headers.host}`;
  }
  const ips = getLocalIPs();
  const primaryIP = ips[0] || 'localhost';
  return `http://${primaryIP}:${PORT}`;
}

// -------------------------------------------------------------
// RUTAS DE LA API REST
// -------------------------------------------------------------

// Credenciales de acceso y roles del sistema
const USERS = [
  { username: 'admin', password: 'S0p0rt3pp', role: 'admin', displayName: 'Administrador' },
  { username: 'user', password: 'solover', role: 'operador', displayName: 'Observador' }
];

// Obtener rol del usuario actual basado en el token Bearer
function getUserRole(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return 'admin'; // Fallback por defecto
  
  try {
    const token = authHeader.replace('Bearer ', '').trim();
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [username, role] = decoded.split(':');
    return role || 'admin';
  } catch (e) {
    return 'admin';
  }
}

// Login de Usuarios (Admin / Operador)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Credenciales incompletas' });
  }

  const foundUser = USERS.find(u => 
    u.username.toLowerCase() === username.trim().toLowerCase() && 
    u.password === password.trim()
  );
  
  if (foundUser) {
    const token = Buffer.from(`${foundUser.username}:${foundUser.role}:${Date.now()}`).toString('base64');
    return res.json({
      success: true,
      user: foundUser.username,
      role: foundUser.role,
      displayName: foundUser.displayName,
      token: token,
      message: 'Inicio de sesión exitoso'
    });
  }
  return res.status(401).json({
    success: false,
    error: 'Usuario o contraseña incorrectos'
  });
});

// Servir script para ejecución remota en 1 sola línea (irm http://IP:3000/scan | iex)
app.get(['/scan', '/agent.ps1', '/api/script'], (req, res) => {
  const scriptPath = path.join(__dirname, 'scripts', 'collector.ps1');
  const serverUrl = getServerUrl(req);
  const ubicacion = (req.query.ubicacion || req.query.amb || req.query.u || 'Soporte Técnico').trim();
  
  try {
    let scriptContent = fs.readFileSync(scriptPath, 'utf8');
    scriptContent = scriptContent.replace(/\[string\]\$ServerUrl\s*=\s*"[^"]*"/i, `[string]$ServerUrl = "${serverUrl}"`);
    scriptContent = scriptContent.replace(/\[string\]\$Ubicacion\s*=\s*"[^"]*"/i, `[string]$Ubicacion = "${ubicacion}"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(scriptContent);
  } catch (err) {
    res.status(500).send('# Error leyendo script de escaneo');
  }
});

// Endpoint para descargar el archivo ESCANEAR_ESTE_EQUIPO.bat con permisos de Administrador por defecto
app.get(['/api/download-batch', '/download-batch', '/escanear.bat'], (req, res) => {
  const serverUrl = getServerUrl(req);
  
  const batContent = `@echo off
chcp 65001 >nul
title SYS-INVENTORY - AUDITORIA DE HARDWARE
color 0C

:: ====================================================================
:: AUTO-ELEVACION AUTOMATICA A PERMISOS DE ADMINISTRADOR POR DEFECTO
:: ====================================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Solicitando permisos de Administrador para auditar BIOS y Hardware...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
cls

echo ====================================================================
echo             SYS-INVENTORY - AUDITORIA TOTAL DE HARDWARE
echo ====================================================================
echo.
echo [*] Permisos de Administrador: [OK - CONCEDIDOS]
echo [*] Conectando con servidor (${serverUrl})...
echo [*] Extrayendo BIOS, Motherboard, CPU, RAM, Discos y Perifericos...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls; irm ${serverUrl}/scan | iex"

echo.
echo ====================================================================
echo  [OK] Escaneo completado. Los datos se guardaron en el inventario.
echo ====================================================================
echo.
timeout /t 5 >nul
`;

  res.setHeader('Content-Type', 'application/x-bat; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ESCANEAR_ESTE_EQUIPO.bat"');
  res.send(batContent);
});

// Info de red y código QR para conectar el teléfono celular
app.get('/api/server-info', async (req, res) => {
  const ips = getLocalIPs();
  const primaryIP = ips[0];
  const url = getServerUrl(req);
  
  // Calcular la subred base
  const parts = primaryIP.split('.');
  const subnetBase = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : '192.168.1';
  
  try {
    const qrDataUrlDark = await QRCode.toDataURL(url, {
      margin: 2,
      color: {
        dark: '#DC143C',
        light: '#0A0A0E'
      },
      width: 260
    });

    const qrDataUrlLight = await QRCode.toDataURL(url, {
      margin: 2,
      color: {
        dark: '#9f1239',
        light: '#FFFFFF'
      },
      width: 260
    });
    
    res.json({
      port: PORT,
      ips,
      primaryIP,
      subnetBase,
      serverUrl: url,
      oneLinerCommand: `irm ${url}/scan | iex`,
      qrCode: qrDataUrlDark,
      qrCodeDark: qrDataUrlDark,
      qrCodeLight: qrDataUrlLight,
      hostname: os.hostname(),
      isCloud: process.platform !== 'win32'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error generando código QR', details: err.message });
  }
});

// Disparar escaneo de toda la red local
app.post('/api/scan-network', (req, res) => {
  const serverUrl = getServerUrl(req);

  // Si el servidor está en la nube (Render / Linux):
  if (process.platform !== 'win32') {
    const items = loadDB();
    return res.json({
      message: 'Servidor alojado en la Nube',
      output: `[✓] SERVIDOR ACTIVO EN LA NUBE (${serverUrl})\n\n[*] Como este servidor está en internet, para auditar cualquier PC o laptop de tu red local y que aparezca en este panel en vivo, abre PowerShell en esa máquina y pega:\n\n    irm ${serverUrl}/scan | iex\n\n[OK] El equipo se registrará automáticamente en tu inventario al instante.`,
      totalEquipos: items.length,
      items: items
    });
  }

  const { subnet } = req.body;
  const ips = getLocalIPs();
  const primaryIP = ips[0];
  const parts = primaryIP.split('.');
  const defaultSubnet = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : '192.168.1';
  const targetSubnet = subnet || defaultSubnet;
  
  const scriptPath = path.join(__dirname, 'scripts', 'scan_network.ps1');
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" "${serverUrl}" "${targetSubnet}"`;
  
  console.log(`[*] Iniciando escaneo de red local en subred: ${targetSubnet}.0/24...`);

  exec(cmd, { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
    const items = loadDB();
    if (error) {
      console.error('Error durante escaneo de red:', error, stderr);
      return res.status(500).json({
        error: 'Error durante el barrido de red',
        details: stderr || error.message,
        items
      });
    }

    res.json({
      message: `Escaneo de red completado en ${targetSubnet}.0/24`,
      output: stdout,
      totalEquipos: items.length,
      items: items
    });
  });
});

// Obtener inventario con filtros opcionales
app.get('/api/inventory', (req, res) => {
  const items = loadDB();
  const { search, tipo, estado } = req.query;
  
  let filtered = items;
  
  if (tipo && tipo !== 'Todos') {
    filtered = filtered.filter(item => {
      if (tipo === 'Desktop' || tipo === 'PC de Escritorio') {
        return item.tipo_equipo === 'PC de Escritorio' || item.tipo_equipo === 'Desktop' || item.tipo_equipo === 'Mini PC';
      }
      if (tipo === 'Laptop') {
        return item.tipo_equipo === 'Laptop' || item.tipo_equipo === 'Notebook' || item.tipo_equipo === 'Portátil';
      }
      return item.tipo_equipo === tipo;
    });
  }
  
  if (estado && estado !== 'Todos') {
    filtered = filtered.filter(item => item.estado === estado);
  }
  
  if (search && search.trim() !== '') {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(item => {
      return (
        (item.modelo && item.modelo.toLowerCase().includes(q)) ||
        (item.numero_serie && item.numero_serie.toLowerCase().includes(q)) ||
        (item.placa_base && item.placa_base.toLowerCase().includes(q)) ||
        (item.procesador && item.procesador.toLowerCase().includes(q)) ||
        (item.hostname && item.hostname.toLowerCase().includes(q)) ||
        (item.usuario_actual && item.usuario_actual.toLowerCase().includes(q)) ||
        (item.ubicacion && item.ubicacion.toLowerCase().includes(q)) ||
        (item.almacenamiento_resumen && item.almacenamiento_resumen.toLowerCase().includes(q))
      );
    });
  }
  
  res.json({
    total: filtered.length,
    totalGeneral: items.length,
    items: filtered
  });
});

// Obtener un solo equipo
app.get('/api/inventory/:id', (req, res) => {
  const items = loadDB();
  const item = items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json(item);
});

// Crear registro manual (Bloqueado para operador)
app.post('/api/inventory', (req, res) => {
  const role = getUserRole(req);
  if (role === 'operador') {
    return res.status(403).json({ error: 'Acceso denegado: El usuario operador solo tiene permisos de visualización y no puede crear registros.' });
  }

  const items = loadDB();
  const body = req.body;
  
  if (!body.modelo || !body.numero_serie) {
    return res.status(400).json({ error: 'El modelo y número de serie son obligatorios' });
  }
  
  const newItem = {
    id: `item-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    modelo: body.modelo.trim(),
    numero_serie: body.numero_serie.trim(),
    placa_base: body.placa_base ? body.placa_base.trim() : 'N/A',
    placa_base_completa: body.placa_base_completa || body.placa_base || 'N/A',
    placa_base_serial: body.placa_base_serial || '',
    tipo_equipo: body.tipo_equipo || 'PC de Escritorio',
    fabricante: body.fabricante || 'Genérico',
    procesador: body.procesador || '',
    ram_total: body.ram_total || '',
    ram_detalles: body.ram_detalles || [],
    almacenamiento_resumen: body.almacenamiento_resumen || '',
    almacenamiento: body.almacenamiento || [],
    monitores: body.monitores || [],
    perifericos: body.perifericos || [],
    hostname: body.hostname || '',
    usuario_actual: body.usuario_actual || '',
    ubicacion: body.ubicacion || 'Sin asignar',
    estado: body.estado || 'Operativo',
    notas: body.notas || '',
    fecha_escaneo: new Date().toISOString().replace('T', ' ').substring(0, 19),
    origen: 'Manual'
  };
  
  items.unshift(newItem);
  saveDB(items);
  
  res.status(201).json({ message: 'Equipo registrado exitosamente', item: newItem });
});

// Actualizar equipo (Bloqueado para operador)
app.put('/api/inventory/:id', (req, res) => {
  const role = getUserRole(req);
  if (role === 'operador') {
    return res.status(403).json({ error: 'Acceso denegado: El usuario operador solo tiene permisos de visualización y no puede editar registros.' });
  }

  const items = loadDB();
  const index = items.findIndex(i => i.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Equipo no encontrado' });
  }
  
  const updated = {
    ...items[index],
    ...req.body,
    id: items[index].id, // preservar ID
    fecha_modificacion: new Date().toISOString().replace('T', ' ').substring(0, 19)
  };
  
  items[index] = updated;
  saveDB(items);
  
  res.json({ message: 'Equipo actualizado exitosamente', item: updated });
});

// Eliminar equipo (Bloqueado para operador)
app.delete('/api/inventory/:id', (req, res) => {
  const role = getUserRole(req);
  if (role === 'operador') {
    return res.status(403).json({ error: 'Acceso denegado: El usuario operador solo tiene permisos de visualización y no puede eliminar registros.' });
  }

  let items = loadDB();
  const initialLen = items.length;
  items = items.filter(i => i.id !== req.params.id);
  
  if (items.length === initialLen) {
    return res.status(404).json({ error: 'Equipo no encontrado' });
  }
  
  saveDB(items);
  res.json({ message: 'Equipo eliminado exitosamente' });
});

// Endpoint receptor para el Agente Escaneador de Hardware (.bat / PowerShell)
app.post('/api/agent/report', (req, res) => {
  const payload = req.body;
  if (!payload || !payload.modelo) {
    return res.status(400).json({ error: 'Payload de escaneo inválido' });
  }
  
  const items = loadDB();
  
  const serialNormalized = (payload.numero_serie || '').trim();
  const macNormalized = (payload.mac_address || '').trim().toLowerCase();
  const mbSerialNormalized = (payload.placa_base_serial || '').trim().toLowerCase();

  // Lista de seriales genéricos o no disponibles que NO deben usarse para reemplazar equipos distintos
  const isGenericSerial = !serialNormalized || 
    /^(s\/n no disponible|default string|to be filled by o\.e\.m\.|system serial number|none|n\/a|0|0123456789|1234567890|invalid|not specified|oem|all series)$/i.test(serialNormalized);

  let existingIndex = -1;

  // 1. Coincidencia por número de serie físico válido (NO genérico)
  if (!isGenericSerial) {
    existingIndex = items.findIndex(i => {
      const itemSerial = (i.numero_serie || '').trim().toLowerCase();
      return itemSerial && itemSerial === serialNormalized.toLowerCase();
    });
  }

  // 2. Si el serial es genérico o no coincidió, buscar por intersección de MAC Address física
  if (existingIndex === -1 && macNormalized && macNormalized !== 'n/a' && macNormalized !== '') {
    const reportMacs = macNormalized.split(/[\s|,]+/).map(m => m.trim().toLowerCase()).filter(m => m.length >= 12);
    existingIndex = items.findIndex(i => {
      const itemMacs = (i.mac_address || '').trim().toLowerCase().split(/[\s|,]+/).map(m => m.trim().toLowerCase()).filter(m => m.length >= 12);
      return reportMacs.some(rm => itemMacs.includes(rm));
    });
  }

  // 3. Si el serial de la placa base es único y válido (no genérico), verificar coincidencia
  if (existingIndex === -1 && mbSerialNormalized && !/^(default string|none|n\/a|0|to be filled by o\.e\.m\.)$/i.test(mbSerialNormalized)) {
    existingIndex = items.findIndex(i => {
      const itemMb = (i.placa_base_serial || '').trim().toLowerCase();
      return itemMb && itemMb === mbSerialNormalized;
    });
  }

  // 4. Si el Hostname coincide Y (la Placa Base coincide O el Procesador coincide), es la MISMA máquina física re-escaneada
  if (existingIndex === -1 && payload.hostname) {
    const cleanHost = payload.hostname.trim().toLowerCase();
    existingIndex = items.findIndex(i => {
      const itemHost = (i.hostname || '').trim().toLowerCase();
      if (itemHost && itemHost === cleanHost) {
        const sameMb = (i.placa_base || '').trim().toLowerCase() === (payload.placa_base || '').trim().toLowerCase();
        const sameCpu = (i.procesador || '').trim().toLowerCase().substring(0, 25) === (payload.procesador || '').trim().toLowerCase().substring(0, 25);
        return sameMb || sameCpu;
      }
      return false;
    });
  }

  const recordHostname = payload.hostname || 'DESKTOP-EQUIPO';

  const record = {
    id: existingIndex >= 0 ? items[existingIndex].id : `item-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    modelo: payload.modelo,
    numero_serie: payload.numero_serie || 'S/N NO DISPONIBLE',
    placa_base: payload.placa_base || 'N/A',
    placa_base_completa: payload.placa_base_completa || payload.placa_base,
    placa_base_serial: payload.placa_base_serial || '',
    tipo_equipo: payload.tipo_equipo || 'PC de Escritorio',
    fabricante: payload.fabricante || '',
    procesador: payload.procesador || '',
    ram_total: payload.ram_total || '',
    ram_detalles: payload.ram_detalles || [],
    almacenamiento_resumen: payload.almacenamiento_resumen || '',
    almacenamiento: payload.almacenamiento || [],
    monitores: payload.monitores || [],
    perifericos: (payload.perifericos || []).filter(p => {
      const n = (p.nombre || '').trim();
      const f = (p.fabricante || '').trim();
      if (!n || isInternalAudioDriver.test(n) || isGenericStub.test(n)) return false;
      if (f && (isInternalAudioDriver.test(f) || isGenericStub.test(f))) return false;
      return PROPRIETARY_BRANDS_PATTERN.test(n) || PROPRIETARY_BRANDS_PATTERN.test(f) || p.es_marca === true;
    }),
    hostname: recordHostname,
    usuario_actual: payload.usuario_actual || '',
    sistema_operativo: payload.sistema_operativo || '',
    ip_red: payload.ip_red || '',
    ubicacion: (payload.ubicacion && !/detectado autom[aá]ticamente|sin asignar/i.test(payload.ubicacion)) 
      ? payload.ubicacion 
      : ((existingIndex >= 0 && items[existingIndex].ubicacion && !/detectado autom[aá]ticamente|sin asignar/i.test(items[existingIndex].ubicacion)) ? items[existingIndex].ubicacion : 'Soporte Técnico'),
    estado: existingIndex >= 0 ? (items[existingIndex].estado || 'Operativo') : 'Operativo',
    notas: existingIndex >= 0 ? items[existingIndex].notas : 'Registrado por escáner automático',
    fecha_escaneo: payload.fecha_escaneo || new Date().toISOString().replace('T', ' ').substring(0, 19),
    origen: 'Escáner Batch/PowerShell'
  };
  
  if (existingIndex >= 0) {
    items[existingIndex] = record;
  } else {
    items.unshift(record);
  }
  
  saveDB(items);
  console.log(`[✓] Equipo procesado: "${record.hostname}" (S/N: ${record.numero_serie}) - Acción: ${existingIndex >= 0 ? 'Actualizado' : 'Nuevo Registro Creado'}`);
  res.json({ message: 'Equipo procesado con éxito', item: record, action: existingIndex >= 0 ? 'actualizado' : 'creado' });
});

// Diagnóstico de estado de la base de datos (MongoDB vs Local)
app.get('/api/db-status', (req, res) => {
  res.json({
    mongoConfigured: !!MONGODB_URI,
    mongoConnected: !!mongoCollection,
    mongoError: mongoError,
    dbType: mongoCollection ? 'MongoDB Atlas (Persistente)' : 'Almacenamiento Local (Efímero)',
    totalEquipos: loadDB().length
  });
});

// Disparar escaneo de este PC desde el botón web de forma 100% silenciosa y automática
app.post(['/api/run-local-scan', '/api/scan-local'], (req, res) => {
  const { cloudReportUrl } = req.body || {};
  const targetServerUrl = cloudReportUrl || getServerUrl(req);

  // Si estamos en Windows (máquina física):
  if (process.platform === 'win32') {
    const scriptPath = path.join(__dirname, 'scripts', 'collector.ps1');
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" "${targetServerUrl}"`;
    
    exec(cmd, { windowsHide: true, timeout: 25000 }, (error, stdout, stderr) => {
      const items = loadDB();
      if (error) {
        console.error('Error ejecutando escaneo local:', error, stderr);
        return res.status(500).json({ error: 'Error ejecutando escaneo', details: stderr || error.message });
      }
      res.json({
        success: true,
        message: 'Escaneo ejecutado automáticamente en segundo plano',
        totalEquipos: items.length,
        items: items
      });
    });
    return;
  }

  // Si estamos en la nube (Render / Linux):
  res.json({
    success: true,
    isCloud: true,
    message: 'Servidor en la Nube activo'
  });
});

// Descargar Copia de Seguridad JSON completa
app.get('/api/backup-json', (req, res) => {
  const items = loadDB();
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="SYS_INVENTORY_BACKUP_${dateStr}.json"`);
  res.send(JSON.stringify(items, null, 2));
});

// Restaurar Copia de Seguridad JSON
app.post('/api/restore-json', (req, res) => {
  try {
    const newItems = req.body;
    if (!Array.isArray(newItems)) {
      return res.status(400).json({ error: 'Formato inválido. Se espera un array de equipos.' });
    }
    
    const current = loadDB();
    const map = new Map();
    
    // Indexar actuales
    current.forEach(item => {
      const key = item.numero_serie && item.numero_serie !== 'N/A' ? item.numero_serie : (item.id || item.hostname);
      map.set(key, item);
    });

    // Fusionar nuevos
    newItems.forEach(item => {
      const key = item.numero_serie && item.numero_serie !== 'N/A' ? item.numero_serie : (item.id || item.hostname);
      map.set(key, { ...map.get(key), ...item });
    });

    const merged = Array.from(map.values());
    saveDB(merged);

    res.json({
      success: true,
      message: `Copia de seguridad restaurada con éxito. Total equipos: ${merged.length}`,
      total: merged.length,
      items: merged
    });
  } catch (err) {
    res.status(500).json({ error: 'Error restaurando respaldo', details: err.message });
  }
});

// Exportación a Excel con hojas separadas por categoría y tipo de hardware
app.get('/api/export-excel', async (req, res) => {
  try {
    const items = loadDB();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SYS-INVENTORY PRO';
    workbook.created = new Date();

    const toUpper = (val) => (val !== undefined && val !== null ? String(val).toUpperCase() : '');

    const getBloqueName = (item) => {
      if (item.bloque) {
        if (/bloque\s*a/i.test(item.bloque)) return 'BLOQUE A';
        if (/bloque\s*b/i.test(item.bloque)) return 'BLOQUE B';
        if (/bloque\s*c/i.test(item.bloque)) return 'BLOQUE C';
      }
      const u = (item.ubicacion || '').trim().toLowerCase();
      if (!u || u === 'cae') return 'BLOQUE A';
      if (/^(soporte|aula|207|304|305|centro de informaci|20[1-6]|30[1-6]|40[1-9]|50[1-9]|60[1-9]|t[oó]pico|lactario|guarder[ií]a|psicopedag[oó]gico|atp|admis|finanzas|defensor|garita)/i.test(u)) return 'BLOQUE A';
      if (/^(auditorio|direcci[oó]n|counter|gth|coordinaci|retenci|ssoma|dtc|sala de reuniones|comedor)/i.test(u)) return 'BLOQUE B';
      if (/^(vida universitaria|promoci|marketing|infraestructura|log[ií]stica|sala gamer)/i.test(u)) return 'BLOQUE C';
      return 'BLOQUE A';
    };

    const styleWorksheet = (ws, columns) => {
      ws.columns = columns;
      const headerRow = ws.getRow(1);
      headerRow.height = 28;
      headerRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF1F4E38' } // Verde esmeralda corporativo
        };
        cell.font = {
          name: 'Segoe UI',
          size: 11,
          bold: true,
          color: { argb: 'FFFFFFFF' }
        };
        cell.alignment = {
          vertical: 'middle',
          horizontal: 'center',
          wrapText: true
        };
        cell.border = {
          top: { style: 'medium', color: { argb: 'FF0D2E1F' } },
          left: { style: 'thin', color: { argb: 'FF336B50' } },
          bottom: { style: 'medium', color: { argb: 'FF0D2E1F' } },
          right: { style: 'thin', color: { argb: 'FF336B50' } }
        };
      });
    };

    const styleDataRows = (ws) => {
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.height = 24;
        const isEven = rowNumber % 2 === 0;
        row.eachCell((cell) => {
          cell.font = {
            name: 'Calibri',
            size: 11,
            color: { argb: 'FF1A1A1A' }
          };
          cell.alignment = { 
            vertical: 'middle', 
            horizontal: 'center',
            wrapText: true 
          };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF7FAF8' }
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD4D4D4' } },
            left: { style: 'thin', color: { argb: 'FFD4D4D4' } },
            bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } },
            right: { style: 'thin', color: { argb: 'FFD4D4D4' } }
          };
        });
      });
    };

    // -------------------------------------------------------------
    // HOJA 1: CASE (PCs de Escritorio, All-in-One, Mini PCs)
    // -------------------------------------------------------------
    const wsCase = workbook.addWorksheet('CASE', { views: [{ showGridLines: true }] });
    styleWorksheet(wsCase, [
      { header: 'HOSTNAME', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'MODELO PC', key: 'modelo', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'PLACA BASE', key: 'placa_base', width: 22 },
      { header: 'PROCESADOR', key: 'procesador', width: 34 },
      { header: 'MEMORIA RAM', key: 'ram', width: 20 },
      { header: 'DISCOS / SSD', key: 'almacenamiento', width: 38 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 20 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 2: LAPTOPS
    // -------------------------------------------------------------
    const wsLaptops = workbook.addWorksheet('LAPTOPS', { views: [{ showGridLines: true }] });
    styleWorksheet(wsLaptops, [
      { header: 'HOSTNAME', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'MODELO LAPTOP', key: 'modelo', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'PROCESADOR', key: 'procesador', width: 34 },
      { header: 'MEMORIA RAM', key: 'ram', width: 20 },
      { header: 'DISCOS / SSD', key: 'almacenamiento', width: 38 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 20 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 3: MONITOR
    // -------------------------------------------------------------
    const wsMonitor = workbook.addWorksheet('MONITOR', { views: [{ showGridLines: true }] });
    styleWorksheet(wsMonitor, [
      { header: 'MONITOR MODELO / MARCA', key: 'monitor', width: 30 },
      { header: 'NÚMERO DE SERIE (S/N)', key: 'serie', width: 24 },
      { header: 'CONECTADO A (HOSTNAME)', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 4: TECLADO
    // -------------------------------------------------------------
    const wsTeclado = workbook.addWorksheet('TECLADO', { views: [{ showGridLines: true }] });
    styleWorksheet(wsTeclado, [
      { header: 'TECLADO / MARCA', key: 'dispositivo', width: 32 },
      { header: 'CONECTADO A (HOSTNAME)', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 5: AUDÍFONOS
    // -------------------------------------------------------------
    const wsAudifonos = workbook.addWorksheet('AUDÍFONOS', { views: [{ showGridLines: true }] });
    styleWorksheet(wsAudifonos, [
      { header: 'DISPOSITIVO DE AUDIO / DIADEMA', key: 'dispositivo', width: 34 },
      { header: 'CONECTADO A (HOSTNAME)', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 6: MOUSE
    // -------------------------------------------------------------
    const wsMouse = workbook.addWorksheet('MOUSE', { views: [{ showGridLines: true }] });
    styleWorksheet(wsMouse, [
      { header: 'MOUSE / MARCA', key: 'dispositivo', width: 32 },
      { header: 'CONECTADO A (HOSTNAME)', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 7: IMPRESORAS
    // -------------------------------------------------------------
    const wsImpresoras = workbook.addWorksheet('IMPRESORAS', { views: [{ showGridLines: true }] });
    styleWorksheet(wsImpresoras, [
      { header: 'EQUIPO / MODELO', key: 'modelo', width: 30 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 20 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 8: INVENTARIO GENERAL
    // -------------------------------------------------------------
    const wsGeneral = workbook.addWorksheet('INVENTARIO GENERAL', { views: [{ showGridLines: true }] });
    styleWorksheet(wsGeneral, [
      { header: 'HOSTNAME', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario_actual', width: 22 },
      { header: 'BLOQUE', key: 'bloque_area', width: 18 },
      { header: 'AULA / AMBIENTE ESPECÍFICO', key: 'ubicacion', width: 28 },
      { header: 'MODELO', key: 'modelo', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'PLACA BASE', key: 'placa_base', width: 20 },
      { header: 'TIPO DE EQUIPO', key: 'tipo_equipo', width: 18 },
      { header: 'PROCESADOR', key: 'procesador', width: 36 },
      { header: 'MEMORIA RAM', key: 'ram_total', width: 20 },
      { header: 'ALMACENAMIENTO (DISCOS / SSD)', key: 'almacenamiento_str', width: 44 },
      { header: 'MONITORES (SERIAL)', key: 'monitores_str', width: 32 },
      { header: 'PERIFÉRICOS CONECTADOS', key: 'perifericos_str', width: 40 },
      { header: 'ESTADO', key: 'estado', width: 15 },
      { header: 'DIRECCIÓN IP', key: 'ip_red', width: 22 },
      { header: 'FECHA REGISTRO', key: 'fecha_escaneo', width: 20 }
    ]);

    // Poblado de Datos en todas las hojas
    items.forEach((item) => {
      const bloque = getBloqueName(item);
      const amb = toUpper(item.ubicacion || 'CAE');
      const host = toUpper(item.hostname || 'PC-EQUIPO');
      const user = toUpper(item.usuario_actual || 'ADMIN');
      const status = toUpper(item.estado || 'OPERATIVO');
      const ip = toUpper(item.ip_red || 'N/A');

      let almacenamientoStr = '';
      if (item.almacenamiento && Array.isArray(item.almacenamiento) && item.almacenamiento.length > 0) {
        almacenamientoStr = item.almacenamiento.map(d => {
          const serialPart = d.serie && d.serie !== 'N/A' ? ` (S/N: ${d.serie})` : '';
          return `${d.modelo || d.tipo || 'Disco'} - ${d.capacidad || ''}${serialPart}`;
        }).join('\n');
      } else {
        almacenamientoStr = item.almacenamiento_resumen || 'Disco Principal';
      }

      const isLaptop = /laptop|port[aá]til|notebook/i.test(item.tipo_equipo || '');
      const isImpresora = /impresora|multifuncional|proyector/i.test(item.tipo_equipo || '');

      // 1. CASE o LAPTOP
      if (isLaptop) {
        wsLaptops.addRow({
          hostname: host,
          usuario: user,
          bloque: bloque,
          ubicacion: amb,
          modelo: toUpper(item.modelo || ''),
          numero_serie: toUpper(item.numero_serie || ''),
          procesador: toUpper(item.procesador || 'N/A'),
          ram: toUpper(item.ram_total || 'N/A'),
          almacenamiento: toUpper(almacenamientoStr),
          ip: ip,
          estado: status
        });
      } else if (isImpresora) {
        wsImpresoras.addRow({
          modelo: toUpper(item.modelo || ''),
          numero_serie: toUpper(item.numero_serie || ''),
          usuario: user,
          bloque: bloque,
          ubicacion: amb,
          ip: ip,
          estado: status
        });
      } else {
        wsCase.addRow({
          hostname: host,
          usuario: user,
          bloque: bloque,
          ubicacion: amb,
          modelo: toUpper(item.modelo || ''),
          numero_serie: toUpper(item.numero_serie || ''),
          placa_base: toUpper(item.placa_base_completa || item.placa_base || 'N/A'),
          procesador: toUpper(item.procesador || 'N/A'),
          ram: toUpper(item.ram_total || 'N/A'),
          almacenamiento: toUpper(almacenamientoStr),
          ip: ip,
          estado: status
        });
      }

      // 2. Monitores a su propia hoja
      (item.monitores || []).forEach(m => {
        wsMonitor.addRow({
          monitor: toUpper(`${m.modelo || m.fabricante || 'Monitor'}`),
          serie: toUpper(m.serie || 'N/A'),
          hostname: host,
          usuario: user,
          bloque: bloque,
          ubicacion: amb,
          estado: status
        });
      });

      // 3. Periféricos clasificados en TECLADO, MOUSE, AUDÍFONOS (Solo hardware propietario/marca)
      const validPerifericos = (item.perifericos || []).filter(isValidPeripheral);

      validPerifericos.forEach(p => {
        const pName = toUpper(p.nombre || p.tipo || '');
        const pType = (p.tipo || '').toLowerCase();
        const pNameLower = pName.toLowerCase();

        if (/teclado|keyboard/i.test(pType) || /teclado|keyboard/i.test(pNameLower)) {
          wsTeclado.addRow({
            dispositivo: pName,
            hostname: host,
            usuario: user,
            bloque: bloque,
            ubicacion: amb,
            estado: status
          });
        } else if (/mouse|rat[oó]n|puntero/i.test(pType) || /mouse|rat[oó]n|puntero/i.test(pNameLower)) {
          wsMouse.addRow({
            dispositivo: pName,
            hostname: host,
            usuario: user,
            bloque: bloque,
            ubicacion: amb,
            estado: status
          });
        } else if (/aud[ií]fono|diadema|headset|auricular|hyperx|jabra|poly|plantronics|kraken|void|quantum|sennheiser|audio-technica/i.test(pNameLower) || /aud[ií]fono|diadema|headset|auricular/i.test(pType)) {
          wsAudifonos.addRow({
            dispositivo: pName,
            hostname: host,
            usuario: user,
            bloque: bloque,
            ubicacion: amb,
            estado: status
          });
        }
      });

      // 4. Inventario General
      const monitoresStr = (item.monitores || []).map(m => `${m.modelo || m.fabricante || ''} (S/N: ${m.serie || 'N/A'})`).join('\n') || 'N/A';
      const perifericosStr = validPerifericos.map(p => `${p.nombre || p.tipo || ''}`).join('\n') || 'ESTÁNDAR';

      wsGeneral.addRow({
        hostname: host,
        usuario_actual: user,
        bloque_area: bloque,
        ubicacion: amb,
        modelo: toUpper(item.modelo || ''),
        numero_serie: toUpper(item.numero_serie || ''),
        placa_base: toUpper(item.placa_base_completa || item.placa_base || 'N/A'),
        tipo_equipo: toUpper(item.tipo_equipo || 'PC'),
        procesador: toUpper(item.procesador || 'N/A'),
        ram_total: toUpper(item.ram_total || 'N/A'),
        almacenamiento_str: toUpper(almacenamientoStr),
        monitores_str: toUpper(monitoresStr),
        perifericos_str: toUpper(perifericosStr),
        estado: status,
        ip_red: ip,
        fecha_escaneo: toUpper(item.fecha_escaneo || '')
      });
    });

    // Aplicar estilos y auto-ajustar anchos a todas las hojas creadas
    [wsCase, wsLaptops, wsMonitor, wsTeclado, wsAudifonos, wsMouse, wsImpresoras, wsGeneral].forEach(ws => {
      styleDataRows(ws);
      if (ws.columns) {
        ws.columns.forEach((column) => {
          let maxLen = 0;
          column.eachCell({ includeEmpty: true }, (cell) => {
            const val = cell.value ? cell.value.toString() : '';
            const lines = val.split(/\r\n|\r|\n/);
            lines.forEach(line => {
              if (line.length > maxLen) {
                maxLen = line.length;
              }
            });
          });
          column.width = Math.min(Math.max(maxLen + 4, 18), 65);
        });
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + `Inventario_Hardware_${new Date().toISOString().substring(0, 10)}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generando archivo Excel:', err);
    res.status(500).json({ error: 'Error exportando a Excel', details: err.message });
  }
});

// Estado del Auto-Escaneo de Red al iniciar
let isAutoScanning = false;
let autoScanStatus = {
  active: false,
  subnet: '',
  startedAt: null,
  completedAt: null,
  message: 'En espera'
};

function autoScanNetworkOnStartup() {
  if (isAutoScanning) return;
  const ips = getLocalIPs();
  const primaryIP = ips[0];
  const parts = primaryIP.split('.');
  if (parts.length !== 4) return;
  const targetSubnet = `${parts[0]}.${parts[1]}.${parts[2]}`;

  isAutoScanning = true;
  autoScanStatus = {
    active: true,
    subnet: `${targetSubnet}.0/24`,
    startedAt: new Date().toISOString(),
    completedAt: null,
    message: `Escaneando automáticamente la red ${targetSubnet}.0/24...`
  };

  console.log(`\n===========================================================`);
  console.log(`🔍 [AUTO-DESCUBRIMIENTO DE RED INICIADO]`);
  console.log(`📡 Red detectada automáticamente: ${targetSubnet}.0/24 (IP: ${primaryIP})`);
  console.log(`🚀 Escaneando todos los equipos de la red en segundo plano...`);
  console.log(`===========================================================\n`);

  const scriptPath = path.join(__dirname, 'scripts', 'scan_network.ps1');
  const serverUrl = `http://${primaryIP}:${PORT}`;
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" "${serverUrl}" "${targetSubnet}"`;

  exec(cmd, { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
    isAutoScanning = false;
    const db = loadDB();
    autoScanStatus.active = false;
    autoScanStatus.completedAt = new Date().toISOString();
    
    if (error) {
      autoScanStatus.message = `Auto-escaneo completado.`;
      console.log(`[!] [AUTO-DESCUBRIMIENTO] Escaneo de red finalizado. Total equipos registrados: ${db.length}`);
    } else {
      autoScanStatus.message = `Auto-escaneo completado con éxito.`;
      console.log(`✅ [AUTO-DESCUBRIMIENTO] Red ${targetSubnet}.0/24 escaneada con éxito. Total equipos en inventario: ${db.length}`);
    }
  });
}

// Endpoint para consultar estado del auto-escaneo
app.get('/api/auto-scan-status', (req, res) => {
  res.json(autoScanStatus);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('===========================================================');
  console.log(`  SISTEMA DE INVENTARIO DE HARDWARE ACTIVO`);
  console.log(`  - Local:             http://localhost:${PORT}`);
  console.log(`  - Red Local / Móvil:   http://${ips[0]}:${PORT}`);
  console.log('===========================================================');
  console.log('  [OK] Servidor listo. Presiona Ctrl+C para detenerlo.\n');

  // Disparar auto-descubrimiento silencioso de la red local al iniciar
  setTimeout(() => {
    autoScanNetworkOnStartup();
  }, 2500);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] ERROR: El puerto ${PORT} ya está siendo utilizado por otra instancia.`);
    console.error(`    Ejecuta nuevamente 'INICIAR_SISTEMA.bat' para reiniciarlo automáticamente.`);
  } else {
    console.error('\n[!] Error en el servidor:', err.message);
  }
});
