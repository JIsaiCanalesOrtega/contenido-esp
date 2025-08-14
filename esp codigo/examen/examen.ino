#include "BLEDevice.h"
#include "BLEScan.h"
#include "BLEAdvertisedDevice.h"
#include <WiFi.h>
#include <HTTPClient.h>

// Configuración WiFi
const char* ssid = "WNS R1057";
const char* password = "zcWmyqNw2X";
const char* backendURL = "https://contenido-esp.onrender.com";

// Pines de LEDs
#define LED_GREEN 2
#define LED_RED 4

// Variables globales mínimas
BLEScan* scan;
unsigned long lastScan = 0;
unsigned long lastSync = 0;
String priority[3]; // Solo 3 dispositivos prioritarios máximo
int priorityCount = 0;
bool hasAlert = false;

// Callback ultra simplificado
class SimpleCallback: public BLEAdvertisedDeviceCallbacks {
public:
  void onResult(BLEAdvertisedDevice device) {
    String addr = device.getAddress().toString().c_str();
    int rssi = device.getRSSI();
    
    // Solo procesar si es prioritario
    for(int i = 0; i < priorityCount; i++) {
      if(priority[i] == addr) {
        if(rssi < -70) { // Dispositivo lejano
          digitalWrite(LED_GREEN, HIGH);
          hasAlert = true;
          Serial.println("Alejamiento detectado");
        } else {
          digitalWrite(LED_GREEN, LOW);
        }
        break;
      }
    }
  }
};

void setup() {
  Serial.begin(115200);
  
  // LEDs
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, LOW);
  
  // BLE básico
  BLEDevice::init("");
  scan = BLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new SimpleCallback());
  scan->setActiveScan(false);
  
  // WiFi
  WiFi.begin(ssid, password);
  while(WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConectado");
  
  // Obtener prioridades inicial
  syncPriorities();
}

void loop() {
  unsigned long now = millis();
  
  // Escanear cada 20 segundos
  if(now - lastScan > 20000) {
    Serial.println("Escaneando...");
    scan->start(2, false);
    scan->clearResults();
    lastScan = now;
  }
  
  // Sincronizar cada 60 segundos
  if(now - lastSync > 60000) {
    syncPriorities();
    lastSync = now;
  }
  
  // LED rojo si hay alerta
  if(hasAlert) {
    digitalWrite(LED_RED, (millis() / 500) % 2);
  } else {
    digitalWrite(LED_RED, LOW);
  }
  
  delay(100);
}

void syncPriorities() {
  if(WiFi.status() != WL_CONNECTED) return;
  
  HTTPClient http;
  http.begin(String(backendURL) + "/api/priority-devices");
  
  if(http.GET() == 200) {
    String data = http.getString();
    parsePriorities(data);
    Serial.printf("Prioridades: %d\n", priorityCount);
  }
  http.end();
}

void parsePriorities(String json) {
  priorityCount = 0;
  int pos = 0;
  
  while(pos < json.length() && priorityCount < 3) {
    int start = json.indexOf("\"", pos);
    if(start == -1) break;
    int end = json.indexOf("\"", start + 1);
    if(end == -1) break;
    
    String addr = json.substring(start + 1, end);
    if(addr.length() == 17) { // Validar formato MAC
      priority[priorityCount++] = addr;
    }
    pos = end + 1;
  }
}