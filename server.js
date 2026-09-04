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

// Endpoint de salud y keep-alive para evitar hibernación en Render
app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send('pong');
});

// Anti-Hibernación 24/7 para Render (elimina el modo de espera)
const RENDER_PING_URL = 'https://ivt.onrender.com/api/ping';
function pingRenderService() {
  try {
    https.get(RENDER_PING_URL, (res) => {}).on('error', () => {});
  } catch (e) {}
}
// Ping cada 5 minutos de forma continua
setInterval(pingRenderService, 5 * 60 * 1000);
setTimeout(pingRenderService, 2000);

// Endpoint prioritario para descargar la App Android (.APK) siempre fresca con no-cache y nombre de versión claro
app.get(['/SysInventory.apk', '/sysinventory.apk', '/SysInventory-v2.1.2.apk', '/SysInventory-v2.1.1.apk', '/SysInventory-v2.1.0.apk', '/SysInventory-v2.0.0.apk', '/apk', '/app', '/download-apk', '/api/download-apk'], (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const localApk = path.join(__dirname, 'public', 'SysInventory.apk');
  if (fs.existsSync(localApk)) {
    return res.download(localApk, 'SysInventory-v2.1.2.apk');
  }
  return res.redirect('https://github.com/Tayron211/inventario-computo/releases/download/app-v2.1.2/SysInventory.apk');
});

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

function cleanGenericModel(val, placaBase, tipo) {
  if (!val) return 'PC Ensamblada';
  const str = String(val).trim();
  if (/^(system product name|to be filled by o\.e\.m\.|default string|system manufacturer|all series|generic|desconocido)$/i.test(str)) {
    if (placaBase && placaBase !== 'N/A' && !/^(system|default|generic|to be filled)/i.test(placaBase)) {
      return `PC Ensamblada (${placaBase})`;
    }
    return 'PC Ensamblada';
  }
  return str;
}

function cleanGenericManufacturer(val, placaBase) {
  if (!val) return 'Ensamblado';
  const str = String(val).trim();
  if (/^(system manufacturer|to be filled by o\.e\.m\.|default string|oem|generic|desconocido)$/i.test(str)) {
    if (placaBase && placaBase !== 'N/A' && !/^(system|default|generic|to be filled)/i.test(placaBase)) {
      const parts = placaBase.split(' ');
      return parts[0] || 'Ensamblado';
    }
    return 'Ensamblado';
  }
  return str;
}

function normalizeItem(item) {
  if (!item) return item;
  const { _id, ...clean } = item;
  clean.modelo = cleanGenericModel(clean.modelo, clean.placa_base, clean.tipo_equipo);
  clean.fabricante = cleanGenericManufacturer(clean.fabricante, clean.placa_base);

  if (clean.monitores && Array.isArray(clean.monitores)) {
    clean.monitores = clean.monitores.map(m => {
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
  if (clean.perifericos && Array.isArray(clean.perifericos)) {
    clean.perifericos = clean.perifericos.filter(isValidPeripheral);
  }
  return clean;
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

async function saveDB(data) {
  const normalized = (data || []).map(normalizeItem);
  memoryCache = normalized;
  saveLocalFile(normalized);
  
  if (mongoCollection) {
    try {
      await mongoCollection.deleteMany({});
      if (normalized.length > 0) {
        const toInsert = normalized.map(i => {
          const { _id, ...clean } = i;
          return clean;
        });
        await mongoCollection.insertMany(toInsert);
      }
    } catch (err) {
      console.error('⚠️ Error sincronizando en MongoDB Atlas:', err.message);
    }
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

// =============================================================
// SISTEMA DE CATEGORÍAS Y PRIVILEGIOS DE USUARIOS
// =============================================================
const USER_CATEGORIES = {
  // 1. PLATINUM: Acceso Total a todo el sistema y todos los privilegios
  Platinum: {
    categoria: 'Platinum',
    role: 'admin',
    badge: 'platinum',
    canCreate: true,
    canScan: true,
    canEdit: true,
    canDelete: true,
    canExport: true
  },
  // 2. GOLDEN: Todos los privilegios EXCEPTO eliminar registros
  Golden: {
    categoria: 'Golden',
    role: 'gold_admin',
    badge: 'gold',
    canCreate: true,
    canScan: true,
    canEdit: true,
    canDelete: false,
    canExport: true
  },
  // 3. BRONCE: Solo lectura, sin edición, sin Excel, sin registro ni eliminación
  Bronce: {
    categoria: 'Bronce',
    role: 'observador',
    badge: 'bronze',
    canCreate: false,
    canScan: false,
    canEdit: false,
    canDelete: false,
    canExport: false
  }
};

// Listado de usuarios del sistema organizados por Categoría
const USERS = [
  // --- CATEGORÍA PLATINUM (Acceso Total: Crear, Escanear, Editar, Eliminar, Exportar) ---
  { 
    username: 'admin', 
    passwords: ['admin', 'S0p0rt3pp', 'soporte', 'soportepp'], 
    categoria: 'Platinum',
    displayName: 'Administrador',
    ...USER_CATEGORIES.Platinum 
  },

  // --- CATEGORÍA GOLDEN (Todos los privilegios EXCEPTO Eliminar) ---
  { 
    username: 'Tayron', 
    passwords: ['210391', 'tayron'], 
    categoria: 'Golden',
    displayName: 'Tayron',
    ...USER_CATEGORIES.Golden 
  },
  { 
    username: 'Cristian', 
    passwords: ['Joel0209', 'joel0209', 'cristian'], 
    categoria: 'Golden',
    displayName: 'Cristian',
    ...USER_CATEGORIES.Golden 
  },
  { 
    username: 'David', 
    passwords: ['Goñigo', 'Gonigo', 'goñigo', 'gonigo', 'david'], 
    categoria: 'Golden',
    displayName: 'David',
    ...USER_CATEGORIES.Golden 
  },

  // --- CATEGORÍA BRONCE (Solo Lectura: No registrar, No escanear, No editar, No exportar, No eliminar) ---
  { 
    username: 'observador', 
    passwords: ['solover', 'observador', 'solo_ver', '123456'], 
    categoria: 'Bronce',
    displayName: 'Observador',
    ...USER_CATEGORIES.Bronce 
  },
  { 
    username: 'user', 
    passwords: ['solover', 'observador', 'user', '123456'], 
    categoria: 'Bronce',
    displayName: 'Observador',
    ...USER_CATEGORIES.Bronce 
  }
];

// Obtener información y privilegios completos del usuario actual
function getUserInfo(req) {
  let token = req.headers['authorization'] || (req.query && req.query.token);
  if (!token) return { ...USER_CATEGORIES.Platinum, username: 'admin', displayName: 'Administrador' };
  
  try {
    const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();
    const decoded = Buffer.from(cleanToken, 'base64').toString('utf8');
    const [username, role, badge, categoria] = decoded.split(':');
    const matched = USERS.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
    if (matched) return matched;

    const catKey = categoria || (role === 'admin' ? 'Platinum' : (role === 'gold_admin' ? 'Golden' : 'Bronce'));
    const baseCat = USER_CATEGORIES[catKey] || USER_CATEGORIES.Platinum;

    return {
      username: username || 'admin',
      displayName: username || 'Usuario',
      ...baseCat
    };
  } catch (e) {
    return { ...USER_CATEGORIES.Platinum, username: 'admin', displayName: 'Administrador' };
  }
}

function getUserRole(req) {
  return getUserInfo(req).role;
}

// Login de Usuarios con resolución automática de categoría y privilegios
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Por favor ingresa usuario y contraseña' });
  }

  const uClean = String(username).trim().toLowerCase();
  const pClean = String(password).trim();
  const pCleanLower = pClean.toLowerCase();

  const foundUser = USERS.find(u => {
    const userMatch = u.username.toLowerCase() === uClean;
    const passMatch = u.passwords.some(p => p === pClean || p.toLowerCase() === pCleanLower);
    return userMatch && passMatch;
  });
  
  if (foundUser) {
    const token = Buffer.from(`${foundUser.username}:${foundUser.role}:${foundUser.badge}:${foundUser.categoria}:${Date.now()}`).toString('base64');
    return res.json({
      success: true,
      user: foundUser.username,
      categoria: foundUser.categoria,
      role: foundUser.role,
      badge: foundUser.badge,
      canCreate: foundUser.canCreate,
      canScan: foundUser.canScan,
      canEdit: foundUser.canEdit,
      canDelete: foundUser.canDelete,
      canExport: foundUser.canExport,
      displayName: foundUser.displayName,
      token: token,
      message: 'Inicio de sesión exitoso'
    });
  }
  
  return res.status(401).json({
    success: false,
    error: 'Usuario o contraseña incorrectos. Verifica las mayúsculas/minúsculas.'
  });
});

// Servir script para ejecución remota en 1 sola línea personalizada por usuario (irm http://IP:3000/scan?u=NOMBRE | iex)
app.get(['/scan', '/agent.ps1', '/api/script'], (req, res) => {
  const scriptPath = path.join(__dirname, 'scripts', 'collector.ps1');
  const serverUrl = getServerUrl(req);
  const ubicacion = (req.query.ubicacion || req.query.amb || 'Soporte Técnico').trim();
  const rawUser = (req.query.u || req.query.user || req.query.usuario || req.query.registrado_por || req.query.creado_por || 'Administrador').trim();
  
  let scannerUser = rawUser;
  const matchedUser = USERS.find(u => u.username.toLowerCase() === rawUser.toLowerCase());
  if (matchedUser) {
    scannerUser = matchedUser.displayName || matchedUser.username;
  } else if (/^admin$/i.test(rawUser)) {
    scannerUser = 'Administrador';
  }
  
  try {
    let scriptContent = fs.readFileSync(scriptPath, 'utf8');
    scriptContent = scriptContent.replace(/\[string\]\$ServerUrl\s*=\s*"[^"]*"/i, `[string]$ServerUrl = "${serverUrl}"`);
    scriptContent = scriptContent.replace(/\[string\]\$Ubicacion\s*=\s*"[^"]*"/i, `[string]$Ubicacion = "${ubicacion}"`);
    scriptContent = scriptContent.replace(/\[string\]\$UsuarioScanner\s*=\s*"[^"]*"/i, `[string]$UsuarioScanner = "${scannerUser}"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(scriptContent);
  } catch (err) {
    res.status(500).send('# Error leyendo script de escaneo');
  }
});



// Endpoint para descargar el archivo .BAT personalizado por usuario con permisos de Administrador por defecto
app.get(['/api/download-batch', '/download-batch', '/escanear.bat'], (req, res) => {
  const serverUrl = getServerUrl(req);
  const rawUser = (req.query.u || req.query.user || req.query.usuario || req.query.registrado_por || 'Administrador').trim();
  
  let scannerUser = rawUser;
  const matchedUser = USERS.find(u => u.username.toLowerCase() === rawUser.toLowerCase());
  if (matchedUser) {
    scannerUser = matchedUser.displayName || matchedUser.username;
  } else if (/^admin$/i.test(rawUser)) {
    scannerUser = 'Administrador';
  }
  
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
echo [*] Auditor / Usuario Responsable: [${scannerUser.toUpperCase()}]
echo [*] Conectando con servidor (${serverUrl})...
echo [*] Extrayendo BIOS, Motherboard, CPU, RAM, Discos y Perifericos...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls; irm ${serverUrl}/scan?u=${encodeURIComponent(scannerUser)} | iex"

echo.
echo ====================================================================
echo  [OK] Escaneo completado. Registrado exitosamente por: ${scannerUser}
echo ====================================================================
echo.
timeout /t 5 >nul
`;

  const fileNameSafe = `ESCANEAR_EQUIPO_${scannerUser.toUpperCase().replace(/[^A-Z0-9]/gi, '_')}.bat`;
  res.setHeader('Content-Type', 'application/x-bat; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileNameSafe}"`);
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

// =============================================================
// BASE DE DATOS Y DETECCIÓN AUTOMÁTICA DE TINTA / TÓNER (BACKEND)
// =============================================================
const PRINTER_CONSUMABLES_DB = [
  // EPSON ECOTANK / INK TANK (TINTAS)
  { pattern: /l575|l555|l565|l355|l365|l375|l380|l395|l455|l475|l495|l210|l220|l110|l120|l1300/i, brand: 'Epson', consumable: 'Tinta Epson T664' },
  { pattern: /l3110|l3150|l3160|l3210|l3250|l3251|l3260|l5190|l5290|l5590|l1110|l1210|l1250/i, brand: 'Epson', consumable: 'Tinta Epson T544' },
  { pattern: /l4150|l4160|l4260|l6161|l6171|l6191|l6270|l14150/i, brand: 'Epson', consumable: 'Tinta Epson T504' },
  { pattern: /l800|l805|l810|l850|l1800/i, brand: 'Epson', consumable: 'Tinta Epson T673' },
  { pattern: /l8050|l18050/i, brand: 'Epson', consumable: 'Tinta Epson 108' },
  { pattern: /m1100|m1120|m2140|m2170|m3170|m3180/i, brand: 'Epson', consumable: 'Tinta Epson T534' },
  { pattern: /wf-c5790|wf-c5290|wf-c5710|wf-c5890/i, brand: 'Epson', consumable: 'Tinta Epson T941 / T942' },
  { pattern: /wf-m5799|wf-m5299/i, brand: 'Epson', consumable: 'Tinta Epson T962' },
  { pattern: /l6570|l6580|l15150|l15160/i, brand: 'Epson', consumable: 'Tinta Epson T542' },
  { pattern: /epson.*(l[1-8]\d{2,4}|m\d{3,4}|wf-\w+)/i, brand: 'Epson', consumable: 'Tinta Epson EcoTank / WorkForce' },

  // HP LASERJET (TÓNER)
  { pattern: /p1102|m1132|m1212|m1214|m1217/i, brand: 'HP', consumable: 'Tóner HP 85A' },
  { pattern: /p1005|p1006/i, brand: 'HP', consumable: 'Tóner HP 35A' },
  { pattern: /p1505|m1522|m1120/i, brand: 'HP', consumable: 'Tóner HP 36A' },
  { pattern: /p1606|p1566|m1536/i, brand: 'HP', consumable: 'Tóner HP 78A' },
  { pattern: /m12w|m12a|m26a|m26nw/i, brand: 'HP', consumable: 'Tóner HP 79A' },
  { pattern: /m15a|m15w|m28a|m28w/i, brand: 'HP', consumable: 'Tóner HP 48A' },
  { pattern: /107a|107w|107r|135a|135w|135r|137fnw/i, brand: 'HP', consumable: 'Tóner HP 105A' },
  { pattern: /m402|m426/i, brand: 'HP', consumable: 'Tóner HP 26A' },
  { pattern: /m404|m428|m406|m430/i, brand: 'HP', consumable: 'Tóner HP 58A' },
  { pattern: /m401|m425/i, brand: 'HP', consumable: 'Tóner HP 80A' },
  { pattern: /p2035|p2055/i, brand: 'HP', consumable: 'Tóner HP 05A' },
  { pattern: /p3015|m521|m525/i, brand: 'HP', consumable: 'Tóner HP 55A' },
  { pattern: /m506|m507|m527|m528/i, brand: 'HP', consumable: 'Tóner HP 89A' },
  { pattern: /m209|m211|m234|m236/i, brand: 'HP', consumable: 'Tóner HP 134A' },
  { pattern: /cp1025|m175|m275/i, brand: 'HP', consumable: 'Tóner HP 126A' },
  { pattern: /m252|m277|m254|m281/i, brand: 'HP', consumable: 'Tóner HP 201A' },
  { pattern: /m452|m477|m454|m479/i, brand: 'HP', consumable: 'Tóner HP 410A / 414A' },

  // HP SMART TANK & INK TANK (TINTAS)
  { pattern: /smart tank|515|519|530|580|615|720|750|790/i, brand: 'HP', consumable: 'Tinta HP GT53 / GT52' },
  { pattern: /ink tank|115|315|415|419/i, brand: 'HP', consumable: 'Tinta HP GT51 / GT52' },

  // CANON (PIXMA TINTA & IMAGECLASS TÓNER)
  { pattern: /g1100|g1110|g2100|g2110|g3100|g3110|g4100|g4110/i, brand: 'Canon', consumable: 'Tinta Canon GI-190' },
  { pattern: /g2160|g3160|g2170|g3170|g4170/i, brand: 'Canon', consumable: 'Tinta Canon GI-11' },
  { pattern: /g5010|g6010|g7010|gm2010/i, brand: 'Canon', consumable: 'Tinta Canon GI-10' },
  { pattern: /g510|g610/i, brand: 'Canon', consumable: 'Tinta Canon GI-13' },
  { pattern: /mf3010|lbp6000|lbp6030/i, brand: 'Canon', consumable: 'Tóner Canon 125' },
  { pattern: /mf4770|mf4890|d530|d550/i, brand: 'Canon', consumable: 'Tóner Canon 128' },
  { pattern: /mf212|mf216|mf227|mf232|mf244|mf247/i, brand: 'Canon', consumable: 'Tóner Canon 137' },
  { pattern: /mf445|mf448|mf449|lbp226|lbp228/i, brand: 'Canon', consumable: 'Tóner Canon 057' },

  // BROTHER (INKBENEFIT TINTA & HL/DCP TÓNER)
  { pattern: /t300|t310|t500w|t510w|t700w|t710w|t220|t420w|t520w|t720dw|t820dw|t920dw/i, brand: 'Brother', consumable: 'Tinta Brother BTD60BK / BT5001' },
  { pattern: /hl-1212w|dcp-1617nw|hl-1110|hl-1112|hl-1200|hl-1202/i, brand: 'Brother', consumable: 'Tóner Brother TN-1060' },
  { pattern: /hl-l2320d|hl-l2360dw|dcp-l2520dw|dcp-l2540dw|mfc-l2700dw|mfc-l2720dw|mfc-l2740dw/i, brand: 'Brother', consumable: 'Tóner Brother TN-660 / TN-2370' },
  { pattern: /hl-l2350dw|hl-l2370dw|dcp-l2550dw|mfc-l2710dw|mfc-l2750dw/i, brand: 'Brother', consumable: 'Tóner Brother TN-760 / TN-2470' },
  { pattern: /hl-l5100dn|hl-l5200dw|hl-l6200dw|dcp-l5500dn|dcp-l5600dn|dcp-l5650dn|mfc-l5800dw|mfc-l5900dw/i, brand: 'Brother', consumable: 'Tóner Brother TN-3472 / TN-3479' },

  // KYOCERA (ECOSYS TÓNER)
  { pattern: /m2040dn|m2540dn|m2640idw|m2135dn|m2635dn/i, brand: 'Kyocera', consumable: 'Tóner Kyocera TK-1175 / TK-1152' },
  { pattern: /m3145dn|m3645dn|m3540dn|m3040dn/i, brand: 'Kyocera', consumable: 'Tóner Kyocera TK-3172 / TK-3182' },
  { pattern: /m3655idn|m3860idn/i, brand: 'Kyocera', consumable: 'Tóner Kyocera TK-3192' },

  // RICOH
  { pattern: /mp 201|mp 301|mp 305/i, brand: 'Ricoh', consumable: 'Tóner Ricoh MP 301' },
  { pattern: /mp 401|mp 402|mp 501|mp 601/i, brand: 'Ricoh', consumable: 'Tóner Ricoh MP 501' },
  { pattern: /im c2000|im c2500|im c3000|im c3500/i, brand: 'Ricoh', consumable: 'Tóner Ricoh IM C3000' }
];

function autoDetectPrinterConsumables(modelText) {
  if (!modelText || typeof modelText !== 'string') return null;
  const clean = modelText.trim();
  if (clean.length < 2) return null;

  for (const item of PRINTER_CONSUMABLES_DB) {
    if (item.pattern.test(clean)) {
      return item;
    }
  }
  return null;
}

// Base de datos Extensa de Especificaciones de Fábrica por Modelo (Hardware, Redes, Impresión, Servidores)
const HARDWARE_MODELS_CATALOG = [
  // ==========================================
  // IMPRESORAS POPULARES (EPSON, HP, CANON, BROTHER, KYOCERA)
  // ==========================================
  { pattern: /l575|l555|l565|l355|l365|l375|l380|l395|l455|l475|l495|l210|l220|l110|l120|l1300/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Microcontrolador RISC Epson ESC/P-R (4 Colores)', ram: '128 MB Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson EcoTank L500/L300 Series Controller Board', consumible: 'Tinta Epson T664' },
  { pattern: /l3250|l3210|l3150|l3110|l1250|l1210|l5190|l5290|l5590/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Microcontrolador RISC Epson ESC/P-R', ram: '128 MB Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson EcoTank L3200 Series Controller Board', consumible: 'Tinta Epson T544' },
  { pattern: /l4260|l4160|l4150|l6161|l6171|l6191|l6270|l14150/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson PrecisionCore Dual Engine (Duplex Automático)', ram: '256 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson EcoTank PrecisionCore Controller Board', consumible: 'Tinta Epson T504' },
  { pattern: /l800|l805|l810|l850|l1800/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson 6-Color Photographic Micro Piezo Engine', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson Photo Controller Board', consumible: 'Tinta Epson T673' },
  { pattern: /l8050|l18050/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson High-Speed 6-Color Photo Print Engine', ram: '256 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson Photo EcoTank Controller Board', consumible: 'Tinta Epson 108' },
  { pattern: /m1100|m1120|m2140|m2170|m3170|m3180/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson PrecisionCore Monocromático de Alta Velocidad', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson EcoTank Mono Controller Board', consumible: 'Tinta Epson T534' },
  { pattern: /wf[- ]?c5790|wf[- ]?c5290|wf[- ]?c5710|wf[- ]?c5890/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'PrecisionCore 4-Color WorkForce Enterprise Engine', ram: '512 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson WorkForce Pro Controller Board', consumible: 'Tinta Epson T941 / T942' },
  { pattern: /epson/i, brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Microcontrolador RISC Epson ESC/P-R', ram: '128 MB Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson Controller Formatter Board', consumible: 'Tinta Epson EcoTank' },

  // SWITCHES DE RED & ROUTERS (CISCO, MIKROTIK, TP-LINK, UBIQUITI, ARUBA, HP, D-LINK)
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
  // TARJETAS DE VIDEO DEDICADAS / GPUs (NVIDIA, AMD, INTEL - 2009 A 2026)
  // ==========================================
  // NVIDIA RTX Serie 40 y 50
  { pattern: /rtx\s*5090/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Blackwell GB202 GPU (21760 CUDA Cores)', ram: '32 GB GDDR7 (512-bit, 28 Gbps)', storage: 'PCIe 5.0 x16 (600W 12V-2x6)', motherboard: 'Tarjeta Gráfica Dedicada (3x DisplayPort 2.1, 1x HDMI 2.1a)' },
  { pattern: /rtx\s*5080/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Blackwell GB203 GPU (10752 CUDA Cores)', ram: '16 GB GDDR7 (256-bit, 30 Gbps)', storage: 'PCIe 5.0 x16 (400W 12V-2x6)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 2.1, 1x HDMI 2.1a)' },
  { pattern: /rtx\s*4090/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ada Lovelace AD102 GPU (16384 CUDA Cores @ 2.52GHz)', ram: '24 GB GDDR6X (384-bit)', storage: 'PCIe 4.0 x16 (450W TDP, 1x 16-pin 12VHPWR)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*4080\s*super|rtx\s*4080/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ada Lovelace AD103 GPU (10240 CUDA Cores @ 2.55GHz)', ram: '16 GB GDDR6X (256-bit)', storage: 'PCIe 4.0 x16 (320W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*4070\s*ti\s*super|rtx\s*4070\s*ti/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ada Lovelace AD103/AD104 GPU (8448 CUDA Cores)', ram: '16 GB / 12 GB GDDR6X (256-bit / 192-bit)', storage: 'PCIe 4.0 x16 (285W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*4070\s*super|rtx\s*4070/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ada Lovelace AD104 GPU (7168 CUDA Cores @ 2.48GHz)', ram: '12 GB GDDR6X (192-bit)', storage: 'PCIe 4.0 x16 (220W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*4060\s*ti/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ada Lovelace AD106 GPU (4352 CUDA Cores @ 2.54GHz)', ram: '8 GB / 16 GB GDDR6 (128-bit)', storage: 'PCIe 4.0 x8 (160W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*4060/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ada Lovelace AD107 GPU (3072 CUDA Cores @ 2.46GHz)', ram: '8 GB GDDR6 (128-bit)', storage: 'PCIe 4.0 x8 (115W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },

  // NVIDIA RTX Serie 30
  { pattern: /rtx\s*3090\s*ti|rtx\s*3090/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ampere GA102 GPU (10496 CUDA Cores @ 1.70GHz)', ram: '24 GB GDDR6X (384-bit)', storage: 'PCIe 4.0 x16 (350W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*3080\s*ti|rtx\s*3080/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ampere GA102 GPU (8704/10240 CUDA Cores)', ram: '10 GB / 12 GB GDDR6X (320-bit / 384-bit)', storage: 'PCIe 4.0 x16 (320W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*3070\s*ti|rtx\s*3070/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ampere GA104 GPU (5888/6144 CUDA Cores @ 1.73GHz)', ram: '8 GB GDDR6 / GDDR6X (256-bit)', storage: 'PCIe 4.0 x16 (220W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*3060\s*ti/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ampere GA104 GPU (4864 CUDA Cores @ 1.67GHz)', ram: '8 GB GDDR6 (256-bit)', storage: 'PCIe 4.0 x16 (200W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*3060/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ampere GA106 GPU (3584 CUDA Cores @ 1.78GHz)', ram: '12 GB GDDR6 (192-bit)', storage: 'PCIe 4.0 x16 (170W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4a, 1x HDMI 2.1)' },
  { pattern: /rtx\s*3050/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Ampere GA106/GA107 GPU (2560/2048 CUDA Cores)', ram: '6 GB / 8 GB GDDR6 (128-bit / 96-bit)', storage: 'PCIe 4.0 x8 (70W-130W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },

  // NVIDIA RTX Serie 20 & GTX 16
  { pattern: /rtx\s*2080\s*ti|rtx\s*2080\s*super|rtx\s*2080/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Turing TU102/TU104 GPU (2944-4352 CUDA Cores)', ram: '8 GB / 11 GB GDDR6 (256-bit / 352-bit)', storage: 'PCIe 3.0 x16 (215W-250W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4, 1x HDMI 2.0b, Type-C)' },
  { pattern: /rtx\s*2070\s*super|rtx\s*2070/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Turing TU104/TU106 GPU (2304-2560 CUDA Cores)', ram: '8 GB GDDR6 (256-bit)', storage: 'PCIe 3.0 x16 (175W-215W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / USB-C)' },
  { pattern: /rtx\s*2060\s*super|rtx\s*2060/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Turing TU106 GPU (1920/2176 CUDA Cores @ 1.68GHz)', ram: '6 GB / 8 GB / 12 GB GDDR6 (192-bit / 256-bit)', storage: 'PCIe 3.0 x16 (160W-175W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /gtx\s*1660\s*ti|gtx\s*1660\s*super|gtx\s*1660/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Turing TU116 GPU (1408-1536 CUDA Cores @ 1.78GHz)', ram: '6 GB GDDR5 / GDDR6 (192-bit)', storage: 'PCIe 3.0 x16 (120W-125W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP 1.4, HDMI 2.0b, DVI)' },
  { pattern: /gtx\s*1650\s*super|gtx\s*1650/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Turing TU117/TU116 GPU (896-1280 CUDA Cores)', ram: '4 GB GDDR5 / GDDR6 (128-bit)', storage: 'PCIe 3.0 x16 (75W-100W TDP, Bajo Consumo)', motherboard: 'Tarjeta Gráfica Dedicada (HDMI / DP / DVI)' },

  // NVIDIA GTX Serie 10, 900, 700, 600, 500, 400, 200 (2009-2018)
  { pattern: /gtx\s*1080\s*ti|gtx\s*1080/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Pascal GP102/GP104 GPU (2560-3584 CUDA Cores @ 1.73GHz)', ram: '8 GB / 11 GB GDDR5X (256-bit / 352-bit)', storage: 'PCIe 3.0 x16 (180W-250W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP, 1x HDMI)' },
  { pattern: /gtx\s*1070\s*ti|gtx\s*1070/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Pascal GP104 GPU (1920-2432 CUDA Cores @ 1.68GHz)', ram: '8 GB GDDR5 (256-bit)', storage: 'PCIe 3.0 x16 (150W-180W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /gtx\s*1060/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Pascal GP106 GPU (1152-1280 CUDA Cores @ 1.70GHz)', ram: '3 GB / 6 GB GDDR5 (192-bit)', storage: 'PCIe 3.0 x16 (120W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /gtx\s*1050\s*ti|gtx\s*1050/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Pascal GP107 GPU (640-768 CUDA Cores @ 1.39GHz)', ram: '2 GB / 4 GB GDDR5 (128-bit)', storage: 'PCIe 3.0 x16 (75W TDP Sin Conector)', motherboard: 'Tarjeta Gráfica Dedicada (HDMI / DP / DVI)' },
  { pattern: /gtx\s*980\s*ti|gtx\s*980|gtx\s*970/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Maxwell GM204/GM200 GPU (1664-2816 CUDA Cores)', ram: '4 GB / 6 GB GDDR5 (256-bit / 384-bit)', storage: 'PCIe 3.0 x16 (145W-250W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /gtx\s*960|gtx\s*950/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Maxwell GM206 GPU (768-1024 CUDA Cores)', ram: '2 GB / 4 GB GDDR5 (128-bit)', storage: 'PCIe 3.0 x16 (90W-120W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /gtx\s*780\s*ti|gtx\s*780|gtx\s*770|gtx\s*760/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Kepler GK110/GK104 GPU (1152-2880 CUDA Cores)', ram: '2 GB / 3 GB / 4 GB GDDR5 (256-bit / 384-bit)', storage: 'PCIe 3.0 x16 (170W-250W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (2x DVI, HDMI, DP)' },
  { pattern: /gtx\s*750\s*ti|gtx\s*750/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Maxwell 1st Gen GM107 GPU (512-640 CUDA Cores)', ram: '1 GB / 2 GB / 4 GB GDDR5 (128-bit)', storage: 'PCIe 3.0 x16 (55W-60W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (HDMI / DVI / VGA)' },
  { pattern: /gt\s*1030|gt\s*730|gt\s*710|gt\s*610/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Low-Profile Video Processor (384/192 CUDA Cores)', ram: '1 GB / 2 GB / 4 GB GDDR5 / DDR3 / DDR4', storage: 'PCIe 3.0 / 2.0 x8/x16 (19W-38W TDP Pasiva/Activa)', motherboard: 'Tarjeta Gráfica de Salida de Video (HDMI / DVI / VGA)' },
  { pattern: /gtx\s*680|gtx\s*670|gtx\s*660|gtx\s*650/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Kepler GK104/GK106/GK107 GPU', ram: '1 GB / 2 GB GDDR5 (128-bit / 192-bit / 256-bit)', storage: 'PCIe 3.0 x16 (64W-195W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DVI / HDMI / DP)' },
  { pattern: /gtx\s*580|gtx\s*570|gtx\s*560|gtx\s*550/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Fermi GF110/GF114/GF116 GPU (192-512 CUDA Cores)', ram: '1 GB / 1.5 GB GDDR5 (192-bit / 320-bit / 384-bit)', storage: 'PCIe 2.0 x16 (116W-244W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (2x DVI, Mini-HDMI)' },
  { pattern: /gtx\s*480|gtx\s*470|gtx\s*460|gtx\s*280|gtx\s*260/i, brand: 'NVIDIA', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Fermi GF100/GT200 Architecture (216-480 Cores)', ram: '896 MB / 1 GB / 1.5 GB GDDR3 / GDDR5', storage: 'PCIe 2.0 x16 (160W-250W TDP)', motherboard: 'Tarjeta Gráfica Dedicada Vintage (Dual DVI / S-Video)' },
  { pattern: /quadro\s*(rtx\s*4000|rtx\s*5000|p4000|p2000|k4000|k2000|k620|t1000|t600|t400)/i, brand: 'NVIDIA Quadro', type: 'Tarjeta de Video (GPU)', cpu: 'NVIDIA Quadro Professional Workstation GPU (ECC / CAD / 3D)', ram: '2 GB / 4 GB / 8 GB / 16 GB GDDR5 / GDDR6', storage: 'PCIe 3.0 / 4.0 x16 (Workstation ISV Certified)', motherboard: 'Tarjeta Gráfica Profesional (4x DisplayPort / Mini-DP)' },

  // AMD Radeon GPUs (RX 7000, 6000, 5000, 500, 400, R9/R7, HD 7000/6000/5000)
  { pattern: /rx\s*7900\s*xtx|rx\s*7900\s*xt|rx\s*7900\s*gre/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 3 Navi 31 GPU (5376-6144 Stream Processors)', ram: '16 GB / 20 GB / 24 GB GDDR6 (256-bit / 320-bit / 384-bit)', storage: 'PCIe 4.0 x16 (260W-355W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DisplayPort 2.1, HDMI 2.1a)' },
  { pattern: /rx\s*7800\s*xt|rx\s*7700\s*xt/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 3 Navi 32 GPU (3456-3840 Stream Processors)', ram: '12 GB / 16 GB GDDR6 (192-bit / 256-bit)', storage: 'PCIe 4.0 x16 (245W-263W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP 2.1, HDMI 2.1)' },
  { pattern: /rx\s*7600\s*xt|rx\s*7600/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 3 Navi 33 GPU (2048 Stream Processors @ 2.65GHz)', ram: '8 GB / 16 GB GDDR6 (128-bit)', storage: 'PCIe 4.0 x8 (165W-190W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 2.1, 1x HDMI 2.1)' },
  { pattern: /rx\s*6950\s*xt|rx\s*6900\s*xt|rx\s*6800\s*xt|rx\s*6800/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 2 Navi 21 GPU (3840-5120 Stream Processors, 128MB Infinity Cache)', ram: '16 GB GDDR6 (256-bit)', storage: 'PCIe 4.0 x16 (250W-335W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP 1.4, HDMI 2.1)' },
  { pattern: /rx\s*6750\s*xt|rx\s*6700\s*xt|rx\s*6700/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 2 Navi 22 GPU (2304-2560 Stream Processors @ 2.42GHz)', ram: '10 GB / 12 GB GDDR6 (160-bit / 192-bit)', storage: 'PCIe 4.0 x16 (175W-250W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4, 1x HDMI 2.1)' },
  { pattern: /rx\s*6650\s*xt|rx\s*6600\s*xt|rx\s*6600/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 2 Navi 23 GPU (1792-2048 Stream Processors @ 2.49GHz)', ram: '8 GB GDDR6 (128-bit, 32MB Infinity Cache)', storage: 'PCIe 4.0 x8 (132W-180W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (3x DP 1.4, 1x HDMI 2.1)' },
  { pattern: /rx\s*6500\s*xt|rx\s*6400/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD RDNA 2 Navi 24 GPU (768-1024 Stream Processors)', ram: '4 GB GDDR6 (64-bit)', storage: 'PCIe 4.0 x4 (53W-107W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (1x DP, 1x HDMI)' },
  { pattern: /rx\s*5700\s*xt|rx\s*5700|rx\s*5600\s*xt|rx\s*5500\s*xt/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD 1st Gen RDNA Navi 10/14 GPU (1408-2560 Stream Processors)', ram: '4 GB / 6 GB / 8 GB GDDR6 (128-bit / 192-bit / 256-bit)', storage: 'PCIe 4.0 x16 (130W-225W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP 1.4 / HDMI 2.0b)' },
  { pattern: /rx\s*590|rx\s*580|rx\s*570|rx\s*560|rx\s*550/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD Polaris 20/21 Architecture (512-2304 Stream Processors @ 1.34GHz)', ram: '2 GB / 4 GB / 8 GB GDDR5 (128-bit / 256-bit)', storage: 'PCIe 3.0 x16 (50W-185W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /rx\s*480|rx\s*470|rx\s*460/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD Polaris 10/11 Architecture (896-2304 Stream Processors)', ram: '2 GB / 4 GB / 8 GB GDDR5 (128-bit / 256-bit)', storage: 'PCIe 3.0 x16 (75W-150W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DP / HDMI / DVI)' },
  { pattern: /r9\s*390|r9\s*380|r9\s*290|r9\s*280|r9\s*270|r7\s*260|r7\s*250|r7\s*240/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD GCN 1.0/2.0/3.0 Architecture (Hawaii / Tonga / Curacao / Oland)', ram: '1 GB / 2 GB / 4 GB / 8 GB GDDR5 (128-bit a 512-bit)', storage: 'PCIe 3.0 x16 (30W-275W TDP)', motherboard: 'Tarjeta Gráfica Dedicada (DVI / HDMI / DP)' },
  { pattern: /hd\s*7970|hd\s*7950|hd\s*7870|hd\s*7850|hd\s*7770|hd\s*6970|hd\s*6870|hd\s*5870|hd\s*5770|hd\s*5450/i, brand: 'AMD Radeon', type: 'Tarjeta de Video (GPU)', cpu: 'AMD TeraScale / GCN Vintage Graphics Core', ram: '512 MB / 1 GB / 2 GB / 3 GB GDDR3 / GDDR5', storage: 'PCIe 2.0 / 3.0 x16 (Legacy Video Output)', motherboard: 'Tarjeta Gráfica Dedicada (DVI / VGA / HDMI / Mini-DP)' },
  { pattern: /arc\s*a770|arc\s*a750|arc\s*a580|arc\s*a380|arc\s*b580/i, brand: 'Intel Arc', type: 'Tarjeta de Video (GPU)', cpu: 'Intel Alchemist / Battlemage Xe-HPG Architecture (8-32 Xe Cores, Ray Tracing)', ram: '6 GB / 8 GB / 12 GB / 16 GB GDDR6 (96-bit a 256-bit)', storage: 'PCIe 4.0 x16 / x8 (75W-225W TDP)', motherboard: 'Tarjeta Gráfica Dedicada Intel (3x DP 2.0, 1x HDMI 2.1)' },

  // ==========================================
  // MEMORIAS RAM INDEPENDIENTES (DDR5, DDR4, DDR3)
  // ==========================================
  { pattern: /(fury|vengeance|trident\s*z|t-force|xpg|crucial|ballistix|kingston|corsair|g\.skill).*(ddr5|6000|5600|5200|4800|6400|7200)/i, brand: 'Memoria RAM', type: 'Memoria RAM', cpu: 'N/A (Módulo de Memoria RAM)', ram: '16 GB / 32 GB / 64 GB DDR5 (4800MHz - 7200MHz XMP 3.0 / AMD EXPO)', storage: 'On-Die ECC Integrado (1.1V - 1.4V)', motherboard: 'Formato DIMM 288-pin (Compatible Placas Intel LGA1700/1851 & AMD AM5)' },
  { pattern: /(fury|vengeance|ripjaws|t-force|xpg|crucial|ballistix|hyperx|kingston|corsair).*(ddr4|3200|2666|2400|3000|3600|4000)/i, brand: 'Memoria RAM', type: 'Memoria RAM', cpu: 'N/A (Módulo de Memoria RAM)', ram: '8 GB / 16 GB / 32 GB DDR4 (2400MHz - 3600MHz CL16/CL18 XMP 2.0)', storage: 'Disipador Térmico de Aluminio (1.2V - 1.35V)', motherboard: 'Formato DIMM 288-pin (Compatible Placas Intel LGA1200/1151 & AMD AM4)' },
  { pattern: /(ddr3|1600mhz|1333mhz|1866mhz)/i, brand: 'Memoria RAM', type: 'Memoria RAM', cpu: 'N/A (Módulo de Memoria RAM)', ram: '4 GB / 8 GB DDR3 / DDR3L (1333MHz - 1600MHz)', storage: '1.5V / 1.35V Bajo Voltaje', motherboard: 'Formato DIMM 240-pin / SO-DIMM 204-pin' },

  // ==========================================
  // DISCOS Y ALMACENAMIENTO INDEPENDIENTE (SSD NVMe M.2, SSD SATA, HDD)
  // ==========================================
  { pattern: /(990\s*pro|980\s*pro|970\s*evo|sn850x|sn770|kc3000|fury\s*renegade|p5\s*plus|t500|legend\s*960|nm790)/i, brand: 'Almacenamiento', type: 'Disco / Almacenamiento', cpu: 'Controlador NVMe PCIe Gen4/Gen5 x4', ram: 'DRAM Cache LPDDR4 / HMB', storage: '500 GB / 1 TB / 2 TB / 4 TB SSD NVMe M.2 2280 (Hasta 7400 MB/s)', motherboard: 'Interfaz M.2 PCIe NVMe (M-Key 2280)' },
  { pattern: /(nv2|sn580|sn570|p3\s*plus|p3|legend\s*800|sx8200|mp600)/i, brand: 'Almacenamiento', type: 'Disco / Almacenamiento', cpu: 'Controlador NVMe PCIe Gen3/Gen4 x4', ram: 'Host Memory Buffer (HMB)', storage: '250 GB / 500 GB / 1 TB / 2 TB SSD M.2 NVMe (Hasta 3500-5000 MB/s)', motherboard: 'Interfaz M.2 PCIe NVMe (M-Key 2280)' },
  { pattern: /(a400|kc600|bx500|mx500|870\s*evo|870\s*qvo|wd\s*green|wd\s*blue\s*sata|sandisk\s*ssd)/i, brand: 'Almacenamiento', type: 'Disco / Almacenamiento', cpu: 'Controlador SATA III 6Gb/s', ram: 'DRAM Cache / Cache SLC', storage: '120 GB / 240 GB / 480 GB / 960 GB / 1 TB / 2 TB SSD SATA 2.5" (Hasta 550 MB/s)', motherboard: 'Interfaz SATA III 6.0 Gb/s (7mm Factor de Forma 2.5")' },
  { pattern: /(barracuda|ironwolf|skyhawk|wd\s*purple|wd\s*black|wd\s*red|wd\s*blue|toshiba\s*p300)/i, brand: 'Almacenamiento', type: 'Disco / Almacenamiento', cpu: 'Controlador de Disco Magnético Mecánico', ram: '64 MB / 128 MB / 256 MB Cache Buffer', storage: '1 TB / 2 TB / 4 TB / 6 TB / 8 TB / 12 TB / 16 TB HDD SATA 3.5" (5400 / 7200 RPM)', motherboard: 'Interfaz SATA III 6.0 Gb/s (Factor de Forma 3.5" / 2.5")' },

  // ==========================================
  // PROCESADORES (CPUs) INDEPENDIENTES
  // ==========================================
  { pattern: /(i9[- ]?14900|i9[- ]?13900|i7[- ]?14700|i7[- ]?13700|i5[- ]?14600|i5[- ]?13600|i5[- ]?13400)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 13va/14va Gen Raptor Lake Refresh (10 a 24 Núcleos, hasta 6.0GHz Turbo)', ram: 'Soporte Dual Channel DDR5-5600 / DDR4-3200', storage: 'Intel Smart Cache 20MB a 36MB (PCIe 5.0 x16)', motherboard: 'Socket Intel LGA 1700 (Chipsets B760, Z790, B660, Z690)' },
  { pattern: /(i7[- ]?12700|i5[- ]?12600|i5[- ]?12400|i3[- ]?12100)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 12va Gen Alder Lake (4 a 12 Núcleos, hasta 4.90GHz Turbo)', ram: 'Soporte DDR5 / DDR4 (PCIe Gen5)', storage: 'Intel Smart Cache 12MB a 25MB', motherboard: 'Socket Intel LGA 1700 (Chipsets H610, B660, Z690, B760)' },
  { pattern: /(i7[- ]?1[01]700|i5[- ]?1[01]400|i3[- ]?10100)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 10ma/11va Gen Comet Lake / Rocket Lake (4 a 8 Núcleos, hasta 5.0GHz)', ram: 'Soporte DDR4-2666 / DDR4-3200', storage: 'Intel Smart Cache 8MB a 16MB', motherboard: 'Socket Intel LGA 1200 (Chipsets H410, B460, Z490, H510, B560, Z590)' },
  { pattern: /(i7[- ]?[89]700|i5[- ]?[89]400|i3[- ]?[89]100)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 8va/9na Gen Coffee Lake (4 a 8 Núcleos, hasta 4.7GHz)', ram: 'Soporte DDR4-2400 / DDR4-2666', storage: 'Intel Smart Cache 6MB a 12MB', motherboard: 'Socket Intel LGA 1151 v2 (Chipsets H310, B360, B365, Z390)' },
  { pattern: /(i7[- ]?[67]700|i5[- ]?[67]400|i3[- ]?[67]100)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 6ta/7ma Gen Skylake / Kaby Lake (2 a 4 Núcleos, 4/8 Hilos)', ram: 'Soporte DDR4 / DDR3L', storage: 'Intel Smart Cache 3MB a 8MB', motherboard: 'Socket Intel LGA 1151 v1 (Chipsets H110, B150, B250, Z170, Z270)' },
  { pattern: /(i7[- ]?4790|i5[- ]?4590|i5[- ]?4460|i3[- ]?4160)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 4ta Gen Haswell Refresh (2 a 4 Núcleos, hasta 4.0GHz)', ram: 'Soporte Dual Channel DDR3-1600', storage: 'Intel Smart Cache 3MB a 8MB', motherboard: 'Socket Intel LGA 1150 (Chipsets H81, B85, H87, Z97)' },
  { pattern: /(i7[- ]?3770|i5[- ]?3470|i7[- ]?2600|i5[- ]?2400|core\s*2\s*quad)/i, brand: 'Intel', type: 'Procesador (CPU)', cpu: 'Intel Core 2da/3ra Gen Sandy Bridge / Ivy Bridge (2 a 4 Núcleos @ 3.40GHz)', ram: 'Soporte DDR3-1333 / 1600', storage: 'Intel Smart Cache 6MB a 8MB', motherboard: 'Socket Intel LGA 1155 (Chipsets H61, B75, Z68, Z77)' },
  { pattern: /(ryzen\s*9\s*9950x|ryzen\s*9\s*7950x|ryzen\s*7\s*9800x3d|ryzen\s*7\s*7800x3d|ryzen\s*7\s*7700|ryzen\s*5\s*7600)/i, brand: 'AMD Ryzen', type: 'Procesador (CPU)', cpu: 'AMD Ryzen Serie 7000/9000 Zen 4 / Zen 5 (6 a 16 Núcleos, 3D V-Cache hasta 5.7GHz)', ram: 'Soporte Dual Channel DDR5 (AMD EXPO)', storage: 'Cache L3 hasta 96MB (PCIe 5.0 x16)', motherboard: 'Socket AMD AM5 (Chipsets A620, B650, X670, B850, X870)' },
  { pattern: /(ryzen\s*9\s*5900|ryzen\s*7\s*5800x3d|ryzen\s*7\s*5700x|ryzen\s*5\s*5600x|ryzen\s*5\s*5600g|ryzen\s*5\s*5500)/i, brand: 'AMD Ryzen', type: 'Procesador (CPU)', cpu: 'AMD Ryzen Serie 5000 Zen 3 Architecture (6 a 16 Núcleos, hasta 4.90GHz Turbo)', ram: 'Soporte Dual Channel DDR4-3200', storage: 'Cache L3 16MB a 96MB (PCIe 4.0)', motherboard: 'Socket AMD AM4 (Chipsets A520, B450, B550, X570)' },
  { pattern: /(ryzen\s*5\s*3600|ryzen\s*5\s*2600|ryzen\s*5\s*1600|ryzen\s*3\s*3200g|ryzen\s*3\s*2200g)/i, brand: 'AMD Ryzen', type: 'Procesador (CPU)', cpu: 'AMD Ryzen Serie 1000/2000/3000 Zen / Zen 2 (4 a 8 Núcleos, hasta 4.2GHz)', ram: 'Soporte Dual Channel DDR4 (2666-3200MHz)', storage: 'Cache L3 4MB a 32MB', motherboard: 'Socket AMD AM4 (Chipsets A320, B350, B450, X470)' },

  // ==========================================
  // PLACAS BASE / MOTHERBOARDS INDEPENDIENTES
  // ==========================================
  { pattern: /(tuf\s*gaming\s*b760|rog\s*strix\s*b760|prime\s*b760|mag\s*b760|b760m\s*ds3h|b760)/i, brand: 'Placa Base', type: 'Placa Base', cpu: 'Socket Intel LGA 1700 (Soporte Intel 12va, 13va y 14va Gen)', ram: '4x Ranuras DDR5 / DDR4 (Hasta 128GB / 192GB XMP)', storage: '2x-3x Ranuras M.2 PCIe 4.0 NVMe + 4x SATA III', motherboard: 'Placa Base Chipset Intel B760 (VRM Disipado, PCIe 5.0/4.0 x16, 2.5Gb LAN)' },
  { pattern: /(z790|z690|z890)/i, brand: 'Placa Base', type: 'Placa Base', cpu: 'Socket Intel LGA 1700 / LGA 1851 (Overclocking K-Series)', ram: '4x DDR5 Dual Channel (Hasta 8000+ MHz OC)', storage: '4x-5x Ranuras M.2 PCIe Gen4/Gen5 + 6x SATA III', motherboard: 'Placa Base Enthusiast Chipset Intel Z790/Z890 (Wi-Fi 6E/7, PCIe 5.0, Thunderbolt 4)' },
  { pattern: /(b650|b650m|x670|x870|a620)/i, brand: 'Placa Base', type: 'Placa Base', cpu: 'Socket AMD AM5 (Soporte AMD Ryzen Serie 7000, 8000 y 9000)', ram: '4x Ranuras DDR5 Dual Channel (AMD EXPO hasta 6400+ MHz)', storage: '2x-3x Ranuras M.2 PCIe 5.0/4.0 NVMe + 4x SATA', motherboard: 'Placa Base Chipset AMD B650/X870 (VRM Digital, PCIe 5.0 x16, 2.5Gb LAN, Wi-Fi 6E)' },
  { pattern: /(b550|b550m|b450|b450m|a520|a520m|x570|a320)/i, brand: 'Placa Base', type: 'Placa Base', cpu: 'Socket AMD AM4 (Soporte AMD Ryzen Serie 1000 a 5000 / 5000X3D)', ram: '2x/4x Ranuras DDR4 Dual Channel (Hasta 128GB 3600MHz)', storage: '1x-2x Ranuras M.2 NVMe PCIe 4.0/3.0 + 4x SATA III', motherboard: 'Placa Base Chipset AMD B550/B450 (PCIe 4.0 x16, Gigabit LAN, Audio HD)' },
  { pattern: /(h610|h510|h410|h310|h110|h81|h61)/i, brand: 'Placa Base', type: 'Placa Base', cpu: 'Socket Intel (LGA 1700 / 1200 / 1151 / 1150 / 1155)', ram: '2x Ranuras DDR4 / DDR3 (Hasta 32GB/64GB Dual Channel)', storage: '1x Ranura M.2 NVMe + 4x SATA III', motherboard: 'Placa Base Chipset Intel Serie H (Factor Micro-ATX, Salidas HDMI/VGA)' },

  // ==========================================
  // FUENTES DE PODER (PSU) INDEPENDIENTES
  // ==========================================
  { pattern: /(rm1000|rm850|rm750|rm650|cx650|cv550|supernova|focus\s*gx|mwe\s*gold|toughpower|smart\s*600|kiris|rpbs)/i, brand: 'Fuente de Poder', type: 'Fuente de Poder (PSU)', cpu: 'N/A (Unidad de Suministro de Energía)', ram: 'Protecciones OVP, UVP, OCP, OPP, SCP, OTP', storage: 'Cables Mallados / Full Modular / Semi Modular', motherboard: 'Fuente de Poder ATX 500W a 1000W (Certificación 80 Plus Bronce / Gold / Platino)' },

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
  if (/nvidia/i.test(combinedText)) brand = 'NVIDIA';
  else if (/amd|radeon/i.test(combinedText)) brand = 'AMD';
  else if (/intel/i.test(combinedText)) brand = 'Intel';
  else if (/kingston|hyperx|fury/i.test(combinedText)) brand = 'Kingston';
  else if (/corsair/i.test(combinedText)) brand = 'Corsair';
  else if (/samsung/i.test(combinedText)) brand = 'Samsung';
  else if (/crucial|ballistix|micron/i.test(combinedText)) brand = 'Crucial';
  else if (/western\s*digital|wd/i.test(combinedText)) brand = 'Western Digital';
  else if (/seagate/i.test(combinedText)) brand = 'Seagate';
  else if (/g\.?skill/i.test(combinedText)) brand = 'G.Skill';
  else if (/adata|xpg/i.test(combinedText)) brand = 'Adata';
  else if (/teamgroup|t-force/i.test(combinedText)) brand = 'TeamGroup';
  else if (/msi/i.test(combinedText)) brand = 'MSI';
  else if (/asus|rog|tuf/i.test(combinedText)) brand = 'ASUS';
  else if (/gigabyte|aorus/i.test(combinedText)) brand = 'Gigabyte';
  else if (/asrock/i.test(combinedText)) brand = 'ASRock';
  else if (/evga/i.test(combinedText)) brand = 'EVGA';
  else if (/zotac/i.test(combinedText)) brand = 'ZOTAC';
  else if (/sapphire/i.test(combinedText)) brand = 'Sapphire';
  else if (/seasonic/i.test(combinedText)) brand = 'Seasonic';
  else if (/cooler\s*master/i.test(combinedText)) brand = 'Cooler Master';
  else if (/thermaltake/i.test(combinedText)) brand = 'Thermaltake';
  else if (/cisco/i.test(combinedText)) brand = 'Cisco';
  else if (/mikrotik/i.test(combinedText)) brand = 'MikroTik';
  else if (/tp[- ]?link|omada|jetstream/i.test(combinedText)) brand = 'TP-Link';
  else if (/ubiquiti|unifi/i.test(combinedText)) brand = 'Ubiquiti';
  else if (/dell|poweredge|optiplex|latitude/i.test(combinedText)) brand = 'Dell';
  else if (/hp|proliant|prodesk|elitedesk|probook|elitebook|laserjet/i.test(combinedText)) brand = 'HP';
  else if (/lenovo|thinkpad|thinkcentre|thinksystem/i.test(combinedText)) brand = 'Lenovo';
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
  if (/geforce|radeon|rtx|gtx|quadro|intel\s*arc|graphics|video\s*card|tarjeta\s*de\s*video|gpu/i.test(combinedText)) type = 'Tarjeta de Video (GPU)';
  else if (/ddr5|ddr4|ddr3|ram|memoria\s*ram|dimm|so-dimm|vengeance|fury\s*beast/i.test(combinedText)) type = 'Memoria RAM';
  else if (/ssd|nvme|m\.2|sata|hdd|disco\s*duro|almacenamiento|barracuda|ironwolf|990\s*pro|980\s*pro|a400|nv2|nv3|sn580|sn570|sn770|sn850/i.test(combinedText)) type = 'Disco / Almacenamiento';
  else if (/intel\s*core|ryzen|core\s*i[3579]|threadripper|xeon|procesador|cpu/i.test(combinedText)) type = 'Procesador (CPU)';
  else if (/motherboard|placa\s*madre|placa\s*base|mainboard|b760|b650|b550|z790|z690|h610|h510/i.test(combinedText)) type = 'Placa Base';
  else if (/fuente\s*de\s*poder|psu|power\s*supply|80\s*plus|modular/i.test(combinedText)) type = 'Fuente de Poder (PSU)';
  else if (/monitor|pantalla|display|ultragear|viewfinity/i.test(combinedText)) type = 'Monitor / Pantalla';
  else if (/mouse|raton|teclado|keyboard|audifono|headset/i.test(combinedText)) type = 'Teclado / Mouse / Periférico';
  else if (/switch|catalyst|managed|rackmount|ports|puertos\s*gigabit/i.test(combinedText)) type = 'Switch de Red';
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

  if (type === 'Tarjeta de Video (GPU)') {
    cpu = `${brand} Graphics Processing Unit (GPU Dedicada)`;
    ram = 'VRAM Dedicada (GDDR6 / GDDR6X / GDDR5)';
    storage = 'Interfaz PCIe x16 (DirectX 12 Ultimate / Vulkan / Ray Tracing)';
    motherboard = 'Tarjeta Gráfica Dedicada (Salidas DisplayPort / HDMI)';
  } else if (type === 'Memoria RAM') {
    cpu = 'N/A (Módulo de Memoria)';
    ram = `${brand} Memoria RAM (DDR4 / DDR5 High Speed)`;
    storage = 'Disipador Térmico / Perfil XMP / EXPO';
    motherboard = 'Formato DIMM / SO-DIMM Estándar JEDEC';
  } else if (type === 'Disco / Almacenamiento') {
    cpu = 'Controlador de Almacenamiento';
    ram = 'Cache DRAM / SLC Buffer';
    storage = `${brand} Unidad de Almacenamiento (SSD NVMe / SATA / HDD)`;
    motherboard = 'Interfaz M.2 PCIe / SATA III 6.0Gb/s';
  } else if (type === 'Procesador (CPU)') {
    cpu = `${brand} Procesador Multi-Core (Arquitectura Alto Rendimiento)`;
    ram = 'Controlador de Memoria Integrado Dual Channel';
    storage = 'Memoria Cache L2 / L3 Integrada';
    motherboard = `Socket Compatible ${brand}`;
  } else if (type === 'Placa Base') {
    cpu = 'Socket de Procesador Multi-Generación';
    ram = 'Ranuras de Memoria RAM Dual Channel';
    storage = 'Puertos M.2 NVMe PCIe + SATA III';
    motherboard = `${brand} Placa Base / Mainboard`;
  } else if (type === 'Fuente de Poder (PSU)') {
    cpu = 'N/A (Suministro de Energía Eléctrica)';
    ram = 'Protecciones Eléctricas OVP / UVP / OCP / SCP';
    storage = 'Cableado ATX / EPS / PCIe / SATA';
    motherboard = `${brand} Fuente de Poder ATX (Certificación 80 Plus)`;
  } else if (type === 'Switch de Red') {
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
    if (/i7[- ]?1[1234].../i.test(combinedText)) cpu = 'Intel Core i7 (11va a 14va Gen) @ 2.80GHz-5.00GHz (8+ Núcleos)';
    else if (/i7[- ]?[89].../i.test(combinedText)) cpu = 'Intel Core i7 (8va/9na Gen) @ 3.00GHz (6/8 Núcleos)';
    else if (/i5[- ]?1[1234].../i.test(combinedText)) cpu = 'Intel Core i5 (11va a 14va Gen) @ 2.40GHz-4.60GHz (6 a 14 Núcleos)';
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
    source: onlineSnippet ? 'Internet & Base de Datos Global' : 'Inferencia Inteligente de Hardware',
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

// Crear registro manual (Bloqueado para observador)
app.post('/api/inventory', async (req, res) => {
  const userInfo = getUserInfo(req);
  if (userInfo.role === 'observador') {
    return res.status(403).json({ error: 'Acceso denegado: El usuario observador solo tiene permisos de visualización y no puede crear registros.' });
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
    mac_ethernet: body.mac_ethernet || '',
    mac_wifi: body.mac_wifi || '',
    mac_bluetooth: body.mac_bluetooth || '',
    mac_address: body.mac_address || [body.mac_ethernet, body.mac_wifi, body.mac_bluetooth].filter(Boolean).join(' | '),
    ip_red: body.ip_red || '',
    usuario_actual: body.usuario_actual || '',
    ubicacion: body.ubicacion || 'Sin asignar',
    estado: body.estado || 'Operativo',
    consumible: body.consumible || body.tinta_toner || '',
    notas: body.notas || '',
    creado_por: userInfo.username || 'admin',
    creado_por_badge: userInfo.badge || (userInfo.role === 'admin' ? 'platinum' : (userInfo.role === 'gold_admin' ? 'gold' : 'bronze')),
    creado_por_rol: userInfo.role || 'admin',
    creado_por_nombre: userInfo.displayName || userInfo.username || 'Admin',
    fecha_escaneo: new Date().toISOString().replace('T', ' ').substring(0, 19),
    origen: 'Manual'
  };
  
  items.unshift(newItem);
  await saveDB(items);
  
  res.status(201).json({ message: 'Equipo registrado exitosamente', item: newItem });
});

// Actualizar equipo (Bloqueado para observador)
app.put('/api/inventory/:id', async (req, res) => {
  const userInfo = getUserInfo(req);
  if (userInfo.role === 'observador') {
    return res.status(403).json({ error: 'Acceso denegado: El usuario observador solo tiene permisos de visualización y no puede editar registros.' });
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
    modificado_por: userInfo.username || 'admin',
    modificado_por_badge: userInfo.badge || 'gold',
    fecha_modificacion: new Date().toISOString().replace('T', ' ').substring(0, 19)
  };
  
  items[index] = updated;
  await saveDB(items);
  
  res.json({ message: 'Equipo actualizado exitosamente', item: updated });
});

// Eliminar equipo (SOLO permitido para Administrador Platinum / Super Admin)
app.delete('/api/inventory/:id', async (req, res) => {
  const userInfo = getUserInfo(req);
  if (!userInfo.canDelete || userInfo.role !== 'admin') {
    return res.status(403).json({ 
      error: 'Acceso denegado: Solo el Administrador Platinum tiene permisos para eliminar registros. Los Administradores Gold y Observadores no pueden borrar registros.' 
    });
  }

  let items = loadDB();
  const rawId = req.params.id;
  const decodedId = decodeURIComponent(rawId);
  const initialLen = items.length;
  
  items = items.filter(i => i.id !== rawId && i.id !== decodedId);
  
  if (items.length === initialLen) {
    return res.status(404).json({ error: 'Equipo no encontrado' });
  }
  
  await saveDB(items);
  res.json({ message: 'Equipo eliminado exitosamente' });
});

// Endpoint receptor para el Agente Escaneador de Hardware (.bat / PowerShell)
app.post('/api/agent/report', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.modelo) {
      return res.status(400).json({ error: 'Payload de escaneo inválido' });
    }
    
    const items = loadDB();
    
    const serialNormalized = (payload.numero_serie || '').trim();
    const macNormalized = (payload.mac_address || '').trim().toLowerCase();
    const ethMacNorm = (payload.mac_ethernet || '').trim().toLowerCase();
    const wifiMacNorm = (payload.mac_wifi || '').trim().toLowerCase();
    const btMacNorm = (payload.mac_bluetooth || '').trim().toLowerCase();
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

    // 2. Si el serial es genérico o no coincidió, buscar por intersección de MAC Address física (Ethernet, Wi-Fi o Bluetooth)
    const reportMacs = [
      ethMacNorm,
      wifiMacNorm,
      btMacNorm,
      ...(macNormalized ? macNormalized.split(/[\s|,]+/) : [])
    ].map(m => m.trim().toLowerCase()).filter(m => m.length >= 12 && m !== 'n/a');

    if (existingIndex === -1 && reportMacs.length > 0) {
      existingIndex = items.findIndex(i => {
        const itemMacs = [
          (i.mac_ethernet || '').trim().toLowerCase(),
          (i.mac_wifi || '').trim().toLowerCase(),
          (i.mac_bluetooth || '').trim().toLowerCase(),
          ...((i.mac_address || '').trim().toLowerCase().split(/[\s|,]+/))
        ].map(m => m.trim().toLowerCase()).filter(m => m.length >= 12 && m !== 'n/a');
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

    // Resolver usuario y categoría del auditor que disparó el escáner
    const rawCreator = (payload.creado_por || payload.registrado_por || payload.usuario_scanner || payload.creado_por_nombre || 'Administrador').trim();
    let creatorUser = rawCreator;
    let creatorBadge = 'platinum';
    let creatorRole = 'admin';
    let creatorCat = 'Platinum';

    const matchedUser = USERS.find(u => u.username.toLowerCase() === rawCreator.toLowerCase());
    if (matchedUser) {
      creatorUser = matchedUser.displayName || matchedUser.username;
      creatorBadge = matchedUser.badge;
      creatorRole = matchedUser.role;
      creatorCat = matchedUser.categoria;
    } else if (/^(tayron|cristian|david)$/i.test(rawCreator)) {
      creatorUser = rawCreator.charAt(0).toUpperCase() + rawCreator.slice(1).toLowerCase();
      creatorBadge = 'gold';
      creatorRole = 'gold_admin';
      creatorCat = 'Golden';
    } else if (/^(user|observador)$/i.test(rawCreator)) {
      creatorUser = 'Observador';
      creatorBadge = 'bronze';
      creatorRole = 'observador';
      creatorCat = 'Bronce';
    } else {
      creatorUser = 'Administrador';
      creatorBadge = 'platinum';
      creatorRole = 'admin';
      creatorCat = 'Platinum';
    }

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
      creado_por: (existingIndex >= 0 && items[existingIndex].creado_por) ? items[existingIndex].creado_por : creatorUser,
      creado_por_nombre: (existingIndex >= 0 && items[existingIndex].creado_por_nombre) ? items[existingIndex].creado_por_nombre : creatorUser,
      creado_por_badge: (existingIndex >= 0 && items[existingIndex].creado_por_badge) ? items[existingIndex].creado_por_badge : creatorBadge,
      creado_por_rol: (existingIndex >= 0 && items[existingIndex].creado_por_rol) ? items[existingIndex].creado_por_rol : creatorRole,
      creado_por_categoria: (existingIndex >= 0 && items[existingIndex].creado_por_categoria) ? items[existingIndex].creado_por_categoria : creatorCat,
      modificado_por: creatorUser,
      modificado_por_badge: creatorBadge,
      modificado_por_categoria: creatorCat,
      sistema_operativo: payload.sistema_operativo || '',
      ip_red: payload.ip_red || '',
      mac_ethernet: payload.mac_ethernet || (existingIndex >= 0 ? items[existingIndex].mac_ethernet : '') || '',
      mac_wifi: payload.mac_wifi || (existingIndex >= 0 ? items[existingIndex].mac_wifi : '') || '',
      mac_bluetooth: payload.mac_bluetooth || (existingIndex >= 0 ? items[existingIndex].mac_bluetooth : '') || '',
      mac_address: payload.mac_address || [payload.mac_ethernet, payload.mac_wifi, payload.mac_bluetooth].filter(Boolean).join(' | '),
      ubicacion: (payload.ubicacion && !/detectado autom[aá]ticamente|sin asignar/i.test(payload.ubicacion)) 
        ? payload.ubicacion 
        : ((existingIndex >= 0 && items[existingIndex].ubicacion && !/detectado autom[aá]ticamente|sin asignar/i.test(items[existingIndex].ubicacion)) ? items[existingIndex].ubicacion : 'Soporte Técnico'),
      estado: existingIndex >= 0 ? (items[existingIndex].estado || 'Operativo') : 'Operativo',
      notas: existingIndex >= 0 ? items[existingIndex].notas : `Registrado por escáner (${creatorUser})`,
      fecha_escaneo: payload.fecha_escaneo || new Date().toISOString().replace('T', ' ').substring(0, 19),
      origen: 'Escáner Batch/PowerShell'
    };
    
    if (existingIndex >= 0) {
      items[existingIndex] = record;
    } else {
      items.unshift(record);
    }
    
    await saveDB(items);
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
app.post('/api/restore-json', async (req, res) => {
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
    await saveDB(merged);

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

// Exportación a Excel con hojas separadas por categoría y tipo de hardware (Bloqueado para Observador)
app.get('/api/export-excel', async (req, res) => {
  try {
    const userInfo = getUserInfo(req);
    if (userInfo.role === 'observador' || userInfo.role === 'operador') {
      return res.status(403).json({ 
        error: 'Acceso denegado: El usuario Observador solo tiene permisos de visualización y no puede exportar el inventario en Excel.' 
      });
    }

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
        let maxLines = 1;
        row.eachCell((cell) => {
          const val = cell.value ? cell.value.toString() : '';
          const lineCount = val.split(/\r\n|\r|\n/).length;
          if (lineCount > maxLines) maxLines = lineCount;
        });
        row.height = Math.max(26, maxLines * 20);
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

    // Función para simplificar y limpiar la información del disco: Marca Modelo (S/N: Serial)
    const formatCleanDisk = (rawModel, rawSerial, rawCap) => {
      let model = (rawModel || '').trim();
      let serial = (rawSerial || '').trim();

      // Si el modelo contiene el serial empaquetado (ej: "KBG60ZNV512G KIOXIA (477 GB, S/N: ...)")
      if (!serial && model.includes('S/N:')) {
        const sMatch = model.match(/S\/N:\s*([^)]+)/i);
        if (sMatch) {
          serial = sMatch[1].trim();
          model = model.replace(/\s*\([^)]*S\/N:[^)]*\)/i, '').trim();
        }
      }

      if (!model && rawCap) {
        model = rawCap;
      }

      // 1. Limpiar Número de Serie
      serial = serial.replace(/[._\s\r\n]+$/, '').trim();

      // Si el serial tiene padding de ceros como 0000_0000_... o 0000 0000 ...
      if (/(?:0000[_ ]+){2,}/i.test(serial)) {
        serial = serial.replace(/^(?:0000[_ ]+)+/i, '');
      }

      // Si tiene saltos de línea internos o espacios múltiples
      serial = serial.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (/\b[0-9A-Fa-f]{4}\s+[0-9A-Fa-f]{4}\b/.test(serial)) {
        serial = serial.replace(/\s+/g, '');
      }
      serial = serial.replace(/\.+$/g, '').trim();

      // 2. Limpiar Marca y Modelo
      let brand = '';
      let cleanModel = model;

      // Remover sufijos y capacidades crudas del nombre del modelo
      cleanModel = cleanModel.replace(/-\s*\d+\s*(?:GB|TB)/i, '').trim();
      cleanModel = cleanModel.replace(/\b\d+\s*(?:GB|TB)\b/i, '').trim();
      cleanModel = cleanModel.replace(/SDEPNSJ[\w-]+/i, '').trim();

      if (/kioxia/i.test(cleanModel)) {
        brand = 'KIOXIA';
        cleanModel = cleanModel.replace(/kioxia/i, '').trim();
      } else if (/sk\s*hynix/i.test(cleanModel)) {
        brand = 'SK HYNIX';
        cleanModel = cleanModel.replace(/sk\s*hynix/i, '').replace(/pvc\d+/i, '').trim();
      } else if (/kingston/i.test(cleanModel)) {
        brand = 'KINGSTON';
        cleanModel = cleanModel.replace(/kingston/i, '').trim();
      } else if (/lexar/i.test(cleanModel)) {
        brand = 'LEXAR';
        cleanModel = cleanModel.replace(/lexar/i, '').replace(/ssd/i, '').trim();
      } else if (/samsung/i.test(cleanModel)) {
        brand = 'SAMSUNG';
        cleanModel = cleanModel.replace(/samsung/i, '').replace(/ssd/i, '').trim();
      } else if (/wdc|western\s*digital|wd\b|sn5000|sn850|sn770|sn580|sn570/i.test(cleanModel)) {
        brand = 'WESTERN DIGITAL';
        cleanModel = cleanModel.replace(/wdc\s*/i, '').replace(/western\s*digital\s*/i, '').trim();
      } else if (/st\d{4}dm|st\d{3}dm|seagate|barracuda/i.test(cleanModel)) {
        brand = 'SEAGATE';
        cleanModel = cleanModel.replace(/seagate\s*/i, '').trim();
      } else if (/crucial|micron/i.test(cleanModel)) {
        brand = 'CRUCIAL';
        cleanModel = cleanModel.replace(/crucial\s*/i, '').replace(/micron\s*/i, '').trim();
      } else if (/adata|xpg/i.test(cleanModel)) {
        brand = 'ADATA';
        cleanModel = cleanModel.replace(/adata\s*/i, '').trim();
      } else if (/toshiba/i.test(cleanModel)) {
        brand = 'TOSHIBA';
        cleanModel = cleanModel.replace(/toshiba\s*/i, '').trim();
      } else if (/hp\b/i.test(cleanModel)) {
        brand = 'HP';
        cleanModel = cleanModel.replace(/hp\s*/i, '').trim();
      }

      cleanModel = cleanModel.replace(/-\w{5,8}$/, '').trim();
      cleanModel = cleanModel.replace(/\s+/g, ' ').trim();

      let finalName = brand ? `${brand} ${cleanModel}`.trim() : cleanModel;
      finalName = finalName.toUpperCase();

      const serialStr = (serial && serial !== 'N/A' && serial !== 'NONE') ? ` (S/N: ${serial.toUpperCase()})` : '';
      return `${finalName}${serialStr}`;
    };

    // Función para obtener detalles de red separados (IP, MAC Ethernet, MAC Wi-Fi, MAC Bluetooth)
    const getNetworkDetails = (item) => {
      let ip = '';
      if (item.ip_red) {
        // Filtrar estrictamente solo direcciones IPv4 válidas (descartando IPv6 como FE80::... o FD20::...)
        const ipv4Matches = String(item.ip_red).match(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g);
        if (ipv4Matches && ipv4Matches.length > 0) {
          const validIps = ipv4Matches.filter(ipStr => !ipStr.startsWith('127.') && !ipStr.startsWith('169.254.'));
          ip = (validIps.length > 0 ? validIps : ipv4Matches).join(' | ');
        }
      }
      ip = toUpper(ip || 'N/A');
      if (ip === '' || ip === 'NULL' || ip === 'UNDEFINED') ip = 'N/A';

      let macEth = item.mac_ethernet ? String(item.mac_ethernet).trim() : '';
      let macWifi = item.mac_wifi ? String(item.mac_wifi).trim() : '';
      let macBt = item.mac_bluetooth ? String(item.mac_bluetooth).trim() : '';

      // Fallback si el equipo fue registrado antes y solo tiene mac_address legacy
      if ((!macEth || macEth === 'N/A') && (!macWifi || macWifi === 'N/A') && (!macBt || macBt === 'N/A') && item.mac_address) {
        const rawMacs = String(item.mac_address).split(/[\s|,\n]+/).map(m => m.trim().toUpperCase()).filter(m => m.length >= 12 && m !== 'N/A');
        if (rawMacs.length === 1) {
          if (/wifi|access point|router|laptop|notebook|port[aá]til/i.test(item.tipo_equipo || '')) {
            macWifi = rawMacs[0];
          } else {
            macEth = rawMacs[0];
          }
        } else if (rawMacs.length === 2) {
          macEth = rawMacs[0];
          macWifi = rawMacs[1];
        } else if (rawMacs.length >= 3) {
          macEth = rawMacs[0];
          macWifi = rawMacs[1];
          macBt = rawMacs[2];
        }
      }

      // Fallback si el serial fue generado como MAC-XXXXXXXXXXXX
      if ((!macEth || macEth === 'N/A') && (!macWifi || macWifi === 'N/A') && (!macBt || macBt === 'N/A')) {
        if (item.numero_serie && /^MAC-[0-9a-fA-F]{12}$/i.test(item.numero_serie)) {
          const rawHex = item.numero_serie.replace(/^MAC-/i, '');
          const formatted = rawHex.replace(/..(?!$)/g, '$&:').toUpperCase();
          if (/laptop|notebook|port[aá]til/i.test(item.tipo_equipo || '')) {
            macWifi = formatted;
          } else {
            macEth = formatted;
          }
        }
      }

      return {
        ip: ip,
        mac_ethernet: macEth ? toUpper(macEth) : 'N/A',
        mac_wifi: macWifi ? toUpper(macWifi) : 'N/A',
        mac_bluetooth: macBt ? toUpper(macBt) : 'N/A'
      };
    };

    // -------------------------------------------------------------
    // HOJA 1: RESUMEN GENERAL EJECUTIVO
    // -------------------------------------------------------------
    const wsResumen = workbook.addWorksheet('RESUMEN GENERAL', { views: [{ showGridLines: true }] });
    styleWorksheet(wsResumen, [
      { header: 'CATEGORÍA / TIPO', key: 'categoria', width: 32 },
      { header: 'TOTAL AUDITADOS', key: 'total', width: 20 },
      { header: 'OPERATIVOS', key: 'operativos', width: 18 },
      { header: 'EN USO', key: 'en_uso', width: 18 },
      { header: 'EN BODEGA / STOCK', key: 'en_bodega', width: 22 },
      { header: 'EN MANTENIMIENTO', key: 'mantenimiento', width: 22 },
      { header: 'DE BAJA', key: 'de_baja', width: 18 }
    ]);

    // -------------------------------------------------------------
    // HOJA 2: CASE & SERVIDORES (PCs de Escritorio, All-in-One, Mini PCs, Servidores)
    // -------------------------------------------------------------
    const wsCase = workbook.addWorksheet('CASE Y SERVIDORES', { views: [{ showGridLines: true }] });
    styleWorksheet(wsCase, [
      { header: 'HOSTNAME', key: 'hostname', width: 24 },
      { header: 'USUARIO / CUSTODIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'MODELO EQUIPO', key: 'modelo', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'PLACA BASE', key: 'placa_base', width: 24 },
      { header: 'PROCESADOR', key: 'procesador', width: 34 },
      { header: 'MEMORIA RAM', key: 'ram', width: 20 },
      { header: 'DISCOS / SSD', key: 'almacenamiento', width: 38 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 22 },
      { header: 'MAC ETHERNET', key: 'mac_ethernet', width: 22 },
      { header: 'MAC WI-FI', key: 'mac_wifi', width: 22 },
      { header: 'MAC BLUETOOTH', key: 'mac_bluetooth', width: 22 },
      { header: 'FECHA Y HORA', key: 'fecha', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 3: LAPTOPS
    // -------------------------------------------------------------
    const wsLaptops = workbook.addWorksheet('LAPTOPS', { views: [{ showGridLines: true }] });
    styleWorksheet(wsLaptops, [
      { header: 'HOSTNAME', key: 'hostname', width: 24 },
      { header: 'USUARIO / DOCENTE', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'MODELO LAPTOP', key: 'modelo', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'PROCESADOR', key: 'procesador', width: 34 },
      { header: 'MEMORIA RAM', key: 'ram', width: 20 },
      { header: 'DISCOS / SSD', key: 'almacenamiento', width: 38 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 22 },
      { header: 'MAC ETHERNET', key: 'mac_ethernet', width: 22 },
      { header: 'MAC WI-FI', key: 'mac_wifi', width: 22 },
      { header: 'MAC BLUETOOTH', key: 'mac_bluetooth', width: 22 },
      { header: 'FECHA Y HORA', key: 'fecha', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 4: TARJETAS DE VIDEO DEDICADAS (GPU)
    // -------------------------------------------------------------
    const wsGPU = workbook.addWorksheet('TARJETAS DE VIDEO (GPU)', { views: [{ showGridLines: true }] });
    styleWorksheet(wsGPU, [
      { header: 'MODELO DE GPU / TARJETA', key: 'modelo', width: 32 },
      { header: 'ENSAMBLADOR / MARCA', key: 'fabricante', width: 22 },
      { header: 'VRAM / MEMORIA', key: 'vram', width: 24 },
      { header: 'INTERFAZ / PUERTOS', key: 'interfaz', width: 30 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'ASIGNADO A / HOST', key: 'asignado', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / BODEGA', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 5: MEMORIAS RAM
    // -------------------------------------------------------------
    const wsRAM = workbook.addWorksheet('MEMORIAS RAM', { views: [{ showGridLines: true }] });
    styleWorksheet(wsRAM, [
      { header: 'MODELO DE MEMORIA', key: 'modelo', width: 30 },
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'CAPACIDAD & VELOCIDAD', key: 'capacidad', width: 26 },
      { header: 'FORMATO / TIPO', key: 'tipo', width: 24 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'ASIGNADO A / HOST', key: 'asignado', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / BODEGA', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 6: DISCOS Y ALMACENAMIENTO
    // -------------------------------------------------------------
    const wsDiscos = workbook.addWorksheet('DISCOS Y SSD', { views: [{ showGridLines: true }] });
    styleWorksheet(wsDiscos, [
      { header: 'MODELO DE DISCO / SSD', key: 'modelo', width: 32 },
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'CAPACIDAD', key: 'capacidad', width: 20 },
      { header: 'TECNOLOGÍA / INTERFAZ', key: 'interfaz', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'ASIGNADO A / HOST', key: 'asignado', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / BODEGA', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 7: PROCESADORES (CPU)
    // -------------------------------------------------------------
    const wsCPU = workbook.addWorksheet('PROCESADORES (CPU)', { views: [{ showGridLines: true }] });
    styleWorksheet(wsCPU, [
      { header: 'MODELO DE PROCESADOR', key: 'modelo', width: 32 },
      { header: 'FABRICANTE (INTEL/AMD)', key: 'fabricante', width: 22 },
      { header: 'NÚCLEOS / FRECUENCIA', key: 'specs', width: 30 },
      { header: 'SOCKET / COMPATIBILIDAD', key: 'socket', width: 24 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'ASIGNADO A / HOST', key: 'asignado', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / BODEGA', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 8: PLACAS BASE
    // -------------------------------------------------------------
    const wsPlacas = workbook.addWorksheet('PLACAS BASE', { views: [{ showGridLines: true }] });
    styleWorksheet(wsPlacas, [
      { header: 'MODELO DE PLACA BASE', key: 'modelo', width: 32 },
      { header: 'FABRICANTE / MARCA', key: 'fabricante', width: 22 },
      { header: 'CHIPSET & SOCKET', key: 'chipset', width: 26 },
      { header: 'FACTOR DE FORMA / RANURAS', key: 'formato', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'ASIGNADO A / HOST', key: 'asignado', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / BODEGA', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 9: FUENTES Y COMPONENTES
    // -------------------------------------------------------------
    const wsFuentes = workbook.addWorksheet('FUENTES Y COMPONENTES', { views: [{ showGridLines: true }] });
    styleWorksheet(wsFuentes, [
      { header: 'COMPONENTE / MODELO', key: 'modelo', width: 32 },
      { header: 'TIPO DE COMPONENTE', key: 'tipo', width: 24 },
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'POTENCIA / ESPECIFICACIÓN', key: 'specs', width: 28 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / BODEGA', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 10: IMPRESORAS
    // -------------------------------------------------------------
    const wsImpresoras = workbook.addWorksheet('IMPRESORAS', { views: [{ showGridLines: true }] });
    styleWorksheet(wsImpresoras, [
      { header: 'EQUIPO / MODELO', key: 'modelo', width: 30 },
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'CONSUMIBLE (TINTA/TÓNER)', key: 'consumible', width: 26 },
      { header: 'NÚMERO DE SERIE', key: 'numero_serie', width: 24 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 22 },
      { header: 'MAC ETHERNET', key: 'mac_ethernet', width: 22 },
      { header: 'MAC WI-FI', key: 'mac_wifi', width: 22 },
      { header: 'MAC BLUETOOTH', key: 'mac_bluetooth', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'RESPONSABLE', key: 'usuario', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 11: PROYECTORES
    // -------------------------------------------------------------
    const wsProyectores = workbook.addWorksheet('PROYECTORES', { views: [{ showGridLines: true }] });
    styleWorksheet(wsProyectores, [
      { header: 'MODELO PROYECTOR', key: 'modelo', width: 30 },
      { header: 'MARCA / FABRICANTE', key: 'fabricante', width: 22 },
      { header: 'NÚMERO DE SERIE (S/N)', key: 'numero_serie', width: 24 },
      { header: 'DIRECCIÓN IP / RED', key: 'ip', width: 22 },
      { header: 'MAC ETHERNET', key: 'mac_ethernet', width: 22 },
      { header: 'MAC WI-FI', key: 'mac_wifi', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE (UBICACIÓN)', key: 'ubicacion', width: 28 },
      { header: 'ESTADO', key: 'estado', width: 16 },
      { header: 'NOTAS / OBSERVACIONES', key: 'notas', width: 30 }
    ]);

    // -------------------------------------------------------------
    // HOJA 12: WIFI Y RED
    // -------------------------------------------------------------
    const wsWifi = workbook.addWorksheet('WIFI Y RED', { views: [{ showGridLines: true }] });
    styleWorksheet(wsWifi, [
      { header: 'DISPOSITIVO / SWITCH / AP', key: 'dispositivo', width: 32 },
      { header: 'MARCA / FABRICANTE', key: 'marca', width: 22 },
      { header: 'DIRECCIÓN IP / RED', key: 'ip', width: 22 },
      { header: 'MAC ETHERNET', key: 'mac_ethernet', width: 22 },
      { header: 'MAC WI-FI', key: 'mac_wifi', width: 22 },
      { header: 'MAC BLUETOOTH', key: 'mac_bluetooth', width: 22 },
      { header: 'NÚMERO DE SERIE (S/N)', key: 'numero_serie', width: 24 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE (UBICACIÓN)', key: 'ubicacion', width: 28 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 13: MONITORES
    // -------------------------------------------------------------
    const wsMonitor = workbook.addWorksheet('MONITORES', { views: [{ showGridLines: true }] });
    styleWorksheet(wsMonitor, [
      { header: 'MONITOR MODELO / MARCA', key: 'monitor', width: 30 },
      { header: 'NÚMERO DE SERIE (S/N)', key: 'serie', width: 24 },
      { header: 'CONECTADO A (HOSTNAME)', key: 'hostname', width: 24 },
      { header: 'USUARIO / CUSTODIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 14: TECLADOS
    // -------------------------------------------------------------
    const wsTeclado = workbook.addWorksheet('TECLADOS', { views: [{ showGridLines: true }] });
    styleWorksheet(wsTeclado, [
      { header: 'TECLADO / MARCA', key: 'dispositivo', width: 32 },
      { header: 'CONECTADO A (HOSTNAME)', key: 'hostname', width: 24 },
      { header: 'USUARIO', key: 'usuario', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'AULA / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // -------------------------------------------------------------
    // HOJA 15: MOUSE
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
    // HOJA 16: AUDÍFONOS
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
    // HOJA 17: INVENTARIO CONSOLIDADO TOTAL
    // -------------------------------------------------------------
    const wsTotal = workbook.addWorksheet('INVENTARIO TOTAL', { views: [{ showGridLines: true }] });
    styleWorksheet(wsTotal, [
      { header: 'ID', key: 'id', width: 16 },
      { header: 'TIPO DE EQUIPO / COMPONENTE', key: 'tipo', width: 28 },
      { header: 'MODELO', key: 'modelo', width: 30 },
      { header: 'FABRICANTE', key: 'fabricante', width: 20 },
      { header: 'NÚMERO DE SERIE', key: 'serie', width: 22 },
      { header: 'ESPECIFICACIONES / DETALLES', key: 'specs', width: 38 },
      { header: 'DIRECCIÓN IP', key: 'ip', width: 22 },
      { header: 'MAC ETHERNET', key: 'mac_ethernet', width: 22 },
      { header: 'MAC WI-FI', key: 'mac_wifi', width: 22 },
      { header: 'MAC BLUETOOTH', key: 'mac_bluetooth', width: 22 },
      { header: 'BLOQUE', key: 'bloque', width: 18 },
      { header: 'UBICACIÓN / AMBIENTE', key: 'ubicacion', width: 26 },
      { header: 'USUARIO / CUSTODIO', key: 'usuario', width: 22 },
      { header: 'FECHA Y HORA', key: 'fecha', width: 22 },
      { header: 'ESTADO', key: 'estado', width: 16 }
    ]);

    // Mapas para estadísticas de resumen general
    const categoryStats = {};
    const initCategoryStat = (cat) => {
      if (!categoryStats[cat]) {
        categoryStats[cat] = { total: 0, operativo: 0, en_uso: 0, en_bodega: 0, mantenimiento: 0, de_baja: 0 };
      }
    };

    // Poblado de Datos en todas las hojas categorizadas
    items.forEach((item) => {
      const bloque = getBloqueName(item);
      const amb = toUpper(item.ubicacion || 'CAE');
      const host = toUpper(item.hostname || 'PC-EQUIPO');
      const user = toUpper(item.usuario_actual || 'ADMIN');
      const status = toUpper(item.estado || 'OPERATIVO');
      const fechaReg = toUpper(item.fecha_escaneo || item.fecha_modificacion || 'N/A');
      const netInfo = getNetworkDetails(item);
      const tipo = (item.tipo_equipo || '').toLowerCase();

      let almacenamientoStr = '';
      if (item.almacenamiento && Array.isArray(item.almacenamiento) && item.almacenamiento.length > 0) {
        almacenamientoStr = item.almacenamiento.map(d => formatCleanDisk(d.modelo || d.tipo, d.serie, d.capacidad)).join('\n');
      } else if (item.almacenamiento_resumen) {
        const rawDisks = item.almacenamiento_resumen.split(/\s*\|\s*/);
        almacenamientoStr = rawDisks.map(rd => formatCleanDisk(rd, '', '')).join('\n');
      } else {
        almacenamientoStr = 'DISCO PRINCIPAL';
      }

      // Conteo estadístico
      let mainCat = 'Computadoras';
      if (/tarjeta de video|gpu/i.test(tipo)) mainCat = 'Tarjetas de Video (GPU)';
      else if (/memoria ram|ram/i.test(tipo)) mainCat = 'Memorias RAM';
      else if (/disco|almacenamiento|ssd|nvme|hdd/i.test(tipo)) mainCat = 'Discos y Almacenamiento';
      else if (/procesador|cpu/i.test(tipo)) mainCat = 'Procesadores (CPU)';
      else if (/placa base|motherboard/i.test(tipo)) mainCat = 'Placas Base';
      else if (/fuente de poder|psu|refrigeraci|cooler/i.test(tipo)) mainCat = 'Fuentes y Componentes';
      else if (/proyector/i.test(tipo) || /proyector/i.test(item.modelo || '')) mainCat = 'Proyectores';
      else if (/impresora|multifuncional/i.test(tipo) || /impresora/i.test(item.modelo || '')) mainCat = 'Impresoras';
      else if (/switch|access point|router|wifi/i.test(tipo)) mainCat = 'Equipos de Red / Wi-Fi';
      else if (/laptop|port[aá]til/i.test(tipo)) mainCat = 'Laptops';

      initCategoryStat(mainCat);
      categoryStats[mainCat].total++;
      if (status.includes('BODEGA') || status.includes('STOCK')) categoryStats[mainCat].en_bodega++;
      else if (status.includes('USO')) categoryStats[mainCat].en_uso++;
      else if (status.includes('MANTEN')) categoryStats[mainCat].mantenimiento++;
      else if (status.includes('BAJA')) categoryStats[mainCat].de_baja++;
      else categoryStats[mainCat].operativo++;

      // Ficha consolidada total
      wsTotal.addRow({
        id: item.id || '',
        tipo: toUpper(item.tipo_equipo || 'PC'),
        modelo: toUpper(item.modelo || ''),
        fabricante: toUpper(item.fabricante || 'OEM'),
        serie: toUpper(item.numero_serie || 'N/A'),
        specs: toUpper(item.hardware_specs || item.procesador || item.ram_total || almacenamientoStr || 'Estándar'),
        ip: netInfo.ip,
        mac_ethernet: netInfo.mac_ethernet,
        mac_wifi: netInfo.mac_wifi,
        mac_bluetooth: netInfo.mac_bluetooth,
        bloque: bloque,
        ubicacion: amb,
        usuario: user,
        fecha: fechaReg,
        estado: status
      });

      // 1. CLASIFICACIÓN EXACTA EN CADA HOJA DE EXCEL
      if (/tarjeta de video|gpu/i.test(tipo)) {
        wsGPU.addRow({
          modelo: toUpper(item.modelo || 'GPU Dedicada'),
          fabricante: toUpper(item.fabricante || 'NVIDIA / AMD'),
          vram: toUpper(item.ram_total || item.hardware_specs || 'VRAM Dedicada'),
          interfaz: toUpper(item.placa_base || 'PCIe x16'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          asignado: host,
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          estado: status
        });
      } else if (/memoria ram|ram/i.test(tipo)) {
        wsRAM.addRow({
          modelo: toUpper(item.modelo || 'Memoria RAM'),
          fabricante: toUpper(item.fabricante || 'Kingston / Corsair'),
          capacidad: toUpper(item.ram_total || item.almacenamiento_resumen || '16 GB'),
          tipo: toUpper(item.placa_base || item.hardware_specs || 'DDR4 / DDR5'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          asignado: host,
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          estado: status
        });
      } else if (/disco|almacenamiento|ssd|nvme|hdd/i.test(tipo)) {
        wsDiscos.addRow({
          modelo: toUpper(item.modelo || 'Unidad de Almacenamiento'),
          fabricante: toUpper(item.fabricante || 'Samsung / Kingston / WD'),
          capacidad: toUpper(item.almacenamiento_resumen || '1 TB'),
          interfaz: toUpper(item.placa_base || item.hardware_specs || 'M.2 NVMe PCIe'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          asignado: host,
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          estado: status
        });
      } else if (/procesador|cpu/i.test(tipo)) {
        wsCPU.addRow({
          modelo: toUpper(item.modelo || 'Procesador CPU'),
          fabricante: toUpper(item.fabricante || 'Intel / AMD'),
          specs: toUpper(item.procesador || item.hardware_specs || 'Multi-Core'),
          socket: toUpper(item.placa_base || 'Socket Estándar'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          asignado: host,
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          estado: status
        });
      } else if (/placa base|motherboard/i.test(tipo)) {
        wsPlacas.addRow({
          modelo: toUpper(item.modelo || 'Placa Base'),
          fabricante: toUpper(item.fabricante || 'ASUS / MSI / Gigabyte'),
          chipset: toUpper(item.placa_base || item.hardware_specs || 'Chipset Estándar'),
          formato: toUpper(item.almacenamiento_resumen || 'ATX / Micro-ATX'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          asignado: host,
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          estado: status
        });
      } else if (/fuente de poder|psu|refrigeraci|cooler/i.test(tipo)) {
        wsFuentes.addRow({
          modelo: toUpper(item.modelo || 'Fuente de Poder / Componente'),
          tipo: toUpper(item.tipo_equipo || 'Componente'),
          fabricante: toUpper(item.fabricante || 'Corsair / EVGA'),
          specs: toUpper(item.hardware_specs || item.almacenamiento_resumen || '80 Plus Gold'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          estado: status
        });
      } else if (/proyector|datashow/i.test(tipo) || /proyector/i.test(item.modelo || '')) {
        wsProyectores.addRow({
          modelo: toUpper(item.modelo || 'Proyector Multimedia'),
          fabricante: toUpper(item.fabricante || 'Epson / BenQ'),
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          ip: netInfo.ip,
          mac_ethernet: netInfo.mac_ethernet,
          mac_wifi: netInfo.mac_wifi,
          bloque: bloque,
          ubicacion: amb,
          fecha: fechaReg,
          estado: status,
          notas: toUpper(item.notas || 'Equipo audiovisual')
        });
      } else if (/impresora|multifuncional|fotocopiadora/i.test(tipo) || /impresora/i.test(item.modelo || '')) {
        wsImpresoras.addRow({
          modelo: toUpper(item.modelo || ''),
          fabricante: toUpper(item.fabricante || 'Epson / HP / Canon'),
          consumible: toUpper(item.consumible || item.tinta_toner || 'Tinta / Tóner'),
          numero_serie: toUpper(item.numero_serie || ''),
          ip: netInfo.ip,
          mac_ethernet: netInfo.mac_ethernet,
          mac_wifi: netInfo.mac_wifi,
          mac_bluetooth: netInfo.mac_bluetooth,
          bloque: bloque,
          ubicacion: amb,
          usuario: user,
          fecha: fechaReg,
          estado: status
        });
      } else if (/laptop|port[aá]til|notebook/i.test(tipo)) {
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
          ip: netInfo.ip,
          mac_ethernet: netInfo.mac_ethernet,
          mac_wifi: netInfo.mac_wifi,
          mac_bluetooth: netInfo.mac_bluetooth,
          fecha: fechaReg,
          estado: status
        });
      } else if (/switch|access point|router|wifi/i.test(tipo)) {
        wsWifi.addRow({
          dispositivo: toUpper(item.modelo || 'Equipo de Red'),
          marca: toUpper(item.fabricante || 'Cisco / Ubiquiti / Mikrotik'),
          ip: netInfo.ip,
          mac_ethernet: netInfo.mac_ethernet,
          mac_wifi: netInfo.mac_wifi,
          mac_bluetooth: netInfo.mac_bluetooth,
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          bloque: bloque,
          ubicacion: amb,
          fecha: fechaReg,
          estado: status
        });
      } else {
        // Computadoras de Escritorio, All-in-One, Mini PC, Servidores
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
          ip: netInfo.ip,
          mac_ethernet: netInfo.mac_ethernet,
          mac_wifi: netInfo.mac_wifi,
          mac_bluetooth: netInfo.mac_bluetooth,
          fecha: fechaReg,
          estado: status
        });
      }

      // Registro adicional en hoja WIFI si tiene interfaz de red detectada
      if (!/switch|access point|router/i.test(tipo) && (netInfo.mac_wifi !== 'N/A' || netInfo.mac_ethernet !== 'N/A' || netInfo.mac_bluetooth !== 'N/A')) {
        wsWifi.addRow({
          dispositivo: toUpper(`INTERFAZ RED (${item.hostname || item.modelo})`),
          marca: toUpper(item.fabricante || 'ADAPTADOR DE RED'),
          ip: netInfo.ip,
          mac_ethernet: netInfo.mac_ethernet,
          mac_wifi: netInfo.mac_wifi,
          mac_bluetooth: netInfo.mac_bluetooth,
          numero_serie: toUpper(item.numero_serie || 'N/A'),
          bloque: bloque,
          ubicacion: amb,
          estado: status
        });
      }

      // Monitores conectados a la hoja de Monitores
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

      // Periféricos clasificados
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
        } else if (/aud[ií]fono|diadema|headset|auricular/i.test(pNameLower) || /aud[ií]fono|diadema|headset|auricular/i.test(pType)) {
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

    // Llenar Hoja de Resumen General Ejecutivo
    Object.entries(categoryStats).forEach(([cat, stats]) => {
      wsResumen.addRow({
        categoria: cat,
        total: stats.total,
        operativos: stats.operativo,
        en_uso: stats.en_uso,
        en_bodega: stats.en_bodega,
        mantenimiento: stats.mantenimiento,
        de_baja: stats.de_baja
      });
    });

    // Aplicar estilos y auto-ajustar anchos a todas las hojas categorizadas
    const allSheets = [
      wsResumen, wsCase, wsLaptops, wsGPU, wsRAM, wsDiscos, wsCPU, wsPlacas, wsFuentes, 
      wsImpresoras, wsProyectores, wsWifi, wsMonitor, wsTeclado, wsMouse, wsAudifonos, wsTotal
    ];

    allSheets.forEach(ws => {
      styleDataRows(ws);
      if (ws.columns) {
        ws.columns.forEach((column) => {
          let maxLen = 0;
          column.eachCell({ includeEmpty: true }, (cell) => {
            const val = cell.value ? cell.value.toString() : '';
            const lines = val.split(/\r\n|\r|\n/);
            lines.forEach(line => {
              const cleanLineLen = line.trim().length;
              if (cleanLineLen > maxLen) {
                maxLen = cleanLineLen;
              }
            });
          });
          column.width = Math.min(Math.max(maxLen + 5, 20), 85);
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
