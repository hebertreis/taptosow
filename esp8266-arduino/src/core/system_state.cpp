/**
 * @file system_state.cpp
 * @brief Global system state implementation
 */

#include "core/system_state.h"
#include <cstdio>

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
    g_system.portalApSsid = "";
    g_system.portalApPassword = WIFI_AP_PASSWORD;
    g_system.isWifiConnected = false;
    g_system.isMqttConnected = false;
    g_system.isNfcConnected = false;
    g_system.portalActive = false;
    g_system.state = STATE_BOOT;
    g_system.debugMode = false;
    g_system.legacyReadMode = false;
    g_system.wifiSsid = "";
    g_system.wifiIp = "";
    g_system.wifiRssi = 0;
    g_system.lastHeartbeat = 0;
    g_system.lastNfcPoll = 0;
    g_system.lastActivity = millis();
    g_system.lastReconnectAttempt = 0;
    g_system.stateHoldUntil = 0;
    g_system.nfcFirmwareVersion = 0x00;
    g_system.nfcJob = NfcJob();
    g_system.lastCard = NfcCardInfo();
    g_system.lastCompletedCommand = NFC_CMD_NONE;
    g_system.lastErrorSource = "";
    g_system.lastErrorCode = "";
    g_system.lastErrorMessage = "";
    g_system.locks = ResourceLocks();
}

void stateSet(DeviceState newState) {
    g_system.state = newState;
    g_system.lastActivity = millis();
}

DeviceState stateGet() {
    return (DeviceState)g_system.state;
}

void setLastError(const String& source, const String& code, const String& message) {
    g_system.lastErrorSource = source;
    g_system.lastErrorCode = code;
    g_system.lastErrorMessage = message;
    stateSet(STATE_ERROR);
}

void clearLastError() {
    g_system.lastErrorSource = "";
    g_system.lastErrorCode = "";
    g_system.lastErrorMessage = "";
}

void startNfcJob(NfcCommandType command,
                 const String& requestId,
                 const String& url,
                 unsigned long timeoutMs,
                 bool lockCard) {
    g_system.locks.nfcLocked = false;
    g_system.locks.nfcLockUntil = 0;
    g_system.nfcJob.active = true;
    g_system.nfcJob.command = command;
    g_system.nfcJob.requestId = requestId;
    g_system.nfcJob.url = url;
    g_system.nfcJob.lockCard = lockCard;
    g_system.nfcJob.timeoutMs = timeoutMs;
    g_system.nfcJob.startedAt = millis();
    g_system.nfcJob.timeoutReported = false;
    g_system.lastNfcPoll = 0;
    g_system.lastCard.clear();
    g_system.stateHoldUntil = 0;
    clearLastError();
    stateSet(STATE_NFC_WAITING);
    g_system.lastActivity = millis();
}

void clearNfcJob() {
    g_system.nfcJob.active = false;
    g_system.nfcJob.command = NFC_CMD_NONE;
    g_system.nfcJob.requestId = "";
    g_system.nfcJob.url = "";
    g_system.nfcJob.lockCard = false;
    g_system.nfcJob.timeoutMs = NFC_DEFAULT_COMMAND_TIMEOUT_SEC * 1000UL;
    g_system.nfcJob.startedAt = 0;
    g_system.nfcJob.timeoutReported = false;
}

bool nfcJobActive() {
    return g_system.nfcJob.active;
}

// ============================================================================
// Resource Coordination
// ============================================================================

bool nfcRequestLock() {
    if (g_system.locks.nfcLocked) {
        if (millis() > g_system.locks.nfcLockUntil) {
            g_system.locks.nfcLocked = false;
            g_system.locks.nfcLockUntil = 0;
        } else {
            return false;
        }
    }
    
    // Acquire lock
    g_system.locks.nfcLocked = true;
    unsigned long holdMs = g_system.nfcJob.active
        ? (g_system.nfcJob.timeoutMs + NFC_ACTIVITY_TIMEOUT_MS)
        : NFC_ACTIVITY_TIMEOUT_MS;
    g_system.locks.nfcLockUntil = millis() + holdMs;
    
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
    if (g_system.locks.nfcLocked) {
        if (millis() > g_system.locks.nfcLockUntil) {
            g_system.locks.nfcLocked = false;
            g_system.locks.nfcLockUntil = 0;
        } else {
            return false;
        }
    }
    
    return true;
}

// ============================================================================
// Helper Functions
// ============================================================================

bool isDeviceReady() {
    return g_system.isWifiConnected && 
           g_system.isMqttConnected && 
           g_system.isNfcConnected;
}

String deviceStateName(DeviceState state) {
    switch (state) {
        case STATE_BOOT: return "boot";
        case STATE_IDLE: return "idle";
        case STATE_WIFI_SETUP: return "wifi_setup";
        case STATE_NFC_WAITING: return "nfc_waiting";
        case STATE_NFC_ACTIVE: return "nfc_active";
        case STATE_SUCCESS: return "success";
        case STATE_ERROR: return "error";
        default: return "unknown";
    }
}

String nfcCommandName(NfcCommandType command) {
    switch (command) {
        case NFC_CMD_READ: return "read";
        case NFC_CMD_WRITE: return "write";
        default: return "none";
    }
}

namespace {
void fillStatusDoc(JsonDocument& doc) {
    char firmwareHex[5] = {0};
    snprintf(firmwareHex, sizeof(firmwareHex), "%02X", g_system.nfcFirmwareVersion);

    doc["type"] = "status";
    doc["deviceId"] = g_system.deviceId;
    doc["version"] = DEVICE_VERSION;
    doc["ready"] = isDeviceReady();
    doc["state"] = deviceStateName((DeviceState)g_system.state);
    doc["uptime"] = millis();
    doc["freeHeap"] = ESP.getFreeHeap();
    doc["timestamp"] = millis();
    doc["wifiConnected"] = g_system.isWifiConnected;
    doc["ssid"] = g_system.wifiSsid;
    doc["ip"] = g_system.wifiIp;
    doc["rssi"] = g_system.wifiRssi;
    doc["portalActive"] = g_system.portalActive;
    doc["portalSsid"] = g_system.portalApSsid;
    doc["mqttConnected"] = g_system.isMqttConnected;
    doc["nfcReady"] = g_system.isNfcConnected;
    doc["firmwareHex"] = firmwareHex;

    if (g_system.nfcJob.active) {
        doc["job"] = nfcCommandName(g_system.nfcJob.command);
        doc["requestId"] = g_system.nfcJob.requestId;
        doc["timeoutSec"] = g_system.nfcJob.timeoutMs / 1000UL;
    } else {
        doc["job"] = "none";
    }

    if (g_system.lastCompletedCommand != NFC_CMD_NONE) {
        doc["last"] = nfcCommandName(g_system.lastCompletedCommand);
        doc["lastUid"] = g_system.lastCard.uid;
        doc["lastUrl"] = g_system.lastCard.ndefUrl;
    }

    if (g_system.lastErrorCode.length() > 0) {
        doc["errorSource"] = g_system.lastErrorSource;
        doc["errorCode"] = g_system.lastErrorCode;
        doc["errorMessage"] = g_system.lastErrorMessage;
    }
}

void fillHeartbeatDoc(JsonDocument& doc) {
    doc["type"] = "heartbeat";
    doc["deviceId"] = g_system.deviceId;
    doc["state"] = deviceStateName((DeviceState)g_system.state);
    doc["ready"] = isDeviceReady();
    doc["uptime"] = millis();
    doc["freeHeap"] = ESP.getFreeHeap();
    doc["timestamp"] = millis();
    doc["wifiConnected"] = g_system.isWifiConnected;
    doc["mqttConnected"] = g_system.isMqttConnected;
    doc["nfcReady"] = g_system.isNfcConnected;
    doc["rssi"] = g_system.wifiRssi;
    doc["job"] = g_system.nfcJob.active ? nfcCommandName(g_system.nfcJob.command) : "none";
}
} // namespace

size_t serializeStatusJson(char* buffer, size_t bufferSize) {
    if (buffer == nullptr || bufferSize == 0) {
        return 0;
    }

    StaticJsonDocument<512> doc;
    fillStatusDoc(doc);
    return serializeJson(doc, buffer, bufferSize);
}

size_t serializeHeartbeatJson(char* buffer, size_t bufferSize) {
    if (buffer == nullptr || bufferSize == 0) {
        return 0;
    }

    StaticJsonDocument<256> doc;
    fillHeartbeatDoc(doc);
    return serializeJson(doc, buffer, bufferSize);
}

String getStatusJson() {
    StaticJsonDocument<512> doc;
    fillStatusDoc(doc);

    String payload;
    payload.reserve(measureJson(doc) + 1);
    serializeJson(doc, payload);
    return payload;
}

String getHeartbeatJson() {
    StaticJsonDocument<256> doc;
    fillHeartbeatDoc(doc);

    String payload;
    payload.reserve(measureJson(doc) + 1);
    serializeJson(doc, payload);
    return payload;
}
