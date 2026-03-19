/**
 * @file system_state.h
 * @brief Global system state and coordination for OneTapGo
 * 
 * Thread-safe state management with coordination between:
 * - NFC (RC522)
 * - LCD (SSD1306)
 * - MQTT
 * - WiFi
 */

#ifndef SYSTEM_STATE_H
#define SYSTEM_STATE_H

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WiFiMulti.h>
#include <PubSubClient.h>
#include <MFRC522.h>
#include <NfcAdapter.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <Wire.h>

// Configuration headers
#include "config/hardware_config.h"
#include "config/wifi_config.h"
#include "config/mqtt_config.h"
#include "config/nfc_config.h"
#include "config/version.h"

// ============================================================================
// Device States
// ============================================================================
enum DeviceState {
    STATE_BOOT,
    STATE_IDLE,
    STATE_WIFI_SETUP,
    STATE_NFC_WAITING,
    STATE_NFC_ACTIVE,
    STATE_SUCCESS,
    STATE_ERROR
};

// ============================================================================
// NFC Command Types
// ============================================================================
enum NfcCommandType {
    NFC_CMD_NONE,
    NFC_CMD_READ,
    NFC_CMD_WRITE
};

// ============================================================================
// NFC Card Details
// ============================================================================
struct __attribute__((aligned(4))) NfcCardInfo {
    String uid = "";
    String piccTypeName = "";
    String family = "";
    String brand = "";
    String ndefUrl = "";
    uint32_t capacityBytes = 0;
    uint8_t uidLength = 0;
    bool formatted = false;
    bool hasNdef = false;
    bool lockRequested = false;
    bool lockApplied = false;
    
    // Clear all fields to default values
    void clear() {
        uid = "";
        piccTypeName = "";
        family = "";
        brand = "";
        ndefUrl = "";
        capacityBytes = 0;
        uidLength = 0;
        formatted = false;
        hasNdef = false;
        lockRequested = false;
        lockApplied = false;
    }
};

// ============================================================================
// NFC Job
// ============================================================================
struct NfcJob {
    bool active = false;
    NfcCommandType command = NFC_CMD_NONE;
    String requestId = "";
    String url = "";
    bool lockCard = false;
    unsigned long timeoutMs = NFC_DEFAULT_COMMAND_TIMEOUT_SEC * 1000UL;
    unsigned long startedAt = 0;
    bool timeoutReported = false;
};

// ============================================================================
// Resource Locks (for SPI/I2C coordination)
// ============================================================================
struct ResourceLocks {
    volatile bool nfcLocked = false;
    volatile unsigned long nfcLockUntil = 0;
    volatile bool lcdSuspended = false;
};

// ============================================================================
// System State
// ============================================================================
struct SystemState {
    // Device identification
    String deviceId = "";
    String mqttTopicBase = "";
    String portalApSsid = "";
    String portalApPassword = "";
    
    // Connection states
    volatile bool isWifiConnected = false;
    volatile bool isMqttConnected = false;
    volatile bool isNfcConnected = false;
    volatile bool portalActive = false;
    
    // Active state
    volatile DeviceState state = STATE_BOOT;
    volatile bool debugMode = false;
    volatile bool legacyReadMode = false;
    
    // Network details
    String wifiSsid = "";
    String wifiIp = "";
    int16_t wifiRssi = 0;
    
    // Timing
    volatile unsigned long lastHeartbeat = 0;
    volatile unsigned long lastNfcPoll = 0;
    volatile unsigned long lastActivity = 0;
    volatile unsigned long lastReconnectAttempt = 0;
    volatile unsigned long stateHoldUntil = 0;
    
    // NFC
    byte nfcFirmwareVersion = 0x00;
    NfcJob nfcJob;
    NfcCardInfo lastCard;
    NfcCommandType lastCompletedCommand = NFC_CMD_NONE;
    
    // Error tracking
    String lastErrorSource = "";
    String lastErrorCode = "";
    String lastErrorMessage = "";

    // Resource coordination
    ResourceLocks locks;
};

// ============================================================================
// Global State Instance
// ============================================================================
extern SystemState g_system;

// ============================================================================
// Hardware Instances (extern)
// ============================================================================
extern ESP8266WiFiMulti g_wifiMulti;
extern WiFiClientSecure g_wifiClient;
extern PubSubClient g_mqttClient;
extern MFRC522 g_mfrc522;
extern NfcAdapter g_nfc;
extern Adafruit_SSD1306 g_display;

// ============================================================================
// State Management Functions
// ============================================================================

/**
 * Initialize system state
 */
void stateInit();

/**
 * Set device state (thread-safe)
 */
void stateSet(DeviceState newState);

/**
 * Get current device state
 */
DeviceState stateGet();

/**
 * Set last error information
 */
void setLastError(const String& source, const String& code, const String& message);

/**
 * Clear last error information
 */
void clearLastError();

/**
 * Start a new NFC job
 */
void startNfcJob(NfcCommandType command,
                 const String& requestId,
                 const String& url,
                 unsigned long timeoutMs,
                 bool lockCard);

/**
 * Clear current NFC job
 */
void clearNfcJob();

/**
 * Check if an NFC job is active
 */
bool nfcJobActive();

// ============================================================================
// Resource Coordination Functions
// ============================================================================

/**
 * Request exclusive NFC access (for SPI/I2C coordination)
 * @return true if lock acquired, false if LCD is active
 */
bool nfcRequestLock();

/**
 * Release NFC lock
 */
void nfcReleaseLock();

/**
 * Check if NFC can operate (has lock)
 */
bool nfcHasLock();

/**
 * Check if LCD can update (not paused for NFC)
 */
bool lcdCanUpdate();

/**
 * Suspend periodic LCD updates while NFC is using the shared pins.
 */
void lcdSuspendUpdates();

/**
 * Resume LCD updates after NFC finishes using the shared pins.
 */
void lcdResumeUpdates();

// ============================================================================
// State Helper Functions
// ============================================================================

/**
 * Check if device is ready (all systems connected)
 */
bool isDeviceReady();

/**
 * Human readable state name
 */
String deviceStateName(DeviceState state);

/**
 * Human readable NFC command name
 */
String nfcCommandName(NfcCommandType command);

/**
 * Get status JSON
 */
String getStatusJson();

/**
 * Serialize status JSON directly to a buffer
 * @return bytes written (0 on failure)
 */
size_t serializeStatusJson(char* buffer, size_t bufferSize);

/**
 * Get heartbeat JSON
 */
String getHeartbeatJson();

/**
 * Serialize heartbeat JSON directly to a buffer
 * @return bytes written (0 on failure)
 */
size_t serializeHeartbeatJson(char* buffer, size_t bufferSize);

#endif // SYSTEM_STATE_H
