/**
 * @file system_state.cpp
 * @brief Global system state implementation
 */

#include "core/system_state.h"

// ============================================================================
// Global State Instance
// ============================================================================
SystemState g_system;

// ============================================================================
// Hardware Instances
// ============================================================================
ESP8266WiFiMulti g_wifiMulti;
WiFiClientSecure g_wifiClient;
PubSubClient g_mqttClient;
MFRC522 g_mfrc522(RC522_SS_PIN, RC522_RST_PIN);
NfcAdapter g_nfc = NfcAdapter(&g_mfrc522);
Adafruit_SSD1306 g_display(OLED_WIDTH, OLED_HEIGHT, &Wire, OLED_RESET_PIN);

// ============================================================================
// State Management
// ============================================================================

void stateInit() {
    g_system.deviceId = "";
    g_system.mqttTopicBase = "";
    g_system.isWifiConnected = false;
    g_system.isMqttConnected = false;
    g_system.isNfcConnected = false;
    g_system.state = STATE_IDLE;
    g_system.mode = MODE_STANDBY;
    g_system.debugMode = false;
    g_system.readMode = true;
    g_system.hasPendingWriteCommand = false;
    g_system.lastHeartbeat = 0;
    g_system.lastLcdUpdate = 0;
    g_system.lastNfcPoll = 0;
    g_system.lastActivity = millis();
    g_system.nfcFirmwareVersion = 0x00;
    g_system.locks.nfcLocked = false;
    g_system.locks.lcdLocked = false;
    g_system.locks.nfcLockUntil = 0;
    g_system.locks.lcdPauseUntil = 0;
}

void stateSet(DeviceState newState) {
    g_system.state = newState;
    g_system.lastActivity = millis();
}

DeviceState stateGet() {
    return (DeviceState)g_system.state;
}

void modeSet(OperationMode newMode) {
    g_system.mode = newMode;
    
    // Update state based on mode
    switch (newMode) {
        case MODE_WRITER:
            stateSet(STATE_WAITING_TAG);
            break;
        case MODE_READER:
            stateSet(STATE_READ_MODE);
            break;
        case MODE_STANDBY:
            stateSet(STATE_IDLE);
            break;
    }
}

OperationMode modeGet() {
    return (OperationMode)g_system.mode;
}

// ============================================================================
// Resource Coordination
// ============================================================================

bool nfcRequestLock() {
    // Check if lock is already held
    if (g_system.locks.nfcLocked) {
        return true;
    }
    
    // Check if LCD is currently updating
    if (g_system.locks.lcdLocked) {
        return false;
    }
    
    // Acquire lock
    g_system.locks.nfcLocked = true;
    g_system.locks.nfcLockUntil = millis() + NFC_ACTIVITY_TIMEOUT_MS;
    g_system.locks.lcdPauseUntil = millis() + NFC_ACTIVITY_TIMEOUT_MS;
    
    // Small delay to ensure I2C is complete
    delayMicroseconds(I2C_TO_SPI_DELAY_US);
    
    // Re-initialize SPI/RC522 after I2C
    g_mfrc522.PCD_Init();
    g_mfrc522.PCD_SetAntennaGain(g_mfrc522.RxGain_max);
    delay(SPI_STABILIZE_DELAY_MS);
    
    return true;
}

void nfcReleaseLock() {
    g_system.locks.nfcLocked = false;
    g_system.locks.nfcLockUntil = 0;
}

bool nfcHasLock() {
    // Check if lock is held and not expired
    if (!g_system.locks.nfcLocked) {
        return false;
    }
    
    if (millis() > g_system.locks.nfcLockUntil) {
        // Lock expired
        g_system.locks.nfcLocked = false;
        g_system.locks.nfcLockUntil = 0;
        return false;
    }
    
    return true;
}

bool lcdCanUpdate() {
    // Check if LCD is paused for NFC
    if (millis() < g_system.locks.lcdPauseUntil) {
        return false;
    }
    
    // Check if NFC has active lock
    if (g_system.locks.nfcLocked && millis() < g_system.locks.nfcLockUntil) {
        return false;
    }
    
    return true;
}

void lcdPauseForNfc() {
    g_system.locks.lcdPauseUntil = millis() + NFC_ACTIVITY_TIMEOUT_MS;
}

void lcdResumeAfterNfc() {
    g_system.locks.lcdPauseUntil = 0;
}

// ============================================================================
// Helper Functions
// ============================================================================

bool isDeviceReady() {
    return g_system.isWifiConnected && 
           g_system.isMqttConnected && 
           g_system.isNfcConnected;
}

String getStatusJson() {
    StaticJsonDocument<512> doc;
    
    doc["status"] = g_system.isMqttConnected ? "online" : "offline";
    doc["ready"] = isDeviceReady();
    doc["state"] = g_system.state;
    
    JsonObject connections = doc.createNestedObject("connections");
    connections["wifi"] = g_system.isWifiConnected;
    connections["mqtt"] = g_system.isMqttConnected;
    connections["nfc"] = g_system.isNfcConnected;
    
    doc["operationMode"] = g_system.hasPendingWriteCommand ? "writer" : 
                           (g_system.readMode ? "reader" : "standby");
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["wifi_ssid"] = WiFi.SSID();
    doc["ip_address"] = WiFi.localIP().toString();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["timestamp"] = millis();
    doc["version"] = DEVICE_VERSION;
    doc["debugMode"] = g_system.debugMode;
    doc["readMode"] = g_system.readMode;
    doc["hasPendingCommand"] = g_system.hasPendingWriteCommand;
    
    String payload;
    serializeJson(doc, payload);
    return payload;
}

String getHeartbeatJson() {
    StaticJsonDocument<512> doc;
    
    doc["type"] = "heartbeat";
    doc["deviceId"] = g_system.deviceId;
    doc["state"] = g_system.state;
    doc["ready"] = isDeviceReady();
    
    JsonObject connections = doc.createNestedObject("connections");
    connections["wifi"] = g_system.isWifiConnected;
    connections["mqtt"] = g_system.isMqttConnected;
    connections["nfc"] = g_system.isNfcConnected;
    
    doc["operationMode"] = g_system.hasPendingWriteCommand ? "writer" : 
                           (g_system.readMode ? "reader" : "standby");
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["uptime"] = millis();
    doc["timestamp"] = millis();
    doc["debugMode"] = g_system.debugMode;
    doc["readMode"] = g_system.readMode;
    doc["hasPendingCommand"] = g_system.hasPendingWriteCommand;
    
    String payload;
    serializeJson(doc, payload);
    return payload;
}
