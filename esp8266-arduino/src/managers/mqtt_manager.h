/**
 * @file mqtt_manager.h
 * @brief MQTT client manager for OneTapGo
 */

#ifndef MQTT_MANAGER_H
#define MQTT_MANAGER_H

#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "core/system_state.h"

void mqttCallbackWrapper(char* topic, byte* payload, unsigned int length);

class MqttManager {
public:
    void begin(const String& deviceId, const String& mqttTopicBase);
    void loop();
    bool connect();
    bool isConnected();
    bool publish(const String& topic, const char* payload, bool retained = false);
    bool publish(const String& topic, const String& payload, bool retained = false);

    void publishStatus(bool retained = true);
    void publishHeartbeat();
    void publishReadResult(const NfcCardInfo& card, const String& requestId);
    void publishWriteResult(const NfcCardInfo& card,
                            const String& requestId,
                            const String& writtenUrl,
                            bool success,
                            const String& errorCode = "",
                            const String& message = "");
    void publishNfcTimeout(const String& requestId,
                           NfcCommandType command,
                           unsigned long timeoutMs,
                           unsigned long elapsedMs);
    void publishHardwareError(const String& source,
                              const String& errorCode,
                              const String& message,
                              const String& requestId = "");
    void setDebugMode(bool enabled);
    void setLegacyReadMode(bool enabled);
    unsigned long getLastHeartbeat() { return _lastHeartbeat; }

    void _handleMessage(char* topic, byte* payload, unsigned int length);

private:
    String _deviceId = "";
    String _mqttTopicBase = "";
    String _statusTopic = "";
    String _heartbeatTopic = "";
    String _commandTopic = "";
    String _resultTopic = "";
    unsigned long _lastHeartbeat = 0;
    unsigned long _lastReconnect = 0;
    int _reconnectAttempts = 0;

    static bool _isValidUri(const String& url);
    static unsigned long _clampTimeout(JsonDocument& doc, unsigned long defaultTimeoutMs);
    static String _requestIdFromDoc(JsonDocument& doc);
    bool _publishDoc(const String& topic, JsonDocument& doc, bool retained);
    void _handleWrite(JsonDocument& doc);
    void _handleRead(JsonDocument& doc);
    void _handleStatus();
    void _handleRestart();
    void _handleSetDebug(JsonDocument& doc);
    void _handleSetReadMode(JsonDocument& doc);
};

extern MqttManager g_mqttManager;

#endif // MQTT_MANAGER_H
