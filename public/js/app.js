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
      ? `<i class="fa-solid fa-eye text-cyan"></i>` 
      : `<i class="fa-solid fa-crown gold-crown-icon"></i>`;
  }
  
  if (sessionUserName) {
    sessionUserName.innerHTML = role === 'operador' 
      ? `<b>OBSERVADOR</b>` 
      : `<b>${escapeHTML(username)}</b>`;
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

  const color = theme === 'light' ? '#ffffff' : '#08080c';

  const metaThemeColor = document.getElementById('metaThemeColor');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', color);
  }

  const metaMsNav = document.getElementById('metaMsNav');
  if (metaMsNav) {
    metaMsNav.setAttribute('content', color);
  }

  const metaAppleStatus = document.getElementById('metaAppleStatus');
  if (metaAppleStatus) {
    metaAppleStatus.setAttribute('content', theme === 'light' ? 'default' : 'black-translucent');
  }

  // Actualizar cualquier otra etiqueta theme-color
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.setAttribute('content', color);
  });

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

  // Filtros por pestañas (Pills)
  document.querySelectorAll('.filter-pills-group .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pills-group .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const target = pill.getAttribute('data-type') || pill.getAttribute('data-category') || 'Todos';
      applyMetricFilter(target);
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
  if (statusFilter) {
    statusFilter.addEventListener('change', (e) => {
      currentFilterStatus = e.target.value;
      renderData();
    });
  }

  // Clic interactivo en tarjetas de métricas y pastillas para filtrar
  window.applyMetricFilter = function(target) {
    document.querySelectorAll('.filter-pills-group .pill').forEach(p => {
      const pCat = p.getAttribute('data-category');
      const pType = p.getAttribute('data-type');
      if (target === 'Todos' && (pCat === 'Todos' || pType === 'Todos')) p.classList.add('active');
      else if (pCat === target || pType === target) p.classList.add('active');
      else p.classList.remove('active');
    });

    document.querySelectorAll('.metrics-grid .metric-card').forEach(card => {
      const cFilter = card.getAttribute('data-filter');
      if (cFilter === target) {
        card.classList.add('active-filter');
      } else {
        card.classList.remove('active-filter');
      }
    });

    currentCategory = target;
    currentFilterType = 'Todos';
    currentSpecificType = 'Todos';
    if (typeSelectFilter) typeSelectFilter.value = 'Todos';

    if (target === 'Todos') {
      currentFilterStatus = 'Todos';
      if (statusFilter) statusFilter.value = 'Todos';
      if (searchInput) {
        searchInput.value = '';
        currentSearchQuery = '';
        if (btnClearSearch) btnClearSearch.style.display = 'none';
      }
      showToast('Mostrando todos los equipos', 'info');
    } else {
      showToast(`Filtrando por: ${target}`, 'info');
    }

    renderData();
    const tableContainer = document.getElementById('tableViewContainer');
    if (tableContainer) tableContainer.scrollIntoView({ behavior: 'smooth' });
  };

  const cardFilterTotal = document.getElementById('cardFilterTotal');
  if (cardFilterTotal) cardFilterTotal.addEventListener('click', () => applyMetricFilter('Todos'));

  const cardFilterDesktop = document.getElementById('cardFilterDesktop');
  if (cardFilterDesktop) cardFilterDesktop.addEventListener('click', () => applyMetricFilter('PC de Escritorio'));

  const cardFilterLaptop = document.getElementById('cardFilterLaptop');
  if (cardFilterLaptop) cardFilterLaptop.addEventListener('click', () => applyMetricFilter('Laptop'));

  const cardFilterMonitor = document.getElementById('cardFilterMonitor');
  if (cardFilterMonitor) cardFilterMonitor.addEventListener('click', () => applyMetricFilter('Monitor'));

  const cardFilterPerifericos = document.getElementById('cardFilterPerifericos');
  if (cardFilterPerifericos) cardFilterPerifericos.addEventListener('click', () => applyMetricFilter('Periféricos'));

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

  // Auto-detección en tiempo real de Especificaciones de Fábrica (CPU, RAM, Almacenamiento, Placa, Marca, Consumible)
  // Base de datos cliente de Auto-Llenado Rápido con Coincidencia Difusa Ultra-Flexible (0ms)
  const CLIENT_SPECS_CATALOG = [
    // GAMING & HIGH-PERFORMANCE LAPTOPS
    { keywords: ['victus', '15-fb', 'gaming 15', 'fb3021la'], brand: 'HP', type: 'Laptop', cpu: 'AMD Ryzen 5 8645HS @ 4.30GHz (6 Núcleos, 12 Hilos) / NVIDIA GeForce RTX 3050 (6GB)', ram: '16 GB DDR5 (5600MHz)', storage: '512 GB SSD NVMe M.2 PCIe Gen4', motherboard: 'HP 8B9D (AMD Promontory/Bixby Chipset)' },
    { keywords: ['omen'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i7-13700HX / AMD Ryzen 7 (NVIDIA GeForce RTX 4060/4070)', ram: '16 GB DDR5', storage: '1 TB SSD NVMe M.2 PCIe Gen4', motherboard: 'HP OMEN Gaming Motherboard' },
    { keywords: ['tuf', 'fx506', 'fa506', 'tuf gaming'], brand: 'ASUS', type: 'Laptop', cpu: 'Intel Core i5-11400H @ 2.70GHz (6 Núcleos, 12 Hilos) / NVIDIA GeForce RTX 3050', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'ASUS TUF GAMING F15 FX506' },
    { keywords: ['rog', 'strix', 'zephyrus'], brand: 'ASUS', type: 'Laptop', cpu: 'AMD Ryzen 7 7735HS / Intel Core i7 (NVIDIA GeForce RTX 4060)', ram: '16 GB DDR5', storage: '1 TB SSD NVMe M.2', motherboard: 'ASUS ROG Gaming Motherboard' },
    { keywords: ['nitro', 'an515', 'nitro 5'], brand: 'Acer', type: 'Laptop', cpu: 'Intel Core i5-10300H @ 2.50GHz / AMD Ryzen 5 4600H (NVIDIA GeForce RTX)', ram: '16 GB DDR4', storage: '512 GB SSD NVMe M.2', motherboard: 'Acer Nitro AN515' },
    { keywords: ['predator', 'helios'], brand: 'Acer', type: 'Laptop', cpu: 'Intel Core i7-12700H @ 2.30GHz (14 Núcleos, 20 Hilos) / NVIDIA GeForce RTX 3070', ram: '16 GB DDR5', storage: '1 TB SSD NVMe', motherboard: 'Acer Predator Helios Board' },
    { keywords: ['legion', 'legion 5'], brand: 'Lenovo', type: 'Laptop', cpu: 'AMD Ryzen 7 5800H / Intel Core i7 (NVIDIA GeForce RTX 3060)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe', motherboard: 'Lenovo Legion Gaming Board' },

    // HP CORPORATIVO
    { keywords: ['probook', '450'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2 PCIe', motherboard: 'HP 880D' },
    { keywords: ['probook', '440'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe', motherboard: 'HP 880C' },
    { keywords: ['elitebook', '840'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i7-1165G7 @ 2.80GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'HP 8809' },
    { keywords: ['elitebook', '850'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i7-10510U @ 1.80GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4', storage: '512 GB SSD NVMe M.2', motherboard: 'HP 8723' },
    { keywords: ['hp 240', '240 g8', '240 g7', '245 g8', '245 g7'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i3-1115G4 @ 3.00GHz / AMD Ryzen 3 5300U', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'HP 881D' },
    { keywords: ['pavilion', 'hp 15'], brand: 'HP', type: 'Laptop', cpu: 'Intel Core i5-1135G7 / AMD Ryzen 5 5500U', ram: '8 GB / 16 GB DDR4', storage: '512 GB SSD NVMe M.2', motherboard: 'HP Pavilion Motherboard' },
    { keywords: ['prodesk', '400', '600'], brand: 'HP', type: 'PC de Escritorio', cpu: 'Intel Core i5-10500 @ 3.10GHz (6 Núcleos, 12 Hilos)', ram: '8 GB / 16 GB DDR4', storage: '256 GB / 512 GB SSD NVMe', motherboard: 'HP ProDesk System Board' },
    { keywords: ['elitedesk', '800'], brand: 'HP', type: 'PC de Escritorio', cpu: 'Intel Core i7-10700 @ 2.90GHz (8 Núcleos, 16 Hilos)', ram: '16 GB DDR4 (2933MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'HP EliteDesk System Board' },

    // DELL CORPORATIVO & CONSUMO
    { keywords: ['optiplex', '7080', '7070', '7090', '7060', '7050'], brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i7-10700 @ 2.90GHz (8 Núcleos, 16 Hilos)', ram: '16 GB DDR4 (2933MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Dell OptiPlex 7080 (Intel Q470)' },
    { keywords: ['optiplex', '3080', '3070', '3060', '3050', '3020'], brand: 'Dell', type: 'PC de Escritorio', cpu: 'Intel Core i5-10500 / i5-7500 @ 3.10GHz (4/6 Núcleos)', ram: '8 GB DDR4', storage: '256 GB SSD / 500GB HDD', motherboard: 'Dell OptiPlex System Board' },
    { keywords: ['latitude', '5430', '5420', '5410', '5400'], brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 / i5-1235U @ 2.40GHz (4/10 Núcleos)', ram: '16 GB DDR4 (3200MHz)', storage: '256 GB / 512 GB SSD NVMe', motherboard: 'Dell Latitude 5420 System Board' },
    { keywords: ['latitude', '3420', '3410'], brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell Latitude 3420 System Board' },
    { keywords: ['latitude', '7420', '7430'], brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i7-1185G7 @ 3.00GHz (4 Núcleos, 8 Hilos)', ram: '16 GB LPDDR4x', storage: '512 GB SSD NVMe M.2', motherboard: 'Dell Latitude 7420 System Board' },
    { keywords: ['inspiron', '3501', '3511', 'inspiron 15'], brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 / AMD Ryzen 5 5500U', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB SSD NVMe M.2', motherboard: 'Dell Inspiron Mainboard' },
    { keywords: ['vostro', '3400', '3500'], brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz', ram: '8 GB DDR4', storage: '256 GB SSD NVMe', motherboard: 'Dell Vostro System Board' },
    { keywords: ['xps', 'xps 13', 'xps 15'], brand: 'Dell', type: 'Laptop', cpu: 'Intel Core i7-12700H / i7-1185G7 (14 Núcleos)', ram: '16 GB / 32 GB LPDDR5', storage: '512 GB / 1 TB SSD NVMe', motherboard: 'Dell XPS Motherboard' },

    // LENOVO CORPORATIVO
    { keywords: ['thinkpad', 't14', 't490', 't480'], brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-1135G7 @ 2.40GHz (4 Núcleos, 8 Hilos)', ram: '16 GB DDR4 (3200MHz)', storage: '512 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkPad T14 Gen 2' },
    { keywords: ['thinkpad', 'e14', 'e15', 'l14'], brand: 'Lenovo', type: 'Laptop', cpu: 'Intel Core i5-1135G7 / AMD Ryzen 5 5500U', ram: '8 GB / 16 GB DDR4', storage: '256 GB / 512 GB SSD NVMe', motherboard: 'Lenovo ThinkPad System Board' },
    { keywords: ['thinkcentre', 'm70q', 'm720q', 'm920q', 'tiny'], brand: 'Lenovo', type: 'Mini PC', cpu: 'Intel Core i5-10400T @ 2.00GHz (6 Núcleos, 12 Hilos)', ram: '8 GB / 16 GB DDR4', storage: '256 GB SSD NVMe M.2', motherboard: 'Lenovo ThinkCentre M70q' },
    { keywords: ['ideapad', 'ideapad 3', 'ideapad 5'], brand: 'Lenovo', type: 'Laptop', cpu: 'AMD Ryzen 5 5500U @ 2.10GHz / Intel Core i5', ram: '8 GB DDR4 (3200MHz)', storage: '256 GB / 512 GB SSD NVMe', motherboard: 'Lenovo IdeaPad 3 System Board' },

    // APPLE
    { keywords: ['macbook', 'air m1', 'm1'], brand: 'Apple', type: 'Laptop', cpu: 'Apple M1 (8-Core CPU, 7-Core/8-Core GPU)', ram: '8 GB Memoria Unificada', storage: '256 GB SSD PCIe', motherboard: 'Apple M1 Logic Board' },
    { keywords: ['air m2', 'm2'], brand: 'Apple', type: 'Laptop', cpu: 'Apple M2 (8-Core CPU, 8-Core/10-Core GPU)', ram: '8 GB / 16 GB Memoria Unificada', storage: '256 GB / 512 GB SSD PCIe', motherboard: 'Apple M2 Logic Board' },
    { keywords: ['air m3', 'm3', 'macbook pro'], brand: 'Apple', type: 'Laptop', cpu: 'Apple M3 / M3 Pro (8/12-Core CPU, 10/18-Core GPU)', ram: '16 GB / 36 GB Memoria Unificada', storage: '512 GB SSD PCIe', motherboard: 'Apple M3 Logic Board' },
    { keywords: ['imac', 'imac 24'], brand: 'Apple', type: 'All-in-One', cpu: 'Apple M1 / M3 (8-Core CPU, 8-Core GPU)', ram: '8 GB / 16 GB Memoria Unificada', storage: '256 GB / 512 GB SSD', motherboard: 'Apple iMac Logic Board' },

    // IMPRESORAS & MULTIFUNCIONALES
    { keywords: ['l3250', 'l3210', 'l3150', 'l3110', 'ecotank'], brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Microcontrolador RISC Epson ESC/P-R', ram: '128 MB Buffer', storage: 'Memoria Flash Firmware', motherboard: 'Epson EcoTank L3200 Series Controller Board', consumible: 'Tinta Epson T544' },
    { keywords: ['l4260', 'l4160', 'l4150'], brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson ESC/P-R Dual Engine (Duplex Automático)', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson EcoTank L4000 Controller Board', consumible: 'Tinta Epson T504' },
    { keywords: ['l6270', 'l6171', 'l14150'], brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'PrecisionCore Print Head Controller (ADF)', ram: '256 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson EcoTank PrecisionCore Board', consumible: 'Tinta Epson T504' },
    { keywords: ['l805', 'l1800'], brand: 'Epson', type: 'Impresora / Multifuncional', cpu: 'Epson 6-Color Photographic Micro Piezo Engine', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Epson Photo Controller Board', consumible: 'Tinta Epson T673' },
    { keywords: ['laserjet', 'm404', 'm402'], brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP Custom 1200MHz High-Speed Processor', ram: '256 MB DDR3', storage: '512 MB Flash', motherboard: 'HP LaserJet Pro Formatter Board', consumible: 'Tóner HP 58A' },
    { keywords: ['m428', 'laserjet pro mfp'], brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP Dual Core 1200MHz Formatter Engine', ram: '512 MB DDR3', storage: '512 MB Flash', motherboard: 'HP MFP Formatter Board', consumible: 'Tóner HP 58A' },
    { keywords: ['p1102', 'm1132', 'm1212'], brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP RISC 266MHz Processor', ram: '8 MB / 64 MB Buffer', storage: 'Flash ROM', motherboard: 'HP LaserJet P1100 Formatter Board', consumible: 'Tóner HP 85A' },
    { keywords: ['smart tank', '580', '530', '515', '720'], brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP 980MHz Sensor RISC SoC (Wi-Fi BLE)', ram: '256 MB Buffer', storage: 'Memoria Flash', motherboard: 'HP Smart Tank Main Controller Board', consumible: 'Tinta HP GT53 / GT52' },
    { keywords: ['107a', '107w', '135a', '135w', '137fnw'], brand: 'HP', type: 'Impresora / Multifuncional', cpu: 'HP ARM 600MHz Processor', ram: '128 MB Memory', storage: '128 MB Flash', motherboard: 'HP Laser 100 Formatter Board', consumible: 'Tóner HP 105A' },
    { keywords: ['g2110', 'g3110', 'g3160', 'g4110', 'pixma'], brand: 'Canon', type: 'Impresora / Multifuncional', cpu: 'Canon FINE Print Engine Controller', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Canon PIXMA MegaTank Mainboard', consumible: 'Tinta Canon GI-190' },
    { keywords: ['mf3010', 'lbp6030', 'imageclass'], brand: 'Canon', type: 'Impresora / Multifuncional', cpu: 'Canon On-Demand SURF Laser Processor', ram: '64 MB Buffer', storage: 'Memoria Flash', motherboard: 'Canon imageCLASS Laser Formatter Board', consumible: 'Tóner Canon 125' },
    { keywords: ['t520w', 't510w', 't720dw', 't710w', 'brother'], brand: 'Brother', type: 'Impresora / Multifuncional', cpu: 'Brother High-Speed Piezo Controller', ram: '128 MB Buffer', storage: 'Memoria Flash', motherboard: 'Brother InkBenefit Tank Mainboard', consumible: 'Tinta Brother BTD60BK / BT5001' },
    { keywords: ['hl-1212w', 'dcp-1617nw', 'hl-1112'], brand: 'Brother', type: 'Impresora / Multifuncional', cpu: 'Brother 200MHz Laser Controller', ram: '32 MB Buffer', storage: 'Flash ROM', motherboard: 'Brother Laser Engine Board', consumible: 'Tóner Brother TN-1060' },
    { keywords: ['m2040dn', 'm2135dn', 'ecosys', 'kyocera'], brand: 'Kyocera', type: 'Impresora / Multifuncional', cpu: 'Cortex-A9 800MHz Processor', ram: '512 MB RAM', storage: 'Flash Memory', motherboard: 'Kyocera ECOSYS System Controller Board', consumible: 'Tóner Kyocera TK-1175' },

    // SWITCHES, ROUTERS & ACCESS POINTS
    { keywords: ['catalyst', '2960', '9200', '3560', '3750', '3850', 'cisco'], brand: 'Cisco', type: 'Switch de Red', cpu: 'Cisco Enterprise MIPS/ARM Switch Engine', ram: '512 MB DRAM', storage: '128 MB Flash Memory', motherboard: 'Cisco Catalyst 24/48 Puertos Gigabit PoE+ / SFP+' },
    { keywords: ['crs', 'crs326', 'crs328', 'mikrotik', 'rb750', 'rb3011', 'rb4011', 'hex'], brand: 'MikroTik', type: 'Switch de Red', cpu: 'Marvell Dual Core 800MHz (RouterOS / SwOS)', ram: '512 MB RAM', storage: '16 MB Flash', motherboard: 'MikroTik Cloud Gigabit Switch / Router Board' },
    { keywords: ['unifi', 'usw', 'u6', 'u6-pro', 'udm', 'ubiquiti'], brand: 'Ubiquiti', type: 'Switch de Red', cpu: 'Ubiquiti UniFi ARM Processor', ram: '512 MB DDR3', storage: '256 MB Flash', motherboard: 'Ubiquiti UniFi Managed Gigabit Board (PoE+)' },
    { keywords: ['sg1024', 'sg1016', 'sg2428p', 'jetstream', 'tp-link'], brand: 'TP-Link', type: 'Switch de Red', cpu: 'Realtek Gigabit Switch Engine', ram: '256 MB RAM', storage: '32 MB Flash', motherboard: 'TP-Link JetStream Rackmount Switch Board' },

    // SERVIDORES & PROYECTORES
    { keywords: ['poweredge', 'r740', 'r730', 'r640', 'r440', 't440'], brand: 'Dell', type: 'Servidor', cpu: '2x Intel Xeon Silver 4210R @ 2.40GHz (20 Núcleos, 40 Hilos)', ram: '64 GB DDR4 ECC Registered', storage: '4x 1.2 TB SAS 10K RPM (PERC H730P RAID)', motherboard: 'Dell PowerEdge Server Motherboard (iDRAC9)' },
    { keywords: ['proliant', 'dl380', 'dl360', 'ml350', 'gen10'], brand: 'HP', type: 'Servidor', cpu: '2x Intel Xeon Silver 4210R (20 Núcleos, 40 Hilos)', ram: '64 GB DDR4 ECC SmartMemory', storage: '4x 1.2 TB SAS 12G (HPE Smart Array RAID)', motherboard: 'HPE ProLiant Server Board (iLO 5)' },
    { keywords: ['powerlite', 'e20', 'x41', 'fh52', 'w49'], brand: 'Epson', type: 'Proyector', cpu: 'Epson 3LCD Image Processing Engine', ram: 'Video Processing Buffer', storage: 'Firmware Flash ROM', motherboard: 'Epson 3LCD Optical Engine Mainboard (HDMI/VGA)' },
    { keywords: ['mw560', 'mx560', 'benq'], brand: 'BenQ', type: 'Proyector', cpu: 'Texas Instruments DLP Image Processor', ram: 'DLP Video Buffer', storage: 'Firmware Flash', motherboard: 'BenQ DLP High-Brightness Mainboard' }
  ];

  function findClientSpecsMatch(query) {
    if (!query || typeof query !== 'string') return null;
    const lower = query.toLowerCase().trim();
    if (lower.length < 2) return null;

    // Buscar si alguna palabra clave coincide
    for (const item of CLIENT_SPECS_CATALOG) {
      for (const kw of item.keywords) {
        if (lower.includes(kw)) {
          return item;
        }
      }
    }
    return null;
  }

  // Auto-detección en tiempo real de Especificaciones de Fábrica
  let specLookupTimeout = null;

  async function triggerModelSpecsAutofill(modelQuery, isManual = false) {
    if (!modelQuery || modelQuery.trim().length < 2) return;
    const cleanModel = modelQuery.trim();

    const formTipo = document.getElementById('formTipoEquipo');
    const formFab = document.getElementById('formFabricante');
    const formCpu = document.getElementById('formProcesador');
    const formRam = document.getElementById('formRamTotal');
    const formDisk = document.getElementById('formAlmacenamiento');
    const formPlaca = document.getElementById('formPlacaBase');
    const formCons = document.getElementById('formConsumible');
    const badgeAuto = document.getElementById('badgeSpecAuto');
    const badgeConsAuto = document.getElementById('badgeConsumibleAuto');
    const btnLookup = document.getElementById('btnLookupSpecs');

    if (btnLookup) {
      btnLookup.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Buscando...</span>';
      btnLookup.disabled = true;
    }

    // 1. Intento Inmediato con Catálogo Cliente (0ms de latencia)
    const clientMatch = findClientSpecsMatch(cleanModel);
    if (clientMatch) {
      applyAutofillData(clientMatch, isManual);
      if (btnLookup) {
        btnLookup.innerHTML = '<i class="fa-solid fa-bolt"></i> <span>Auto-Llenar</span>';
        btnLookup.disabled = false;
      }
      return;
    }

    // 2. Consulta al Servidor / API de Internet si no hubo match local
    try {
      const res = await fetch(`/api/lookup-specs?model=${encodeURIComponent(cleanModel)}`);
      const data = await res.json();

      if (data && data.found) {
        applyAutofillData(data, isManual);
      } else if (isManual) {
        showToast('No se encontraron especificaciones para este modelo', 'error');
      }
    } catch (err) {
      console.warn('Error en auto-lookup de hardware:', err);
      if (isManual) showToast('Error al consultar especificaciones en el servidor', 'error');
    } finally {
      if (btnLookup) {
        btnLookup.innerHTML = '<i class="fa-solid fa-bolt"></i> <span>Auto-Llenar</span>';
        btnLookup.disabled = false;
      }
    }
  }

  function applyAutofillData(data, isManual) {
    const formTipo = document.getElementById('formTipoEquipo');
    const formFab = document.getElementById('formFabricante');
    const formCpu = document.getElementById('formProcesador');
    const formRam = document.getElementById('formRamTotal');
    const formDisk = document.getElementById('formAlmacenamiento');
    const formPlaca = document.getElementById('formPlacaBase');
    const formCons = document.getElementById('formConsumible');
    const badgeAuto = document.getElementById('badgeSpecAuto');
    const badgeConsAuto = document.getElementById('badgeConsumibleAuto');

    if (formTipo && data.type) {
      formTipo.value = data.type;
      adaptFormFieldsByType(data.type);
    } else if (formTipo && data.tipo_equipo) {
      formTipo.value = data.tipo_equipo;
      adaptFormFieldsByType(data.tipo_equipo);
    }

    if (formFab && data.brand && data.brand !== 'Genérico') {
      formFab.value = data.brand;
    } else if (formFab && data.fabricante && data.fabricante !== 'Genérico') {
      formFab.value = data.fabricante;
    }

    if (formCpu && (data.cpu || data.procesador)) {
      formCpu.value = data.cpu || data.procesador;
    }

    if (formRam && (data.ram || data.ram_total)) {
      formRam.value = data.ram || data.ram_total;
    }

    if (formDisk && (data.storage || data.almacenamiento)) {
      formDisk.value = data.storage || data.almacenamiento;
    }

    if (formPlaca && (data.motherboard || data.placa_base) && (data.motherboard !== 'N/A' && data.placa_base !== 'N/A')) {
      formPlaca.value = data.motherboard || data.placa_base;
    }

    if (formCons && (data.consumible || data.tinta_toner)) {
      formCons.value = data.consumible || data.tinta_toner;
      if (badgeConsAuto) {
        badgeConsAuto.style.display = 'inline-flex';
        badgeConsAuto.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Consumible Auto-Detectado`;
      }
    }

    const brandName = data.brand || data.fabricante || 'Hardware';
    if (badgeAuto) {
      badgeAuto.style.display = 'inline-flex';
      badgeAuto.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Ficha Cargada (${brandName})`;
    }

    const fieldsToAnimate = [formTipo, formFab, formCpu, formRam, formDisk, formPlaca, formCons].filter(Boolean);
    fieldsToAnimate.forEach(f => {
      f.classList.remove('input-autofill-glow');
      void f.offsetWidth;
      f.classList.add('input-autofill-glow');
    });

    if (isManual) {
      showToast(`Ficha técnica cargada: ${brandName}`, 'success');
    }
  }

  const formModelo = document.getElementById('formModelo');
  const btnLookupSpecs = document.getElementById('btnLookupSpecs');

  // Chips de modelos rápidos en el modal (1 clic)
  document.querySelectorAll('.chip-model-quick').forEach(chip => {
    chip.addEventListener('click', () => {
      const modelName = chip.getAttribute('data-model');
      if (formModelo && modelName) {
        formModelo.value = modelName;
        triggerModelSpecsAutofill(modelName, true);
      }
    });
  });

  if (formModelo) {
    formModelo.addEventListener('input', (e) => {
      clearTimeout(specLookupTimeout);
      const val = e.target.value;
      if (val && val.trim().length >= 2) {
        specLookupTimeout = setTimeout(() => {
          triggerModelSpecsAutofill(val, false);
        }, 300);
      }
    });

    formModelo.addEventListener('change', (e) => {
      triggerModelSpecsAutofill(e.target.value, false);
    });
  }

  if (btnLookupSpecs) {
    btnLookupSpecs.addEventListener('click', () => {
      const val = formModelo ? formModelo.value : '';
      if (!val || val.trim().length < 2) {
        showToast('Escribe una palabra o modelo (ej. victus, optiplex, probook)', 'info');
        if (formModelo) formModelo.focus();
        return;
      }
      triggerModelSpecsAutofill(val, true);
    });
  }

  // Selectores dependientes de Bloque y Aula/Ambiente
  const formBloque = document.getElementById('formBloque');
  const formUbicacion = document.getElementById('formUbicacion');
  const formUbicacionCustom = document.getElementById('formUbicacionCustom');

  if (formBloque) {
    formBloque.addEventListener('change', (e) => {
      populateFormAmbientes(e.target.value);
    });
  }

  if (formUbicacion) {
    formUbicacion.addEventListener('change', (e) => {
      if (e.target.value === '__custom__') {
        if (formUbicacionCustom) {
          formUbicacionCustom.style.display = 'block';
          formUbicacionCustom.focus();
        }
      } else {
        if (formUbicacionCustom) formUbicacionCustom.style.display = 'none';
      }
    });
  }

  // Selector dependiente de Tipo de Dispositivo (Adapta los campos del formulario según categoría)
  const formTipoEquipo = document.getElementById('formTipoEquipo');
  if (formTipoEquipo) {
    formTipoEquipo.addEventListener('change', (e) => {
      adaptFormFieldsByType(e.target.value);
    });
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

  // Cerrar modales ÚNICAMENTE con botones explícitos 'data-close-modal' (No al hacer clic afuera)
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

  // Arrastre con Mouse para Scroll Horizontal Cómodo
  initTableDragScroll();
}

function initTableDragScroll() {
  const slider = document.querySelector('.table-responsive');
  if (!slider) return;

  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;

  slider.addEventListener('mousedown', (e) => {
    // Si el usuario hace clic sobre un botón interactivo, enlace o copiar serial, permitir acción normal
    if (e.target.closest('button, a, .serial-badge, input, select, textarea')) return;
    
    isDown = true;
    slider.classList.add('grabbing');
    startX = e.pageX - slider.offsetLeft;
    scrollLeft = slider.scrollLeft;
  });

  window.addEventListener('mouseup', () => {
    if (isDown) {
      isDown = false;
      slider.classList.remove('grabbing');
    }
  });

  slider.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - slider.offsetLeft;
    const walk = (x - startX) * 1.5;
    slider.scrollLeft = scrollLeft - walk;
  });

  // Soporte directo: Shift + Rueda del mouse para desplazamiento horizontal inmediato
  slider.addEventListener('wheel', (e) => {
    if (e.shiftKey) return;
    if (Math.abs(e.deltaX) > 0) return;
    if (e.altKey) {
      e.preventDefault();
      slider.scrollLeft += e.deltaY;
    }
  }, { passive: false });
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

function deduplicateClientData(items) {
  const unique = [];
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
      unique.push(item);
    }
  }
  return unique;
}

// Obtener Inventario
async function fetchInventory(silent = false) {
  try {
    const res = await fetch('/api/inventory');
    if (!res.ok) throw new Error('Error al cargar inventario');
    const data = await res.json();
    const prevCount = inventoryData.length;
    inventoryData = deduplicateClientData(data.items || []);
    updateMetrics();
    renderData();
    renderDashboard();
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
  
  if (t.includes('laptop') || t.includes('notebook') || t.includes('portátil') || t.includes('portatil') || t.includes('thinkpad') || t.includes('latitude') || t.includes('macbook')) {
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
  if (t.includes('mouse') || t.includes('puntero') || t.includes('ratón') || t.includes('raton')) {
    return { icon: 'fa-mouse', class: 'mouse', label: 'Mouse', category: 'Periféricos' };
  }
  if (t.includes('audífono') || t.includes('audifono') || t.includes('diadema') || t.includes('auricular') || t.includes('headphone') || t.includes('headset')) {
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
  let displayItems = [];

  if (currentCategory === 'Monitor' || currentCategory === 'Monitores') {
    inventoryData.forEach(item => {
      const t = (item.tipo_equipo || '').toLowerCase();
      // Si el registro es un monitor independiente
      if (t.includes('monitor') || t.includes('pantalla') || t.includes('display')) {
        displayItems.push({
          ...item,
          isDiscreteDevice: true,
          discreteCategory: 'Monitor',
          deviceTypeLabel: 'Monitor',
          equipoAsignado: item.hostname || 'Independiente'
        });
      }
      // Monitores conectados a las computadoras
      if (item.monitores && Array.isArray(item.monitores) && item.monitores.length > 0) {
        item.monitores.forEach((m, idx) => {
          const monName = formatMonitorDisplayName(m);
          const monSerial = (m.serie && m.serie !== 'PNP-ID' && m.serie !== 'N/A' && m.serie !== 'No reportado por EDID') ? m.serie : 'PNP-STD';
          displayItems.push({
            id: `${item.id}-mon-${idx}`,
            parentId: item.id,
            hostname: monName,
            modelo: monName,
            fabricante: m.fabricante && m.fabricante !== 'PNP' ? m.fabricante : (EDID_BRAND_MAP[m.fabricante] || 'Monitor'),
            numero_serie: monSerial,
            tipo_equipo: 'Monitor / Pantalla',
            ubicacion: item.ubicacion || 'Sin Asignar',
            usuario_actual: item.usuario_actual || 'Sin Asignar',
            ip_red: item.ip_red || '',
            placa_base: item.hostname ? `Conectado a: ${item.hostname}` : 'Integrado',
            estado: item.estado || 'Operativo',
            hardware_specs: m.resolucion ? `Resolución: ${m.resolucion}` : 'Pantalla Externa',
            isDiscreteDevice: true,
            discreteCategory: 'Monitor',
            deviceTypeLabel: 'Monitor',
            equipoAsignado: item.hostname || item.modelo || 'Equipo'
          });
        });
      }
    });
  } else if (currentCategory === 'Periféricos' || currentCategory === 'Perifericos') {
    inventoryData.forEach(item => {
      const info = getDeviceTypeInfo(item.tipo_equipo);
      // Si el registro es un periférico independiente
      if (info.category === 'Periféricos') {
        displayItems.push({
          ...item,
          isDiscreteDevice: true,
          discreteCategory: 'Periférico',
          deviceTypeLabel: item.tipo_equipo || 'Periférico',
          equipoAsignado: item.hostname || 'Independiente'
        });
      }
      // Periféricos conectados a las computadoras
      if (item.perifericos && Array.isArray(item.perifericos) && item.perifericos.length > 0) {
        item.perifericos.forEach((p, idx) => {
          const pName = p.nombre || p.modelo || p.tipo || 'Periférico USB';
          const pSerial = (p.serie && p.serie !== 'N/A' && !/^(0+$|none)/i.test(p.serie)) ? p.serie : (p.id_hardware || 'Plug & Play');
          displayItems.push({
            id: `${item.id}-perif-${idx}`,
            parentId: item.id,
            hostname: pName,
            modelo: pName,
            fabricante: p.fabricante || 'Dispositivo USB',
            numero_serie: pSerial,
            tipo_equipo: p.tipo || 'Periférico USB',
            ubicacion: item.ubicacion || 'Sin Asignar',
            usuario_actual: item.usuario_actual || 'Sin Asignar',
            ip_red: item.ip_red || '',
            placa_base: item.hostname ? `Conectado a: ${item.hostname}` : 'N/A',
            estado: item.estado || 'Operativo',
            hardware_specs: p.interfaz || p.conexion || 'Conexión USB',
            isDiscreteDevice: true,
            discreteCategory: 'Periférico',
            deviceTypeLabel: p.tipo || 'Periférico',
            equipoAsignado: item.hostname || item.modelo || 'Equipo'
          });
        });
      }
    });
  } else {
    // Aplicar filtros estándar para equipos completos
    displayItems = inventoryData.filter(item => {
      const typeInfo = getDeviceTypeInfo(item.tipo_equipo);
      const itemType = (item.tipo_equipo || '').toLowerCase();

      // Filtro por categoría pills
      if (currentCategory && currentCategory !== 'Todos') {
        if (currentCategory === 'Laptop' || currentCategory === 'Laptops') {
          const isLap = itemType.includes('laptop') || itemType.includes('notebook') || itemType.includes('portat') || itemType.includes('thinkpad') || itemType.includes('latitude') || itemType.includes('macbook');
          if (!isLap) return false;
        } else if (currentCategory === 'PC de Escritorio' || currentCategory === 'PCs Escritorio') {
          const isLap = itemType.includes('laptop') || itemType.includes('notebook') || itemType.includes('portat') || itemType.includes('thinkpad') || itemType.includes('latitude') || itemType.includes('macbook');
          const isAio = itemType.includes('all-in-one') || itemType.includes('aio');
          if (isLap || isAio) return false;
          const isPc = itemType.includes('pc') || itemType.includes('escritorio') || itemType.includes('desktop') || itemType.includes('torre') || itemType.includes('mini pc') || typeInfo.category === 'Computadoras';
          if (!isPc) return false;
        } else if (currentCategory === 'All-in-One') {
          const isAio = itemType.includes('all-in-one') || itemType.includes('aio');
          if (!isAio) return false;
        } else if (typeInfo.category !== currentCategory) {
          return false;
        }
      }

      // Filtro por tipo específico dropdown
      if (currentSpecificType && currentSpecificType !== 'Todos') {
        const targetType = currentSpecificType.toLowerCase();
        if (targetType === 'laptop') {
          if (!itemType.includes('laptop') && !itemType.includes('notebook') && !itemType.includes('portat')) return false;
        } else if (targetType === 'pc de escritorio') {
          if (itemType.includes('laptop') || itemType.includes('all-in-one')) return false;
        } else if (item.tipo_equipo !== currentSpecificType && !itemType.includes(targetType)) {
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
          (item.hostname && item.hostname.toLowerCase().includes(q)) ||
          (item.usuario_actual && item.usuario_actual.toLowerCase().includes(q)) ||
          (item.ubicacion && item.ubicacion.toLowerCase().includes(q)) ||
          (item.ip_red && item.ip_red.toLowerCase().includes(q))
        );
        if (!match) return false;
      }

      return true;
    });
  }

  // Filtrar por búsqueda si es categoría discreta
  if (currentSearchQuery && (currentCategory === 'Monitor' || currentCategory === 'Monitores' || currentCategory === 'Periféricos' || currentCategory === 'Perifericos')) {
    const q = currentSearchQuery;
    displayItems = displayItems.filter(d => 
      (d.modelo && d.modelo.toLowerCase().includes(q)) ||
      (d.numero_serie && d.numero_serie.toLowerCase().includes(q)) ||
      (d.fabricante && d.fabricante.toLowerCase().includes(q)) ||
      (d.ubicacion && d.ubicacion.toLowerCase().includes(q)) ||
      (d.usuario_actual && d.usuario_actual.toLowerCase().includes(q)) ||
      (d.placa_base && d.placa_base.toLowerCase().includes(q))
    );
  }

  // Actualizar contadores visibles
  visibleCount.textContent = displayItems.length;
  totalCount.textContent = (currentCategory === 'Todos') ? inventoryData.length : displayItems.length;

  if (displayItems.length === 0) {
    tableBody.innerHTML = '';
    gridContainer.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

  // Renderizar Tabla
  renderTable(displayItems);

  // Renderizar Grid
  renderGrid(displayItems);
}

function highlightMatch(text, query) {
  if (!text) return '';
  if (!query || query.trim() === '') return escapeHTML(String(text));
  const qClean = query.trim().toLowerCase();
  const textStr = String(text);
  const lower = textStr.toLowerCase();
  const idx = lower.indexOf(qClean);
  if (idx === -1) return escapeHTML(textStr);

  const before = textStr.substring(0, idx);
  const match = textStr.substring(idx, idx + qClean.length);
  const after = textStr.substring(idx + qClean.length);
  return `${escapeHTML(before)}<span class="spec-match-highlight">${escapeHTML(match)}</span>${highlightMatch(after, query)}`;
}

function renderTable(items) {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';
  const queryActive = Boolean(currentSearchQuery && currentSearchQuery.trim());

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
        const serieText = d.serie && d.serie !== 'N/A' ? ` <span class="serial-mini-tag">S/N: ${highlightMatch(d.serie, currentSearchQuery)}</span>` : '';
        return `<div class="hw-item-line"><i class="fa-solid fa-hard-drive text-crimson"></i> <b>${highlightMatch(d.modelo || d.tipo, currentSearchQuery)}</b> (${escapeHTML(d.capacidad || '')})${serieText}</div>`;
      }).join('');
    } else if (item.almacenamiento_resumen) {
      storageHtml = `<div class="hw-item-line"><i class="fa-solid fa-hard-drive text-crimson"></i> ${highlightMatch(item.almacenamiento_resumen, currentSearchQuery)}</div>`;
    }

    // Periféricos y Monitores completos
    let perifericosListHtml = '';
    
    // Monitores primero (con marca comercial y modelo)
    if (item.monitores && item.monitores.length > 0) {
      item.monitores.forEach(m => {
        const monDisplayName = formatMonitorDisplayName(m);
        const monSerial = m.serie && m.serie !== 'PNP-ID' && m.serie !== 'N/A' && m.serie !== 'No reportado por EDID' ? ` <span class="serial-mini-tag">S/N: ${highlightMatch(m.serie, currentSearchQuery)}</span>` : '';
        perifericosListHtml += `<div class="hw-item-line mon-line"><i class="fa-solid fa-display text-crimson"></i> <b>${highlightMatch(monDisplayName, currentSearchQuery)}</b>${monSerial}</div>`;
      });
    }

    // Periféricos
    const validPerifs = (item.perifericos || []).filter(isValidProprietaryPeripheral);
    if (validPerifs.length > 0) {
      validPerifs.forEach(p => {
        const pTipoIcon = (p.tipo && p.tipo.toLowerCase().includes('mouse')) ? 'fa-mouse' : ((p.tipo && p.tipo.toLowerCase().includes('teclado')) ? 'fa-keyboard' : 'fa-plug');
        perifericosListHtml += `<div class="hw-item-line"><i class="fa-solid ${pTipoIcon}"></i> ${highlightMatch(p.nombre || p.tipo, currentSearchQuery)}</div>`;
      });
    }

    if (!perifericosListHtml) {
      perifericosListHtml = '<div class="hw-item-line text-gray-400">Estándar / Integrado</div>';
    }

    // Construir bloque de especificaciones adaptativo
    let specsHtml = '';
    const isPrinter = typeInfo.category === 'Impresoras' || (item.tipo_equipo || '').toLowerCase().includes('impresora') || Boolean(item.consumible);

    if (item.isDiscreteDevice) {
      specsHtml = `
        <div class="specs-full-block">
          <div class="hw-item-line"><i class="fa-solid fa-microchip text-crimson"></i> <b>${highlightMatch(item.hardware_specs || 'Dispositivo Externo', currentSearchQuery)}</b></div>
        </div>
      `;
      perifericosListHtml = `
        <div class="hw-item-line mon-line"><i class="fa-solid fa-desktop text-crimson"></i> <b>${highlightMatch(item.placa_base || 'Conectado a PC', currentSearchQuery)}</b></div>
      `;
    } else if (isPrinter) {
      const consVal = item.consumible || item.tinta_toner || autoDetectPrinterConsumables(item.modelo)?.consumable || 'Tinta / Tóner Estándar';
      specsHtml = `
        <div class="specs-full-block">
          <div class="hw-item-line" style="color: #06b6d4; font-weight: 700;">
            <i class="fa-solid fa-droplet text-cyan"></i> <b>Consumible:</b> ${highlightMatch(consVal, currentSearchQuery)}
          </div>
          ${item.notas ? `<div class="hw-item-line text-gray-400"><i class="fa-solid fa-circle-info"></i> ${highlightMatch(item.notas, currentSearchQuery)}</div>` : ''}
        </div>
      `;
    } else if (cpuText || ramText || storageHtml) {
      specsHtml = `
        <div class="specs-full-block">
          ${cpuText ? `<div class="spec-cpu-title"><i class="fa-solid fa-microchip text-crimson"></i> <b>${highlightMatch(cpuText, currentSearchQuery)}</b></div>` : ''}
          ${ramText ? `<div class="spec-ram-line"><i class="fa-solid fa-memory text-crimson"></i> <b>RAM:</b> ${highlightMatch(ramText, currentSearchQuery)}</div>` : ''}
          ${storageHtml ? `<div class="spec-storage-block">${storageHtml}</div>` : ''}
        </div>
      `;
    } else {
      specsHtml = `
        <div class="specs-full-block">
          <div class="hw-item-line"><i class="fa-solid ${tipoIcon} text-crimson"></i> <b>${highlightMatch(item.fabricante || 'Dispositivo', currentSearchQuery)}</b> ${highlightMatch(item.tipo_equipo || '', currentSearchQuery)}</div>
          ${item.notas ? `<div class="hw-item-line text-gray-400"><i class="fa-solid fa-circle-info"></i> ${highlightMatch(item.notas, currentSearchQuery)}</div>` : ''}
        </div>
      `;
    }

    const statusClass = (item.estado || 'Operativo').toLowerCase().replace(/\s+/g, '-');
    const primaryName = item.hostname || item.modelo || 'Equipo';
    const subName = item.hostname ? (item.modelo || '') : '';
    const isRowHighlighted = queryActive ? 'row-highlight-pulse' : '';

    return `
      <tr class="${isRowHighlighted}">
        <td class="cell-modelo">
          <div class="col-modelo-val">
            <div class="modelo-header">
              <i class="fa-solid ${tipoIcon} text-crimson modelo-type-icon"></i>
              <strong class="modelo-text">${highlightMatch(primaryName, currentSearchQuery)}</strong>
            </div>
            ${subName ? `<span style="font-size: 0.74rem; color: var(--gray-400); margin-left: 20px; line-height: 1.2;">${highlightMatch(subName, currentSearchQuery)}</span>` : ''}
            ${item.fabricante ? `<span class="fabricante-tag">${highlightMatch(item.fabricante, currentSearchQuery)}</span>` : ''}
          </div>
        </td>
        <td class="cell-serie">
          <span class="serial-badge" onclick="copyText('${escapeHTML(item.numero_serie)}')" title="Clic para copiar S/N">
            <i class="fa-solid fa-barcode"></i>
            ${highlightMatch(item.numero_serie || 'N/A', currentSearchQuery)}
          </span>
        </td>
        <td class="cell-ambiente">
          <div class="user-loc" title="Ambiente / Ubicación"><i class="fa-solid fa-location-dot text-crimson"></i> <b>${highlightMatch(item.ubicacion || 'Sin Asignar', currentSearchQuery)}</b></div>
        </td>
        <td class="cell-placa">
          <span class="placa-badge" title="Placa Base / Conexión">${highlightMatch(item.placa_base || 'N/A', currentSearchQuery)}</span>
        </td>
        <td class="cell-tipo">
          <span class="tipo-badge ${tipoClass}">
            <i class="fa-solid ${tipoIcon}"></i> ${highlightMatch(item.tipo_equipo || 'Equipo', currentSearchQuery)}
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
            <div class="user-name"><i class="fa-solid fa-user text-crimson"></i> <b>${highlightMatch(item.usuario_actual || 'Sin Asignar', currentSearchQuery)}</b></div>
            ${item.ip_red ? `<div class="user-host"><i class="fa-solid fa-network-wired"></i> ${highlightMatch(item.ip_red.split(',')[0].trim(), currentSearchQuery)}</div>` : ''}
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
            <button class="action-btn-mini" onclick="viewDetails('${item.parentId || item.id}')" title="Ver Ficha Técnica Completa">
              <i class="fa-solid fa-eye"></i>
            </button>
            ${!isOperador && !item.isDiscreteDevice ? `
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
  const queryActive = Boolean(currentSearchQuery && currentSearchQuery.trim());

  gridContainer.innerHTML = items.map(item => {
    const typeInfo = getDeviceTypeInfo(item.tipo_equipo);
    const primaryName = item.hostname || item.modelo || 'Equipo';
    const subName = item.hostname ? (item.modelo || '') : '';
    const highlightCardClass = queryActive ? 'card-highlight-pulse' : '';

    return `
      <div class="grid-card ${highlightCardClass}">
        <div class="grid-card-header">
          <div>
            <div class="grid-card-title">${highlightMatch(primaryName, currentSearchQuery)}</div>
            ${subName ? `<div style="font-size: 0.78rem; color: var(--gray-400); margin-top: 2px;">${highlightMatch(subName, currentSearchQuery)}</div>` : ''}
            <span class="tipo-badge ${typeInfo.class} mt-4"><i class="fa-solid ${typeInfo.icon}"></i> ${highlightMatch(item.tipo_equipo || 'Equipo', currentSearchQuery)}</span>
          </div>
          <span class="serial-badge" onclick="copyText('${escapeHTML(item.numero_serie)}')">
            <i class="fa-solid fa-barcode"></i> ${highlightMatch(item.numero_serie || 'N/A', currentSearchQuery)}
          </span>
        </div>

        <div class="grid-card-specs">
          <div class="grid-spec-row">
            <span class="grid-spec-label">Marca / Placa:</span>
            <span class="grid-spec-val">${highlightMatch(item.fabricante || item.placa_base || 'N/A', currentSearchQuery)}</span>
          </div>
          ${item.procesador ? `
          <div class="grid-spec-row">
            <span class="grid-spec-label">Procesador:</span>
            <span class="grid-spec-val">${highlightMatch(item.procesador.substring(0, 24), currentSearchQuery)}...</span>
          </div>` : ''}
          ${item.ram_total ? `
          <div class="grid-spec-row">
            <span class="grid-spec-label">RAM:</span>
            <span class="grid-spec-val">${highlightMatch(item.ram_total, currentSearchQuery)}</span>
          </div>` : ''}
          <div class="grid-spec-row">
            <span class="grid-spec-label">Ubicación / Resp:</span>
            <span class="grid-spec-val">${highlightMatch(item.ubicacion || item.usuario_actual || 'N/A', currentSearchQuery)}</span>
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
  let total = inventoryData.length;
  let pcs = 0;
  let laptops = 0;
  let aio = 0;
  let monitores = 0;
  let perifericos = 0;

  inventoryData.forEach(item => {
    const t = (item.tipo_equipo || '').toLowerCase();
    const info = getDeviceTypeInfo(item.tipo_equipo);

    const isLap = t.includes('laptop') || t.includes('notebook') || t.includes('portat') || t.includes('thinkpad') || t.includes('latitude') || t.includes('macbook');
    const isAio = t.includes('all-in-one') || t.includes('aio');
    const isPc = (t.includes('pc') || t.includes('escritorio') || t.includes('desktop') || t.includes('torre') || t.includes('mini pc') || info.category === 'Computadoras') && !isLap && !isAio;

    if (isLap) laptops++;
    if (isAio) aio++;
    if (isPc) pcs++;

    if ((item.monitores && item.monitores.length > 0) || t.includes('monitor') || t.includes('pantalla') || t.includes('display') || info.category === 'Monitores') {
      monitores++;
    }

    if ((item.perifericos && item.perifericos.length > 0) || info.category === 'Periféricos' || t.includes('teclado') || t.includes('mouse') || t.includes('periferico')) {
      perifericos++;
    }
  });

  const statTotal = document.getElementById('statTotal');
  const statDesktop = document.getElementById('statDesktop');
  const statLaptop = document.getElementById('statLaptop');
  const statMonitors = document.getElementById('statMonitors');
  const statPeripherals = document.getElementById('statPeripherals');

  if (statTotal) statTotal.textContent = total;
  if (statDesktop) statDesktop.textContent = pcs;
  if (statLaptop) statLaptop.textContent = laptops;
  if (statMonitors) statMonitors.textContent = monitores;
  if (statPeripherals) statPeripherals.textContent = perifericos;

  const countAll = document.getElementById('countAll');
  const countLaptops = document.getElementById('countLaptops');
  const countDesktop = document.getElementById('countDesktop');
  const countAIO = document.getElementById('countAIO');
  const countMonitores = document.getElementById('countMonitores');
  const countPerifericos = document.getElementById('countPerifericos');

  if (countAll) countAll.textContent = total;
  if (countLaptops) countLaptops.textContent = laptops;
  if (countDesktop) countDesktop.textContent = pcs;
  if (countAIO) countAIO.textContent = aio;
  if (countMonitores) countMonitores.textContent = monitores;
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

// -------------------------------------------------------------
// BASE DE DATOS Y DETECCIÓN AUTOMÁTICA DE TINTA / TÓNER
// -------------------------------------------------------------
const PRINTER_CONSUMABLES_DB = [
  // EPSON ECOTANK / INK TANK (TINTAS)
  { pattern: /l3110|l3150|l3160|l3210|l3250|l3251|l3260|l5190|l5290|l1110|l1210|l1250/i, brand: 'Epson', consumable: 'Tinta Epson T544' },
  { pattern: /l4150|l4160|l4260|l6161|l6171|l6191|l6270|l14150/i, brand: 'Epson', consumable: 'Tinta Epson T504' },
  { pattern: /l800|l805|l810|l850|l1800/i, brand: 'Epson', consumable: 'Tinta Epson T673' },
  { pattern: /l8050|l18050/i, brand: 'Epson', consumable: 'Tinta Epson 108' },
  { pattern: /m1100|m1120|m2140|m2170|m3170|m3180/i, brand: 'Epson', consumable: 'Tinta Epson T534' },
  { pattern: /l210|l220|l355|l365|l375|l380|l395|l455|l475|l495|l555|l575|l110|l120|l1300/i, brand: 'Epson', consumable: 'Tinta Epson T664' },
  { pattern: /wf-c5790|wf-c5290|wf-c5710/i, brand: 'Epson', consumable: 'Tinta Epson T941' },

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
  { pattern: /p2035|p2055/i, brand: 'HP', consumable: 'Tóner HP 05A' },
  { pattern: /p3015|m521|m525/i, brand: 'HP', consumable: 'Tóner HP 55A' },
  { pattern: /m506|m507|m527|m528/i, brand: 'HP', consumable: 'Tóner HP 89A' },
  { pattern: /m209|m211|m234|m236/i, brand: 'HP', consumable: 'Tóner HP 134A' },
  { pattern: /cp1025|m175|m275/i, brand: 'HP', consumable: 'Tóner HP 126A' },
  { pattern: /m252|m277|m254|m281/i, brand: 'HP', consumable: 'Tóner HP 201A' },
  { pattern: /m452|m477|m454|m479/i, brand: 'HP', consumable: 'Tóner HP 410A' },

  // HP SMART TANK & INK TANK (TINTAS)
  { pattern: /smart tank|515|519|530|580|615|720|750/i, brand: 'HP', consumable: 'Tinta HP GT53 / GT52' },
  { pattern: /ink tank|115|315|415|419/i, brand: 'HP', consumable: 'Tinta HP GT51 / GT52' },

  // CANON (PIXMA TINTA & IMAGECLASS TÓNER)
  { pattern: /g1100|g1110|g2100|g2110|g3100|g3110|g4100|g4110/i, brand: 'Canon', consumable: 'Tinta Canon GI-190' },
  { pattern: /g2160|g3160/i, brand: 'Canon', consumable: 'Tinta Canon GI-11' },
  { pattern: /g5010|g6010|g7010/i, brand: 'Canon', consumable: 'Tinta Canon GI-10' },
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

function populateFormAmbientes(selectedBloque, currentAmbienteValue = '') {
  const formUbicacion = document.getElementById('formUbicacion');
  const formUbicacionCustom = document.getElementById('formUbicacionCustom');
  if (!formUbicacion) return;

  const bloquesMap = {
    'Bloque A (Área Administrativa)': [
      'CAE', 'Soporte Técnico', 'Tópico', 'Lactario', 'Guardería', 'Psicopedagógico', 'ATP', 
      'Admisión', 'Finanzas', 'Defensoría', 'Garita'
    ],
    'Bloque A (Aulas y Laboratorios)': [
      'Aula 201', 'Aula 202', 'Aula 203', 'Aula 204', 'Aula 205', 'Aula 206', 
      '207 (Sala SUM)', 'Aula 301', 'Aula 302', 'Aula 303', 'Laboratorio 304', 
      'Laboratorio 305', 'Aula 306', 'Centro de Información', 'Aula 401', 
      'Aula 402', 'Aula 403', 'Aula 404', 'Aula 405', 'Aula 406', 'Aula 407', 
      'Aula 408', 'Aula 409', 'Aula 501', 'Aula 502', 'Aula 503', 'Aula 504', 
      'Aula 505', 'Aula 506', 'Aula 507', 'Aula 508', 'Aula 509', 'Aula 601', 
      'Aula 602', 'Aula 603', 'Aula 604', 'Aula 605', 'Aula 606', 'Aula 607', 
      'Aula 608', 'Aula 609'
    ],
    'Bloque B (Área Administrativa)': [
      'Auditorio', 'Dirección', 'Counter', 'GTH', 'Coordinación Académica', 
      'Retención', 'SSOMA', 'DTC', 'Sala de Reuniones', 'Comedor'
    ],
    'Bloque C (Área Administrativa)': [
      'Vida Universitaria', 'Promoción', 'Marketing', 'Infraestructura', 
      'Logística', 'Sala Gamer'
    ]
  };

  if (selectedBloque === 'Personalizado') {
    formUbicacion.style.display = 'none';
    if (formUbicacionCustom) {
      formUbicacionCustom.style.display = 'block';
      formUbicacionCustom.required = true;
      if (currentAmbienteValue) formUbicacionCustom.value = currentAmbienteValue;
    }
    return;
  }

  formUbicacion.style.display = 'block';
  if (formUbicacionCustom) {
    formUbicacionCustom.style.display = 'none';
    formUbicacionCustom.required = false;
  }

  const list = bloquesMap[selectedBloque] || [];
  formUbicacion.innerHTML = list.map(amb => {
    const icon = amb.startsWith('Aula') ? '🎓' : (amb.startsWith('Lab') ? '🔬' : (amb.startsWith('Centro') ? '📚' : '📍'));
    return `<option value="${escapeHTML(amb)}">${icon} ${escapeHTML(amb)}</option>`;
  }).join('') + '<option value="__custom__">✏️ Escribir otro ambiente...</option>';

  if (currentAmbienteValue && list.includes(currentAmbienteValue)) {
    formUbicacion.value = currentAmbienteValue;
  } else if (currentAmbienteValue) {
    formUbicacion.value = '__custom__';
    if (formUbicacionCustom) {
      formUbicacionCustom.style.display = 'block';
      formUbicacionCustom.value = currentAmbienteValue;
    }
  } else if (list.length > 0) {
    formUbicacion.value = list[0];
  }
}

function adaptFormFieldsByType(selectedType) {
  const t = (selectedType || '').toLowerCase();

  const groupPlacaBase = document.getElementById('formGroupPlacaBase');
  const sectionHardware = document.getElementById('formSectionHardware');
  const sectionPerifericos = document.getElementById('formSectionPerifericos');
  const groupMacAddress = document.getElementById('formGroupMacAddress');
  const labelHostname = document.getElementById('labelFormHostname');
  const inputHostname = document.getElementById('formHostname');
  const labelUsuario = document.getElementById('labelFormUsuario');
  const inputUsuario = document.getElementById('formUsuario');

  const isComputer = t.includes('pc de escritorio') || t.includes('laptop') || t.includes('all-in-one') || t.includes('mini pc') || t.includes('servidor') || t.includes('computadora');
  const isPrinterOrProjector = t.includes('impresora') || t.includes('proyector');
  const isNetwork = t.includes('switch') || t.includes('access point') || t.includes('router') || t.includes('red');
  const isPeripheral = t.includes('teclado') || t.includes('mouse') || t.includes('audífono') || t.includes('audifono') || t.includes('monitor') || t.includes('otro periférico') || t.includes('periférico');

  // 1. Placa Base (Solo en computadoras)
  if (groupPlacaBase) {
    groupPlacaBase.style.display = isComputer ? 'block' : 'none';
  }

  // 2. Hardware Interno (CPU, RAM, Discos - Solo en computadoras)
  if (sectionHardware) {
    sectionHardware.style.display = isComputer ? 'block' : 'none';
  }

  // 3. Periféricos y Monitores Asociados (Solo en computadoras)
  if (sectionPerifericos) {
    sectionPerifericos.style.display = isComputer ? 'block' : 'none';
  }

  // 4. Consumible / Tinta / Tóner (Solo en Impresoras)
  const groupConsumible = document.getElementById('formGroupConsumible');
  if (groupConsumible) {
    groupConsumible.style.display = isPrinterOrProjector ? 'block' : 'none';
  }

  // 5. Campo MAC Address (Visible para Dispositivos de Red, Impresoras y PCs)
  if (groupMacAddress) {
    groupMacAddress.style.display = (isNetwork || isPrinterOrProjector || isComputer) ? 'block' : 'none';
  }

  // 5. Adaptar textos y placeholders contextuales
  if (labelHostname && inputHostname) {
    if (isNetwork) {
      labelHostname.textContent = 'NOMBRE / IP DEL EQUIPO DE RED';
      inputHostname.placeholder = 'Ej: SWITCH-CORE-01, AP-AULA201 o 192.168.89.254';
    } else if (isPrinterOrProjector) {
      labelHostname.textContent = 'NOMBRE / IP EN RED DEL DISPOSITIVO';
      inputHostname.placeholder = 'Ej: IMP-CAE-01, PROY-AULA301 o 192.168.89.40';
    } else if (isPeripheral) {
      labelHostname.textContent = 'CONECTADO A (HOSTNAME DE PC)';
      inputHostname.placeholder = 'Ej: PC-SOPORTE04 o Sin Asignar';
    } else {
      labelHostname.textContent = 'NOMBRE DEL EQUIPO (HOSTNAME / IP)';
      inputHostname.placeholder = 'Ej: DESKTOP-HP-01 o 192.168.89.50';
    }
  }

  if (labelUsuario && inputUsuario) {
    if (isNetwork) {
      labelUsuario.textContent = 'ADMINISTRADOR / RESPONSABLE TI';
      inputUsuario.placeholder = 'Ej: Administrador de Red / Soporte TI';
    } else if (isPeripheral) {
      labelUsuario.textContent = 'USUARIO ASIGNADO';
      inputUsuario.placeholder = 'Ej: Docente Aula / Libre';
    } else {
      labelUsuario.textContent = 'USUARIO / RESPONSABLE';
      inputUsuario.placeholder = 'Ej: Juan Pérez / Contabilidad';
    }
  }
}

function openManualCreateModal() {
  const isOperador = (sessionStorage.getItem('sysinventario_role') || 'admin') === 'operador';
  if (isOperador) {
    showToast('Acceso denegado: El usuario operador no tiene permisos para registrar equipos.', 'error');
    return;
  }
  document.getElementById('modalFormTitle').textContent = 'Registrar Nuevo Dispositivo / Equipo';
  document.getElementById('formEquipmentId').value = '';
  equipmentForm.reset();

  const formTipoEquipo = document.getElementById('formTipoEquipo');
  if (formTipoEquipo) {
    formTipoEquipo.value = 'PC de Escritorio';
    adaptFormFieldsByType('PC de Escritorio');
  }

  const formBloque = document.getElementById('formBloque');
  if (formBloque) {
    formBloque.value = 'Bloque A (Área Administrativa)';
    populateFormAmbientes('Bloque A (Área Administrativa)', 'CAE');
  }

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

  document.getElementById('modalFormTitle').textContent = `Editar: ${item.modelo || item.tipo_equipo || 'Equipo'}`;
  document.getElementById('formEquipmentId').value = item.id;
  document.getElementById('formModelo').value = item.modelo || '';
  document.getElementById('formNumeroSerie').value = item.numero_serie || '';
  document.getElementById('formPlacaBase').value = item.placa_base || '';
  
  const formTipoEquipo = document.getElementById('formTipoEquipo');
  if (formTipoEquipo) {
    formTipoEquipo.value = item.tipo_equipo || 'PC de Escritorio';
    adaptFormFieldsByType(item.tipo_equipo || 'PC de Escritorio');
  }
  
  document.getElementById('formFabricante').value = item.fabricante || '';
  document.getElementById('formEstado').value = item.estado || 'Operativo';
  document.getElementById('formProcesador').value = item.procesador || '';
  document.getElementById('formRamTotal').value = item.ram_total || '';
  document.getElementById('formAlmacenamiento').value = item.almacenamiento_resumen || '';
  
  const formConsumible = document.getElementById('formConsumible');
  if (formConsumible) {
    formConsumible.value = item.consumible || item.tinta_toner || (autoDetectPrinterConsumables(item.modelo)?.consumable || '');
  }
  
  // Monitores & Periféricos
  const monStr = (item.monitores || []).map(m => `${m.modelo || m.fabricante} (${m.serie || 'S/N: N/A'})`).join(', ');
  document.getElementById('formMonitor').value = monStr;
  
  const perStr = (item.perifericos || []).map(p => p.nombre || p.tipo).join(', ');
  document.getElementById('formPerifericos').value = perStr;

  document.getElementById('formHostname').value = item.hostname || '';
  
  const formMacAddress = document.getElementById('formMacAddress');
  if (formMacAddress) formMacAddress.value = item.mac_address || '';
  
  document.getElementById('formUsuario').value = item.usuario_actual || '';

  const currentUbicacion = item.ubicacion || 'CAE';
  const blockBadge = getBlockBadgeForAmbiente(currentUbicacion);
  let matchingBloque = 'Bloque A (Área Administrativa)';

  if (blockBadge.class === 'block-a-aulas') matchingBloque = 'Bloque A (Aulas y Laboratorios)';
  else if (blockBadge.class === 'block-a') matchingBloque = 'Bloque A (Área Administrativa)';
  else if (blockBadge.class === 'block-b') matchingBloque = 'Bloque B (Área Administrativa)';
  else if (blockBadge.class === 'block-c') matchingBloque = 'Bloque C (Área Administrativa)';
  else matchingBloque = 'Bloque A (Área Administrativa)';

  const formBloque = document.getElementById('formBloque');
  if (formBloque) {
    formBloque.value = matchingBloque;
    populateFormAmbientes(matchingBloque, currentUbicacion);
  }

  document.getElementById('formNotas').value = item.notas || '';

  closeModal('detailsModal');
  openModal('manualModal');
}

// Enviar Formulario Manual
async function handleFormSubmit(e) {
  e.preventDefault();

  const btnSubmit = document.getElementById('btnSaveEquipment') || e.target.querySelector('button[type="submit"]');
  const oldBtnHtml = btnSubmit ? btnSubmit.innerHTML : '';
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Guardando...`;
  }

  const id = (document.getElementById('formEquipmentId').value || '').trim();
  const formBloqueVal = document.getElementById('formBloque') ? document.getElementById('formBloque').value : '';
  let finalUbicacion = document.getElementById('formUbicacion') ? document.getElementById('formUbicacion').value : '';
  const formUbicacionCustom = document.getElementById('formUbicacionCustom');

  if (finalUbicacion === '__custom__' || formBloqueVal === 'Personalizado') {
    finalUbicacion = (formUbicacionCustom ? formUbicacionCustom.value.trim() : '') || 'Sin Asignar';
  }

  const monitorVal = document.getElementById('formMonitor') ? document.getElementById('formMonitor').value.trim() : '';
  let parsedMonitores = undefined;
  if (monitorVal) {
    const match = monitorVal.match(/^(.*?)(?:\s*\((?:S\/N:?\s*)?([^)]+)\))?$/);
    const mod = match && match[1] ? match[1].trim() : monitorVal;
    const ser = match && match[2] ? match[2].trim() : '';
    parsedMonitores = [{
      modelo: mod,
      fabricante: mod.split(' ')[0] || 'Genérico',
      serie: ser || 'N/A'
    }];
  }

  const perifsVal = document.getElementById('formPerifericos') ? document.getElementById('formPerifericos').value.trim() : '';
  let parsedPerifericos = undefined;
  if (perifsVal) {
    parsedPerifericos = perifsVal.split(',').map(p => {
      const pName = p.trim();
      return {
        nombre: pName,
        tipo: /teclado|keyboard/i.test(pName) ? 'Teclado' : (/mouse|rat/i.test(pName) ? 'Mouse / Puntero' : 'Accesorio'),
        es_marca: true
      };
    }).filter(p => p.nombre);
  }

  const payload = {
    modelo: (document.getElementById('formModelo').value || '').trim(),
    numero_serie: (document.getElementById('formNumeroSerie').value || '').trim(),
    placa_base: (document.getElementById('formPlacaBase').value || '').trim(),
    tipo_equipo: document.getElementById('formTipoEquipo').value,
    fabricante: (document.getElementById('formFabricante').value || '').trim(),
    estado: document.getElementById('formEstado').value,
    procesador: (document.getElementById('formProcesador').value || '').trim(),
    ram_total: (document.getElementById('formRamTotal').value || '').trim(),
    almacenamiento_resumen: (document.getElementById('formAlmacenamiento').value || '').trim(),
    hostname: (document.getElementById('formHostname').value || '').trim(),
    mac_address: (document.getElementById('formMacAddress') ? document.getElementById('formMacAddress').value : '').trim(),
    usuario_actual: (document.getElementById('formUsuario').value || '').trim(),
    ubicacion: finalUbicacion,
    consumible: (document.getElementById('formConsumible') ? document.getElementById('formConsumible').value : '').trim(),
    notas: (document.getElementById('formNotas').value || '').trim()
  };

  if (parsedMonitores !== undefined) {
    payload.monitores = parsedMonitores;
  }
  if (parsedPerifericos !== undefined) {
    payload.perifericos = parsedPerifericos;
  }

  const isEdit = Boolean(id && id !== '');
  const url = isEdit ? `/api/inventory/${encodeURIComponent(id)}` : '/api/inventory';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem('sysinventario_session_token') || ''}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Error al guardar');
    }

    closeModal('manualModal');
    showToast(isEdit ? '¡Equipo actualizado con éxito!' : '¡Nuevo equipo registrado con éxito!', 'success');
    await fetchInventory();
  } catch (err) {
    showToast(err.message || 'Error al guardar los cambios', 'error');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = oldBtnHtml;
    }
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
  let monitoresHtml = '<p class="text-gray-400" style="font-size: 0.85rem;">Sin pantallas adicionales</p>';
  if (item.monitores && item.monitores.length > 0) {
    monitoresHtml = `
      <div class="component-card-grid">
        ${item.monitores.map(m => {
          const hasSerial = m.serie && m.serie !== 'N/A' && !/^(0+$|none|pnp|no reportado)/i.test(m.serie);
          return `
            <div class="component-card">
              <div class="comp-header">
                <span class="comp-icon"><i class="fa-solid fa-display text-emerald"></i></span>
                <span class="comp-title">${escapeHTML(m.modelo || m.fabricante || 'Monitor')}</span>
                ${m.fabricante && m.fabricante !== 'Estándar' ? `<span class="comp-badge">${escapeHTML(m.fabricante)}</span>` : ''}
              </div>
              ${hasSerial ? `
                <div class="comp-details">
                  <div class="comp-serial">
                    <span class="serial-label">S/N:</span>
                    <code class="serial-code">${escapeHTML(m.serie)}</code>
                  </div>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Periféricos List
  let perifericosHtml = '<p class="text-gray-400" style="font-size: 0.85rem;">Sin periféricos registrados</p>';
  if (item.perifericos && item.perifericos.length > 0) {
    perifericosHtml = `
      <div class="component-card-grid">
        ${item.perifericos.map(p => {
          const pTipo = (p.tipo || '').toLowerCase();
          const icon = pTipo.includes('mouse') ? 'fa-mouse text-purple' : (pTipo.includes('teclado') ? 'fa-keyboard text-blue' : 'fa-plug text-cyan');
          return `
            <div class="component-card">
              <div class="comp-header">
                <span class="comp-icon"><i class="fa-solid ${icon}"></i></span>
                <span class="comp-title">${escapeHTML(p.nombre || p.tipo || 'Dispositivo')}</span>
                <span class="comp-pill">${escapeHTML(p.tipo || 'USB')}</span>
              </div>
              ${p.id_hardware ? `
                <div class="comp-details">
                  <div class="comp-serial">
                    <span class="serial-label">ID:</span>
                    <code class="serial-code">${escapeHTML(p.id_hardware)}</code>
                  </div>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // RAM Slots List
  let ramSlotsHtml = `<div class="spec-box-val">${escapeHTML(item.ram_total || 'N/A')}</div>`;
  if (item.ram_detalles && item.ram_detalles.length > 0) {
    ramSlotsHtml += `
      <div class="component-card-grid mt-2">
        ${item.ram_detalles.map(slot => `
          <div class="component-card">
            <div class="comp-header">
              <span class="comp-icon"><i class="fa-solid fa-memory text-amber"></i></span>
              <span class="comp-title" style="font-size: 0.82rem;">${escapeHTML(slot)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Discos List
  let discosHtml = `<div class="spec-box-val">${escapeHTML(item.almacenamiento_resumen || 'N/A')}</div>`;
  if (item.almacenamiento && item.almacenamiento.length > 0) {
    discosHtml = `
      <div class="component-card-grid">
        ${item.almacenamiento.map(d => {
          const capText = d.capacidad ? `<span class="comp-pill">${escapeHTML(d.capacidad)}</span>` : '';
          const hasSerial = d.serie && d.serie !== 'N/A' && !/^(0+$|none)/i.test(d.serie);
          const hasInterfaz = d.interfaz && d.interfaz !== 'N/A';

          return `
            <div class="component-card">
              <div class="comp-header">
                <span class="comp-icon"><i class="fa-solid fa-hard-drive text-cyan"></i></span>
                <span class="comp-title">${escapeHTML(d.modelo || d.tipo || 'Disco')}</span>
                ${capText}
              </div>
              <div class="comp-details">
                ${hasInterfaz ? `<span class="comp-badge">${escapeHTML(d.interfaz)}</span>` : ''}
                ${hasSerial ? `
                  <div class="comp-serial">
                    <span class="serial-label">S/N:</span>
                    <code class="serial-code">${escapeHTML(d.serie)}</code>
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
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
      ${(item.consumible || (item.tipo_equipo && item.tipo_equipo.toLowerCase().includes('impresora')) || autoDetectPrinterConsumables(item.modelo)) ? `
      <div class="spec-box" style="grid-column: 1 / -1; border-color: rgba(6, 182, 212, 0.4); background: rgba(6, 182, 212, 0.06);">
        <div class="spec-box-title" style="color: #06b6d4;"><i class="fa-solid fa-droplet"></i> CONSUMIBLE (TINTA / TÓNER COMPATIBLE)</div>
        <div class="spec-box-val" style="color: #22d3ee; font-size: 1.05rem;"><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHTML(item.consumible || item.tinta_toner || autoDetectPrinterConsumables(item.modelo)?.consumable || 'Tinta / Tóner Estándar')}</div>
      </div>
      ` : ''}
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

function filterByAmbiente(searchTerm) {
  switchPage('inventory');

  // Resetear filtros para que la búsqueda sea global y no quede bloqueada por una categoría previa
  currentCategory = 'Todos';
  currentFilterType = 'Todos';
  currentSpecificType = 'Todos';
  currentFilterStatus = 'Todos';
  
  if (typeSelectFilter) typeSelectFilter.value = 'Todos';
  if (statusFilter) statusFilter.value = 'Todos';

  document.querySelectorAll('.filter-pills-group .pill').forEach(p => {
    if (p.getAttribute('data-category') === 'Todos') p.classList.add('active');
    else p.classList.remove('active');
  });

  if (searchInput) {
    searchInput.value = searchTerm;
    currentSearchQuery = searchTerm.toLowerCase().trim();
    if (btnClearSearch) btnClearSearch.style.display = 'block';
  }

  renderData();
  showToast(`Filtrando inventario por: "${searchTerm}"`, 'info');
  const tableCard = document.getElementById('tableViewContainer');
  if (tableCard) tableCard.scrollIntoView({ behavior: 'smooth' });
}

function filterByStatus(statusName) {
  switchPage('inventory');
  
  currentCategory = 'Todos';
  currentFilterType = 'Todos';
  currentSpecificType = 'Todos';
  if (typeSelectFilter) typeSelectFilter.value = 'Todos';
  if (searchInput) {
    searchInput.value = '';
    currentSearchQuery = '';
    if (btnClearSearch) btnClearSearch.style.display = 'none';
  }

  document.querySelectorAll('.filter-pills-group .pill').forEach(p => {
    if (p.getAttribute('data-category') === 'Todos') p.classList.add('active');
    else p.classList.remove('active');
  });

  if (statusFilter) {
    statusFilter.value = statusName;
    currentFilterStatus = statusName;
  }
  renderData();
  showToast(`Filtrando inventario por estado: "${statusName}"`, 'info');
  const tableCard = document.getElementById('tableViewContainer');
  if (tableCard) tableCard.scrollIntoView({ behavior: 'smooth' });
}

function filterByPeripheralType(tipo, brand) {
  switchPage('inventory');
  
  if (searchInput) {
    searchInput.value = '';
    currentSearchQuery = '';
    if (btnClearSearch) btnClearSearch.style.display = 'none';
  }
  
  if (statusFilter) {
    statusFilter.value = 'Todos';
    currentFilterStatus = 'Todos';
  }
  
  document.querySelectorAll('.filter-pills-group .pill').forEach(p => {
    p.classList.remove('active');
  });

  const tipoClean = (tipo || '').toLowerCase();
  
  if (tipoClean.includes('monitor') || tipoClean.includes('pantalla') || tipoClean.includes('display')) {
    currentCategory = 'Todos';
    currentFilterType = 'Todos';
    currentSpecificType = 'Monitor / Pantalla';
    if (typeSelectFilter) typeSelectFilter.value = 'Monitor / Pantalla';
    showToast('Filtrando por tipo: Monitores / Pantallas', 'info');
  } else if (tipoClean.includes('teclado') || tipoClean.includes('keyboard')) {
    currentCategory = 'Periféricos';
    currentFilterType = 'Todos';
    currentSpecificType = 'Teclado';
    if (typeSelectFilter) typeSelectFilter.value = 'Teclado';
    showToast('Filtrando por tipo: Teclados', 'info');
  } else if (tipoClean.includes('mouse') || tipoClean.includes('ratón') || tipoClean.includes('raton')) {
    currentCategory = 'Periféricos';
    currentFilterType = 'Todos';
    currentSpecificType = 'Mouse / Puntero';
    if (typeSelectFilter) typeSelectFilter.value = 'Mouse / Puntero';
    showToast('Filtrando por tipo: Mouse / Punteros', 'info');
  } else if (tipoClean.includes('audífono') || tipoClean.includes('audifono') || tipoClean.includes('diadema') || tipoClean.includes('headset')) {
    currentCategory = 'Periféricos';
    currentFilterType = 'Todos';
    currentSpecificType = 'Audífonos / Diadema';
    if (typeSelectFilter) typeSelectFilter.value = 'Audífonos / Diadema';
    showToast('Filtrando por tipo: Audífonos / Diademas', 'info');
  } else {
    currentCategory = 'Periféricos';
    currentFilterType = 'Todos';
    currentSpecificType = 'Todos';
    if (typeSelectFilter) typeSelectFilter.value = 'Todos';
    const pillPerif = document.querySelector('.filter-pills-group .pill[data-category="Periféricos"]');
    if (pillPerif) pillPerif.classList.add('active');
    showToast(`Filtrando por tipo: Periféricos (${tipo || 'Accesorios'})`, 'info');
  }

  renderData();
  const tableCard = document.getElementById('tableViewContainer');
  if (tableCard) tableCard.scrollIntoView({ behavior: 'smooth' });
}

const GENERIC_DRIVER_EXCLUDE_REGEX = /compatible con hid|hid-compliant|dispositivo de |dispositivo del |dispositivo definido|dispositivo port[aá]til|controles de radio|dispositivo de interfaz|usb input device|hid keyboard|hid mouse|touchpad|trackpoint|button driver|wireless button|ideacamera|virtual|composite|dispositivo del sistema|realtek|high definition audio|altavoces|micr[oó]fono|audioendpoint|dispositivo de audio|audio digital|mezcla est|controlador de audio|wave|stereo mix|s\/pdif/i;

const RECOGNIZED_PERIPHERAL_BRANDS = [
  'Logitech', 'HP', 'Dell', 'Lenovo', 'Microsoft', 'Corsair', 'Razer', 
  'HyperX', 'Kingston', 'Redragon', 'Genius', 'ASUS', 'Samsung', 'LG', 
  'AOC', 'ViewSonic', 'JBL', 'Sony', 'Jabra', 'Poly', 'Plantronics', 
  'Epson', 'Canon', 'Brother', 'Apple', 'Huawei', 'Xiaomi', 'Wacom', 'A4Tech', 'Cougar',
  'Teraware', 'Halion', 'Micronics', 'Antryx', 'Marvo', 'Gamemax', 'Fantech', 'VSG'
];

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

function formatMonitorDisplayName(m) {
  if (!m) return 'Monitor';
  const rawManuf = (m.fabricante || '').trim().toUpperCase();
  const brand = EDID_BRAND_MAP[rawManuf] || (m.fabricante || '').trim();
  let model = (m.modelo || 'Monitor').trim();
  
  if (brand && brand !== 'Estándar' && brand !== 'Monitor Integrado' && !model.toLowerCase().includes(brand.toLowerCase())) {
    return `${brand} ${model}`;
  }
  return model;
}

function isValidProprietaryPeripheral(p) {
  if (!p) return false;
  const rawName = (typeof p === 'string' ? p : `${p.fabricante || ''} ${p.nombre || ''} ${p.modelo || ''} ${p.tipo || ''}`).trim();
  if (!rawName || GENERIC_DRIVER_EXCLUDE_REGEX.test(rawName)) return false;
  return getPeripheralBrandInfo(p).isRecognized || p.es_marca === true;
}

function getPeripheralBrandInfo(p) {
  const rawName = (typeof p === 'string' ? p : `${p.fabricante || ''} ${p.nombre || ''} ${p.modelo || ''}`).trim();
  if (GENERIC_DRIVER_EXCLUDE_REGEX.test(rawName)) {
    return { brand: null, isRecognized: false, fullName: rawName };
  }
  for (const brand of RECOGNIZED_PERIPHERAL_BRANDS) {
    const regex = new RegExp(`\\b${brand}\\b`, 'i');
    if (regex.test(rawName)) {
      return { brand, isRecognized: true, fullName: rawName };
    }
  }
  return { brand: null, isRecognized: false, fullName: rawName };
}

const ORGANIZATIONAL_BLOCKS = {
  '🏢 Bloque A (Área Administrativa)': [
    'CAE', 'Soporte Técnico', 'Tópico', 'Lactario', 'Guardería', 'Psicopedagógico', 'ATP', 
    'Admisión', 'Finanzas', 'Defensoría', 'Garita'
  ],
  '🎓 Bloque A (Aulas y Laboratorios)': [
    'Aula 201', 'Aula 202', 'Aula 203', 'Aula 204', 'Aula 205', 'Aula 206', 
    '207 (Sala SUM)', 'Aula 301', 'Aula 302', 'Aula 303', 'Laboratorio 304', 
    'Laboratorio 305', 'Aula 306', 'Centro de Información', 'Aula 401', 
    'Aula 402', 'Aula 403', 'Aula 404', 'Aula 405', 'Aula 406', 'Aula 407', 
    'Aula 408', 'Aula 409', 'Aula 501', 'Aula 502', 'Aula 503', 'Aula 504', 
    'Aula 505', 'Aula 506', 'Aula 507', 'Aula 508', 'Aula 509', 'Aula 601', 
    'Aula 602', 'Aula 603', 'Aula 604', 'Aula 605', 'Aula 606', 'Aula 607', 
    'Aula 608', 'Aula 609'
  ],
  '🏢 Bloque B (Área Administrativa)': [
    'Auditorio', 'Dirección', 'Counter', 'GTH', 'Coordinación Académica', 
    'Retención', 'SSOMA', 'DTC', 'Sala de Reuniones', 'Comedor'
  ],
  '🏢 Bloque C (Área Administrativa)': [
    'Vida Universitaria', 'Promoción', 'Marketing', 'Infraestructura', 
    'Logística', 'Sala Gamer'
  ]
};

function getBlockBadgeForAmbiente(ambName) {
  if (!ambName) return { label: 'General', class: 'block-general', full: 'Área General' };
  const clean = ambName.trim().toLowerCase();
  for (const [blockTitle, list] of Object.entries(ORGANIZATIONAL_BLOCKS)) {
    if (list.some(item => {
      const itemClean = item.toLowerCase();
      return clean === itemClean || clean.includes(itemClean) || (itemClean.startsWith('aula ') && clean === itemClean.replace('aula ', ''));
    })) {
      if (blockTitle.includes('Aulas')) return { label: 'Bloque A - Aulas', class: 'block-a-aulas', full: 'Bloque A - Aulas y Labs' };
      if (blockTitle.includes('Bloque A')) return { label: 'Bloque A', class: 'block-a', full: 'Bloque A - Administrativo' };
      if (blockTitle.includes('Bloque B')) return { label: 'Bloque B', class: 'block-b', full: 'Bloque B - Administrativo' };
      if (blockTitle.includes('Bloque C')) return { label: 'Bloque C', class: 'block-c', full: 'Bloque C - Administrativo' };
    }
  }
  return { label: 'General', class: 'block-general', full: 'Área General' };
}

function renderDashboard() {
  const dashFilterAmbiente = document.getElementById('dashFilterAmbiente');
  const dashFilterTipo = document.getElementById('dashFilterTipo');

  const selectedAmbiente = dashFilterAmbiente ? dashFilterAmbiente.value : 'Todos';
  const selectedTipo = dashFilterTipo ? dashFilterTipo.value : 'Todos';

  // 1. Poblar el selector de ambientes agrupado por Bloques Organizacionales
  if (dashFilterAmbiente) {
    const uniqueAmbientes = Array.from(new Set(inventoryData.map(i => (i.ubicacion || 'Sin Asignar').trim()))).filter(Boolean);
    const prevVal = dashFilterAmbiente.value;
    
    let html = '<option value="Todos">🏢 Todos los Ambientes y Bloques</option>';
    
    Object.entries(ORGANIZATIONAL_BLOCKS).forEach(([blockName, list]) => {
      html += `<optgroup label="${blockName}">`;
      list.forEach(amb => {
        const count = inventoryData.filter(i => (i.ubicacion || '').trim().toLowerCase() === amb.toLowerCase()).length;
        html += `<option value="${amb}">📍 ${amb} (${count} equipos)</option>`;
      });
      html += `</optgroup>`;
    });

    const otherAmbs = uniqueAmbientes.filter(amb => {
      const b = getBlockBadgeForAmbiente(amb);
      return b.class === 'block-general';
    });

    if (otherAmbs.length > 0) {
      html += `<optgroup label="🏢 Otros Ambientes y Áreas">`;
      otherAmbs.sort().forEach(amb => {
        const count = inventoryData.filter(i => (i.ubicacion || '').trim().toLowerCase() === amb.toLowerCase()).length;
        html += `<option value="${amb}">📍 ${amb} (${count} equipos)</option>`;
      });
      html += `</optgroup>`;
    }

    dashFilterAmbiente.innerHTML = html;
    if (prevVal) dashFilterAmbiente.value = prevVal;
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

  // 2. Extraer Periféricos y Monitores de Marcas Reconocidas
  let totalMonitoresReconocidos = 0;
  let totalPerifericosReconocidos = 0;
  const brandPeripheralsMap = {}; // { 'Logitech': { count: 0, items: [] }, ... }

  filteredData.forEach(item => {
    // Monitores (con marca o modelo específico)
    (item.monitores || []).forEach(m => {
      const rawManuf = (m.fabricante || '').trim().toUpperCase();
      const edidBrand = EDID_BRAND_MAP[rawManuf];
      const monName = `${edidBrand || m.fabricante || ''} ${m.modelo || ''}`.trim();
      const brandInfo = getPeripheralBrandInfo(monName);
      
      if (brandInfo.isRecognized || edidBrand || (m.serie && m.serie !== 'PNP-ID' && m.serie !== 'N/A')) {
        totalMonitoresReconocidos++;
        let brandKey = edidBrand || brandInfo.brand || (m.fabricante && m.fabricante !== 'Estándar' && m.fabricante !== 'Monitor Integrado' ? m.fabricante : 'Display Certificado');
        if (brandKey === 'HPN' || brandKey === 'HWP' || brandKey === 'HEW') brandKey = 'HP';
        if (brandKey === 'AUS' || brandKey === 'ASU' || brandKey === 'ACI') brandKey = 'ASUS';
        if (brandKey === 'SAM' || brandKey === 'SEC') brandKey = 'Samsung';
        if (brandKey === 'DEL' || brandKey === 'DLL') brandKey = 'Dell';
        if (brandKey === 'LEN' || brandKey === 'LNK') brandKey = 'Lenovo';
        if (brandKey === 'GSM' || brandKey === 'LGD' || brandKey === 'LGE') brandKey = 'LG';

        if (!brandPeripheralsMap[brandKey]) brandPeripheralsMap[brandKey] = { count: 0, tipo: 'Monitor', hosts: new Set() };
        brandPeripheralsMap[brandKey].count++;
        if (item.hostname) brandPeripheralsMap[brandKey].hosts.add(item.hostname);
      }
    });

    // Periféricos USB / HID (Solo marcas reconocidas como Logitech, etc.)
    (item.perifericos || []).forEach(p => {
      const brandInfo = getPeripheralBrandInfo(p);
      if (brandInfo.isRecognized) {
        totalPerifericosReconocidos++;
        const brandKey = brandInfo.brand;
        if (!brandPeripheralsMap[brandKey]) brandPeripheralsMap[brandKey] = { count: 0, tipo: p.tipo || 'Accesorio', hosts: new Set() };
        brandPeripheralsMap[brandKey].count++;
        if (item.hostname) brandPeripheralsMap[brandKey].hosts.add(item.hostname);
      }
    });
  });

  // 3. Calcular KPIs
  const allAmbientes = new Set(inventoryData.map(i => (i.ubicacion || 'Sin Asignar').trim()).filter(Boolean));
  let totalDesktops = 0;
  let totalLaptops = 0;

  filteredData.forEach(i => {
    const t = (i.tipo_equipo || '').toLowerCase();
    if (t.includes('laptop') || t.includes('notebook') || t.includes('portat') || t.includes('thinkpad') || t.includes('latitude') || t.includes('macbook')) {
      totalLaptops++;
    } else {
      const info = getDeviceTypeInfo(i.tipo_equipo);
      if (info.category === 'Computadoras') {
        totalDesktops++;
      }
    }
  });

  const dashTotalAmbientes = document.getElementById('dashTotalAmbientes');
  const dashTotalPCs = document.getElementById('dashTotalPCs');
  const dashTotalLaptops = document.getElementById('dashTotalLaptops');
  const dashTotalMonitores = document.getElementById('dashTotalMonitores');
  const dashTotalPerifericos = document.getElementById('dashTotalPerifericos');

  if (dashTotalAmbientes) dashTotalAmbientes.textContent = allAmbientes.size;
  if (dashTotalPCs) dashTotalPCs.textContent = totalDesktops;
  if (dashTotalLaptops) dashTotalLaptops.textContent = totalLaptops;
  if (dashTotalMonitores) dashTotalMonitores.textContent = totalMonitoresReconocidos;
  if (dashTotalPerifericos) dashTotalPerifericos.textContent = totalPerifericosReconocidos;

  // 4. Renderizar Tarjetas de Ambientes (Distribución Espacial por Bloques)
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
          perifericosMarca: 0,
          usuarios: new Set()
        });
      }
      const data = ambientesMap.get(ambName);
      data.equipos.push(item);
      const t = (item.tipo_equipo || '').toLowerCase();
      if (t.includes('laptop') || t.includes('notebook') || t.includes('portat') || t.includes('thinkpad') || t.includes('latitude') || t.includes('macbook')) {
        data.laptops++;
      } else {
        data.desktops++;
      }
      data.monitores += (item.monitores || []).length;
      
      // Contar solo periféricos de marca
      (item.perifericos || []).forEach(p => {
        if (getPeripheralBrandInfo(p).isRecognized) data.perifericosMarca++;
      });

      if (item.usuario_actual) data.usuarios.add(item.usuario_actual);
    });

    const ambientesList = Array.from(ambientesMap.values());
    if (ambientesList.length === 0) {
      ambientesGrid.innerHTML = '<p class="text-gray-400">No hay ambientes registrados aún.</p>';
    } else {
      // Ordenar: Bloque A primero, luego Bloque B, luego Bloque C, luego Otros
      ambientesList.sort((a, b) => {
        const orderA = getBlockBadgeForAmbiente(a.nombre).class;
        const orderB = getBlockBadgeForAmbiente(b.nombre).class;
        return orderA.localeCompare(orderB) || a.nombre.localeCompare(b.nombre);
      });

      ambientesGrid.innerHTML = ambientesList.map(amb => {
        const blockInfo = getBlockBadgeForAmbiente(amb.nombre);
        const userListStr = Array.from(amb.usuarios).slice(0, 3).join(', ') || 'No asignado';
        const isSelected = selectedAmbiente === amb.nombre;

        return `
          <div class="ambiente-card ${isSelected ? 'selected-ambiente' : ''}">
            <div class="ambiente-card-header">
              <div class="ambiente-title-box">
                <i class="fa-solid fa-location-dot text-crimson"></i>
                <div>
                  <h4>${escapeHTML(amb.nombre)}</h4>
                  <span class="block-badge ${blockInfo.class}">${blockInfo.label}</span>
                </div>
              </div>
              <span class="ambiente-total-badge">${amb.equipos.length} equipos</span>
            </div>

            <div class="ambiente-card-stats">
              <div class="amb-stat-chip"><i class="fa-solid fa-desktop text-crimson"></i> <b>${amb.desktops}</b> PCs</div>
              <div class="amb-stat-chip"><i class="fa-solid fa-laptop text-blue"></i> <b>${amb.laptops}</b> Laptops</div>
              <div class="amb-stat-chip"><i class="fa-solid fa-display text-emerald"></i> <b>${amb.monitores}</b> Pantallas</div>
              <div class="amb-stat-chip"><i class="fa-solid fa-keyboard text-purple"></i> <b>${amb.perifericosMarca}</b> Accesorios</div>
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

  // 5. Renderizar Desglose por Modelos y Tipos de PC
  const modelosListContainer = document.getElementById('modelosBreakdownList');
  if (modelosListContainer) {
    const modelosCount = {};
    filteredData.forEach(item => {
      const m = (item.modelo || 'Equipo Estándar').trim();
      const f = (item.fabricante || '').trim();
      let modeloKey = m;
      if (f && !m.toLowerCase().startsWith(f.toLowerCase())) {
        modeloKey = `${f} ${m}`;
      }
      modelosCount[modeloKey] = (modelosCount[modeloKey] || 0) + 1;
    });

    const sortedModelos = Object.entries(modelosCount).sort((a, b) => b[1] - a[1]);

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

  // 6. Renderizar Inventario de Periféricos (SOLO MARCAS RECONOCIDAS)
  const perifericosContainer = document.getElementById('perifericosBreakdownList');
  if (perifericosContainer) {
    const sortedBrands = Object.entries(brandPeripheralsMap).sort((a, b) => b[1].count - a[1].count);

    if (sortedBrands.length === 0) {
      perifericosContainer.innerHTML = `
        <div class="empty-brand-box">
          <i class="fa-solid fa-tag text-gray-400 fa-2x mb-2"></i>
          <p class="text-gray-400 mb-1">No se detectaron periféricos con marca comercial registrada aún (ej: Logitech, HP, Dell).</p>
          <small class="text-gray-500">Al escanear PCs con teclados/mouse Logitech o auriculares USB se indexarán automáticamente aquí.</small>
        </div>
      `;
    } else {
      const maxBrandCount = sortedBrands[0] ? sortedBrands[0][1].count : 1;
      perifericosContainer.innerHTML = sortedBrands.map(([brand, data]) => {
        const percent = Math.round((data.count / maxBrandCount) * 100);
        const hostList = Array.from(data.hosts).slice(0, 2).join(', ');

        return `
          <div class="breakdown-row" onclick="filterByPeripheralType('${escapeHTML(data.tipo)}', '${escapeHTML(brand)}')" title="Clic para filtrar por tipo: ${escapeHTML(data.tipo)}">
            <div class="breakdown-label">
              <span class="breakdown-name">
                <span class="brand-badge-icon"><i class="fa-solid fa-tag"></i></span>
                <b>${escapeHTML(brand)}</b>
                <span class="brand-sub-type">(${escapeHTML(data.tipo)})</span>
              </span>
              <span class="breakdown-count"><b class="text-blue">${data.count}</b> unid.</span>
            </div>
            <div class="breakdown-bar-bg">
              <div class="breakdown-bar-fill fill-blue" style="width: ${percent}%;"></div>
            </div>
            ${hostList ? `<div class="brand-hosts-hint"><i class="fa-solid fa-desktop"></i> En: ${escapeHTML(hostList)}${data.hosts.size > 2 ? '...' : ''}</div>` : ''}
          </div>
        `;
      }).join('');
    }
  }

  // 7. Renderizar Estado Operativo & Salud
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

