/**
 * @file mqtt_manager.cpp
 * @brief MQTT client manager implementation
 */

#include "managers/mqtt_manager.h"
#include "managers/lcd_manager.h"
#include "managers/nfc_manager.h"

MqttManager g_mqttManager;

// ============================================================================
// MQTT Callback (C-style wrapper)
// ============================================================================
void mqttCallbackWrapper(char* topic, byte* payload, unsigned int length) {
    g_mqttManager._handleMessage(topic, payload, length);
}

// ============================================================================
// MQTT Manager Implementation
// ============================================================================

void MqttManager::begin(const String& deviceId, const String& mqttTopicBase) {
    _deviceId = deviceId;
    _mqttTopicBase = mqttTopicBase;
    
    Serial.println(F("\n[MQTT] Initializing..."));
    
    // Configure secure WiFi client
    g_wifiClient.setInsecure();
    g_wifiClient.setTimeout(10);
    
    // Configure MQTT client
    g_mqttClient.setClient(g_wifiClient);
    g_mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    g_mqttClient.setCallback(mqttCallbackWrapper);
    g_mqttClient.setBufferSize(1024);
    g_mqttClient.setKeepAlive(MQTT_KEEPALIVE_SEC);
    g_mqttClient.setSocketTimeout(MQTT_SOCKET_TIMEOUT_SEC);
    
    Serial.print(F("[MQTT] Server: "));
    Serial.println(MQTT_HOST);
    Serial.print(F("[MQTT] Port: "));
    Serial.println(MQTT_PORT);
    Serial.print(F("[MQTT] Client ID: "));
    Serial.println(_deviceId);
}

void MqttManager::loop() {
    if (!g_mqttClient.connected()) {
        // Connection lost
        static bool wasConnected = true;
        if (wasConnected) {
            Serial.println(F("[MQTT] Connection lost"));
            g_system.isMqttConnected = false;
            wasConnected = false;
            g_lcd.forceUpdate();
        }
        
        // Reconnect
        if (millis() - _lastReconnect > MQTT_RECONNECT_DELAY_MS) {
            _lastReconnect = millis();
            
            if (connect()) {
                wasConnected = true;
                g_lcd.forceUpdate();
            } else {
                _reconnectAttempts++;
                Serial.print(F("[MQTT] Reconnect attempt "));
                Serial.print(_reconnectAttempts);
                Serial.println(F(" failed"));
                
                if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    Serial.println(F("[MQTT] Max attempts reached"));
                    _reconnectAttempts = 0;
                }
            }
        }
        return;
    }
    
    // Process MQTT messages
    g_mqttClient.loop();
    
    // Send heartbeat
    if (millis() - _lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        _lastHeartbeat = millis();
        g_system.lastHeartbeat = _lastHeartbeat;
        publishHeartbeat();
    }
}

bool MqttManager::connect() {
    Serial.print(F("[MQTT] Connecting..."));
    
    // Last will message
    String willTopic = _mqttTopicBase + "/status";
    String willMessage = "{\"status\":\"offline\",\"timestamp\":" + String(millis()) + "}";
    
    if (g_mqttClient.connect(_deviceId.c_str(), MQTT_USERNAME, MQTT_PASSWORD,
                            willTopic.c_str(), 1, true, willMessage.c_str())) {
        Serial.println(F(" OK"));
        
        // Subscribe to command topic
        String commandTopic = _mqttTopicBase + "/command";
        g_mqttClient.subscribe(commandTopic.c_str(), 1);
        Serial.print(F("[MQTT] Subscribed to: "));
        Serial.println(commandTopic);
        
        g_system.isMqttConnected = true;
        _reconnectAttempts = 0;
        
        publishStatus();
        return true;
    } else {
        Serial.print(F(" FAILED - Code: "));
        Serial.println(g_mqttClient.state());
        g_system.isMqttConnected = false;
        return false;
    }
}

bool MqttManager::isConnected() {
    return g_mqttClient.connected();
}

bool MqttManager::publish(const String& topic, const String& payload, bool retained) {
    if (!g_system.isMqttConnected) {
        Serial.println(F("[MQTT] Cannot publish - not connected"));
        return false;
    }
    
    if (g_mqttClient.publish(topic.c_str(), payload.c_str(), retained)) {
        Serial.print(F("[MQTT] Published to "));
        Serial.print(topic);
        Serial.print(F(": "));
        Serial.println(payload);
        return true;
    } else {
        Serial.print(F("[MQTT] Publish failed to "));
        Serial.println(topic);
        return false;
    }
}

void MqttManager::publishStatus() {
    publish(_mqttTopicBase + "/status", getStatusJson());
}

void MqttManager::publishHeartbeat() {
    publish(_mqttTopicBase + "/heartbeat", getHeartbeatJson());
}

void MqttManager::publishTagData(const String& tagId, const String& ndefUrl, const String& sectorData) {
    StaticJsonDocument<1024> doc;
    
    doc["type"] = "tag_data";
    doc["deviceId"] = _deviceId;
    doc["serialNumber"] = tagId;
    doc["timestamp"] = millis();
    
    // NDEF section
    JsonObject ndef = doc.createNestedObject("ndef");
    if (ndefUrl.length() > 0) {
        ndef["hasMessage"] = true;
        ndef["url"] = ndefUrl;
    } else {
        ndef["hasMessage"] = false;
    }
    
    // Sector data
    if (sectorData.length() > 0) {
        doc["sectorData"] = sectorData;
    }
    
    // Debug data if enabled
    if (g_system.debugMode) {
        doc["debug"] = true;
        doc["freeHeap"] = ESP.getFreeHeap();
    }
    
    String payload;
    serializeJson(doc, payload);
    
    publish(_mqttTopicBase + "/result", payload);
}

void MqttManager::publishWriteResult(bool success, const String& urlOrError) {
    StaticJsonDocument<256> doc;
    
    doc["type"] = success ? "write_success" : "write_error";
    doc["deviceId"] = _deviceId;
    doc["success"] = success;
    
    if (success) {
        doc["url"] = urlOrError;
        doc["error"] = "";
    } else {
        doc["error"] = urlOrError;
    }
    
    doc["timestamp"] = millis();
    
    String payload;
    serializeJson(doc, payload);
    
    publish(_mqttTopicBase + "/result", payload);
}

void MqttManager::publishDebugStatus() {
    StaticJsonDocument<256> doc;
    
    doc["type"] = "debug_status";
    doc["deviceId"] = _deviceId;
    doc["debugEnabled"] = g_system.debugMode;
    doc["timestamp"] = millis();
    
    String payload;
    serializeJson(doc, payload);
    
    publish(_mqttTopicBase + "/debug", payload);
}

void MqttManager::publishReadModeStatus() {
    StaticJsonDocument<256> doc;

    doc["type"] = "read_mode_status";
    doc["deviceId"] = _deviceId;
    doc["readModeEnabled"] = g_system.readMode;
    doc["timestamp"] = millis();

    String payload;
    serializeJson(doc, payload);

    publish(_mqttTopicBase + "/debug", payload);
}

void MqttManager::publishNfcTimeout(unsigned long timeoutMs) {
    StaticJsonDocument<256> doc;

    doc["type"] = "nfc_timeout";
    doc["deviceId"] = _deviceId;
    doc["timeoutMs"] = timeoutMs;
    doc["timeoutSec"] = timeoutMs / 1000;
    doc["message"] = "No tag detected within timeout period";
    doc["timestamp"] = millis();

    String payload;
    serializeJson(doc, payload);

    publish(_mqttTopicBase + "/result", payload);
}

void MqttManager::setDebugMode(bool enabled) {
    g_system.debugMode = enabled;
    Serial.print(F("[MQTT] Debug mode: "));
    Serial.println(enabled ? "ON" : "OFF");
    publishDebugStatus();
}

void MqttManager::setReadMode(bool enabled) {
    g_system.readMode = enabled;
    
    if (enabled) {
        g_system.hasPendingWriteCommand = false;
        g_system.pendingTenantId = "";
        g_system.pendingSectorId = "";
        g_system.pendingUrl = "";
        modeSet(MODE_READER);
        Serial.println(F("[MQTT] Mode: Reader (auto-transmitting)"));
        g_lcd.forceUpdate();
    } else {
        modeSet(MODE_STANDBY);
        Serial.println(F("[MQTT] Mode: Standby"));
        g_lcd.forceUpdate();
    }
    
    Serial.print(F("[MQTT] Read mode: "));
    Serial.println(enabled ? "ON" : "OFF");
    publishReadModeStatus();
}

void MqttManager::_handleMessage(char* topic, byte* payload, unsigned int length) {
    // Convert payload to string
    String message;
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    
    Serial.print(F("[MQTT] Message received: "));
    Serial.println(topic);
    Serial.println(message);
    
    // Parse JSON
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, message);
    
    if (error) {
        Serial.print(F("[MQTT] JSON parse error: "));
        Serial.println(error.c_str());
        return;
    }
    
    // Handle command
    const char* commandType = doc["type"];
    
    if (strcmp(commandType, "write_tag") == 0) {
        _handleWriteTag(doc);
    }
    else if (strcmp(commandType, "status") == 0) {
        _handleStatus();
    }
    else if (strcmp(commandType, "restart") == 0) {
        _handleRestart();
    }
    else if (strcmp(commandType, "set_debug") == 0) {
        _handleSetDebug(doc);
    }
    else if (strcmp(commandType, "set_read_mode") == 0) {
        _handleSetReadMode(doc);
    }
    else if (strcmp(commandType, "read_tag") == 0) {
        _handleReadTag();
    }
}

void MqttManager::_handleWriteTag(JsonDocument& doc) {
    g_system.pendingTenantId = doc["tenantId"].as<String>();
    g_system.pendingSectorId = doc["sectorId"].as<String>();
    g_system.pendingUrl = doc["url"].as<String>();
    g_system.hasPendingWriteCommand = true;
    
    modeSet(MODE_WRITER);
    g_lcd.forceUpdate();
    
    Serial.println(F("[MQTT] Write command received"));
    Serial.print(F("[MQTT] Tenant: "));
    Serial.println(g_system.pendingTenantId);
    Serial.print(F("[MQTT] Sector: "));
    Serial.println(g_system.pendingSectorId);
    Serial.print(F("[MQTT] URL: "));
    Serial.println(g_system.pendingUrl);
    Serial.println(F("[MQTT] Mode: Writer (waiting for tag)"));
}

void MqttManager::_handleSetDebug(JsonDocument& doc) {
    bool enabled = doc["enabled"].as<bool>();
    setDebugMode(enabled);
}

void MqttManager::_handleSetReadMode(JsonDocument& doc) {
    bool enabled = doc["enabled"].as<bool>();
    setReadMode(enabled);
}

void MqttManager::_handleRestart() {
    Serial.println(F("[MQTT] Restart command received"));
    g_lcd.showMessage("Restarting", "By remote command", 1000);
    ESP.restart();
}

void MqttManager::_handleStatus() {
    publishStatus();
}

void MqttManager::_handleReadTag() {
    modeSet(MODE_READER);
    g_lcd.forceUpdate();
    Serial.println(F("[MQTT] One-time read command received"));
}
