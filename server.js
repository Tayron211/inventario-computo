const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
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
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'inventory.json');
const SCANS_DIR = path.join(__dirname, 'scans');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCANS_DIR)) fs.mkdirSync(SCANS_DIR, { recursive: true });

const GENERIC_DRIVER_EXCLUDE_REGEX = /compatible con hid|hid-compliant|dispositivo de |dispositivo del |dispositivo definido|dispositivo port[aá]til|controles de radio|dispositivo de interfaz|usb input device|hid keyboard|hid mouse|touchpad|trackpoint|button driver|wireless button|ideacamera|virtual|composite|dispositivo del sistema|realtek|high definition audio|altavoces|micr[oó]fono|audioendpoint|dispositivo de audio|audio digital|mezcla est|controlador de audio|wave|stereo mix|s\/pdif/i;

const PROPRIETARY_BRANDS_PATTERN = /logitech|hp|dell|lenovo|microsoft|corsair|razer|hyperx|kingston|redragon|genius|asus|rog|tuf|samsung|lg|aoc|viewsonic|jbl|sony|jabra|poly|plantronics|steelseries|trust|targus|kensington|benq|philips|epson|canon|brother|apple|huawei|xiaomi|wacom|a4tech|bloody|cougar|audio-technica|sennheiser|epos|t-force|crucial|western digital|seagate|sandisk|teraware|halion|micronics|antryx|marvo|gamemax|fantech|vsg|evga|msi|gigabyte|zotac|elgato|anker|ugreen|baseus|startech|belkin|kyocera|ricoh|zebra/i;

const EDID_BRAND_MAP = {
  'HPN': 'HP', 'HWP': 'HP', 'HEW': 'HP', 'HP': 'HP',
  'DEL': 'Dell', 'DLL': 'Dell', 'DELL': 'Dell',
  'LEN': 'Lenovo', 'LNK': 'Lenovo', 'LENOVO': 'Lenovo',
  'SAM': 'Samsung', 'SEC': 'Samsung', 'SAMSUNG': 'Samsung',
  'GSM': 'LG', 'LGD': 'LG', 'LGE': 'LG', 'LG': 'LG',
  'AOC': 'AOC',
  'VSC': 'ViewSonic', 'VIEWSONIC': 'ViewSonic',
  'BNQ': 'BenQ', 'BENQ': 'BenQ',
  'PHL': 'Philips', 'PHILIPS': 'Philips',
  'ASU': 'ASUS', 'AUS': 'ASUS', 'ACI': 'ASUS', 'ASUS': 'ASUS',
  'ACR': 'Acer', 'ACER': 'Acer',
  'APP': 'Apple', 'APPLE': 'Apple',
  'MSI': 'MSI', 'GIG': 'Gigabyte', 'SONY': 'Sony',
  'TER': 'Teraware', 'NEC': 'NEC', 'EIZ': 'Eizo'
};

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
  if (item.monitores && Array.isArray(item.monitores)) {
    item.monitores = item.monitores.map(m => {
      const rawManuf = (m.fabricante || '').trim().toUpperCase();
      const brand = EDID_BRAND_MAP[rawManuf] || (m.fabricante || '').trim();
      let model = (m.modelo || 'Monitor').trim();
      if (brand && brand !== 'Estándar' && brand !== 'Monitor Integrado' && !model.toLowerCase().includes(brand.toLowerCase())) {
        model = `${brand} ${model}`;
      }
      return {
        ...m,
        fabricante: brand,
        modelo: model
      };
    });
  }
  if (item.perifericos && Array.isArray(item.perifericos)) {
    item.perifericos = item.perifericos.filter(isValidPeripheral);
  }
  return item;
}

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
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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

// Base de datos Extensa de Especificaciones de Fábrica por Modelo (Hardware, Redes, Impresión, Servidores)
const HARDWARE_MODELS_CATALOG = [
  // ==========================================
  // SWITCHES DE RED & ROUTERS (CISCO, MIKROTIK, TP-LINK, UBIQUITI, ARUBA, HP, D-LINK)
  // ==========================================
  { pattern: /catalyst\s*2960[- ]?x|2960[- ]?x/i, brand: 'Cisco', type: 'Switch de Red', cpu: 'APM86392 600MHz Dual Core', ram: '512 MB DRAM', storage: '128 MB Flash Memory', motherboard: 'Cisco Catalyst 2960-X Mainboard (24/48 Puertos Gigabit PoE+ / SFP+)' },
  { pattern: /catalyst\s*2960|c2960/i, brand: 'Cisco', type: 'Switch de Red', cpu: 'Cisco Integrated MIPS Processor', ram: '128 MB DRAM', storage: '64 MB Flash Memory', motherboard: 'Cisco Catalyst 2960 Managed Switch Board (24/48 Puertos 10/100/1000 + 2 SFP)' },
  { pattern: /catalyst\s*9200|c9200/i, brand: 'Cisco', type: 'Switch de Red', cpu: 'Cisco Quad-Core 1.4GHz CPU', ram: '4 GB DRAM', storage: '4 GB Flash Memory', motherboard: 'Cisco Catalyst 9200 Series Mainboard (Cisco UADP 2.0 Mini ASIC, PoE+)' },
  { pattern: /catalyst\s*3560|catalyst\s*3750|catalyst\s*3850/i, brand: 'Cisco', type: 'Switch de Red', cpu: 'Cisco Multicore Layer 3 Processor', ram: '512 MB DRAM', storage: '128 MB Flash', motherboard: 'Cisco Layer 3 Managed Switch System Board' },
  { pattern: /cisco\s*(sg300|sg350|cbs250|cbs350)/i, brand: 'Cisco', type: 'Switch de Red', cpu: 'Cisco Marvell ARM 800MHz', ram: '512 MB Memory', storage: '256 MB Flash', motherboard: 'Cisco Business Managed Gigabit Switch Board' },
  { pattern: /crs326|crs328|mikrotik\s*crs/i, brand: 'MikroTik', type: 'Switch de Red', cpu: 'Marvell 98DX3236 800MHz (RouterOS / SwOS)', ram: '512 MB RAM', storage: '16 MB Flash Storage', motherboard: 'MikroTik Cloud Router Switch Mainboard (24x Gigabit RJ45 + 2x SFP+ 10G)' },
  { pattern: /rb750|rb750gr3|hex\s*s|hex/i, brand: 'MikroTik', type: 'Access Point Wi-Fi', cpu: 'MediaTek MT7621A 880MHz (2 Cores, 4 Threads)', ram: '256 MB RAM', storage: '16 MB Flash (RouterOS Level 4)', motherboard: 'MikroTik RouterBOARD hEX System Board (5 Puertos Gigabit Ethernet)' },
  { pattern: /rb3011|rb4011|rb5009/i, brand: 'MikroTik', type: 'Access Point Wi-Fi', cpu: 'ARM Cortex 1.4GHz Quad-Core (IPQ-8074/AL21400)', ram: '1 GB / 2 GB DDR4', storage: '512 MB NAND Flash', motherboard: 'MikroTik RouterBOARD Enterprise Mainboard (10x Gigabit RJ45 + SFP+ 10G)' },
  { pattern: /tl-sg1016|tl-sg1024|sg1016|sg1024/i, brand: 'TP-Link', type: 'Switch de Red', cpu: 'Realtek Gigabit Switch ASIC', ram: 'Buffer de Paquetes 4.1 Mbits', storage: 'EEPROM Firmware', motherboard: 'TP-Link 16/24-Port Gigabit Rackmount Switch System Board' },
  { pattern: /tl-sg2428p|tl-sg3428|jetstream/i, brand: 'TP-Link', type: 'Switch de Red', cpu: 'TP-Link Enterprise ARM CPU (Omada SDN)', ram: '256 MB RAM', storage: '32 MB Flash Memory', motherboard: 'TP-Link JetStream L2+ Managed Switch Board (24 Puertos Gigabit PoE+ / 4 SFP)' },
  { pattern: /tl-sg108|tl-sg105|sg108|sg105/i, brand: 'TP-Link', type: 'Switch de Red', cpu: 'Realtek Gigabit Switching Controller', ram: 'Buffer 1.5 Mbits', storage: 'Firmware ROM', motherboard: 'TP-Link 5/8-Port Gigabit Desktop Switch Board' },
  { pattern: /unifi\s*switch|usw-24|usw-48|usw-pro/i, brand: 'Ubiquiti', type: 'Switch de Red', cpu: 'Ubiquiti ARM Cortex Processor', ram: '512 MB DDR3', storage: '256 MB Flash', motherboard: 'Ubiquiti UniFi Managed Layer 2/3 Switch Board (PoE+ / SFP+)' },
  { pattern: /udm[- ]?pro|dream\s*machine/i, brand: 'Ubiquiti', type: 'Access Point Wi-Fi', cpu: 'Quad-Core ARM Cortex-A57 @ 1.7GHz', ram: '4 GB DDR4', storage: '16 GB eMMC + Bahía HDD 3.5" (UniFi Protect)', motherboard: 'Ubiquiti UniFi Dream Machine Pro Gateway Board' },
  { pattern: /dgs-1100|dgs-1210|des-1210/i, brand: 'D-Link', type: 'Switch de Red', cpu: 'D-Link Smart Managed ASIC', ram: '128 MB RAM', storage: '16 MB Flash', motherboard: 'D-Link Smart Managed Gigabit Switch System Board' },
  { pattern: /aruba\s*2930|aruba\s*instant\s*on\s*1930|procurve\s*2530/i, brand: 'HP / Aruba', type: 'Switch de Red', cpu: 'ARM Cortex-A9 @ 1016MHz / ProCurve Dual Core', ram: '1 GB SDRAM', storage: '512 MB eMMC Flash', motherboard: 'Aruba / HPE Managed Enterprise Switch System Board (PoE+ / SFP+)' },

  // ==========================================
  // ACCESS POINTS & WI-FI (UBIQUITI, TP-LINK, CISCO, ARUBA)
  // ==========================================
  { pattern: /u6-pro|u6-lite|u6-mesh|uap-ac-pro|uap-ac-lr/i, brand: 'Ubiquiti', type: 'Access Point Wi-Fi', cpu: 'Qualcomm Dual-Core Wi-Fi 6 SoC', ram: '512 MB RAM', storage: '64 MB Flash', motherboard: 'Ubiquiti UniFi High-Performance Access Point Board (Dual-Band MIMO / PoE)' },
  { pattern: /eap245|eap610|eap650|eap670|omada/i, brand: 'TP-Link', type: 'Access Point Wi-Fi', cpu: 'Qualcomm Atheros 750MHz Dual-Band SoC', ram: '256 MB DDR3', storage: '32 MB Flash', motherboard: 'TP-Link Omada Ceiling Mount Access Point Board (Wi-Fi 6 AX / PoE)' },
  { pattern: /ap-505|ap-515|ap22|ap11/i, brand: 'Aruba', type: 'Access Point Wi-Fi', cpu: 'Qualcomm Tri-Core Wi-Fi 6 Network SoC', ram: '512 MB RAM', storage: '256 MB Flash', motherboard: 'Aruba Instant On Wi-Fi 6 Enterprise Access Point Board (MU-MIMO PoE)' },

  // ==========================================
  // PROYECTORES (EPSON, BENQ, VIEWSONIC, SONY, OPTOMA, INFOCUS, PANASONIC)
  // ==========================================
  { pattern: /brightlink\s*(735|725|1485)|eb-735|eb-725/i, brand: 'Epson', type: 'Proyector', cpu: 'Epson 3LCD Interactive Laser Display Engine', ram: '4 GB Interactive Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson BrightLink Interactive Ultra-Short Throw Board (HDMI/Touch/Pen)' },
  { pattern: /powerlite\s*(l200|l210|l520|l630|l730)|eb-l200/i, brand: 'Epson', type: 'Proyector', cpu: 'Epson 3LCD Solid-State Laser Optical Engine (4500-7000 Lúmenes)', ram: 'High-Speed Video Processing Buffer', storage: 'Firmware Flash ROM', motherboard: 'Epson Laser Display Controller Board (Dual HDMI/HDBaseT/RJ45)' },
  { pattern: /powerlite\s*(x41|e20|fh52|w49|w39|x39|2250|992|ex9240)|eb-(s41|x41|2250|992)/i, brand: 'Epson', type: 'Proyector', cpu: 'Epson 3LCD 3-Chip Optical Image Processing Engine (3300-5000 Lúmenes)', ram: 'Video Processing Buffer', storage: 'Firmware Flash ROM', motherboard: 'Epson 3LCD Optical Engine Mainboard (HDMI / VGA / USB Display)' },
  { pattern: /home\s*cinema\s*(2250|3800|4010)|epson\s*home/i, brand: 'Epson', type: 'Proyector', cpu: 'Epson PRO-UHD 4K Enhancement Processing Engine', ram: '4K Frame Buffer', storage: 'Flash ROM', motherboard: 'Epson Home Cinema Main Controller Board' },
  { pattern: /benq\s*(mw560|mx560|ms560|mx550|mw535|mh733|ew600|eh600)/i, brand: 'BenQ', type: 'Proyector', cpu: 'Texas Instruments DLP High-Brightness Engine (4000 Lúmenes ANSI)', ram: 'DLP Video Buffer', storage: 'Firmware Flash', motherboard: 'BenQ DLP High-Brightness Mainboard (Dual HDMI / VGA)' },
  { pattern: /benq\s*(tk700|th585|th685|lh720|lu930)/i, brand: 'BenQ', type: 'Proyector', cpu: 'Texas Instruments 4K HDR DLP Image Processor / BlueCore Laser', ram: 'High-Speed DLP Buffer', storage: 'Firmware Flash', motherboard: 'BenQ Cinematic Color & Laser Mainboard' },
  { pattern: /viewsonic\s*(pa503w|pa503s|pa503x|pg707|pg706)/i, brand: 'ViewSonic', type: 'Proyector', cpu: 'SuperColor DLP Processing Engine (3800-4000 Lúmenes ANSI)', ram: 'DLP Frame Buffer', storage: 'Firmware Flash', motherboard: 'ViewSonic DLP System Controller Board (HDMI/VGA)' },
  { pattern: /viewsonic\s*(px701|px748|ls740|ls830|ls500|m1|m2)/i, brand: 'ViewSonic', type: 'Proyector', cpu: 'ViewSonic 4K UHD / 3rd Gen Laser Phosphor Engine (4500 Lúmenes)', ram: 'High-Res Video Buffer', storage: 'Firmware Flash', motherboard: 'ViewSonic Laser 4K Phosphor Mainboard' },
  { pattern: /optoma\s*(hd146|uhd38|uhd35|gt1080|zh406|x343|w335|eh412)/i, brand: 'Optoma', type: 'Proyector', cpu: 'Optoma DuraCore Laser / DLP Image Engine (4000-4500 Lúmenes)', ram: 'DLP Video Processing RAM', storage: 'Firmware Flash ROM', motherboard: 'Optoma DLP High-Speed Controller Board' },
  { pattern: /sony\s*(vpl[- ]?cwz10|vpl[- ]?phz10|vpl[- ]?fhz|vpl[- ]?ex|vpl[- ]?dx)/i, brand: 'Sony', type: 'Proyector', cpu: 'Sony BrightEra 3LCD Laser Optical Engine (5000 Lúmenes Z-Phosphor)', ram: 'Sony Reality Creation Video Buffer', storage: 'Flash ROM', motherboard: 'Sony VPL Laser Display Controller Mainboard' },
  { pattern: /panasonic\s*(pt[- ]?vmz|pt[- ]?frq|pt[- ]?mz)|infocus\s*(in114|in116|in118)/i, brand: 'Panasonic / InFocus', type: 'Proyector', cpu: 'Solid Shine Laser / BrilliantColor DLP Engine (4000-6000 Lúmenes)', ram: 'High-Definition Frame Buffer', storage: 'Firmware Flash', motherboard: 'Enterprise High-Brightness Projector Mainboard' },

  // ==========================================
  // SERVIDORES (DELL POWEREDGE, HP PROLIANT, LENOVO THINKSYSTEM, SYNOLOGY NAS)
  // ==========================================
  { pattern: /poweredge\s*r740/i, brand: 'Dell', type: 'Servidor', cpu: '2x Intel Xeon Silver 4210R @ 2.40GHz (20 Núcleos, 40 Hilos)', ram: '64 GB DDR4 ECC Registered', storage: '4x 1.2 TB SAS 10K RPM (PERC H730P RAID)', motherboard: 'Dell PowerEdge R740 Server Motherboard (iDRAC9 Enterprise)' },
  { pattern: /poweredge\s*r730/i, brand: 'Dell', type: 'Servidor', cpu: '2x Intel Xeon E5-2630 v4 @ 2.20GHz (20 Núcleos, 40 Hilos)', ram: '32 GB DDR4 ECC Registered', storage: '2x 600 GB SAS + 2x 2 TB SATA (PERC H730 RAID)', motherboard: 'Dell PowerEdge R730 Server Motherboard (iDRAC8 Enterprise)' },
  { pattern: /poweredge\s*(r640|r440|t440|t340|t140)/i, brand: 'Dell', type: 'Servidor', cpu: 'Intel Xeon Silver 4208 / Xeon E-2224 @ 3.40GHz (4/8 Núcleos)', ram: '32 GB DDR4 ECC', storage: '2x 480 GB SSD Enterprise + 2x 2 TB HDD (PERC RAID)', motherboard: 'Dell PowerEdge System Board (iDRAC9)' },
  { pattern: /proliant\s*dl380\s*gen10|dl380\s*gen10/i, brand: 'HP', type: 'Servidor', cpu: '2x Intel Xeon Silver 4210R @ 2.40GHz (20 Núcleos, 40 Hilos)', ram: '64 GB DDR4-2933 ECC SmartMemory', storage: '4x 1.2 TB SAS 12G (HPE Smart Array P408i-a RAID)', motherboard: 'HPE ProLiant DL380 Gen10 Server Board (iLO 5 Advanced)' },
  { pattern: /proliant\s*dl360|proliant\s*ml350|proliant\s*ml110/i, brand: 'HP', type: 'Servidor', cpu: 'Intel Xeon Bronze / Silver Scalable Processor (8/16 Núcleos)', ram: '32 GB DDR4 ECC SmartMemory', storage: '2x 480 GB SSD SATA + 2x 1 TB SAS (HPE Smart Array)', motherboard: 'HPE ProLiant Server Board (iLO 5)' },
  { pattern: /thinksystem\s*(sr650|sr530|st550)/i, brand: 'Lenovo', type: 'Servidor', cpu: 'Intel Xeon Silver 4214 @ 2.20GHz (12 Núcleos, 24 Hilos)', ram: '32 GB DDR4-2933 ECC', storage: '2x 480 GB SSD NVMe + RAID 930-8i', motherboard: 'Lenovo ThinkSystem Server Motherboard (XClarity Controller)' },
  { pattern: /synology\s*(ds920\+|ds220\+|ds423\+|rs1221\+)|qnap\s*ts/i, brand: 'Synology', type: 'Servidor', cpu: 'Intel Celeron J4125 Quad-Core @ 2.00GHz / AMD Ryzen V1500B', ram: '4 GB / 8 GB DDR4', storage: '4x Bahías SATA 3.5" (Synology Hybrid RAID / Btrfs)', motherboard: 'Synology DiskStation NAS Motherboard (DSM 7 OS)' },

  // ==========================================
  // IMPRESORAS & MULTIFUNCIONALES
  // ==========================================
  { pattern: /ecotank\s*l3250|ecotank\s*l3210/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Microcontrolador RISC Epson ESC/P-R', ram: '128 MB Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson EcoTank L3200 Series Controller Board', consumible: 'Tinta Epson T544' },
  { pattern: /ecotank\s*l3150|ecotank\s*l3110/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Microcontrolador RISC Epson ESC/P-R', ram: '128 MB Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson EcoTank L3100 Series Controller Board', consumible: 'Tinta Epson T544' },
  { pattern: /ecotank\s*l4260|ecotank\s*l4160|ecotank\s*l4150/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson ESC/P-R Dual Engine (Duplex Automático)', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson EcoTank L4000 Series Controller Board', consumible: 'Tinta Epson T504' },
  { pattern: /ecotank\s*l6270|ecotank\s*l6171/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'PrecisionCore Print Head Controller (ADF)', ram: '256 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson EcoTank L6000 Series Controller Board', consumible: 'Tinta Epson T504' },
  { pattern: /ecotank\s*l14150/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson PrecisionCore A3+ Multi-Engine', ram: '512 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson Wide-Format Controller Board', consumible: 'Tinta Epson T504' },
  { pattern: /ecotank\s*l805|ecotank\s*l1800/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson 6-Color Photographic Micro Piezo Engine', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson Photo Controller Board', consumible: 'Tinta Epson T673' },

  { pattern: /laserjet\s*pro\s*m404|laserjet\s*pro\s*m402/i, brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP Custom 1200MHz High-Speed Processor', ram: '256 MB DDR3', storage: '512 MB NAND Flash', motherboard: 'HP LaserJet Pro M400 Series Formatter Board', consumible: 'Tóner HP 58A' },
  { pattern: /laserjet\s*pro\s*mfp\s*m428|laserjet\s*m428/i, brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP Dual Core 1200MHz Formatter Engine', ram: '512 MB DDR3', storage: '512 MB Flash (HP Sure Start)', motherboard: 'HP MFP Formatter Board', consumible: 'Tóner HP 58A' },
  { pattern: /laserjet\s*p1102|laserjet\s*m1132|laserjet\s*m1212/i, brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP RISC 266MHz Processor', ram: '8 MB / 64 MB Buffer', storage: 'Flash ROM', motherboard: 'HP LaserJet P1100 Series Formatter Board', consumible: 'Tóner HP 85A' },
  { pattern: /laserjet\s*107|laserjet\s*mfp\s*135|laserjet\s*mfp\s*137/i, brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP ARM 600MHz Processor', ram: '128 MB Memory', storage: '128 MB Flash', motherboard: 'HP Laser 100 Series Formatter Board', consumible: 'Tóner HP 105A' },
  { pattern: /smart\s*tank\s*515|smart\s*tank\s*530|smart\s*tank\s*580|smart\s*tank\s*720/i, brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP 980MHz Sensor RISC SoC (Wi-Fi BLE)', ram: '256 MB Buffer', storage: 'Memoria Flash', motherboard: 'HP Smart Tank Main Controller Board', consumible: 'Tinta HP GT53 / GT52' },

  { pattern: /pixma\s*g2110|pixma\s*g3110|pixma\s*g3160|pixma\s*g4110/i, brand: 'Canon', type: 'Impresora / Multifuncional', cpu: 'Canon FINE Print Engine Controller', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Canon PIXMA MegaTank Mainboard', consumible: 'Tinta Canon GI-190' },
  { pattern: /imageclass\s*mf3010|lbp6030/i, brand: 'Canon', type: 'Impresora / Multifuncional', cpu: 'Canon On-Demand SURF Laser Processor', ram: '64 MB Buffer', storage: 'Memoria Flash', motherboard: 'Canon imageCLASS Laser Formatter Board', consumible: 'Tóner Canon 125' },

  { pattern: /dcp[- ]?t510w|dcp[- ]?t520w|dcp[- ]?t710w|dcp[- ]?t720dw/i, brand: 'Brother', type: 'Impresora / Multifuncional', cpu: 'Brother High-Speed Piezo Controller', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Brother InkBenefit Tank Mainboard', consumible: 'Tinta Brother BTD60BK / BT5001' },
  { pattern: /hl[- ]?1212w|dcp[- ]?1617nw|hl[- ]?1112/i, brand: 'Brother', type: 'Impresora / Multifuncional', cpu: 'Brother 200MHz Laser Controller', ram: '32 MB Buffer', storage: 'Flash ROM', motherboard: 'Brother Laser Engine Board', consumible: 'Tóner Brother TN-1060' },
  { pattern: /hl[- ]?l2360dw|dcp[- ]?l2540dw|mfc[- ]?l2700dw/i, brand: 'Brother', type: 'Impresora / Multifuncional', cpu: 'Brother ARM9 266MHz Processor (Duplex)', ram: '64 MB RAM', storage: 'Flash Memory', motherboard: 'Brother High-Yield Laser Formatter Board', consumible: 'Tóner Brother TN-2370' },
  { pattern: /ecosys\s*m2040dn|ecosys\s*m2135dn|ecosys\s*p2040dw/i, brand: 'Kyocera', type: 'Impresora / Multifuncional', cpu: 'Kyocera Cortex-A9 800MHz Multi-Task Processor', ram: '512 MB RAM (expandible a 1.5GB)', storage: 'Memoria Flash', motherboard: 'Kyocera ECOSYS Long-Life Formatter Board', consumible: 'Tóner Kyocera TK-1175' },

  // ==========================================
  // DELL OPTIPLEX (DESKTOPS)
  // ==========================================
  { pattern: /optiplex\s*7090/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i7-11700 @ 2.50GHz (8 Núcleos, 16 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2 PCIe', motherboard: 'Dell OptiPlex 7090 (Intel Q570)' },
  { pattern: /optiplex\s*7080/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i7-10700 @ 2.90GHz (8 Núcleos, 16 Hilos)', ram: '16 GB DDR4 (2933MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Dell OptiPlex 7080 (Intel Q470)' },
  { pattern: /optiplex\s*7070/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i7-9700 @ 3.00GHz (8 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (2666MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Dell OptiPlex 7070 (Intel Q370)' },
  { pattern: /optiplex\s*7060/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i7-8700 @ 3.20GHz (6 Núcleos, 12 Hilos)', ram: '16 GB DDR4', storage: '256 GB SSD NVMe + 1 TB HDD', motherboard: 'Dell OptiPlex 7060 (Intel Q370)' },
  { pattern: /optiplex\s*7050/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i7-7700 @ 3.60GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4', storage: '256 GB SSD + 1 TB HDD SATA', motherboard: 'Dell OptiPlex 7050 (Intel Q270)' },
  { pattern: /optiplex\s*3080/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i5-10500 @ 3.10GHz (6 Núcleos, 12 Hilos)', ram: '8 GB DDR4 (2666MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell OptiPlex 3080 (Intel B460)' },
  { pattern: /optiplex\s*3070/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i5-9500 @ 3.00GHz (6 Núcleos, 6 Hilos)', ram: '8 GB DDR4', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell OptiPlex 3070 (Intel B365)' },
  { pattern: /optiplex\s*3060/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i5-8500 @ 3.00GHz (6 Núcleos, 6 Hilos)', ram: '8 GB DDR4', storage: '1 TB HDD SATA (7200 RPM)', motherboard: 'Dell OptiPlex 3060 (Intel H370)' },
  { pattern: /optiplex\s*3050/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i5-7500 @ 3.40GHz (4 Núcleos, 4 Hilos)', ram: '8 GB DDR4', storage: '500 GB HDD / 256 GB SSD', motherboard: 'Dell OptiPlex 3050 (Intel B250)' },
  { pattern: /optiplex\s*3020/i, brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i5-4590 @ 3.30GHz (4 Núcleos)', ram: '8 GB DDR3', storage: '500 GB HDD SATA', motherboard: 'Dell OptiPlex 3020 (Intel H81)' },

  // ==========================================
  // DELL LATITUDE & INSPIRON (LAPTOPS)
  // ==========================================
  { pattern: /latitude\s*5430/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1235U @ 1.30GHz (10 Núcleos, 12 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Dell Latitude 5430 System Board' },
  { pattern: /latitude\s*5420/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell Latitude 5420 System Board' },
  { pattern: /latitude\s*5410/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-10210U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell Latitude 5410 System Board' },
  { pattern: /latitude\s*5400/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-8265U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4', storage: '256 GB SSD M.2', motherboard: 'Dell Latitude 5400 System Board' },
  { pattern: /latitude\s*3420/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell Latitude 3420 System Board' },
  { pattern: /latitude\s*3410/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-10210U @ 1.60GHz (4 Núcleos)', ram: '8 GB DDR4', storage: '1 TB HDD / 256 GB SSD', motherboard: 'Dell Latitude 3410 System Board' },
  { pattern: /latitude\s*7420/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i7-1185G7 @ 3.00GHz (4 Núcleos, 8 Hilos)', ram: '16 GB LPDDR4x', storage: '512 GB SSD NVMe M.2', motherboard: 'Dell Latitude 7420 System Board' },
  { pattern: /inspiron\s*15|inspiron\s*3501|inspiron\s*3511/i, brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 / AMD Ryzen 5 5500U', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell Inspiron Mainboard' },

  // ==========================================
  // HP PROBOOK & ELITEBOOK & GAMING (VICTUS / OMEN)
  // ==========================================
  { pattern: /victus.*15[- ]?fb|victus.*15|victus.*16|hp\s*victus/i, brand: 'HP', type: 'Laptop', cpu: 'AMD Ryzen 5 8645HS @ 4.30GHz (6 Núcleos, 12 Hilos) / NVIDIA GeForce RTX 3050 (6GB)', ram: '16 GB DDR5 (5600MHz)', storage: '512 GB SSD NVMe M.2 PCIe Gen4', motherboard: 'HP 8B9D (AMD Promontory/Bixby Chipset)' },
  { pattern: /omen\s*15|omen\s*16|omen\s*17|hp\s*omen/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i7-13700HX / AMD Ryzen 7 7840HS (NVIDIA GeForce RTX 4060/4070)', ram: '16 GB DDR5 (5600MHz)', storage: '1 TB SSD NVMe M.2 PCIe Gen4', motherboard: 'HP OMEN Gaming Motherboard' },
  { pattern: /probook\s*450\s*g9/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-1235U @ 1.30GHz (10 Núcleos, 12 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2 PCIe', motherboard: 'HP 8A19' },
  { pattern: /probook\s*450\s*g8/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2 PCIe', motherboard: 'HP 880D' },
  { pattern: /probook\s*450\s*g7/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-10210U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (2666MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'HP 86A2' },
  { pattern: /probook\s*450\s*g6/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-8265U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (2400MHz)', storage: '1 TB HDD + 128 GB SSD', motherboard: 'HP 8532' },
  { pattern: /probook\s*450\s*g5/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-8250U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4', storage: '1 TB HDD SATA', motherboard: 'HP 83B2' },
  { pattern: /probook\s*440\s*g8/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos)', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe', motherboard: 'HP 880C' },
  { pattern: /probook\s*440\s*g7/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-10210U @ 1.60GHz (4 Núcleos)', ram: '8 GB DDR4', storage: '256 GB SSD NVMe', motherboard: 'HP 86A0' },
  { pattern: /elitebook\s*840\s*g8/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i7-1165G7 @ 2.80GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'HP 8809' },
  { pattern: /elitebook\s*840\s*g7/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i7-10510U @ 1.80GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4', storage: '512 GB SSD NVMe M.2', motherboard: 'HP 8723' },
  { pattern: /hp\s*240\s*g8|hp\s*245\s*g8/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i3-1115G4 @ 3.00GHz / AMD Ryzen 3 5300U', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'HP 881D' },
  { pattern: /hp\s*240\s*g7|hp\s*245\s*g7/i, brand: 'HP', type: 'Laptop', cpu: 'Intel Core i3-7020U @ 2.30GHz (2 Núcleos, 4 Hilos)', ram: '4 GB DDR4 (2133MHz)', storage: '1 TB HDD SATA (5400 RPM)', motherboard: 'HP 8538' },
  { pattern: /prodesk\s*400\s*g7/i, brand: 'HP', type: 'PC de Escritorio', cpu: 'Intel Core i5-10500 @ 3.10GHz (6 Núcleos, 12 Hilos)', ram: '8 GB DDR4 (2933MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'HP 8718 (Intel Q470)' },
  { pattern: /prodesk\s*400\s*g6/i, brand: 'HP', type: 'PC de Escritorio', cpu: 'Intel Core i5-9500 @ 3.00GHz (6 Núcleos, 6 Hilos)', ram: '8 GB DDR4 (2666MHz)', storage: '1 TB HDD SATA / 256GB SSD', motherboard: 'HP 859B (Intel B360)' },
  { pattern: /elitedesk\s*800\s*g6/i, brand: 'HP', type: 'PC de Escritorio', cpu: 'Intel Core i7-10700 @ 2.90GHz (8 Núcleos, 16 Hilos)', ram: '16 GB DDR4 (2933MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'HP 870C (Intel Q470)' },

  // ==========================================
  // LENOVO THINKPAD, THINKCENTRE & IDEAPAD
  // ==========================================
  { pattern: /thinkpad\s*t14\s*gen\s*3/i, brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-1240P @ 1.70GHz (12 Núcleos, 16 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2 PCIe Gen4', motherboard: 'Lenovo ThinkPad T14 Gen 3' },
  { pattern: /thinkpad\s*t14\s*gen\s*2/i, brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkPad T14 Gen 2 (20W0)' },
  { pattern: /thinkpad\s*t14\s*gen\s*1|thinkpad\s*t14/i, brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-10210U @ 1.60GHz / AMD Ryzen 5 PRO 4650U', ram: '16 GB DDR4 (2666MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkPad T14 Gen 1 (20S0)' },
  { pattern: /thinkpad\s*t490/i, brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-8265U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (2400MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkPad T490 (20N2)' },
  { pattern: /thinkpad\s*t480/i, brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-8250U @ 1.60GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (2400MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkPad T480 (20L5)' },
  { pattern: /thinkcentre\s*m70q/i, brand: 'Lenovo', type: 'Mini PC', cpu: 'Intel Core i5-10400T @ 2.00GHz (6 Núcleos, 12 Hilos)', ram: '8 GB DDR4 (2666MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkCentre M70q' },
  { pattern: /ideapad\s*3/i, brand: 'Lenovo', type: 'Laptop', cpu: 'AMD Ryzen 5 5500U @ 2.10GHz / Intel Core i5-1135G7', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Lenovo IdeaPad 3 System Board' },

  // ==========================================
  // ASUS, ACER, APPLE
  // ==========================================
  { pattern: /tuf\s*gaming\s*f15/i, brand: 'ASUS', type: 'Laptop', cpu: 'Intel Core i5-11400H @ 2.70GHz (6 Núcleos, 12 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2 PCIe', motherboard: 'ASUS TUF GAMING F15 FX506' },
  { pattern: /nitro\s*5/i, brand: 'Acer', type: 'Laptop', cpu: 'Intel Core i5-10300H @ 2.50GHz / AMD Ryzen 5 4600H', ram: '16 GB DDR4 (2933MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Acer Nitro AN515' },
  { pattern: /macbook\s*air\s*m2/i, brand: 'Apple', type: 'Laptop', cpu: 'Apple M2 (8-Core CPU, 8-Core/10-Core GPU)', ram: '8 GB Memoria Unificada', storage: '256 GB SSD PCIe', motherboard: 'Apple M2 Logic Board' },
  { pattern: /macbook\s*air\s*m1/i, brand: 'Apple', type: 'Laptop', cpu: 'Apple M1 (8-Core CPU, 7-Core/8-Core GPU)', ram: '8 GB Memoria Unificada', storage: '256 GB SSD PCIe', motherboard: 'Apple M1 Logic Board' }
];

// Consulta Asíncrona a Internet (Wikipedia / DuckDuckGo API)
function fetchOnlineKnowledge(query) {
  return new Promise((resolve) => {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
    const client = https.get(url, { headers: { 'User-Agent': 'SysInventoryBot/1.0' }, timeout: 2500 }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.query && parsed.query.search && parsed.query.search.length > 0) {
            const snippet = parsed.query.search[0].snippet.replace(/<[^>]+>/g, ' ');
            resolve(snippet);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    client.on('error', () => resolve(null));
    client.on('timeout', () => {
      client.destroy();
      resolve(null);
    });
  });
}

// Función Asíncrona de Búsqueda Inteligente de Especificaciones de Hardware (Catalog + Internet)
async function lookupHardwareSpecsOnline(modelText) {
  if (!modelText || typeof modelText !== 'string') return { found: false };
  const clean = modelText.trim();
  if (clean.length < 2) return { found: false };

  // 1. Buscar en catálogo exacto de modelos
  for (const item of HARDWARE_MODELS_CATALOG) {
    if (item.pattern.test(clean)) {
      return {
        success: true,
        found: true,
        source: 'Catálogo de Fábrica OEM',
        fabricante: item.brand,
        tipo_equipo: item.type,
        procesador: item.cpu,
        ram_total: item.ram,
        almacenamiento: item.storage,
        placa_base: item.motherboard,
        consumible: item.consumible || ''
      };
    }
  }

  // 2. Comprobar si es Impresora
  const printerConsumable = autoDetectPrinterConsumables(clean);
  if (printerConsumable) {
    return {
      success: true,
      found: true,
      source: 'Base de Datos de Impresoras',
      fabricante: printerConsumable.brand,
      tipo_equipo: 'Impresora / Multifuncional',
      procesador: 'Microcontrolador SoC Integrado',
      ram_total: '128 MB Memoria de Buffer',
      almacenamiento: 'Memoria Flash Firmware',
      placa_base: `${printerConsumable.brand} Controller Board`,
      consumible: printerConsumable.consumable
    };
  }

  // 3. Consulta de Internet en tiempo real (Wikipedia / Web Knowledge)
  const onlineSnippet = await fetchOnlineKnowledge(clean);

  // 4. Inferencia Heurística basada en marcas, tipo de dispositivo y snippets de Internet
  const combinedText = (clean + ' ' + (onlineSnippet || '')).toLowerCase();
  
  let brand = 'Genérico';
  if (/cisco/i.test(combinedText)) brand = 'Cisco';
  else if (/mikrotik/i.test(combinedText)) brand = 'MikroTik';
  else if (/tp[- ]?link|omada|jetstream/i.test(combinedText)) brand = 'TP-Link';
  else if (/ubiquiti|unifi/i.test(combinedText)) brand = 'Ubiquiti';
  else if (/dell|poweredge|optiplex|latitude/i.test(combinedText)) brand = 'Dell';
  else if (/hp|proliant|prodesk|elitedesk|probook|elitebook|laserjet/i.test(combinedText)) brand = 'HP';
  else if (/lenovo|thinkpad|thinkcentre|thinksystem/i.test(combinedText)) brand = 'Lenovo';
  else if (/asus|rog|tuf/i.test(combinedText)) brand = 'ASUS';
  else if (/acer|nitro|predator/i.test(combinedText)) brand = 'Acer';
  else if (/apple|macbook|imac/i.test(combinedText)) brand = 'Apple';
  else if (/epson|powerlite|ecotank/i.test(combinedText)) brand = 'Epson';
  else if (/canon|pixma|imageclass/i.test(combinedText)) brand = 'Canon';
  else if (/brother/i.test(combinedText)) brand = 'Brother';
  else if (/kyocera|ecosys/i.test(combinedText)) brand = 'Kyocera';
  else if (/benq/i.test(combinedText)) brand = 'BenQ';
  else if (/viewsonic/i.test(combinedText)) brand = 'ViewSonic';
  else if (/d[- ]?link/i.test(combinedText)) brand = 'D-Link';
  else if (/aruba/i.test(combinedText)) brand = 'Aruba';
  else if (/synology/i.test(combinedText)) brand = 'Synology';

  let type = 'Laptop';
  if (/switch|catalyst|managed|rackmount|ports|puertos\s*gigabit/i.test(combinedText)) type = 'Switch de Red';
  else if (/access\s*point|ap|router|wi[- ]?fi|mesh|routerboard/i.test(combinedText)) type = 'Access Point Wi-Fi';
  else if (/proyector|projector|3lcd|dlp|lumen/i.test(combinedText)) type = 'Proyector';
  else if (/server|servidor|poweredge|proliant|thinksystem|xeon|nas|rack\s*server/i.test(combinedText)) type = 'Servidor';
  else if (/impresora|printer|ecotank|smart\s*tank|laserjet|pixma|inkbenefit|toner|tinta/i.test(combinedText)) type = 'Impresora / Multifuncional';
  else if (/optiplex|prodesk|elitedesk|thinkcentre|torre|desktop|pc\s*de\s*escritorio/i.test(combinedText)) type = 'PC de Escritorio';
  else if (/all-in-one|aio|imac|pavilion\s*24/i.test(combinedText)) type = 'All-in-One';
  else if (/mini\s*pc|nuc|tiny/i.test(combinedText)) type = 'Mini PC';

  // Configuración de especificaciones adaptadas por categoría
  let cpu = '';
  let ram = '';
  let storage = '';
  let motherboard = '';
  let consumible = '';

  if (type === 'Switch de Red') {
    cpu = `${brand} Managed Gigabit Switch ASIC Engine`;
    ram = '256 MB / 512 MB DRAM';
    storage = '64 MB / 128 MB Flash Memory';
    motherboard = `${brand} Managed Enterprise Switch System Board`;
  } else if (type === 'Access Point Wi-Fi') {
    cpu = `${brand} Dual-Band Wi-Fi 6 SoC Controller`;
    ram = '256 MB / 512 MB RAM';
    storage = '64 MB Flash';
    motherboard = `${brand} High-Speed Wireless Access Board (PoE)`;
  } else if (type === 'Proyector') {
    cpu = `${brand} Optical Image Processing Engine`;
    ram = 'Buffer de Procesamiento de Video';
    storage = 'Memoria Flash Firmware';
    motherboard = `${brand} Projector Controller Mainboard (HDMI / VGA)`;
  } else if (type === 'Servidor') {
    cpu = 'Intel Xeon Silver / AMD EPYC (Multi-Core)';
    ram = '32 GB / 64 GB DDR4 ECC Registered';
    storage = '4x Bahías Hot-Plug SAS / SSD (Hardware RAID)';
    motherboard = `${brand} Enterprise Server Board (Remote Management BMC)`;
  } else if (type === 'Impresora / Multifuncional') {
    cpu = 'Microcontrolador SoC Impresora';
    ram = '128 MB Buffer';
    storage = 'Memoria Flash Firmware';
    motherboard = `${brand} Formatter Controller Board`;
    consumible = autoDetectPrinterConsumables(clean)?.consumable || 'Tinta / Tóner Estándar';
  } else {
    // Computadoras / Laptops
    if (/i7[- ]?1[123].../i.test(combinedText)) cpu = 'Intel Core i7 (11va/12va Gen) @ 2.80GHz (8+ Núcleos)';
    else if (/i7[- ]?[89].../i.test(combinedText)) cpu = 'Intel Core i7 (8va/9na Gen) @ 3.00GHz (6/8 Núcleos)';
    else if (/i5[- ]?1[123].../i.test(combinedText)) cpu = 'Intel Core i5 (11va/12va Gen) @ 2.40GHz (4/10 Núcleos)';
    else if (/i5[- ]?[789].../i.test(combinedText)) cpu = 'Intel Core i5 (8va/9na Gen) @ 1.60GHz-3.00GHz (4/6 Núcleos)';
    else if (/i3/i.test(combinedText)) cpu = 'Intel Core i3 @ 3.00GHz (2/4 Núcleos)';
    else if (/ryzen\s*7/i.test(combinedText)) cpu = 'AMD Ryzen 7 @ 3.20GHz (8 Núcleos, 16 Hilos)';
    else if (/ryzen\s*5/i.test(combinedText)) cpu = 'AMD Ryzen 5 @ 2.10GHz-3.60GHz (6 Núcleos, 12 Hilos)';
    else if (/ryzen\s*3/i.test(combinedText)) cpu = 'AMD Ryzen 3 @ 2.60GHz (4 Núcleos, 8 Hilos)';
    else if (/m1|m2|m3/i.test(combinedText)) cpu = 'Apple Silicon SoC (8-Core CPU, 16-Core Neural Engine)';
    else if (type === 'PC de Escritorio') cpu = 'Intel Core i5 @ 3.00GHz (6 Núcleos)';
    else cpu = 'Intel Core i5 / AMD Ryzen 5 (Fábrica)';

    ram = (type === 'PC de Escritorio' || /i7|ryzen\s*7/i.test(combinedText)) ? '16 GB DDR4' : '8 GB DDR4';
    storage = '256 GB / 512 GB SSD NVMe M.2';
    motherboard = brand !== 'Genérico' ? `${brand} OEM System Board` : 'N/A';
  }

  return {
    success: true,
    found: true,
    source: onlineSnippet ? 'Internet & Conocimiento Web' : 'Inferencia Inteligente de Hardware',
    fabricante: brand,
    tipo_equipo: type,
    procesador: cpu,
    ram_total: ram,
    almacenamiento: storage,
    placa_base: motherboard,
    consumible: consumible
  };
}

// Endpoint de Consulta Inteligente de Especificaciones de Hardware
app.get('/api/lookup-specs', async (req, res) => {
  const modelQuery = (req.query.model || '').trim();
  if (!modelQuery || modelQuery.length < 2) {
    return res.status(400).json({ error: 'Modelo no especificado' });
  }

  try {
    const specs = await lookupHardwareSpecsOnline(modelQuery);
    res.json(specs);
  } catch (err) {
    res.json({
      success: false,
      found: false,
      error: err.message
    });
  }
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
    mac_address: body.mac_address || '',
    ip_red: body.ip_red || '',
    usuario_actual: body.usuario_actual || '',
    ubicacion: body.ubicacion || 'Sin asignar',
    estado: body.estado || 'Operativo',
    consumible: body.consumible || body.tinta_toner || '',
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
  const targetId = req.params.id;
  const decodedId = decodeURIComponent(targetId);
  const targetSerial = (req.body && req.body.numero_serie) ? req.body.numero_serie.trim().toLowerCase() : '';
  
  let index = items.findIndex(i => i.id === targetId || i.id === decodedId);
  if (index === -1 && targetSerial) {
    index = items.findIndex(i => (i.numero_serie || '').trim().toLowerCase() === targetSerial);
  }
  
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
  try {
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
      perifericos: (payload.perifericos || []).filter(isValidPeripheral),
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
  } catch (err) {
    console.error('Error procesando reporte de agente:', err);
    res.status(500).json({ error: 'Error interno procesando escaneo', detalle: err.message });
  }
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
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 20 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 8: PROYECTORES
    // -------------------------------------------------------------
    const wsProyectores = workbook.addWorksheet('PROYECTORES', { views: [{ showGridLines: true }] });
    styleWorksheet(wsProyectores, [
      { header: 'MODELO PROYECTOR', key: 'modelo', width: 30 },
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'NÚMERO DE SERIE (S/N)', key: 'numero_serie', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE (UBICACIÓN)', key: 'ubicacion', width: 28 },
      { header: 'DIRECCIÓN IP / RED', key: 'ip', width: 20 },
      { header: 'ESTADO', key: 'estado', width: 16 },
      { header: 'NOTAS / OBSERVACIONES', key: 'notas', width: 30 }
    ]);

    // -------------------------------------------------------------
    // HOJA 9: WIFI / RED
    // -------------------------------------------------------------
    const wsWifi = workbook.addWorksheet('WIFI', { views: [{ showGridLines: true }] });
    styleWorksheet(wsWifi, [
      { header: 'DISPOSITIVO / ACCESS POINT', key: 'dispositivo', width: 32 },
      { header: 'MARCA / FABRICANTE', key: 'marca', width: 22 },
      { header: 'DIRECCIÓN MAC', key: 'mac', width: 24 },
      { header: 'NÚMERO DE SERIE (S/N)', key: 'numero_serie', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE (UBICACIÓN)', key: 'ubicacion', width: 28 },
      { header: 'DIRECCIÓN IP / RED', key: 'ip', width: 20 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // Poblado de Datos en todas las hojas categorizadas
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
      const isProyector = /proyector|multimedia|datashow/i.test(item.tipo_equipo || '') || /proyector|datashow/i.test(item.modelo || '');
      const isImpresora = !isProyector && (/impresora|multifuncional|fotocopiadora/i.test(item.tipo_equipo || '') || /impresora/i.test(item.modelo || ''));
      const isWifiDevice = /wi-fi|wifi|access point|ap|router|switch/i.test(item.tipo_equipo || '') || /wi-fi|wifi|access point|router/i.test(item.modelo || '');

      // 1. CLASIFICACIÓN PRINCIPAL DE EQUIPO
      if (isProyector) {
        wsProyectores.addRow({
          modelo: toUpper(item.modelo || 'Proyector Multimedia'),
          fabricante: toUpper(item.fabricante || 'Epson'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          bloque: bloque,
          ubicacion: amb,
          ip: ip,
          estado: status,
          notas: toUpper(item.notas || 'Equipo audiovisual')
        });
      } else if (isImpresora) {
        wsImpresoras.addRow({
          modelo: toUpper(item.modelo || ''),
          fabricante: toUpper(item.fabricante || 'Epson/HP'),
          numero_serie: toUpper(item.numero_serie || ''),
          usuario: user,
          bloque: bloque,
          ubicacion: amb,
          ip: ip,
          estado: status
        });
      } else if (isLaptop) {
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
      } else if (!isWifiDevice) {
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

      // 2. REGISTRO EN HOJA WIFI (Equipos de red dedicados o interfaces Wi-Fi/MAC detectadas)
      if (isWifiDevice) {
        wsWifi.addRow({
          dispositivo: toUpper(item.modelo || 'Access Point Wi-Fi'),
          marca: toUpper(item.fabricante || 'Cisco / Ubiquiti / Mikrotik'),
          mac: toUpper(item.mac_address || item.mac || 'N/A'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          bloque: bloque,
          ubicacion: amb,
          ip: ip,
          estado: status
        });
      } else if (item.mac_address && item.mac_address !== 'N/A' && item.mac_address !== '') {
        const devDesc = isLaptop ? `LAPTOP WI-FI (${item.hostname || item.modelo})` : `INTERFAZ RED / WI-FI (${item.hostname})`;
        const brandDesc = item.fabricante || (isLaptop ? 'HP / INTEL' : 'GIGABIT ADAPTER');
        wsWifi.addRow({
          dispositivo: toUpper(devDesc),
          marca: toUpper(brandDesc),
          mac: toUpper(item.mac_address),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          bloque: bloque,
          ubicacion: amb,
          ip: ip,
          estado: status
        });
      }

      // 3. Monitores a su propia hoja
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

      // 4. Periféricos clasificados en TECLADO, MOUSE, AUDÍFONOS (Solo hardware propietario/marca)
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
    });

    // Aplicar estilos y auto-ajustar anchos a todas las hojas categorizadas
    [wsCase, wsLaptops, wsMonitor, wsTeclado, wsAudifonos, wsMouse, wsImpresoras, wsProyectores, wsWifi].forEach(ws => {
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
