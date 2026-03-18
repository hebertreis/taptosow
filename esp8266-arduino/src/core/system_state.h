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
#include "config/mqtt_config.h"
#include "config/nfc_config.h"
#include "config/version.h"

// ============================================================================
// Device States
// ============================================================================
enum DeviceState {
    STATE_IDLE,
    STATE_WAITING_TAG,
    STATE_TAG_DETECTED,
    STATE_WRITING,
    STATE_SUCCESS,
    STATE_ERROR,
    STATE_CONFIG_MODE,
    STATE_READ_MODE
};

// ============================================================================
// Operation Mode
// ============================================================================
enum OperationMode {
    MODE_STANDBY,     // No pending operations
    MODE_WRITER,      // Waiting for write command
    MODE_READER       // Auto-transmitting tag data
};

// ============================================================================
// Resource Locks (for SPI/I2C coordination)
// ============================================================================
struct ResourceLocks {
    volatile bool nfcLocked = false;      // NFC has exclusive access
    volatile bool lcdLocked = false;      // LCD is updating
    volatile unsigned long nfcLockUntil = 0;  // When NFC lock expires
    volatile unsigned long lcdPauseUntil = 0; // When LCD can resume
};

// ============================================================================
// System State
// ============================================================================
struct SystemState {
    // Device identification
    String deviceId = "";
    String mqttTopicBase = "";
    
    // Connection states
    volatile bool isWifiConnected = false;
    volatile bool isMqttConnected = false;
    volatile bool isNfcConnected = false;
    
    // Operation state
    volatile DeviceState state = STATE_IDLE;
    volatile OperationMode mode = MODE_STANDBY;
    volatile bool debugMode = false;
    volatile bool readMode = true;
    
    // Pending command data
    volatile bool hasPendingWriteCommand = false;
    String pendingTenantId = "";
    String pendingSectorId = "";
    String pendingUrl = "";

    // Timing
    volatile unsigned long lastHeartbeat = 0;
    volatile unsigned long lastLcdUpdate = 0;
    volatile unsigned long lastNfcPoll = 0;
    volatile unsigned long lastActivity = 0;
    
    // NFC timeout tracking
    volatile unsigned long nfcWaitStartTime = 0;  // When started waiting for tag
    volatile bool nfcTimeoutWarningSent = false;   // Warning already sent

    // NFC
    byte nfcFirmwareVersion = 0x00;

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
 * Set operation mode
 */
void modeSet(OperationMode newMode);

/**
 * Get current operation mode
 */
OperationMode modeGet();

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
 * Force LCD pause for NFC operation
 */
void lcdPauseForNfc();

/**
 * Resume LCD updates after NFC operation
 */
void lcdResumeAfterNfc();

// ============================================================================
// State Helper Functions
// ============================================================================

/**
 * Check if device is ready (all systems connected)
 */
bool isDeviceReady();

/**
 * Get status JSON
 */
String getStatusJson();

/**
 * Get heartbeat JSON
 */
String getHeartbeatJson();

#endif // SYSTEM_STATE_H
