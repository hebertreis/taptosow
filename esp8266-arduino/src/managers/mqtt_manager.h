/**
 * @file mqtt_manager.h
 * @brief MQTT client manager for OneTapGo
 * 
 * Handles MQTT connection, publishing, and command handling.
 */

#ifndef MQTT_MANAGER_H
#define MQTT_MANAGER_H

#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "core/system_state.h"

// Forward declaration of callback wrapper
void mqttCallbackWrapper(char* topic, byte* payload, unsigned int length);

// ============================================================================
// MQTT Manager Class
// ============================================================================
class MqttManager {
public:
    /**
     * Initialize MQTT client
     * @param deviceId Device identifier
     * @param mqttTopicBase Base topic path
     */
    void begin(const String& deviceId, const String& mqttTopicBase);
    
    /**
     * Process MQTT loop (must be called regularly)
     */
    void loop();
    
    /**
     * Connect to MQTT broker
     * @return true if connected
     */
    bool connect();
    
    /**
     * Check if connected
     */
    bool isConnected();
    
    /**
     * Publish message to topic
     * @param topic Topic to publish to
     * @param payload Message payload
     * @param retained Retained flag
     * @return true if published
     */
    bool publish(const String& topic, const String& payload, bool retained = false);
    
    /**
     * Publish status update
     */
    void publishStatus();
    
    /**
     * Publish heartbeat
     */
    void publishHeartbeat();
    
    /**
     * Publish tag data
     * @param tagId Tag UID
     * @param ndefUrl NDEF URL (optional)
     * @param sectorData Sector data (optional)
     */
    void publishTagData(const String& tagId, const String& ndefUrl = "", const String& sectorData = "");
    
    /**
     * Publish write result
     * @param success Write success
     * @param url Written URL (on success) or error message
     */
    void publishWriteResult(bool success, const String& urlOrError = "");
    
    /**
     * Publish debug status
     */
    void publishDebugStatus();
    
    /**
     * Publish read mode status
     */
    void publishReadModeStatus();
    
    /**
     * Publish NFC timeout notification
     * @param timeoutMs Timeout duration in ms
     */
    void publishNfcTimeout(unsigned long timeoutMs);
    
    /**
     * Set debug mode
     * @param enabled Enable/disable debug
     */
    void setDebugMode(bool enabled);
    
    /**
     * Set read mode
     * @param enabled Enable/disable read mode
     */
    void setReadMode(bool enabled);
    
    /**
     * Get last heartbeat time
     */
    unsigned long getLastHeartbeat() { return _lastHeartbeat; }
    
    // Note: _handleMessage is called from mqttCallbackWrapper
    void _handleMessage(char* topic, byte* payload, unsigned int length);

private:
    String _deviceId = "";
    String _mqttTopicBase = "";
    unsigned long _lastHeartbeat = 0;
    unsigned long _lastReconnect = 0;
    int _reconnectAttempts = 0;
    
    /**
     * Handle write_tag command
     */
    void _handleWriteTag(JsonDocument& doc);

    /**
     * Handle set_debug command
     */
    void _handleSetDebug(JsonDocument& doc);

    /**
     * Handle set_read_mode command
     */
    void _handleSetReadMode(JsonDocument& doc);

    /**
     * Handle restart command
     */
    void _handleRestart();

    /**
     * Handle status command
     */
    void _handleStatus();

    /**
     * Handle read_tag command
     */
    void _handleReadTag();
};

// ============================================================================
// Global MQTT Manager Instance
// ============================================================================
extern MqttManager g_mqttManager;

#endif // MQTT_MANAGER_H
