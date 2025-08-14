const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Almacenamiento en memoria (en producción usar base de datos)
let detectedDevices = new Map();
let priorityDevices = new Set();
let notifications = [];
let systemStats = {
  esp32LastSeen: null,
  picoLastSeen: null,
  totalScans: 0,
  startTime: Date.now()
};

// Función para calcular distancia desde RSSI
function calculateDistanceFromRSSI(rssi, txPower = -59) {
  if (rssi === 0) {
    return -1.0;
  }
  const ratio = (txPower - rssi) / 20.0;
  return Math.pow(10, ratio);
}

// Logging mejorado
const originalConsoleLog = console.log;
console.log = function(...args) {
  const timestamp = new Date().toISOString();
  originalConsoleLog(`[${timestamp}]`, ...args);
};

// Ruta principal
app.get('/', (req, res) => {
  res.json({
    message: 'BLE Monitoring Backend API - Sistema ESP32 + Pico W',
    version: '2.0.0',
    system: 'ESP32 + Raspberry Pi Pico W',
    endpoints: {
      devices: 'POST /api/devices - Recibir datos del Pico W',
      getDevices: 'GET /api/devices - Obtener dispositivos detectados',
      priorityDevices: 'GET /api/priority-devices - Obtener dispositivos prioritarios',
      setPriority: 'POST /api/set-priority - Marcar dispositivo como prioritario',
      notifications: 'POST /api/notifications - Recibir notificaciones del ESP32',
      getNotifications: 'GET /api/notifications - Obtener notificaciones',
      systemStats: 'GET /api/system-stats - Estadísticas del sistema',
      health: 'GET /api/health - Estado del sistema'
    }
  });
});

// Endpoint para recibir datos de dispositivos del Pico W
app.post('/api/devices', (req, res) => {
  try {
    const { devices } = req.body;
    
    if (!devices || !Array.isArray(devices)) {
      return res.status(400).json({ error: 'Invalid devices data' });
    }

    // Actualizar timestamp del Pico W
    systemStats.picoLastSeen = Date.now();
    systemStats.totalScans++;

    // Actualizar dispositivos detectados
    devices.forEach(device => {
      const existingDevice = detectedDevices.get(device.address);
      
      // Calcular distancia estimada basada en RSSI si no viene
      let estimatedDistance = device.distance;
      if (!estimatedDistance && device.rssi) {
        estimatedDistance = calculateDistanceFromRSSI(device.rssi);
      }
      
      detectedDevices.set(device.address, {
        ...device,
        distance: estimatedDistance || 5.0,
        isPriority: priorityDevices.has(device.address),
        lastUpdated: new Date().toISOString(),
        source: 'pico_w',
        // Mantener estado previo si existe
        wasInRange: existingDevice ? existingDevice.wasInRange : (estimatedDistance <= 2.0)
      });
    });

    // Limpiar dispositivos antiguos (más de 2 minutos sin actualizar)
    const now = Date.now();
    const twoMinutesAgo = now - 120000;
    
    for (let [address, device] of detectedDevices) {
      if (new Date(device.lastUpdated).getTime() < twoMinutesAgo) {
        // Si era prioritario, notificar desconexión automática
        if (device.isPriority) {
          const notification = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            deviceAddress: address,
            deviceName: device.name || address,
            eventType: 'desconexion',
            timestamp: Date.now(),
            received: new Date().toISOString(),
            source: 'system_timeout'
          };
          
          notifications.unshift(notification);
          if (notifications.length > 100) {
            notifications = notifications.slice(0, 100);
          }
          
          io.emit('notification', notification);
          console.log(`Auto-notificación: ${device.name} desconectado por timeout`);
        }
        
        detectedDevices.delete(address);
      }
    }

    // Emitir actualización a clientes conectados
    const devicesList = Array.from(detectedDevices.values());
    io.emit('devicesUpdate', {
      devices: devicesList,
      timestamp: new Date().toISOString(),
      source: 'pico_w'
    });

    console.log(`Recibidos ${devices.length} dispositivos del Pico W`);
    res.json({ 
      success: true, 
      received: devices.length,
      totalDevices: detectedDevices.size,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error procesando dispositivos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener dispositivos detectados (para el frontend)
app.get('/api/devices', (req, res) => {
  const devicesList = Array.from(detectedDevices.values());
  res.json({
    devices: devicesList,
    count: devicesList.length,
    timestamp: new Date().toISOString(),
    systemStatus: {
      esp32Active: systemStats.esp32LastSeen && (Date.now() - systemStats.esp32LastSeen) < 60000,
      picoActive: systemStats.picoLastSeen && (Date.now() - systemStats.picoLastSeen) < 60000
    }
  });
});

// Endpoint para obtener dispositivos prioritarios (para el ESP32/Pico W)
app.get('/api/priority-devices', (req, res) => {
  res.json({
    priorityDevices: Array.from(priorityDevices),
    count: priorityDevices.size,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para marcar/desmarcar dispositivos como prioritarios (desde el frontend)
app.post('/api/set-priority', (req, res) => {
  try {
    const { deviceAddress, isPriority } = req.body;
    
    if (!deviceAddress) {
      return res.status(400).json({ error: 'Device address is required' });
    }

    if (isPriority) {
      priorityDevices.add(deviceAddress);
      console.log(`Dispositivo ${deviceAddress} marcado como prioritario`);
    } else {
      priorityDevices.delete(deviceAddress);
      console.log(`Dispositivo ${deviceAddress} removido de prioritarios`);
    }

    // Actualizar estado de prioridad en dispositivos detectados
    if (detectedDevices.has(deviceAddress)) {
      const device = detectedDevices.get(deviceAddress);
      device.isPriority = isPriority;
      detectedDevices.set(deviceAddress, device);
    }

    // Emitir actualización de prioridades
    io.emit('priorityUpdate', {
      deviceAddress,
      isPriority,
      priorityDevices: Array.from(priorityDevices),
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      deviceAddress,
      isPriority,
      totalPriorityDevices: priorityDevices.size
    });

  } catch (error) {
    console.error('Error estableciendo prioridad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para recibir notificaciones del ESP32
app.post('/api/notifications', (req, res) => {
  try {
    const { deviceAddress, deviceName, eventType, timestamp } = req.body;
    
    // Actualizar timestamp del ESP32
    systemStats.esp32LastSeen = Date.now();
    
    const notification = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      deviceAddress,
      deviceName: deviceName || deviceAddress,
      eventType,
      timestamp: timestamp || Date.now(),
      received: new Date().toISOString(),
      source: 'esp32'
    };

    // Agregar notificación (mantener solo las últimas 100)
    notifications.unshift(notification);
    if (notifications.length > 100) {
      notifications = notifications.slice(0, 100);
    }

    // Emitir notificación a clientes conectados
    io.emit('notification', notification);

    console.log(`Notificación ESP32: ${eventType} - ${notification.deviceName}`);
    res.json({ success: true, notificationId: notification.id });

  } catch (error) {
    console.error('Error procesando notificación:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener notificaciones (para el frontend)
app.get('/api/notifications', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    notifications: notifications.slice(0, limit),
    total: notifications.length,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para limpiar notificaciones
app.delete('/api/notifications', (req, res) => {
  notifications = [];
  io.emit('notificationsCleared');
  res.json({ success: true, message: 'Notificaciones limpiadas' });
});

// Endpoint para estadísticas del sistema
app.get('/api/system-stats', (req, res) => {
  const now = Date.now();
  const stats = {
    totalDevices: detectedDevices.size,
    priorityDevices: priorityDevices.size,
    recentNotifications: notifications.filter(n => 
      (now - new Date(n.received).getTime()) < 3600000 // Última hora
    ).length,
    devicesByDistance: {
      close: Array.from(detectedDevices.values()).filter(d => d.distance <= 2.0).length,
      medium: Array.from(detectedDevices.values()).filter(d => d.distance > 2.0 && d.distance <= 5.0).length,
      far: Array.from(detectedDevices.values()).filter(d => d.distance > 5.0).length
    },
    priorityDevicesInRange: Array.from(detectedDevices.values()).filter(d => 
      d.isPriority && d.distance <= 2.0
    ).length,
    systemHealth: {
      esp32Active: systemStats.esp32LastSeen && (now - systemStats.esp32LastSeen) < 60000,
      picoActive: systemStats.picoLastSeen && (now - systemStats.picoLastSeen) < 60000,
      esp32LastSeen: systemStats.esp32LastSeen,
      picoLastSeen: systemStats.picoLastSeen
    },
    performance: {
      totalScans: systemStats.totalScans,
      uptime: process.uptime(),
      avgScansPerMinute: systemStats.totalScans / (process.uptime() / 60)
    },
    timestamp: new Date().toISOString()
  };
  
  res.json(stats);
});

// Endpoint de estado del servidor
app.get('/api/status', (req, res) => {
  const now = Date.now();
  res.json({
    status: 'running',
    version: '2.0.0',
    system: 'ESP32 + Pico W',
    devices: detectedDevices.size,
    priorityDevices: priorityDevices.size,
    notifications: notifications.length,
    systemHealth: {
      esp32: systemStats.esp32LastSeen && (now - systemStats.esp32LastSeen) < 60000,
      picoW: systemStats.picoLastSeen && (now - systemStats.picoLastSeen) < 60000
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100
    },
    connections: {
      devices: detectedDevices.size,
      priority: priorityDevices.size,
      websockets: io.engine.clientsCount
    },
    systemComponents: {
      esp32: systemStats.esp32LastSeen ? 'active' : 'inactive',
      picoW: systemStats.picoLastSeen ? 'active' : 'inactive'
    }
  };
  
  res.json(health);
});

// Manejo de conexiones WebSocket
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  
  // Enviar estado actual al cliente recién conectado
  socket.emit('initialData', {
    devices: Array.from(detectedDevices.values()),
    priorityDevices: Array.from(priorityDevices),
    notifications: notifications.slice(0, 20),
    systemStats: {
      esp32Active: systemStats.esp32LastSeen && (Date.now() - systemStats.esp32LastSeen) < 60000,
      picoActive: systemStats.picoLastSeen && (Date.now() - systemStats.picoLastSeen) < 60000
    }
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });

  // Manejar solicitudes específicas del cliente
  socket.on('requestDevices', () => {
    socket.emit('devicesUpdate', {
      devices: Array.from(detectedDevices.values()),
      timestamp: new Date().toISOString()
    });
  });

  socket.on('requestNotifications', () => {
    socket.emit('notificationsUpdate', {
      notifications: notifications.slice(0, 20),
      timestamp: new Date().toISOString()
    });
  });

  socket.on('requestSystemStats', () => {
    socket.emit('systemStatsUpdate', {
      esp32Active: systemStats.esp32LastSeen && (Date.now() - systemStats.esp32LastSeen) < 60000,
      picoActive: systemStats.picoLastSeen && (Date.now() - systemStats.picoLastSeen) < 60000,
      totalDevices: detectedDevices.size,
      priorityDevices: priorityDevices.size,
      timestamp: new Date().toISOString()
    });
  });
});

// Tarea de limpieza y monitoreo periódico
setInterval(() => {
  const now = Date.now();
  const fiveMinutesAgo = now - 300000;
  
  // Limpiar dispositivos muy antiguos
  for (let [address, device] of detectedDevices) {
    if (new Date(device.lastUpdated).getTime() < fiveMinutesAgo) {
      detectedDevices.delete(address);
      console.log(`Dispositivo ${address} removido por inactividad prolongada`);
    }
  }
  
  // Limpiar notificaciones muy antiguas (más de 2 horas)
  const twoHoursAgo = now - 7200000;
  const originalLength = notifications.length;
  notifications = notifications.filter(n => 
    new Date(n.received).getTime() > twoHoursAgo
  );
  
  if (notifications.length < originalLength) {
    console.log(`Limpiadas ${originalLength - notifications.length} notificaciones antiguas`);
    io.emit('notificationsUpdate', {
      notifications: notifications.slice(0, 20),
      timestamp: new Date().toISOString()
    });
  }
  
  // Emitir estadísticas del sistema
  io.emit('systemStatsUpdate', {
    esp32Active: systemStats.esp32LastSeen && (now - systemStats.esp32LastSeen) < 60000,
    picoActive: systemStats.picoLastSeen && (now - systemStats.picoLastSeen) < 60000,
    totalDevices: detectedDevices.size,
    priorityDevices: priorityDevices.size,
    timestamp: new Date().toISOString()
  });
  
}, 300000); // 5 minutos

// Monitoreo de salud del sistema cada minuto
setInterval(() => {
  const now = Date.now();
  const esp32Healthy = systemStats.esp32LastSeen && (now - systemStats.esp32LastSeen) < 120000;
  const picoHealthy = systemStats.picoLastSeen && (now - systemStats.picoLastSeen) < 120000;
  
  if (!esp32Healthy) {
    console.log('⚠️  ESP32 sin respuesta por más de 2 minutos');
  }
  
  if (!picoHealthy) {
    console.log('⚠️  Pico W sin respuesta por más de 2 minutos');
  }
  
  // Emitir alerta si el sistema no está saludable
  if (!esp32Healthy || !picoHealthy) {
    io.emit('systemAlert', {
      type: 'health_warning',
      message: `Sistema no saludable - ESP32: ${esp32Healthy ? 'OK' : 'OFFLINE'}, Pico W: ${picoHealthy ? 'OK' : 'OFFLINE'}`,
      timestamp: new Date().toISOString()
    });
  }
}, 60000); // 1 minuto

// Manejo de errores globales
process.on('uncaughtException', (error) => {
  console.error('Excepción no capturada:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor BLE Monitor ejecutándose en puerto ${PORT}`);
  console.log(`📡 Sistema: ESP32 + Raspberry Pi Pico W`);
  console.log(`🌐 Endpoints disponibles:`);
  console.log(`   - GET /api/health - Estado del sistema`);
  console.log(`   - POST /api/devices - Recibir datos del Pico W`);
  console.log(`   - GET /api/devices - Obtener dispositivos`);
  console.log(`   - POST /api/set-priority - Marcar prioridades`);
  console.log(`   - POST /api/notifications - Recibir notificaciones del ESP32`);
  console.log(`   - GET /api/system-stats - Estadísticas del sistema`);
  console.log(`   - WebSocket en puerto ${PORT} para tiempo real`);
  console.log(`⏰ Inicio: ${new Date().toISOString()}`);
});

module.exports = app;