// ==============================================================================
// SISTEMA DE INVENTARIO DE CÓMPUTO & AUDITORÍA DE HARDWARE - APP.JS
// ==============================================================================

let inventoryData = [];
let currentCategory = 'Todos';
let currentSpecificType = 'Todos';
let currentFilterType = 'Todos';
let currentFilterStatus = 'Todos';
let currentSearchQuery = '';
let currentView = 'table'; // 'table' o 'grid'
let serverInfo = null;

// Elementos del DOM
const tableBody = document.getElementById('inventoryTableBody');
const gridContainer = document.getElementById('gridViewContainer');
const tableViewContainer = document.getElementById('tableViewContainer');
const searchInput = document.getElementById('searchInput');
const btnClearSearch = document.getElementById('btnClearSearch');
const statusFilter = document.getElementById('statusFilter');
const typeSelectFilter = document.getElementById('typeSelectFilter');
const filterPills = document.querySelectorAll('.filter-pills-group .pill');
const emptyState = document.getElementById('emptyState');
const visibleCount = document.getElementById('visibleCount');
const totalCount = document.getElementById('totalCount');
const serverIpDisplay = document.getElementById('serverIpDisplay');
const qrCodeImage = document.getElementById('qrCodeImage');
const modalServerUrl = document.getElementById('modalServerUrl');
const equipmentForm = document.getElementById('equipmentForm');

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAuth();
  initEventListeners();
  fetchServerInfo();
  fetchInventory();
});

// -------------------------------------------------------------
// CONTROL DE AUTENTICACIÓN / SESIÓN
// -------------------------------------------------------------
function initAuth() {
  const loginOverlay = document.getElementById('loginOverlay');
  const loginForm = document.getElementById('loginForm');
  const loginUser = document.getElementById('loginUser');
  const loginPass = document.getElementById('loginPass');
  const loginErrorMsg = document.getElementById('loginErrorMsg');
  const btnTogglePass = document.getElementById('btnTogglePass');
  const togglePassIcon = document.getElementById('togglePassIcon');
  const btnLogout = document.getElementById('btnLogout');
  const sessionToken = sessionStorage.getItem('sysinventario_session_token');

  // Si ya tiene sesión activa en esta pestaña/ventana
  if (sessionToken) {
    if (loginOverlay) loginOverlay.classList.add('hidden');
    const userBox = document.getElementById('userSessionBox');
    if (userBox) userBox.style.display = 'flex';
    updateAuthUI();
  } else {
    if (loginOverlay) {
      loginOverlay.classList.remove('hidden');
      if (loginUser) loginUser.focus();
    }
  }

  // Toggle mostrar contraseña
  if (btnTogglePass && loginPass) {
    btnTogglePass.addEventListener('click', () => {
      const isPass = loginPass.type === 'password';
      loginPass.type = isPass ? 'text' : 'password';
      if (togglePassIcon) {
        togglePassIcon.className = isPass ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
      }
    });
  }

  // Submit de Login
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (loginUser.value || '').trim();
      const password = (loginPass.value || '').trim();
      const btnSubmit = document.getElementById('btnLoginSubmit');

      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Verificando...`;
      if (loginErrorMsg) loginErrorMsg.style.display = 'none';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          // Guardar en sessionStorage (se borra automáticamente al cerrar la página/navegador)
          sessionStorage.setItem('sysinventario_session_token', data.token);
          sessionStorage.setItem('sysinventario_user', data.user);
          sessionStorage.setItem('sysinventario_role', data.role || 'admin');
          sessionStorage.setItem('sysinventario_display', data.displayName || data.user);
          localStorage.removeItem('sysinventario_token');
          
          loginOverlay.classList.add('hidden');
          const userBox = document.getElementById('userSessionBox');
          if (userBox) userBox.style.display = 'flex';
          
          updateAuthUI();
          showToast(`¡Bienvenido, ${data.displayName || data.user}!`, 'success');
          fetchInventory();
        } else {
          if (loginErrorMsg) {
            loginErrorMsg.style.display = 'flex';
            document.getElementById('loginErrorText').textContent = data.error || 'Usuario o contraseña incorrectos';
          }
          if (loginPass) {
            loginPass.value = '';
            loginPass.focus();
          }
        }
      } catch (err) {
        if (loginErrorMsg) {
          loginErrorMsg.style.display = 'flex';
          document.getElementById('loginErrorText').textContent = 'Error al conectar con el servidor';
        }
      } finally {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> Iniciar Sesión`;
      }
    });
  }

  // Logout (Cerrar Sesión)
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      sessionStorage.clear();
      localStorage.removeItem('sysinventario_token');
      localStorage.removeItem('sysinventario_user');
      if (loginOverlay) {
        loginOverlay.classList.remove('hidden');
        if (loginPass) loginPass.value = '';
        if (loginUser) {
          loginUser.value = '';
          loginUser.focus();
        }
      }
      showToast('Sesión cerrada correctamente', 'info');
    });
  }
}

// -------------------------------------------------------------
// ACTUALIZACIÓN DE INTERFAZ SEGÚN ROL DE USUARIO
// -------------------------------------------------------------
function updateAuthUI() {
  const role = sessionStorage.getItem('sysinventario_role') || 'admin';
  const username = sessionStorage.getItem('sysinventario_user') || 'admin';
  
  const userSessionBox = document.getElementById('userSessionBox');
  const sessionUserIcon = document.getElementById('sessionUserIcon');
  const sessionUserName = document.getElementById('sessionUserName');
  
  if (userSessionBox) {
    userSessionBox.classList.remove('badge-role-admin', 'badge-role-operador');
    userSessionBox.classList.add(role === 'operador' ? 'badge-role-operador' : 'badge-role-admin');
  }
  
  if (sessionUserIcon) {
    sessionUserIcon.innerHTML = role === 'operador' 
      ? `<i class="fa-solid fa-user-lock"></i>` 
      : `<i class="fa-solid fa-crown gold-crown-icon"></i>`;
  }
  
  if (sessionUserName) {
    sessionUserName.innerHTML = role === 'operador' 
      ? `<b>${escapeHTML(username)}</b> <span class="role-sublabel">Operador</span>` 
      : `<b>${escapeHTML(username)}</b> <span class="role-sublabel">Admin</span>`;
  }
  
  const btnOpenManualModal = document.getElementById('btnOpenManualModal');
  if (btnOpenManualModal) {
    btnOpenManualModal.style.display = role === 'operador' ? 'none' : 'inline-flex';
  }
}

// -------------------------------------------------------------
// TEMA CLARO / OSCURO
// -------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem('sysinventario_theme') || 'dark';
  setTheme(savedTheme);

  const btnThemeToggle = document.getElementById('btnThemeToggle');
  if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      setTheme(newTheme);
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sysinventario_theme', theme);
  const themeToggleText = document.getElementById('themeToggleText');
  if (themeToggleText) {
    themeToggleText.textContent = theme === 'dark' ? 'Modo Claro' : 'Modo Oscuro';
  }
  updateQrForTheme(theme);
}

function updateQrForTheme(theme) {
  if (serverInfo && qrCodeImage) {
    qrCodeImage.src = (theme === 'light' && serverInfo.qrCodeLight) 
      ? serverInfo.qrCodeLight 
      : (serverInfo.qrCodeDark || serverInfo.qrCode);
  }
}

// -------------------------------------------------------------
// EVENT LISTENERS
// -------------------------------------------------------------
function initEventListeners() {
  // Inicializar Navegación Multi-Página
  initMultiPageNav();

  // Búsqueda en tiempo real
  searchInput.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value.toLowerCase().trim();
    btnClearSearch.style.display = currentSearchQuery ? 'block' : 'none';
    renderData();
  });

  btnClearSearch.addEventListener('click', () => {
    searchInput.value = '';
    currentSearchQuery = '';
    btnClearSearch.style.display = 'none';
    searchInput.focus();
    renderData();
  });

  // Filtros por pestañas (Categorías)
  document.querySelectorAll('.filter-pills-group .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pills-group .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentCategory = pill.getAttribute('data-category') || 'Todos';
      currentFilterType = pill.getAttribute('data-type') || 'Todos';
      if (typeSelectFilter) typeSelectFilter.value = 'Todos';
      currentSpecificType = 'Todos';
      renderData();
    });
  });

  // Filtro por Tipo Específico de Dispositivo
  if (typeSelectFilter) {
    typeSelectFilter.addEventListener('change', (e) => {
      currentSpecificType = e.target.value;
      if (currentSpecificType !== 'Todos') {
        filterPills.forEach(p => p.classList.remove('active'));
        currentCategory = 'Todos';
        currentFilterType = 'Todos';
      }
      renderData();
    });
  }

  // Filtro por Estado
  statusFilter.addEventListener('change', (e) => {
    currentFilterStatus = e.target.value;
    renderData();
  });

  // Clic en tarjetas de métricas para filtrar
  const cardFilterDesktop = document.getElementById('cardFilterDesktop');
  if (cardFilterDesktop) {
    cardFilterDesktop.addEventListener('click', () => {
      setFilterCategory('Computadoras');
    });
  }
  document.getElementById('cardFilterLaptop').addEventListener('click', () => {
    setFilterPill('Laptop');
  });

  // Cambio de Vista (Tabla vs Tarjetas)
  document.getElementById('viewTableBtn').addEventListener('click', () => {
    setView('table');
  });
  document.getElementById('viewGridBtn').addEventListener('click', () => {
    setView('grid');
  });

  // Modales
  const btnShowQr = document.getElementById('btnShowQr');
  if (btnShowQr) {
    btnShowQr.addEventListener('click', () => {
      openModal('qrModal');
    });
  }

  // Botón Nuevo Registro Manual
  const btnOpenManualModal = document.getElementById('btnOpenManualModal');
  if (btnOpenManualModal) {
    btnOpenManualModal.addEventListener('click', openManualCreateModal);
  }

  // Botón Escanear Este Equipo / PC (Abre modal con BAT y Comando)
  const btnScanLocal = document.getElementById('btnScanLocal');
  if (btnScanLocal) {
    btnScanLocal.addEventListener('click', () => {
      const url = (serverInfo && serverInfo.serverUrl) ? serverInfo.serverUrl : window.location.origin;
      const cmd = `irm ${url}/scan | iex`;
      const authDisplay = document.getElementById('authCmdDisplay');
      if (authDisplay) authDisplay.textContent = cmd;
      openModal('agentModal');
    });
  }

  // Botón Copiar Comando en Modal de Escaneo
  const btnAuthCopyCmd = document.getElementById('btnAuthCopyCmd');
  if (btnAuthCopyCmd) {
    btnAuthCopyCmd.addEventListener('click', () => {
      const url = (serverInfo && serverInfo.serverUrl) ? serverInfo.serverUrl : window.location.origin;
      const cmd = `irm ${url}/scan | iex`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(() => {
          showToast('¡Comando copiado! Abre PowerShell (Ctrl + V) y presiona Enter.', 'success');
        });
      } else {
        prompt('Copia este comando y pégalo en PowerShell:', cmd);
      }
    });
  }

  // Botón Descargar BAT en Modal de Escaneo
  const btnAuthDownloadBat = document.getElementById('btnAuthDownloadBat');
  if (btnAuthDownloadBat) {
    btnAuthDownloadBat.addEventListener('click', () => {
      showToast('Descargando script seguro. Ábrelo con 1 clic para auditar la PC.', 'info');
    });
  }

  // Formulario de Registro Manual
  if (equipmentForm) {
    equipmentForm.addEventListener('submit', handleFormSubmit);
  }

  // Botón Escanear con Cámara en Formulario
  const btnScanSerialCam = document.getElementById('btnScanSerialCam');
  if (btnScanSerialCam) {
    btnScanSerialCam.addEventListener('click', () => {
      startCameraScanner('formNumeroSerie');
    });
  }

  const btnCloseCamera = document.getElementById('btnCloseCamera');
  if (btnCloseCamera) {
    btnCloseCamera.addEventListener('click', stopCameraScanner);
  }

  const btnCloseCameraX = document.getElementById('btnCloseCameraX');
  if (btnCloseCameraX) {
    btnCloseCameraX.addEventListener('click', stopCameraScanner);
  }

  const btnSwitchCamera = document.getElementById('btnSwitchCamera');
  if (btnSwitchCamera) {
    btnSwitchCamera.addEventListener('click', () => {
      currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
      startCameraScanner('formNumeroSerie');
    });
  }

  // Cerrar modales con botones 'data-close-modal' o clic fuera
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close-modal');
      if (modalId === 'cameraModal') {
        stopCameraScanner();
      } else {
        closeModal(modalId);
      }
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
      }
    });
  });

  // Copiar URL local
  const btnCopyUrl = document.getElementById('btnCopyUrl');
  if (btnCopyUrl) {
    btnCopyUrl.addEventListener('click', () => {
      if (serverInfo && serverInfo.serverUrl) {
        navigator.clipboard.writeText(serverInfo.serverUrl).then(() => {
          showToast('¡URL copiada al portapapeles!', 'success');
        });
      }
    });
  }
}

// Funciones globales de apertura y cierre de modales
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }
}

function setFilterPill(type) {
  filterPills.forEach(p => {
    if (p.getAttribute('data-type') === type) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
  currentFilterType = type;
  renderData();
}

function setView(view) {
  currentView = view;
  const tableBtn = document.getElementById('viewTableBtn');
  const gridBtn = document.getElementById('viewGridBtn');

  if (view === 'table') {
    tableBtn.classList.add('active');
    gridBtn.classList.remove('active');
    tableViewContainer.style.display = 'block';
    gridContainer.style.display = 'none';
  } else {
    tableBtn.classList.remove('active');
    gridBtn.classList.add('active');
    tableViewContainer.style.display = 'none';
    gridContainer.style.display = 'grid';
  }
}

// -------------------------------------------------------------
// AUTO-DETECCIÓN DE SUBRED LOCAL DEL DISPOSITIVO
// -------------------------------------------------------------
async function detectClientLocalSubnet() {
  return new Promise((resolve) => {
    try {
      const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
      if (!RTCPeerConnection) {
        return resolve(fallbackSubnet());
      }
      
      const rtc = new RTCPeerConnection({ iceServers: [] });
      rtc.createDataChannel('subnet-detect');
      rtc.createOffer().then(offer => rtc.setLocalDescription(offer)).catch(() => resolve(fallbackSubnet()));
      
      let detected = false;
      rtc.onicecandidate = (evt) => {
        if (!evt || !evt.candidate || !evt.candidate.candidate) return;
        const cand = evt.candidate.candidate;
        const ipMatch = cand.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
        if (ipMatch) {
          const ip = ipMatch[1];
          if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
            detected = true;
            const parts = ip.split('.');
            resolve(`${parts[0]}.${parts[1]}.${parts[2]}`);
          }
        }
      };
      
      setTimeout(() => {
        if (!detected) resolve(fallbackSubnet());
      }, 1000);
    } catch (e) {
      resolve(fallbackSubnet());
    }
  });
}

function fallbackSubnet() {
  // Buscar la subred de los equipos activos en el inventario
  for (const item of inventoryData) {
    if (item.ip_red) {
      const match = item.ip_red.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}/);
      if (match) return match[1];
    }
  }
  return (serverInfo && serverInfo.subnetBase) ? serverInfo.subnetBase : '192.168.89';
}

// -------------------------------------------------------------
// COMUNICACIÓN CON API
// -------------------------------------------------------------

// Obtener info del servidor y QR
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    if (!res.ok) throw new Error('Error al obtener info de red');
    serverInfo = await res.json();
    
    if (serverInfo.isCloud || window.location.hostname.includes('onrender.com')) {
      serverIpDisplay.textContent = 'Nube Activa (Online)';
    } else {
      serverIpDisplay.textContent = `${serverInfo.primaryIP}:${serverInfo.port}`;
    }
    
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    updateQrForTheme(currentTheme);
    if (modalServerUrl) {
      modalServerUrl.textContent = serverInfo.serverUrl || window.location.origin;
    }

    // Auto-detectar y pre-rellenar la subred local del cliente
    detectClientLocalSubnet().then(subnet => {
      const inputSubnet = document.getElementById('inputSubnet');
      if (inputSubnet && subnet) {
        inputSubnet.value = subnet;
      }
    });
  } catch (err) {
    console.error(err);
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      serverIpDisplay.textContent = 'Nube Activa';
    } else {
      serverIpDisplay.textContent = 'Modo Local';
    }
    setTimeout(fetchServerInfo, 3000);
  }
}

// Obtener Inventario
async function fetchInventory(silent = false) {
  try {
    const res = await fetch('/api/inventory');
    if (!res.ok) throw new Error('Error al cargar inventario');
    const data = await res.json();
    const prevCount = inventoryData.length;
    inventoryData = data.items || [];
    updateMetrics();
    renderData();
    if (!silent && prevCount > 0 && inventoryData.length > prevCount) {
      showToast(`¡Nuevo equipo detectado en la red! Total: ${inventoryData.length}`, 'success');
    }
  } catch (err) {
    if (!silent) {
      console.error(err);
      showToast('Error al conectar con la base de datos de inventario', 'error');
    }
  }
}

// Sincronización periódica automática (cada 8 segundos)
setInterval(() => {
  fetchInventory(true);
}, 8000);

// Ejecutar escaneo de toda la red local
async function runNetworkScan() {
  const btn = document.getElementById('btnStartSubnetScan');
  const subnetInput = document.getElementById('inputSubnet');
  const consoleBox = document.getElementById('scanConsoleBox');
  const consoleLog = document.getElementById('scanConsoleLog');
  const consoleSpinner = document.getElementById('consoleSpinner');

  let subnet = (subnetInput.value || '').trim();
  if (!subnet) {
    subnet = await detectClientLocalSubnet();
    subnetInput.value = subnet;
  }

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Escaneando ${subnet}.0/24...`;
  consoleBox.style.display = 'block';
  consoleSpinner.style.display = 'inline-block';
  consoleLog.textContent = `[*] Iniciando barrido multi-hilo en la subred ${subnet}.1 - ${subnet}.254...\n[*] Analizando hosts activos, IPs, MACs y nombres de host...`;

  showToast(`Iniciando escaneo de la red ${subnet}.0/24...`, 'info');

  try {
    const res = await fetch('/api/scan-network', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subnet })
    });

    const data = await res.json();
    consoleSpinner.style.display = 'none';

    if (res.ok) {
      consoleLog.textContent = data.output || `[✓] Barrido de red ${subnet}.0/24 completado con éxito.`;
      showToast(`¡Escaneo de red finalizado! Equipos sincronizados en inventario.`, 'success');
      await fetchInventory();
    } else {
      consoleLog.textContent = `[!] Error durante el escaneo:\n${data.error}\n${data.details || ''}`;
      showToast(data.error || 'Error durante el barrido de red', 'error');
    }
  } catch (err) {
    consoleSpinner.style.display = 'none';
    consoleLog.textContent = `[!] Error de comunicación:\n${err.message}`;
    showToast('Error al comunicar con el escáner de red', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-play"></i> Iniciar Escaneo de Red`;
  }
}

// -------------------------------------------------------------
// HELPER: DETECCIÓN DE TIPO DE EQUIPO Y CATEGORÍA
// -------------------------------------------------------------
function getDeviceTypeInfo(tipo) {
  const t = (tipo || '').toLowerCase();
  
  if (t.includes('laptop') || t.includes('notebook') || t.includes('portátil')) {
    return { icon: 'fa-laptop', class: 'laptop', label: 'Laptop', category: 'Computadoras' };
  }
  if (t.includes('all-in-one') || t.includes('aio')) {
    return { icon: 'fa-tv', class: 'aio', label: 'All-in-One', category: 'Computadoras' };
  }
  if (t.includes('mini pc')) {
    return { icon: 'fa-cube', class: 'desktop', label: 'Mini PC', category: 'Computadoras' };
  }
  if (t.includes('impresora') || t.includes('multifuncional') || t.includes('printer')) {
    return { icon: 'fa-print', class: 'impresora', label: 'Impresora', category: 'Impresoras' };
  }
  if (t.includes('switch')) {
    return { icon: 'fa-network-wired', class: 'switch', label: 'Switch', category: 'Redes' };
  }
  if (t.includes('access point') || t.includes('router') || t.includes('ap') || t.includes('wi-fi')) {
    return { icon: 'fa-wifi', class: 'ap', label: 'Access Point', category: 'Redes' };
  }
  if (t.includes('proyector') || t.includes('projector')) {
    return { icon: 'fa-video', class: 'proyector', label: 'Proyector', category: 'Impresoras' };
  }
  if (t.includes('teclado') || t.includes('keyboard')) {
    return { icon: 'fa-keyboard', class: 'teclado', label: 'Teclado', category: 'Periféricos' };
  }
  if (t.includes('mouse') || t.includes('puntero') || t.includes('ratón')) {
    return { icon: 'fa-mouse', class: 'mouse', label: 'Mouse', category: 'Periféricos' };
  }
  if (t.includes('audífono') || t.includes('audifono') || t.includes('diadema') || t.includes('auricular') || t.includes('headphone')) {
    return { icon: 'fa-headphones', class: 'audifonos', label: 'Audífonos', category: 'Periféricos' };
  }
  if (t.includes('monitor') || t.includes('pantalla') || t.includes('display')) {
    return { icon: 'fa-display', class: 'monitor', label: 'Monitor', category: 'Periféricos' };
  }
  if (t.includes('servidor') || t.includes('server')) {
    return { icon: 'fa-server', class: 'servidor', label: 'Servidor', category: 'Computadoras' };
  }
  return { icon: 'fa-desktop', class: 'desktop', label: tipo || 'PC de Escritorio', category: 'Computadoras' };
}

function setFilterCategory(category) {
  filterPills.forEach(p => {
    if (p.getAttribute('data-category') === category) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
  currentCategory = category;
  if (typeSelectFilter) typeSelectFilter.value = 'Todos';
  currentSpecificType = 'Todos';
  renderData();
}

// -------------------------------------------------------------
// RENDERIZADO Y FILTROS
// -------------------------------------------------------------
function renderData() {
  // Aplicar filtros
  const filtered = inventoryData.filter(item => {
    const typeInfo = getDeviceTypeInfo(item.tipo_equipo);

    // Filtro por tipo específico dropdown
    if (currentSpecificType && currentSpecificType !== 'Todos') {
      if (item.tipo_equipo !== currentSpecificType) {
        return false;
      }
    }

    // Filtro por categoría pills
    if (currentCategory && currentCategory !== 'Todos') {
      if (typeInfo.category !== currentCategory) {
        return false;
      }
    }

    // Filtro por estado
    if (currentFilterStatus !== 'Todos' && item.estado !== currentFilterStatus) {
      return false;
    }

    // Filtro por búsqueda de texto
    if (currentSearchQuery) {
      const q = currentSearchQuery;
      const match = (
        (item.modelo && item.modelo.toLowerCase().includes(q)) ||
        (item.numero_serie && item.numero_serie.toLowerCase().includes(q)) ||
        (item.placa_base && item.placa_base.toLowerCase().includes(q)) ||
        (item.tipo_equipo && item.tipo_equipo.toLowerCase().includes(q)) ||
        (item.fabricante && item.fabricante.toLowerCase().includes(q)) ||
        (item.procesador && item.procesador.toLowerCase().includes(q)) ||
        (item.hostname && item.hostname.toLowerCase().includes(q)) ||
        (item.usuario_actual && item.usuario_actual.toLowerCase().includes(q)) ||
        (item.ubicacion && item.ubicacion.toLowerCase().includes(q)) ||
        (item.almacenamiento_resumen && item.almacenamiento_resumen.toLowerCase().includes(q)) ||
        (item.notas && item.notas.toLowerCase().includes(q))
      );
      if (!match) return false;
    }

    return true;
  });

  // Actualizar contadores visibles
  visibleCount.textContent = filtered.length;
  totalCount.textContent = inventoryData.length;

  if (filtered.length === 0) {
    tableBody.innerHTML = '';
    gridContainer.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

  // Renderizar Tabla
  renderTable(filtered);

  // Renderizar Grid
  renderGrid(filtered);
}

function renderTable(items) {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';
  tableBody.innerHTML = items.map(item => {
    const typeInfo = getDeviceTypeInfo(item.tipo_equipo);
    const tipoClass = typeInfo.class;
    const tipoIcon = typeInfo.icon;

    // Procesador Completo (Limpio y legible)
    let cpuText = item.procesador ? item.procesador.replace(/\(R\)/gi, '').replace(/\(TM\)/gi, '').trim() : '';

    // RAM Limpia
    let ramText = item.ram_total ? item.ram_total.replace(/\(\s*modulo\(s\)\)/gi, '(1 Módulo)').replace(/\(\s*\)/gi, '').trim() : '';

    // Discos detallados con seriales
    let storageHtml = '';
    if (item.almacenamiento && item.almacenamiento.length > 0) {
      storageHtml = item.almacenamiento.map(d => {
        const serieText = d.serie && d.serie !== 'N/A' ? ` <span class="serial-mini-tag">S/N: ${escapeHTML(d.serie)}</span>` : '';
        return `<div class="hw-item-line"><i class="fa-solid fa-hard-drive text-crimson"></i> <b>${escapeHTML(d.modelo || d.tipo)}</b> (${escapeHTML(d.capacidad || '')})${serieText}</div>`;
      }).join('');
    } else if (item.almacenamiento_resumen) {
      storageHtml = `<div class="hw-item-line"><i class="fa-solid fa-hard-drive text-crimson"></i> ${escapeHTML(item.almacenamiento_resumen)}</div>`;
    }

    // Periféricos y Monitores completos
    let perifericosListHtml = '';
    
    // Monitores primero
    if (item.monitores && item.monitores.length > 0) {
      item.monitores.forEach(m => {
        const monSerial = m.serie ? ` <span class="serial-mini-tag">S/N: ${escapeHTML(m.serie)}</span>` : '';
        perifericosListHtml += `<div class="hw-item-line mon-line"><i class="fa-solid fa-display text-crimson"></i> <b>${escapeHTML(m.modelo || m.fabricante || 'Monitor')}</b>${monSerial}</div>`;
      });
    }

    // Periféricos
    if (item.perifericos && item.perifericos.length > 0) {
      item.perifericos.forEach(p => {
        const pTipoIcon = (p.tipo && p.tipo.toLowerCase().includes('mouse')) ? 'fa-mouse' : ((p.tipo && p.tipo.toLowerCase().includes('teclado')) ? 'fa-keyboard' : 'fa-plug');
        perifericosListHtml += `<div class="hw-item-line"><i class="fa-solid ${pTipoIcon}"></i> ${escapeHTML(p.nombre || p.tipo)}</div>`;
      });
    }

    if (!perifericosListHtml) {
      perifericosListHtml = '<div class="hw-item-line text-gray-400">Estándar / Integrado</div>';
    }

    // Construir bloque de especificaciones adaptativo
    let specsHtml = '';
    if (cpuText || ramText || storageHtml) {
      specsHtml = `
        <div class="specs-full-block">
          ${cpuText ? `<div class="spec-cpu-title"><i class="fa-solid fa-microchip text-crimson"></i> <b>${escapeHTML(cpuText)}</b></div>` : ''}
          ${ramText ? `<div class="spec-ram-line"><i class="fa-solid fa-memory text-crimson"></i> <b>RAM:</b> ${escapeHTML(ramText)}</div>` : ''}
          ${storageHtml ? `<div class="spec-storage-block">${storageHtml}</div>` : ''}
        </div>
      `;
    } else {
      specsHtml = `
        <div class="specs-full-block">
          <div class="hw-item-line"><i class="fa-solid ${tipoIcon} text-crimson"></i> <b>${escapeHTML(item.fabricante || 'Dispositivo')}</b> ${escapeHTML(item.tipo_equipo || '')}</div>
          ${item.notas ? `<div class="hw-item-line text-gray-400"><i class="fa-solid fa-circle-info"></i> ${escapeHTML(item.notas)}</div>` : ''}
        </div>
      `;
    }

    const statusClass = (item.estado || 'Operativo').toLowerCase().replace(/\s+/g, '-');
    const primaryName = item.hostname || item.modelo || 'Equipo';
    const subName = item.hostname ? (item.modelo || '') : '';

    return `
      <tr>
        <td class="cell-modelo">
          <div class="col-modelo-val">
            <div class="modelo-header">
              <i class="fa-solid ${tipoIcon} text-crimson modelo-type-icon"></i>
              <strong class="modelo-text">${escapeHTML(primaryName)}</strong>
            </div>
            ${subName ? `<span style="font-size: 0.74rem; color: var(--gray-400); margin-left: 20px; line-height: 1.2;">${escapeHTML(subName)}</span>` : ''}
            ${item.fabricante ? `<span class="fabricante-tag">${escapeHTML(item.fabricante)}</span>` : ''}
          </div>
        </td>
        <td class="cell-serie">
          <span class="serial-badge" onclick="copyText('${escapeHTML(item.numero_serie)}')" title="Clic para copiar S/N">
            <i class="fa-solid fa-barcode"></i>
            ${escapeHTML(item.numero_serie || 'N/A')}
          </span>
        </td>
        <td class="cell-ambiente">
          <div class="user-loc" title="Ambiente / Ubicación"><i class="fa-solid fa-location-dot text-crimson"></i> <b>${escapeHTML(item.ubicacion || 'Sin Asignar')}</b></div>
        </td>
        <td class="cell-placa">
          <span class="placa-badge" title="Placa Base">${escapeHTML(item.placa_base || 'N/A')}</span>
        </td>
        <td class="cell-tipo">
          <span class="tipo-badge ${tipoClass}">
            <i class="fa-solid ${tipoIcon}"></i> ${escapeHTML(item.tipo_equipo || 'Equipo')}
          </span>
        </td>
        <td class="cell-specs">
          ${specsHtml}
        </td>
        <td class="cell-perifericos">
          <div class="perifericos-full-block">
            ${perifericosListHtml}
          </div>
        </td>
        <td class="cell-usuario">
          <div class="user-block">
            <div class="user-name"><i class="fa-solid fa-user text-crimson"></i> <b>${escapeHTML(item.usuario_actual || 'Sin Asignar')}</b></div>
            ${item.ubicacion ? `<div class="user-loc"><i class="fa-solid fa-location-dot"></i> ${escapeHTML(item.ubicacion)}</div>` : ''}
            ${item.ip_red ? `<div class="user-host"><i class="fa-solid fa-network-wired"></i> ${escapeHTML(item.ip_red.split(',')[0].trim())}</div>` : ''}
          </div>
        </td>
        <td class="cell-estado">
          <span class="status-indicator status-${statusClass}">
            <span class="status-dot"></span>
            ${escapeHTML(item.estado || 'Operativo')}
          </span>
        </td>
        <td class="cell-acciones">
          <div class="table-actions-cell">
            <button class="action-btn-mini" onclick="viewDetails('${item.id}')" title="Ver Ficha Técnica Completa">
              <i class="fa-solid fa-eye"></i>
            </button>
            ${!isOperador ? `
            <button class="action-btn-mini" onclick="editEquipment('${item.id}')" title="Editar Registro">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="action-btn-mini delete-btn" onclick="deleteEquipment('${item.id}', '${escapeHTML(primaryName)}')" title="Eliminar Registro">
              <i class="fa-solid fa-trash-can"></i>
            </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderGrid(items) {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';

  gridContainer.innerHTML = items.map(item => {
    const typeInfo = getDeviceTypeInfo(item.tipo_equipo);
    const primaryName = item.hostname || item.modelo || 'Equipo';
    const subName = item.hostname ? (item.modelo || '') : '';

    return `
      <div class="grid-card">
        <div class="grid-card-header">
          <div>
            <div class="grid-card-title">${escapeHTML(primaryName)}</div>
            ${subName ? `<div style="font-size: 0.78rem; color: var(--gray-400); margin-top: 2px;">${escapeHTML(subName)}</div>` : ''}
            <span class="tipo-badge ${typeInfo.class} mt-4"><i class="fa-solid ${typeInfo.icon}"></i> ${escapeHTML(item.tipo_equipo || 'Equipo')}</span>
          </div>
          <span class="serial-badge" onclick="copyText('${escapeHTML(item.numero_serie)}')">
            <i class="fa-solid fa-barcode"></i> ${escapeHTML(item.numero_serie || 'N/A')}
          </span>
        </div>

        <div class="grid-card-specs">
          <div class="grid-spec-row">
            <span class="grid-spec-label">Marca / Placa:</span>
            <span class="grid-spec-val">${escapeHTML(item.fabricante || item.placa_base || 'N/A')}</span>
          </div>
          ${item.procesador ? `
          <div class="grid-spec-row">
            <span class="grid-spec-label">Procesador:</span>
            <span class="grid-spec-val">${escapeHTML(item.procesador.substring(0, 24))}...</span>
          </div>` : ''}
          ${item.ram_total ? `
          <div class="grid-spec-row">
            <span class="grid-spec-label">RAM:</span>
            <span class="grid-spec-val">${escapeHTML(item.ram_total)}</span>
          </div>` : ''}
          <div class="grid-spec-row">
            <span class="grid-spec-label">Ubicación / Resp:</span>
            <span class="grid-spec-val">${escapeHTML(item.ubicacion || item.usuario_actual || 'N/A')}</span>
          </div>
        </div>

        <div class="table-actions-cell" style="justify-content: flex-end; margin-top: auto;">
          <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.8rem;" onclick="viewDetails('${item.id}')">
            <i class="fa-solid fa-eye"></i> Ver Ficha
          </button>
          ${!isOperador ? `
          <button class="action-btn-mini" onclick="editEquipment('${item.id}')" title="Editar">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="action-btn-mini delete-btn" onclick="deleteEquipment('${item.id}', '${escapeHTML(primaryName)}')" title="Eliminar">
            <i class="fa-solid fa-trash-can"></i>
          </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// -------------------------------------------------------------
// ACTUALIZACIÓN DE MÉTRICAS Y CONTADORES DE CATEGORÍA
// -------------------------------------------------------------
function updateMetrics() {
  const total = inventoryData.length;
  let computadoras = 0;
  let impresoras = 0;
  let redes = 0;
  let perifericos = 0;

  inventoryData.forEach(item => {
    const info = getDeviceTypeInfo(item.tipo_equipo);
    if (info.category === 'Computadoras') computadoras++;
    else if (info.category === 'Impresoras') impresoras++;
    else if (info.category === 'Redes') redes++;
    else if (info.category === 'Periféricos') perifericos++;
  });

  const statTotal = document.getElementById('statTotal');
  const statDesktop = document.getElementById('statDesktop');
  if (statTotal) statTotal.textContent = total;
  if (statDesktop) statDesktop.textContent = computadoras;

  const countAll = document.getElementById('countAll');
  const countComputadoras = document.getElementById('countComputadoras');
  const countImpresoras = document.getElementById('countImpresoras');
  const countRedes = document.getElementById('countRedes');
  const countPerifericos = document.getElementById('countPerifericos');

  if (countAll) countAll.textContent = total;
  if (countComputadoras) countComputadoras.textContent = computadoras;
  if (countImpresoras) countImpresoras.textContent = impresoras;
  if (countRedes) countRedes.textContent = redes;
  if (countPerifericos) countPerifericos.textContent = perifericos;
}

// -------------------------------------------------------------
// GESTIÓN DE MODALES Y FORMULARIOS
// -------------------------------------------------------------
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('active');
}

function openManualCreateModal() {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';
  if (isOperador) {
    showToast('Acceso denegado: El usuario operador no tiene permisos para registrar equipos.', 'error');
    return;
  }
  document.getElementById('modalFormTitle').textContent = 'Registrar Nuevo Equipo de Cómputo';
  document.getElementById('formEquipmentId').value = '';
  equipmentForm.reset();
  openModal('manualModal');
}

// Editar equipo existente
function editEquipment(id) {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';
  if (isOperador) {
    showToast('Acceso denegado: El usuario operador no tiene permisos para editar equipos.', 'error');
    return;
  }

  const item = inventoryData.find(i => i.id === id);
  if (!item) return;

  document.getElementById('modalFormTitle').textContent = 'Editar Equipo de Cómputo';
  document.getElementById('formEquipmentId').value = item.id;
  document.getElementById('formModelo').value = item.modelo || '';
  document.getElementById('formNumeroSerie').value = item.numero_serie || '';
  document.getElementById('formPlacaBase').value = item.placa_base || '';
  document.getElementById('formTipoEquipo').value = item.tipo_equipo || 'PC de Escritorio';
  document.getElementById('formFabricante').value = item.fabricante || '';
  document.getElementById('formEstado').value = item.estado || 'Operativo';
  document.getElementById('formProcesador').value = item.procesador || '';
  document.getElementById('formRamTotal').value = item.ram_total || '';
  document.getElementById('formAlmacenamiento').value = item.almacenamiento_resumen || '';
  
  // Monitores & Periféricos
  const monStr = (item.monitores || []).map(m => `${m.modelo || m.fabricante} (${m.serie || 'S/N: N/A'})`).join(', ');
  document.getElementById('formMonitor').value = monStr;
  
  const perStr = (item.perifericos || []).map(p => p.nombre || p.tipo).join(', ');
  document.getElementById('formPerifericos').value = perStr;

  document.getElementById('formHostname').value = item.hostname || '';
  document.getElementById('formUsuario').value = item.usuario_actual || '';
  document.getElementById('formUbicacion').value = item.ubicacion || '';
  document.getElementById('formNotas').value = item.notas || '';

  closeModal('detailsModal');
  openModal('manualModal');
}

// Enviar Formulario Manual
async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('formEquipmentId').value;
  const payload = {
    modelo: document.getElementById('formModelo').value,
    numero_serie: document.getElementById('formNumeroSerie').value,
    placa_base: document.getElementById('formPlacaBase').value,
    tipo_equipo: document.getElementById('formTipoEquipo').value,
    fabricante: document.getElementById('formFabricante').value,
    estado: document.getElementById('formEstado').value,
    procesador: document.getElementById('formProcesador').value,
    ram_total: document.getElementById('formRamTotal').value,
    almacenamiento_resumen: document.getElementById('formAlmacenamiento').value,
    hostname: document.getElementById('formHostname').value,
    usuario_actual: document.getElementById('formUsuario').value,
    ubicacion: document.getElementById('formUbicacion').value,
    notas: document.getElementById('formNotas').value
  };

  const isEdit = !!id;
  const url = isEdit ? `/api/inventory/${id}` : '/api/inventory';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Error al guardar');
    }

    closeModal('manualModal');
    showToast(isEdit ? 'Equipo actualizado con éxito' : 'Nuevo equipo registrado con éxito', 'success');
    fetchInventory();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Escanear PC (Ejecución 100% automática y silenciosa sin descargas ni intervención manual)
async function handleScanLocal() {
  showToast('Iniciando auditoría de hardware en segundo plano...', 'info');

  const cloudReportUrl = window.location.origin;

  // 1. Intentar disparar el ejecutor local en segundo plano
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const resLocal = await fetch('http://127.0.0.1:3000/api/run-local-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudReportUrl }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (resLocal.ok) {
      showToast('¡Hardware auditado con éxito! Sincronizando inventario...', 'success');
      setTimeout(fetchInventory, 2500);
      return;
    }
  } catch (e) {}

  // 2. Disparar contra la API activa
  try {
    const res = await fetch('/api/run-local-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudReportUrl })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('¡Hardware auditado y registrado con éxito!', 'success');
      setTimeout(fetchInventory, 2000);
    } else {
      showToast('Auditoría en proceso... Actualizando datos.', 'info');
      setTimeout(fetchInventory, 3000);
    }
  } catch (err) {
    showToast('Auditoría en proceso... Actualizando datos.', 'info');
    setTimeout(fetchInventory, 3000);
  }
}

// Eliminar equipo
async function deleteEquipment(id, modelo) {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';
  if (isOperador) {
    showToast('Acceso denegado: El usuario operador no tiene permisos para eliminar registros.', 'error');
    return;
  }

  if (!confirm(`¿Estás seguro de eliminar el equipo "${modelo}" del inventario?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/inventory/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Error al eliminar');

    showToast('Equipo eliminado del inventario', 'info');
    fetchInventory();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// VER FICHA TÉCNICA DETALLADA
// -------------------------------------------------------------
function viewDetails(id) {
  const item = inventoryData.find(i => i.id === id);
  if (!item) return;

  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';

  document.getElementById('detailsTitle').textContent = item.hostname || item.modelo || 'Ficha Técnica';
  document.getElementById('detailsSubtitle').textContent = `S/N: ${item.numero_serie || 'N/A'} | Tipo: ${item.tipo_equipo || 'PC'}`;

  // Configurar botones de editar y eliminar desde ficha técnica
  const btnEditFromDetails = document.getElementById('btnEditFromDetails');
  const btnDeleteFromDetails = document.getElementById('btnDeleteFromDetails');

  if (btnEditFromDetails) {
    btnEditFromDetails.style.display = isOperador ? 'none' : 'inline-flex';
    btnEditFromDetails.onclick = () => {
      editEquipment(item.id);
    };
  }

  if (btnDeleteFromDetails) {
    btnDeleteFromDetails.style.display = isOperador ? 'none' : 'inline-flex';
    btnDeleteFromDetails.onclick = () => {
      closeModal('detailsModal');
      deleteEquipment(item.id, item.hostname || item.modelo);
    };
  }

  // Monitores List
  let monitoresHtml = '<p class="text-gray-400">Sin monitores adicionales registrados</p>';
  if (item.monitores && item.monitores.length > 0) {
    monitoresHtml = `
      <ul class="components-list">
        ${item.monitores.map(m => `
          <li class="component-item">
            <strong><i class="fa-solid fa-display"></i> ${escapeHTML(m.modelo || m.fabricante || 'Monitor')}</strong>
            <br><small class="text-gray-400">Fabricante: ${escapeHTML(m.fabricante || 'N/A')} | S/N: <span class="text-crimson mono-font">${escapeHTML(m.serie || 'N/A')}</span></small>
          </li>
        `).join('')}
      </ul>
    `;
  }

  // Periféricos List
  let perifericosHtml = '<p class="text-gray-400">Sin periféricos USB registrados</p>';
  if (item.perifericos && item.perifericos.length > 0) {
    perifericosHtml = `
      <ul class="components-list">
        ${item.perifericos.map(p => `
          <li class="component-item">
            <strong><i class="fa-solid fa-plug"></i> [${escapeHTML(p.tipo || 'USB')}] ${escapeHTML(p.nombre || 'Dispositivo')}</strong>
            ${p.id_hardware ? `<br><small class="text-gray-400" style="font-family: var(--font-mono); font-size: 0.72rem;">ID: ${escapeHTML(p.id_hardware)}</small>` : ''}
          </li>
        `).join('')}
      </ul>
    `;
  }

  // RAM Slots List
  let ramSlotsHtml = `<div class="spec-box-val">${escapeHTML(item.ram_total || 'N/A')}</div>`;
  if (item.ram_detalles && item.ram_detalles.length > 0) {
    ramSlotsHtml += `
      <ul class="components-list mt-4">
        ${item.ram_detalles.map(slot => `
          <li class="component-item" style="font-size: 0.78rem;">
            <i class="fa-solid fa-memory"></i> ${escapeHTML(slot)}
          </li>
        `).join('')}
      </ul>
    `;
  }

  // Discos List
  let discosHtml = `<div class="spec-box-val">${escapeHTML(item.almacenamiento_resumen || 'N/A')}</div>`;
  if (item.almacenamiento && item.almacenamiento.length > 0) {
    discosHtml += `
      <ul class="components-list mt-4">
        ${item.almacenamiento.map(d => `
          <li class="component-item">
            <strong><i class="fa-solid fa-hard-drive"></i> ${escapeHTML(d.modelo || d.tipo)} (${escapeHTML(d.capacidad || '')})</strong>
            <br><small class="text-gray-400">Número de Serie: <span class="text-crimson mono-font">${escapeHTML(d.serie || 'N/A')}</span> | Interfaz: ${escapeHTML(d.interfaz || 'N/A')}</small>
          </li>
        `).join('')}
      </ul>
    `;
  }

  const content = `
    <div class="form-section-title">
      <i class="fa-solid fa-circle-check"></i> IDENTIFICACIÓN DEL EQUIPO
    </div>
    
    <div class="specs-detail-grid">
      <div class="spec-box">
        <div class="spec-box-title">NOMBRE DE EQUIPO (HOSTNAME)</div>
        <div class="spec-box-val mono hostname-highlight" style="font-weight: 700; font-size: 1.05rem;">${escapeHTML(item.hostname || 'N/A')}</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">MODELO DE EQUIPO</div>
        <div class="spec-box-val">${escapeHTML(item.modelo || 'N/A')}</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">NÚMERO DE SERIE (S/N)</div>
        <div class="spec-box-val mono">${escapeHTML(item.numero_serie || 'N/A')}</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">PLACA BASE (MOTHERBOARD)</div>
        <div class="spec-box-val mono">${escapeHTML(item.placa_base_completa || item.placa_base || 'N/A')}</div>
      </div>
    </div>

    <div class="form-section-title mt-4">
      <i class="fa-solid fa-microchip"></i> PROCESADOR, MEMORIA & ALMACENAMIENTO
    </div>

    <div class="specs-detail-grid">
      <div class="spec-box" style="grid-column: 1 / -1;">
        <div class="spec-box-title">PROCESADOR (CPU)</div>
        <div class="spec-box-val">${escapeHTML(item.procesador || 'N/A')}</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">MEMORIA RAM</div>
        ${ramSlotsHtml}
      </div>
      <div class="spec-box">
        <div class="spec-box-title">UNIDADES DE ALMACENAMIENTO</div>
        ${discosHtml}
      </div>
    </div>

    <div class="form-section-title mt-4">
      <i class="fa-solid fa-keyboard"></i> MONITORES Y PERIFÉRICOS CONECTADOS
    </div>

    <div class="specs-detail-grid">
      <div class="spec-box">
        <div class="spec-box-title">PANTALLAS / MONITORES</div>
        ${monitoresHtml}
      </div>
      <div class="spec-box">
        <div class="spec-box-title">PERIFÉRICOS & DISPOSITIVOS USB</div>
        ${perifericosHtml}
      </div>
    </div>

    <div class="form-section-title mt-4">
      <i class="fa-solid fa-network-wired"></i> DATOS DE RED, ASIGNACIÓN & AUDITORÍA
    </div>

    <div class="specs-detail-grid">
      <div class="spec-box">
        <div class="spec-box-title">HOSTNAME / EQUIPO</div>
        <div class="spec-box-val mono">${escapeHTML(item.hostname || 'N/A')}</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">USUARIO RESPONSABLE</div>
        <div class="spec-box-val">${escapeHTML(item.usuario_actual || 'N/A')}</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">DIRECCIÓN IP / MAC</div>
        <div class="spec-box-val mono">${escapeHTML(item.ip_red || 'N/A')} (${escapeHTML(item.mac_address || 'N/A')})</div>
      </div>
      <div class="spec-box">
        <div class="spec-box-title">ORIGEN Y FECHA</div>
        <div class="spec-box-val">${escapeHTML(item.origen || 'Manual')} - ${escapeHTML(item.fecha_escaneo || 'N/A')}</div>
      </div>
    </div>
  `;

  document.getElementById('detailsContent').innerHTML = content;
  openModal('detailsModal');
}

// -------------------------------------------------------------
// UTILIDADES
// -------------------------------------------------------------
function copyText(text) {
  if (!text || text === 'N/A') return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Serial copiado: ${text}`, 'success');
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? 'fa-circle-check text-green' : (type === 'error' ? 'fa-triangle-exclamation text-crimson' : 'fa-circle-info text-crimson');
  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHTML(message)}</span>`;
  
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// ESCÁNER DE CÓDIGO DE BARRAS & QR CON CÁMARA (CELULAR)
// -------------------------------------------------------------
let html5QrScanner = null;
let currentCameraFacing = "environment";

function startCameraScanner(targetInputId = 'formNumeroSerie') {
  const camModal = document.getElementById('cameraModal');
  if (camModal) {
    camModal.classList.add('active');
    camModal.style.zIndex = '100050';
    camModal.style.display = 'flex';
  }

  const cameraContainer = document.getElementById('cameraPreview');
  if (cameraContainer) {
    cameraContainer.innerHTML = '<div class="camera-loading-hint"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><span>Encendiendo cámara y visor...</span></div>';
  }

  if (typeof Html5Qrcode === 'undefined') {
    showToast('Iniciando lector de cámara...', 'info');
    setTimeout(() => startCameraScanner(targetInputId), 350);
    return;
  }

  if (html5QrScanner) {
    try {
      html5QrScanner.stop().catch(() => {}).finally(() => {
        try { html5QrScanner.clear(); } catch(e) {}
      });
    } catch (e) {}
  }

  setTimeout(() => {
    try {
      html5QrScanner = new Html5Qrcode("cameraPreview");

      const config = {
        fps: 20,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const width = Math.min(viewfinderWidth * 0.9, 320);
          const height = Math.min(viewfinderHeight * 0.7, 200);
          return { width: Math.floor(width), height: Math.floor(height) };
        },
        aspectRatio: 1.333334
      };

      html5QrScanner.start(
        { facingMode: currentCameraFacing },
        config,
        (decodedText) => {
          const cleanText = (decodedText || '').trim().toUpperCase();
          if (cleanText) {
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            const input = document.getElementById(targetInputId);
            if (input) {
              input.value = cleanText;
              input.focus();
              input.style.borderColor = 'var(--accent-emerald)';
              input.style.boxShadow = '0 0 14px rgba(16, 185, 129, 0.5)';
              setTimeout(() => {
                input.style.borderColor = '';
                input.style.boxShadow = '';
              }, 2500);
            }
            showToast(`¡Código escaneado: ${cleanText}!`, 'success');
            stopCameraScanner();
          }
        },
        () => {}
      ).catch(err => {
        console.warn('Error accediendo a la cámara:', err);
        if (cameraContainer) {
          cameraContainer.innerHTML = '<div class="camera-error-hint"><i class="fa-solid fa-triangle-exclamation text-crimson fa-2x"></i><p>Permite el acceso a la cámara en los permisos de tu navegador</p></div>';
        }
        showToast('Permite el acceso a la cámara en tu navegador', 'error');
      });
    } catch (err) {
      console.error('Error inicializando escáner:', err);
    }
  }, 100);
}

function stopCameraScanner() {
  if (html5QrScanner) {
    try {
      html5QrScanner.stop().then(() => {
        try { html5QrScanner.clear(); } catch(e) {}
      }).catch(() => {
        try { html5QrScanner.clear(); } catch(e) {}
      });
    } catch (e) {}
  }
  closeModal('cameraModal');
  const camModal = document.getElementById('cameraModal');
  if (camModal) {
    camModal.style.display = '';
  }
}

// ==============================================================================
// NAVEGACIÓN MULTI-PÁGINA (INVENTARIO MAESTRO vs DASHBOARD & AMBIENTES)
// ==============================================================================
function initMultiPageNav() {
  const tabNavInventory = document.getElementById('tabNavInventory');
  const tabNavDashboard = document.getElementById('tabNavDashboard');

  if (tabNavInventory && tabNavDashboard) {
    tabNavInventory.addEventListener('click', () => switchPage('inventory'));
    tabNavDashboard.addEventListener('click', () => switchPage('dashboard'));
  }

  const dashFilterAmbiente = document.getElementById('dashFilterAmbiente');
  if (dashFilterAmbiente) {
    dashFilterAmbiente.addEventListener('change', () => renderDashboard());
  }

  const dashFilterTipo = document.getElementById('dashFilterTipo');
  if (dashFilterTipo) {
    dashFilterTipo.addEventListener('change', () => renderDashboard());
  }
}

function switchPage(pageName) {
  const tabNavInventory = document.getElementById('tabNavInventory');
  const tabNavDashboard = document.getElementById('tabNavDashboard');
  const pageInventoryView = document.getElementById('pageInventoryView');
  const pageDashboardView = document.getElementById('pageDashboardView');

  if (pageName === 'dashboard') {
    if (tabNavDashboard) tabNavDashboard.classList.add('active');
    if (tabNavInventory) tabNavInventory.classList.remove('active');
    if (pageDashboardView) pageDashboardView.style.display = 'block';
    if (pageInventoryView) pageInventoryView.style.display = 'none';
    renderDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    if (tabNavInventory) tabNavInventory.classList.add('active');
    if (tabNavDashboard) tabNavDashboard.classList.remove('active');
    if (pageInventoryView) pageInventoryView.style.display = 'block';
    if (pageDashboardView) pageDashboardView.style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function filterByAmbiente(ambienteName) {
  switchPage('inventory');
  if (searchInput) {
    searchInput.value = ambienteName;
    currentSearchQuery = ambienteName.toLowerCase().trim();
    if (btnClearSearch) btnClearSearch.style.display = 'block';
  }
  renderData();
  showToast(`Filtrando inventario por: "${ambienteName}"`, 'info');
  const tableCard = document.getElementById('tableViewContainer');
  if (tableCard) tableCard.scrollIntoView({ behavior: 'smooth' });
}

function filterByStatus(statusName) {
  switchPage('inventory');
  if (statusFilter) {
    statusFilter.value = statusName;
    currentFilterStatus = statusName;
  }
  renderData();
  showToast(`Filtrando inventario por estado: "${statusName}"`, 'info');
  const tableCard = document.getElementById('tableViewContainer');
  if (tableCard) tableCard.scrollIntoView({ behavior: 'smooth' });
}

function renderDashboard() {
  const dashFilterAmbiente = document.getElementById('dashFilterAmbiente');
  const dashFilterTipo = document.getElementById('dashFilterTipo');

  const selectedAmbiente = dashFilterAmbiente ? dashFilterAmbiente.value : 'Todos';
  const selectedTipo = dashFilterTipo ? dashFilterTipo.value : 'Todos';

  // 1. Poblar el selector de ambientes únicos
  if (dashFilterAmbiente && (dashFilterAmbiente.options.length <= 1 || dashFilterAmbiente.options.length !== (new Set(inventoryData.map(i => (i.ubicacion || 'Sin Asignar').trim())).size + 1))) {
    const uniqueAmbientes = Array.from(new Set(inventoryData.map(i => (i.ubicacion || 'Sin Asignar').trim()))).filter(Boolean).sort();
    const prevVal = dashFilterAmbiente.value;
    dashFilterAmbiente.innerHTML = '<option value="Todos">🏢 Todos los Ambientes</option>';
    uniqueAmbientes.forEach(amb => {
      const opt = document.createElement('option');
      opt.value = amb;
      opt.textContent = `📍 ${amb}`;
      dashFilterAmbiente.appendChild(opt);
    });
    if (prevVal && uniqueAmbientes.includes(prevVal)) {
      dashFilterAmbiente.value = prevVal;
    }
  }

  // Filtrar datos para el dashboard según selección
  let filteredData = inventoryData;
  if (selectedAmbiente !== 'Todos') {
    filteredData = filteredData.filter(i => (i.ubicacion || 'Sin Asignar').trim().toLowerCase() === selectedAmbiente.toLowerCase());
  }
  if (selectedTipo !== 'Todos') {
    filteredData = filteredData.filter(i => {
      if (selectedTipo === 'PC de Escritorio') return i.tipo_equipo === 'PC de Escritorio' || i.tipo_equipo === 'Desktop';
      if (selectedTipo === 'Laptop') return i.tipo_equipo === 'Laptop' || i.tipo_equipo === 'Notebook';
      if (selectedTipo === 'Periféricos') return (i.perifericos && i.perifericos.length > 0) || (i.monitores && i.monitores.length > 0);
      return i.tipo_equipo === selectedTipo;
    });
  }

  // 2. Calcular KPIs
  const allAmbientes = new Set(inventoryData.map(i => (i.ubicacion || 'Sin Asignar').trim()).filter(Boolean));
  const totalPCs = filteredData.filter(i => i.tipo_equipo === 'PC de Escritorio' || i.tipo_equipo === 'Laptop' || i.tipo_equipo === 'Mini PC' || i.tipo_equipo === 'All-in-One').length;
  
  let totalMonitores = 0;
  let totalPerifericos = 0;
  filteredData.forEach(item => {
    totalMonitores += (item.monitores || []).length;
    totalPerifericos += (item.perifericos || []).length;
  });

  const dashTotalAmbientes = document.getElementById('dashTotalAmbientes');
  const dashTotalPCs = document.getElementById('dashTotalPCs');
  const dashTotalMonitores = document.getElementById('dashTotalMonitores');
  const dashTotalPerifericos = document.getElementById('dashTotalPerifericos');

  if (dashTotalAmbientes) dashTotalAmbientes.textContent = allAmbientes.size;
  if (dashTotalPCs) dashTotalPCs.textContent = totalPCs;
  if (dashTotalMonitores) dashTotalMonitores.textContent = totalMonitores;
  if (dashTotalPerifericos) dashTotalPerifericos.textContent = totalPerifericos;

  // 3. Renderizar Tarjetas de Ambientes (Distribución Espacial)
  const ambientesGrid = document.getElementById('ambientesCardsGrid');
  if (ambientesGrid) {
    const ambientesMap = new Map();
    inventoryData.forEach(item => {
      const ambName = (item.ubicacion || 'Sin Asignar / Bodega').trim();
      if (!ambientesMap.has(ambName)) {
        ambientesMap.set(ambName, {
          nombre: ambName,
          equipos: [],
          desktops: 0,
          laptops: 0,
          monitores: 0,
          perifericos: 0,
          usuarios: new Set()
        });
      }
      const data = ambientesMap.get(ambName);
      data.equipos.push(item);
      if (item.tipo_equipo === 'Laptop') data.laptops++;
      else data.desktops++;
      data.monitores += (item.monitores || []).length;
      data.perifericos += (item.perifericos || []).length;
      if (item.usuario_actual) data.usuarios.add(item.usuario_actual);
    });

    const ambientesList = Array.from(ambientesMap.values());
    if (ambientesList.length === 0) {
      ambientesGrid.innerHTML = '<p class="text-gray-400">No hay ambientes registrados aún.</p>';
    } else {
      ambientesGrid.innerHTML = ambientesList.map(amb => {
        const userListStr = Array.from(amb.usuarios).slice(0, 3).join(', ') || 'No asignado';
        const isSelected = selectedAmbiente === amb.nombre;

        return `
          <div class="ambiente-card ${isSelected ? 'selected-ambiente' : ''}">
            <div class="ambiente-card-header">
              <div class="ambiente-title-box">
                <i class="fa-solid fa-location-dot text-crimson"></i>
                <h4>${escapeHTML(amb.nombre)}</h4>
              </div>
              <span class="ambiente-total-badge">${amb.equipos.length} equipos</span>
            </div>

            <div class="ambiente-card-stats">
              <div class="amb-stat-chip"><i class="fa-solid fa-desktop text-crimson"></i> <b>${amb.desktops}</b> PCs</div>
              <div class="amb-stat-chip"><i class="fa-solid fa-laptop text-blue"></i> <b>${amb.laptops}</b> Laptops</div>
              <div class="amb-stat-chip"><i class="fa-solid fa-display text-emerald"></i> <b>${amb.monitores}</b> Pantallas</div>
              <div class="amb-stat-chip"><i class="fa-solid fa-keyboard text-purple"></i> <b>${amb.perifericos}</b> Periféricos</div>
            </div>

            <div class="ambiente-user-list">
              <i class="fa-solid fa-users text-gray-400"></i>
              <span><b>Responsables:</b> ${escapeHTML(userListStr)}${amb.usuarios.size > 3 ? '...' : ''}</span>
            </div>

            <div class="ambiente-card-footer">
              <button class="btn btn-secondary btn-sm w-100" onclick="filterByAmbiente('${escapeHTML(amb.nombre)}')">
                <i class="fa-solid fa-arrow-right-to-bracket"></i> Ver Equipos de este Ambiente
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. Renderizar Desglose por Modelos y Tipos
  const modelosListContainer = document.getElementById('modelosBreakdownList');
  if (modelosListContainer) {
    const modelosCount = {};
    filteredData.forEach(item => {
      const modeloKey = `${item.fabricante ? item.fabricante + ' ' : ''}${item.modelo || 'Equipo Estándar'}`.trim();
      modelosCount[modeloKey] = (modelosCount[modeloKey] || 0) + 1;
    });

    const sortedModelos = Object.entries(modelosCount).sort((a, b) => b[1] - a[1]);
    const maxCount = sortedModelos[0] ? sortedModelos[0][1] : 1;

    modelosListContainer.innerHTML = sortedModelos.map(([modelo, count]) => {
      const percent = Math.round((count / (filteredData.length || 1)) * 100);
      return `
        <div class="breakdown-row" onclick="filterByAmbiente('${escapeHTML(modelo)}')" title="Clic para filtrar por este modelo">
          <div class="breakdown-label">
            <span class="breakdown-name"><i class="fa-solid fa-microchip text-crimson"></i> ${escapeHTML(modelo)}</span>
            <span class="breakdown-count"><b>${count}</b> (${percent}%)</span>
          </div>
          <div class="breakdown-bar-bg">
            <div class="breakdown-bar-fill fill-crimson" style="width: ${percent}%;"></div>
          </div>
        </div>
      `;
    }).join('') || '<p class="text-gray-400">No hay modelos registrados</p>';
  }

  // 5. Renderizar Inventario de Periféricos
  const perifericosContainer = document.getElementById('perifericosBreakdownList');
  if (perifericosContainer) {
    const perCatCount = {
      'Monitores': 0,
      'Teclados': 0,
      'Mouse / Punteros': 0,
      'Audífonos / Diademas': 0,
      'Webcams / Cámaras': 0,
      'Otros Dispositivos USB': 0
    };

    filteredData.forEach(item => {
      (item.monitores || []).forEach(() => perCatCount['Monitores']++);
      (item.perifericos || []).forEach(p => {
        const t = (p.tipo || p.nombre || '').toLowerCase();
        if (t.includes('teclado') || t.includes('keyboard')) perCatCount['Teclados']++;
        else if (t.includes('mouse') || t.includes('ratón')) perCatCount['Mouse / Punteros']++;
        else if (t.includes('audífono') || t.includes('headset') || t.includes('diadema')) perCatCount['Audífonos / Diademas']++;
        else if (t.includes('camera') || t.includes('webcam') || t.includes('cámara')) perCatCount['Webcams / Cámaras']++;
        else perCatCount['Otros Dispositivos USB']++;
      });
    });

    const totalPerifs = Object.values(perCatCount).reduce((a, b) => a + b, 0);

    perifericosContainer.innerHTML = Object.entries(perCatCount).map(([cat, count]) => {
      const percent = totalPerifs > 0 ? Math.round((count / totalPerifs) * 100) : 0;
      let icon = 'fa-plug';
      if (cat === 'Monitores') icon = 'fa-display';
      else if (cat === 'Teclados') icon = 'fa-keyboard';
      else if (cat === 'Mouse / Punteros') icon = 'fa-mouse';
      else if (cat === 'Audífonos / Diademas') icon = 'fa-headphones';
      else if (cat === 'Webcams / Cámaras') icon = 'fa-video';

      return `
        <div class="breakdown-row" onclick="filterByAmbiente('${cat === 'Monitores' ? 'Monitor' : 'Periféricos'}')">
          <div class="breakdown-label">
            <span class="breakdown-name"><i class="fa-solid ${icon} text-crimson"></i> ${cat}</span>
            <span class="breakdown-count"><b>${count}</b> unidades</span>
          </div>
          <div class="breakdown-bar-bg">
            <div class="breakdown-bar-fill fill-blue" style="width: ${percent}%;"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 6. Renderizar Estado Operativo & Salud
  const healthGrid = document.getElementById('healthStatusGrid');
  if (healthGrid) {
    const states = {
      'Operativo': { count: 0, icon: 'fa-circle-check', color: '#10b981', label: 'Operativos' },
      'En Uso': { count: 0, icon: 'fa-user-check', color: '#3b82f6', label: 'En Uso Activo' },
      'En Mantenimiento': { count: 0, icon: 'fa-screwdriver-wrench', color: '#f59e0b', label: 'En Mantenimiento' },
      'En Bodega': { count: 0, icon: 'fa-boxes-packing', color: '#94a3b8', label: 'En Bodega / Almacén' },
      'De Baja': { count: 0, icon: 'fa-ban', color: '#ef4444', label: 'De Baja / Retirados' }
    };

    filteredData.forEach(item => {
      const st = item.estado || 'Operativo';
      if (states[st]) states[st].count++;
      else states['Operativo'].count++;
    });

    healthGrid.innerHTML = Object.entries(states).map(([name, data]) => {
      return `
        <div class="health-card" onclick="filterByStatus('${name}')">
          <div class="health-card-icon" style="color: ${data.color}; background: ${data.color}22; border: 1px solid ${data.color}44;">
            <i class="fa-solid ${data.icon}"></i>
          </div>
          <div class="health-card-data">
            <span class="health-num" style="color: ${data.color};">${data.count}</span>
            <span class="health-label">${data.label}</span>
          </div>
        </div>
      `;
    }).join('');
  }
}

