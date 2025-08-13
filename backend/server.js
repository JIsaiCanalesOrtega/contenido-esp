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

// Ruta principal
app.get('/', (req, res) => {
  res.json({
    message: 'BLE Monitoring Backend API',
    endpoints: {
      devices: 'POST /api/devices - Recibir datos del ESP32',
      getDevices: 'GET /api/devices - Obtener dispositivos detectados',
      priorityDevices: 'GET /api/priority-devices - Obtener dispositivos prioritarios',
      setPriority: 'POST /api/set-priority - Marcar dispositivo como prioritario',
      notifications: 'POST /api/notifications - Recibir notificaciones del ESP32',
      getNotifications: 'GET /api/notifications - Obtener notificaciones'
    }
  });
});

// Endpoint para recibir datos de dispositivos del ESP32
app.post('/api/devices', (req, res) => {
  try {
    const { devices } = req.body;
    
    if (!devices || !Array.isArray(devices)) {
      return res.status(400).json({ error: 'Invalid devices data' });
    }

    // Actualizar dispositivos detectados
    devices.forEach(device => {
      const existingDevice = detectedDevices.get(device.address);
      
      detectedDevices.set(device.address, {
        ...device,
        isPriority: priorityDevices.has(device.address),
        lastUpdated: new Date().toISOString(),
        // Mantener estado previo si existe
        wasInRange: existingDevice ? existingDevice.wasInRange : device.distance <= 2.0
      });
    });

    // Limpiar dispositivos antiguos (más de 1 minuto sin actualizar)
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    for (let [address, device] of detectedDevices) {
      if (new Date(device.lastUpdated).getTime() < oneMinuteAgo) {
        detectedDevices.delete(address);
      }
    }

    // Emitir actualización a clientes conectados
    const devicesList = Array.from(detectedDevices.values());
    io.emit('devicesUpdate', {
      devices: devicesList,
      timestamp: new Date().toISOString()
    });

    console.log(`Recibidos ${devices.length} dispositivos del ESP32`);
    res.json({ 
      success: true, 
      received: devices.length,
      totalDevices: detectedDevices.size
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
    timestamp: new Date().toISOString()
  });
});

// Endpoint para obtener dispositivos prioritarios (para el ESP32)
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
    
    const notification = {
      id: Date.now().toString(),
      deviceAddress,
      deviceName: deviceName || deviceAddress,
      eventType,
      timestamp: timestamp || Date.now(),
      received: new Date().toISOString()
    };

    // Agregar notificación (mantener solo las últimas 100)
    notifications.unshift(notification);
    if (notifications.length > 100) {
      notifications = notifications.slice(0, 100);
    }

    // Emitir notificación a clientes conectados
    io.emit('notification', notification);

    console.log(`Notificación recibida: ${eventType} - ${notification.deviceName}`);
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

// Endpoint de estado del servidor
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    devices: detectedDevices.size,
    priorityDevices: priorityDevices.size,
    notifications: notifications.length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Manejo de conexiones WebSocket
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  
  // Enviar estado actual al cliente recién conectado
  socket.emit('initialData', {
    devices: Array.from(detectedDevices.values()),
    priorityDevices: Array.from(priorityDevices),
    notifications: notifications.slice(0, 20)
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
});

// Tarea de limpieza periódica (cada 5 minutos)
setInterval(() => {
  const now = Date.now();
  const fiveMinutesAgo = now - 300000;
  
  // Limpiar dispositivos muy antiguos
  for (let [address, device] of detectedDevices) {
    if (new Date(device.lastUpdated).getTime() < fiveMinutesAgo) {
      detectedDevices.delete(address);
      console.log(`Dispositivo ${address} removido por inactividad`);
    }
  }
  
  // Limpiar notificaciones muy antiguas (más de 1 hora)
  const oneHourAgo = now - 3600000;
  const originalLength = notifications.length;
  notifications = notifications.filter(n => n.timestamp > oneHourAgo);
  
  if (notifications.length < originalLength) {
    console.log(`Limpiadas ${originalLength - notifications.length} notificaciones antiguas`);
  }
  
}, 300000); // 5 minutos

// Manejo de errores globales
process.on('uncaughtException', (error) => {
  console.error('Excepción no capturada:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`Servidor ejecutándose en puerto ${PORT}`);
  console.log(`Endpoints disponibles:`);
  console.log(`- GET /api/status - Estado del servidor`);
  console.log(`- POST /api/devices - Recibir datos del ESP32`);
  console.log(`- GET /api/devices - Obtener dispositivos`);
  console.log(`- POST /api/set-priority - Marcar prioridades`);
  console.log(`- POST /api/notifications - Recibir notificaciones`);
  console.log(`- WebSocket en puerto ${PORT} para tiempo real`);
});

module.exports = app;